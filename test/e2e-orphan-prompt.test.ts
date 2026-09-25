import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { Bot } from './harness/bot.js';
import { HOUR, MINUTE, zoneFor } from '../src/core/tz.js';

/**
 * "Nothing to take right now."
 *
 * Sent to the caregiver at 20:43, 20:47 and 20:52, and for hours before that. It is what a
 * dose prompt renders when none of its doses can be found -- and once a prompt is in that
 * state nothing ever closed it, so it climbed the nag ladder and the escalation ladder
 * about nothing at all. One had reached forty-one nudges over two days, about a medicine
 * stopped the previous evening.
 *
 * Three ways in, and they were all open at once in the live database:
 *  - a medicine stopped, cancelling its dose and leaving the question about it open;
 *  - two ticks overlapping, each creating a prompt for the same dose, only one of which
 *    the dose could point at;
 *  - and no cure for either, because nothing looked for a prompt with nothing to ask.
 */

const z = zoneFor('Asia/Dhaka');
const at = (hhmm: string, day = 0): number => z.wallOnDayUtc(z.addLocalDays('2026-09-14', day), hhmm);
const P = 5000;
const C = 6000;

const realFetch = globalThis.fetch;
let bot: Bot;
beforeEach(() => { bot = new Bot(at('09:00')); bot.install(); });
afterEach(() => { globalThis.fetch = realFetch; });

async function setUp(): Promise<void> {
  const { AdminDb } = await import('../src/io/adminDb.js');
  const admin = new AdminDb(bot.d1 as never);
  const inv = await admin.createInvite('enrol', { createdBy: 'a', ttlMs: 86400_000 }, bot.now);
  await bot.send(P, `/start ${inv.code}`, { firstName: 'Ifti' });
  await bot.sendFile(P, 'p.json', JSON.stringify({
    version: 1, timezone: 'Asia/Dhaka',
    day: { morning_poll_at: '06:30', presumed_wake_at: '09:00', evening_poll_at: '23:30', presumed_sleep_at: '01:00' },
    medicines: [
      { id: 'aqua', name: 'Aquafresh', dose: '1 drop', schedule: { type: 'interval', every: '2h', anchor: 'wake' }, min_gap: '90m' },
      { id: 'filmet', name: 'Filmet', dose: '1 tablet', schedule: { type: 'interval', every: '7h', anchor: 'wake' }, min_gap: '5h' },
    ],
  }));
  await bot.tap(P, /Apply|Confirm|Yes/i);
  const id = Number(bot.d1.one('SELECT id FROM patients')?.['id']);
  const care = await admin.createInvite('caregiver', { createdBy: 'a', ttlMs: 86400_000, patientId: id }, bot.now);
  await bot.send(C, `/caregiver ${care.code}`, { firstName: 'Ashraf' });
  await bot.send(P, '/awake');
  await bot.run(20 * MINUTE, 5 * MINUTE);
}

const emptyPings = (chat: number): string[] =>
  bot.textsTo(chat).filter((t) => /Nothing to take right now/i.test(t));

const orphans = (): Record<string, unknown>[] =>
  bot.d1.rows(
    `SELECT p.* FROM prompts p WHERE p.state='open' AND p.kind='dose'
       AND NOT EXISTS (SELECT 1 FROM doses d WHERE d.prompt_id = p.id
                         AND d.status IN ('scheduled','deferred','due','prompted'))`,
  );

