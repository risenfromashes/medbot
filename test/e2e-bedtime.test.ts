import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { Bot } from './harness/bot.js';
import { MINUTE, zoneFor } from '../src/core/tz.js';

/**
 * What /sleep means.
 *
 * It ends the day. It does not clear it: an unanswered dose stays unanswered and comes
 * back in the morning re-timed to when the patient actually gets up. But it says what is
 * still outstanding and offers the three honest answers, because the alternative is a log
 * full of "missed" for doses that were taken.
 *
 * And it is not a nap. Up at nine, /sleep at ten, /awake at eleven would restart the day
 * three times over and walk the whole schedule with it.
 */

const z = zoneFor('Asia/Dhaka');
const at = (hhmm: string, day = 0): number => z.wallOnDayUtc(z.addLocalDays('2026-09-14', day), hhmm);
const PATIENT = 5000;

const realFetch = globalThis.fetch;
let bot: Bot;

beforeEach(() => {
  bot = new Bot(at('08:00'));
  bot.install();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const PRESCRIPTION = {
  version: 1,
  timezone: 'Asia/Dhaka',
  day: { morning_poll_at: '06:30', presumed_wake_at: '09:00', evening_poll_at: '22:30', presumed_sleep_at: '01:00' },
  meals: [{ id: 'breakfast', typical_local: '08:30' }, { id: 'dinner', typical_local: '20:30' }],
  medicines: [
    { id: 'drops', name: 'Moxifloxacin', dose: '1 drop', schedule: { type: 'interval', every: '3h', anchor: 'wake' }, course: { days: 7 } },
  ],
};

async function setUp(): Promise<void> {
  const { AdminDb } = await import('../src/io/adminDb.js');
  const admin = new AdminDb(bot.d1 as never);
  const inv = await admin.createInvite('enrol', { createdBy: 'a', ttlMs: 86400_000 }, bot.now);
  await bot.send(PATIENT, `/start ${inv.code}`);
  await bot.sendFile(PATIENT, 'p.json', JSON.stringify(PRESCRIPTION));
  await bot.tap(PATIENT, /Apply|Confirm|Yes/i);
  await bot.send(PATIENT, '/awake');
}

const liveDoses = (): Array<Record<string, unknown>> =>
  bot.d1.rows("SELECT * FROM doses WHERE status IN ('scheduled','deferred','due','prompted')");

describe('going to bed', () => {
  it('refuses to end a day that has barely started', async () => {
    await setUp();
    bot.clear();
    await bot.send(PATIENT, '/sleep');
    expect(bot.last(PATIENT)).toMatch(/nap/i);
    expect(bot.d1.one('SELECT wake_state FROM patients')?.['wake_state'], 'a nap ended the day').toBe('awake');
  });

  it('takes no for an answer when the patient insists', async () => {
    await setUp();
    await bot.send(PATIENT, '/sleep');
    await bot.tap(PATIENT, /turning in/i);
    expect(bot.d1.one('SELECT wake_state FROM patients')?.['wake_state']).toBe('asleep');
  });

  it('ends the day once someone has actually had one', async () => {
    await setUp();
    bot.now = at('22:00');
    bot.clear();
    await bot.send(PATIENT, '/sleep');
    expect(bot.last(PATIENT)).toMatch(/Sleep well/);
    expect(bot.d1.one('SELECT wake_state FROM patients')?.['wake_state']).toBe('asleep');
  });

  it('says what is still outstanding rather than letting it rot', async () => {
    await setUp();
    await bot.run(30 * MINUTE);
    bot.now = at('22:00');
    await bot.tick();
    bot.clear();
    await bot.send(PATIENT, '/sleep');
    expect(bot.last(PATIENT), 'went quiet without mentioning the pending dose').toMatch(/outstanding/i);
    expect(bot.last(PATIENT)).toContain('Moxifloxacin');
  });

  it('leaves them alone by default — sleep does not clear the day', async () => {
    await setUp();
    await bot.run(30 * MINUTE);
    bot.now = at('22:00');
    await bot.tick();
    const before = Number(bot.d1.one('SELECT doses_missed FROM medications')?.['doses_missed']);
    await bot.send(PATIENT, '/sleep');
    await bot.tap(PATIENT, /Leave them/i);
    expect(Number(bot.d1.one('SELECT doses_missed FROM medications')?.['doses_missed'])).toBe(before);
    expect(liveDoses().length, 'the dose was thrown away instead of parked').toBeGreaterThan(0);
  });

  it('logs them as taken when the patient says they took them', async () => {
    await setUp();
    await bot.run(30 * MINUTE);
    bot.now = at('22:00');
    await bot.tick();
    await bot.send(PATIENT, '/sleep');
    await bot.tap(PATIENT, /I took them/i);
    expect(Number(bot.d1.one('SELECT doses_taken FROM medications')?.['doses_taken'])).toBeGreaterThan(0);
  });

  it('warns when skipping them, because that is a decision with a cost', async () => {
    await setUp();
    await bot.run(30 * MINUTE);
    bot.now = at('22:00');
    await bot.tick();
    await bot.send(PATIENT, '/sleep');
    const before = bot.sent.length;
    await bot.tap(PATIENT, /skipping them/i);
    const after = bot.sent.slice(before).map((m) => m.text).join('\n');
    expect(after, 'skipped a dose without saying what that costs').toMatch(/⚠️|did not take|fresh/i);
    expect(after).toMatch(/undo/i);
  });

  it('brings a parked dose back when the patient gets up, re-timed', async () => {
    await setUp();
    await bot.run(30 * MINUTE);
    bot.now = at('22:00');
    await bot.tick();
    await bot.send(PATIENT, '/sleep');
    await bot.tap(PATIENT, /Leave them/i);

    bot.now = at('09:30', 1);
    await bot.send(PATIENT, '/awake');
    await bot.run(10 * MINUTE);
    const live = liveDoses();
    expect(live.length, 'the medicine went quiet overnight and never came back').toBeGreaterThan(0);
    expect(Number(live[0]!['effective_due_at']), 'came back stuck in yesterday')
      .toBeGreaterThanOrEqual(at('09:30', 1));
  });
});

describe('undo covers the decisions, not just the doses', () => {
  it('puts back a dose logged at bedtime', async () => {
    await setUp();
    await bot.run(30 * MINUTE);
    bot.now = at('22:00');
    await bot.tick();
    await bot.send(PATIENT, '/sleep');
    await bot.tap(PATIENT, /I took them/i);
    expect(Number(bot.d1.one('SELECT doses_taken FROM medications')?.['doses_taken'])).toBe(1);

    await bot.send(PATIENT, '/undo');
    expect(Number(bot.d1.one('SELECT doses_taken FROM medications')?.['doses_taken'])).toBe(0);
  });

  it('puts back ending the day', async () => {
    await setUp();
    bot.now = at('22:00');
    await bot.send(PATIENT, '/sleep');
    expect(bot.d1.one('SELECT wake_state FROM patients')?.['wake_state']).toBe('asleep');
    bot.clear();
    await bot.send(PATIENT, '/undo');
    expect(bot.last(PATIENT)).toMatch(/undone/i);
    expect(bot.d1.one('SELECT wake_state FROM patients')?.['wake_state'], 'still asleep after undoing it').toBe('awake');
  });

  it('puts back a meal that was recorded by mistake', async () => {
    await setUp();
    await bot.send(PATIENT, '/ate breakfast');
    expect(bot.d1.rows("SELECT * FROM meal_events WHERE source='confirmed'")).toHaveLength(1);
    await bot.send(PATIENT, '/undo');
    expect(bot.d1.rows("SELECT * FROM meal_events WHERE source='confirmed'")).toHaveLength(0);
  });

  it('steps back one decision at a time', async () => {
    await setUp();
    await bot.send(PATIENT, '/ate breakfast');
    bot.now = at('22:00');
    await bot.send(PATIENT, '/sleep');

    await bot.send(PATIENT, '/undo'); // the sleep
    expect(bot.d1.one('SELECT wake_state FROM patients')?.['wake_state']).toBe('awake');
    await bot.send(PATIENT, '/undo'); // the meal
    expect(bot.d1.rows("SELECT * FROM meal_events WHERE source='confirmed'")).toHaveLength(0);
  });

  it('steps over a decision whose dose has since been deleted', async () => {
    // A re-import or a reset takes the doses with it. The audit entry stays, and if it
    // stopped the search there, /undo would report "nothing to undo" for ever after.
    await setUp();
    await bot.run(30 * MINUTE);
    bot.now = at('22:00');
    await bot.tick();
    await bot.send(PATIENT, '/sleep');
    await bot.tap(PATIENT, /I took them/i);
    bot.d1.sqlite.exec('DELETE FROM doses');

    bot.clear();
    await bot.send(PATIENT, '/undo');
    expect(bot.last(PATIENT), 'stuck behind an entry it could not reach').toMatch(/undone/i);
    expect(bot.d1.one('SELECT wake_state FROM patients')?.['wake_state']).toBe('awake');
  });

  it('says so plainly when there is nothing left to undo', async () => {
    await setUp();
    await bot.send(PATIENT, '/undo'); // the /awake that started the day
    bot.clear();
    await bot.send(PATIENT, '/undo');
    expect(bot.last(PATIENT)).toMatch(/nothing to undo/i);
  });
});
