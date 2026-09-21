import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { Bot } from './harness/bot.js';
import { HOUR, MINUTE, zoneFor } from '../src/core/tz.js';

/**
 * The alarm that cried wolf.
 *
 * "⚠️ Something looks wrong. No activity on Aquafresh Liquigel Eye Drops 10ml for a long
 * time, although it is still an active prescription. Check with /status."
 *
 * Nothing was wrong. The watchdog looked only at when a dose was last *taken*, so a
 * medicine that was prompting, nagging and escalating exactly as designed -- but had not
 * been tapped Taken -- tripped it. Four times a day, on both phones, indefinitely, and the
 * only thing it offered was to go and investigate it yourself.
 */

const z = zoneFor('Asia/Dhaka');
const at = (hhmm: string, day = 0): number => z.wallOnDayUtc(z.addLocalDays('2026-09-14', day), hhmm);
const P = 5000;
const C = 6000;

const realFetch = globalThis.fetch;
let bot: Bot;
beforeEach(() => { bot = new Bot(at('09:00')); bot.install(); });
afterEach(() => { globalThis.fetch = realFetch; });

const RX = {
  version: 1, timezone: 'Asia/Dhaka', patient: 'Ifti',
  day: { morning_poll_at: '06:30', presumed_wake_at: '09:00', evening_poll_at: '23:30', presumed_sleep_at: '01:00' },
  medicines: [
    { id: 'aqua', name: 'Aquafresh', dose: '1 drop', schedule: { type: 'interval', every: '2h', anchor: 'wake' }, min_gap: '90m' },
  ],
};

async function setUp(): Promise<void> {
  const { AdminDb } = await import('../src/io/adminDb.js');
  const admin = new AdminDb(bot.d1 as never);
  const enrol = await admin.createInvite('enrol', { createdBy: 'a', ttlMs: 86400_000 }, bot.now);
  await bot.send(P, `/start ${enrol.code}`, { firstName: 'Ifti' });
  await bot.sendFile(P, 'p.json', JSON.stringify(RX));
  await bot.tap(P, /Apply|Confirm|Yes/i);
  const id = Number(bot.d1.one('SELECT id FROM patients')?.['id']);
  const care = await admin.createInvite('caregiver', { createdBy: 'a', ttlMs: 86400_000, patientId: id }, bot.now);
  await bot.send(C, `/caregiver ${care.code}`, { firstName: 'Ashraf' });
  await bot.send(P, '/awake');
}

const alarms = (): string[] =>
  bot.sent.filter((m) => /no next dose booked|something looks wrong/i.test(m.text)).map((m) => m.text);

/** Anchored to a meal nobody has defined: the planner can never schedule it. */
function strandOnUnknownMeal(): void {
  bot.d1.rows(
    `UPDATE medications SET kind='meal', interval_ms=NULL,
       spec_json='{"kind":"meal","meals":[{"meal":"brunch","relation":"after","offsetMs":0}]}'`,
  );
  bot.d1.rows("UPDATE doses SET status='cancelled' WHERE status IN ('scheduled','deferred','due','prompted')");
}

describe('the liveness watchdog', () => {
  it('stays quiet about a medicine being asked for and simply not answered', async () => {
    await setUp();
    await bot.run(20 * HOUR, 10 * MINUTE); // prompted and nagged all day, never tapped
    expect(alarms(), 'cried wolf about a medicine that was prompting correctly').toEqual([]);
  });

  it('does not go off in the small hours over a short-interval medicine', async () => {
    // Three cycles of a two-hourly drop is six hours — shorter than a night's sleep.
    await setUp();
    await bot.send(P, '/sleep');
    await bot.tap(P, /turning in/i).catch(() => undefined);
    await bot.run(9 * HOUR, 10 * MINUTE);
    expect(alarms(), 'woke the household at five in the morning').toEqual([]);
  });

  it('recovers a parked cursor by itself, without an alarm', async () => {
    await setUp();
    await bot.run(30 * MINUTE, 5 * MINUTE);
    bot.d1.rows("UPDATE doses SET status='cancelled' WHERE status IN ('scheduled','deferred','due','prompted')");
    bot.d1.rows(`UPDATE medications SET last_planned_due_at=${at('00:00', 3)}, last_cycle_start_at=${at('00:00', 3)}`);
    await bot.run(2 * HOUR, 5 * MINUTE);
    const live = bot.d1.rows("SELECT * FROM doses WHERE status IN ('scheduled','deferred','due','prompted')");
    expect(live.length, 'left the medicine with nothing booked').toBeGreaterThan(0);
    expect(alarms(), 'alarmed about something it had already put right').toEqual([]);
  });

  it('speaks up when a medicine genuinely can never be scheduled', async () => {
    await setUp();
    await bot.run(30 * MINUTE, 5 * MINUTE);
    strandOnUnknownMeal();
    await bot.run(30 * HOUR, 10 * MINUTE);
    expect(alarms().length, 'a medicine with nothing booked, and nobody told').toBeGreaterThan(0);
  });

  it('names the medicine and says what it is doing, not that you should go and look', async () => {
    await setUp();
    await bot.run(30 * MINUTE, 5 * MINUTE);
    strandOnUnknownMeal();
    await bot.run(30 * HOUR, 10 * MINUTE);
    const text = alarms().join('\n');
    expect(text, 'told the reader to go and diagnose it themselves').not.toMatch(/Check with \/status/);
    expect(text, 'did not say what it was doing about it').toMatch(/rebuilding/i);
    expect(text, 'did not name the medicine').toMatch(/Aquafresh/);
  });

  it('tells the caregiver too, since the patient is by definition not seeing it', async () => {
    await setUp();
    await bot.run(30 * MINUTE, 5 * MINUTE);
    strandOnUnknownMeal();
    await bot.run(30 * HOUR, 10 * MINUTE);
    expect(bot.textsTo(C).filter((t) => /no next dose booked/i.test(t)).length).toBeGreaterThan(0);
  });

  it('leaves a record of the repair it attempted', async () => {
    await setUp();
    await bot.run(30 * MINUTE, 5 * MINUTE);
    strandOnUnknownMeal();
    await bot.run(30 * HOUR, 10 * MINUTE);
    expect(bot.d1.rows("SELECT * FROM audit_log WHERE kind='schedule_rebuilt'").length,
      'repaired silently, with nothing in the log').toBeGreaterThan(0);
  });
});