describe('a prompt with nothing left to ask about', () => {
  it('is never sent to anyone', async () => {
    await setUp();
    await bot.send(P, '/stop filmet');
    await bot.run(6 * HOUR, 5 * MINUTE);
    expect(emptyPings(P), 'told the patient there was nothing to take').toEqual([]);
    expect(emptyPings(C), 'told the caregiver, over and over').toEqual([]);
  });

  /** The id of an open prompt that is genuinely asking about this medicine. */
  const askingAbout = (key: string): number => {
    const row = bot.d1.one(
      `SELECT p.id FROM prompts p JOIN doses d ON d.prompt_id = p.id
         JOIN medications m ON m.id = d.med_id
        WHERE p.state='open' AND m.med_key='${key}'`,
    );
    expect(row, `nothing is asking about ${key}, so this proves nothing`).not.toBeNull();
    return Number(row!['id']);
  };

  it('is closed when its medicine is stopped', async () => {
    await setUp();
    const id = askingAbout('filmet');
    await bot.send(P, '/stop filmet');
    expect(String(bot.d1.one(`SELECT state FROM prompts WHERE id=${id}`)?.['state']),
      'the question outlived the medicine').not.toBe('open');
    await bot.run(10 * MINUTE, 5 * MINUTE);
    expect(orphans()).toEqual([]);
  });

  it('is closed when its course is restarted', async () => {
    await setUp();
    const id = askingAbout('filmet');
    await bot.send(P, '/restart filmet 7d');
    expect(String(bot.d1.one(`SELECT state FROM prompts WHERE id=${id}`)?.['state']),
      'the old course\u2019s question survived into the new one').not.toBe('open');
    await bot.run(10 * MINUTE, 5 * MINUTE);
    expect(orphans()).toEqual([]);
  });

  it('is cleaned up even when something strands it directly', async () => {
    // Whatever the cause, the planner must find it and close it.
    await setUp();
    const open = bot.d1.one("SELECT id FROM prompts WHERE state='open' AND kind='dose'");
    expect(open, 'no open dose prompt to strand').not.toBeNull();
    bot.d1.rows(`UPDATE doses SET prompt_id=NULL, status='cancelled', resolved_at=${bot.now} WHERE prompt_id=${Number(open!['id'])}`);
    await bot.run(30 * MINUTE, 5 * MINUTE);
    expect(orphans(), 'a stranded question nags for ever').toEqual([]);
  });

  it('stops nagging the moment it is closed, rather than one ladder step later', async () => {
    await setUp();
    const open = bot.d1.one("SELECT id FROM prompts WHERE state='open' AND kind='dose'");
    bot.d1.rows(`UPDATE doses SET prompt_id=NULL, status='cancelled', resolved_at=${bot.now} WHERE prompt_id=${Number(open!['id'])}`);
    bot.clear();
    await bot.run(2 * HOUR, 5 * MINUTE);
    expect(emptyPings(P)).toEqual([]);
    expect(emptyPings(C)).toEqual([]);
  });
});

describe('two ticks racing to ask the same question', () => {
  it('produces one prompt, not two', async () => {
    await setUp();
    // Run the same tick twice against the same snapshot, which is what an overlapping
    // cron invocation does.
    const { runTick } = await import('../src/handlers/scheduled.js');
    bot.now = at('12:00');
    await Promise.all([runTick(bot.env, bot.now), runTick(bot.env, bot.now)]);
    const perDose = bot.d1.rows(
      `SELECT d.id, COUNT(p.id) c FROM doses d JOIN prompts p
         ON p.state='open' AND p.kind='dose' AND p.body_json LIKE '%[' || d.id || ']%'
        GROUP BY d.id`,
    );
    for (const r of perDose) {
      expect(Number(r['c']), `dose ${String(r['id'])} has ${String(r['c'])} open prompts`).toBeLessThanOrEqual(1);
    }
    expect(orphans(), 'the loser was left open with nobody to answer it').toEqual([]);
  });

  it('still asks once, rather than not at all', async () => {
    await setUp();
    const { runTick } = await import('../src/handlers/scheduled.js');
    bot.now = at('12:00');
    bot.clear();
    await Promise.all([runTick(bot.env, bot.now), runTick(bot.env, bot.now)]);
    await bot.run(5 * MINUTE, MINUTE);
    expect(bot.d1.rows("SELECT * FROM prompts WHERE state='open' AND kind='dose'").length,
      'the guard swallowed the question entirely').toBeGreaterThan(0);
  });
});
