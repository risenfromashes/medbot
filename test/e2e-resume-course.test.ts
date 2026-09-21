import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { Bot } from './harness/bot.js';
import { HOUR, MINUTE, zoneFor } from '../src/core/tz.js';

/**
 * Resuming a course that has already run its length.
 *
 * `/resume Vigalon` answered "Resumed Vigalon Eye Drops 5ml" and nothing happened: the
 * medicine went active, the planner saw that seven days had passed since it first started
 * on the 14th, and completed it again on the very next tick. /status then listed it as
 * "working out the next one" for ever.
 *
 * A course is a length, not a fixed pair of dates. Resumed after it has run out, it runs
 * again from today -- and `/resume vigalon 7d` says the length outright, which is what a
 * new prescription usually means.
 */

const z = zoneFor('Asia/Dhaka');
const at = (hhmm: string, day = 0): number => z.wallOnDayUtc(z.addLocalDays('2026-09-14', day), hhmm);
const P = 5000;

const realFetch = globalThis.fetch;
let bot: Bot;
beforeEach(() => { bot = new Bot(at('09:00')); bot.install(); });
afterEach(() => { globalThis.fetch = realFetch; });

const RX = {
  version: 1, timezone: 'Asia/Dhaka', patient: 'Ifti',
  day: { morning_poll_at: '06:30', presumed_wake_at: '09:00', evening_poll_at: '23:30', presumed_sleep_at: '01:00' },
  medicines: [
    { id: 'vigalon', name: 'Vigalon', dose: '1 drop', schedule: { type: 'interval', every: '4h40m', anchor: 'wake' }, min_gap: '4h', course: { days: 7 } },
  ],
};

async function setUp(): Promise<void> {
  const { AdminDb } = await import('../src/io/adminDb.js');
  const admin = new AdminDb(bot.d1 as never);
  const inv = await admin.createInvite('enrol', { createdBy: 'a', ttlMs: 86400_000 }, bot.now);
  await bot.send(P, `/start ${inv.code}`, { firstName: 'Ifti' });
  await bot.sendFile(P, 'p.json', JSON.stringify(RX));
  await bot.tap(P, /Apply|Confirm|Yes/i);
  await bot.send(P, '/awake');
  await bot.run(30 * MINUTE, 5 * MINUTE);
  await bot.tap(P, /Taken|✅ Vig/); // gives it a started_at
}

/** Jump past the end of the seven days and let the planner finish the course. */
async function runOutTheCourse(): Promise<void> {
  bot.now = at('10:00', 8);
  await bot.run(30 * MINUTE, 5 * MINUTE);
  expect(String(bot.d1.one('SELECT status FROM medications')?.['status']),
    'the course did not complete, so there is nothing to resume').toBe('completed');
}

const med = (): Record<string, unknown> => bot.d1.one('SELECT * FROM medications')!;

describe('/resume on a course that has already run out', () => {
  it('actually restarts it instead of completing again on the next tick', async () => {
    await setUp();
    await runOutTheCourse();
    await bot.send(P, '/resume vigalon');
    await bot.run(30 * MINUTE, 5 * MINUTE);
    expect(String(med()['status']), 'said "Resumed" and completed it again immediately').toBe('active');
  });

  it('runs the same length again, measured from today', async () => {
    await setUp();
    await runOutTheCourse();
    const startedBefore = Number(med()['started_at']);
    await bot.send(P, '/resume vigalon');
    expect(Number(med()['started_at']), 'still counting from the day it first began')
      .toBeGreaterThan(startedBefore);
    expect(Number(med()['course_days']), 'quietly changed the length').toBe(7);
  });

  it('says so, rather than reporting a resume that did nothing', async () => {
    await setUp();
    await runOutTheCourse();
    bot.clear();
    await bot.send(P, '/resume vigalon');
    const text = bot.last(P);
    expect(text).toMatch(/already run/i);
    expect(text, 'did not say how long it will now run').toMatch(/7 days from today/);
  });

  it('starts reminding again', async () => {
    await setUp();
    await runOutTheCourse();
    await bot.send(P, '/resume vigalon');
    bot.clear();
    await bot.run(8 * HOUR, 10 * MINUTE);
    expect(bot.textsTo(P).join('\n'), 'resumed and then stayed silent').toMatch(/Vigalon/);
    expect(bot.d1.rows("SELECT * FROM doses WHERE status IN ('scheduled','deferred','due','prompted')").length)
      .toBeGreaterThan(0);
  });

  it('takes a length when the new prescription gives one', async () => {
    await setUp();
    await runOutTheCourse();
    bot.clear();
    await bot.send(P, '/resume vigalon 10d');
    expect(Number(med()['course_days'])).toBe(10);
    expect(String(med()['status'])).toBe('active');
    expect(bot.last(P)).toMatch(/10 days from today/);
  });

  it('understands weeks', async () => {
    await setUp();
    await runOutTheCourse();
    await bot.send(P, '/resume vigalon 2w');
    expect(Number(med()['course_days'])).toBe(14);
  });

  it('does not mistake a medicine whose name ends in a number for a duration', async () => {
    await setUp();
    bot.clear();
    await bot.send(P, '/stop vigalon');
    await bot.send(P, '/resume vigalon');
    expect(String(med()['status'])).toBe('active');
  });

  it('leaves a course still running alone', async () => {
    await setUp();
    await bot.send(P, '/stop vigalon');
    const startedBefore = Number(med()['started_at']);
    bot.clear();
    await bot.send(P, '/resume vigalon');
    expect(Number(med()['started_at']), 'restarted a course that had days left to run')
      .toBe(startedBefore);
    expect(bot.last(P), 'talked about restarting a course that never ended').not.toMatch(/already run/i);
  });

  it('can still be given an explicit length mid-course', async () => {
    await setUp();
    await bot.send(P, '/stop vigalon');
    await bot.send(P, '/resume vigalon 3d');
    expect(Number(med()['course_days'])).toBe(3);
    expect(String(med()['status'])).toBe('active');
  });
});

/**
 * Re-importing a prescription that brings a finished medicine back.
 *
 * This is where it actually went wrong. The new prescription said "7 days"; the import
 * reactivated Vigalon and kept `started_at` from the week before, so the planner measured
 * those seven days from a start a week old and completed it again on the next tick. By the
 * time `/resume` was tried the damage was already done -- it set the same status the
 * import had set, against the same stale date.
 */
describe('a prescription that brings a finished medicine back', () => {
  const again = {
    ...RX,
    medicines: [
      { id: 'vigalon', name: 'Vigalon', dose: '1 drop', schedule: { type: 'interval', every: '4h40m', anchor: 'wake' }, min_gap: '4h', course: { days: 7 } },
    ],
  };

  async function reimport(doc: unknown): Promise<void> {
    await bot.sendFile(P, 'p.json', JSON.stringify(doc));
    await bot.tap(P, /Apply|Confirm|Yes/i);
  }

  it('gives it the seven days the prescription asked for, from today', async () => {
    await setUp();
    await runOutTheCourse();
    await reimport(again);
    await bot.run(30 * MINUTE, 5 * MINUTE);
    expect(String(med()['status']), 'imported, reactivated, and completed again at once').toBe('active');
    const started = Number(med()['started_at'] ?? bot.now);
    expect(started === 0 || started >= at('10:00', 8) - MINUTE,
      `the course is still counting from ${new Date(started).toISOString()}`).toBe(true);
  });

  it('starts reminding again after the re-import', async () => {
    await setUp();
    await runOutTheCourse();
    await reimport(again);
    bot.clear();
    await bot.run(8 * HOUR, 10 * MINUTE);
    expect(bot.textsTo(P).join('\n'), 'imported and then stayed silent').toMatch(/Vigalon/);
  });

  it('counts the new course from zero rather than from last week', async () => {
    await setUp();
    await runOutTheCourse();
    const takenBefore = Number(med()['doses_taken']);
    expect(takenBefore, 'nothing was taken, so this proves nothing').toBeGreaterThan(0);
    await reimport(again);
    expect(Number(med()['doses_taken']), 'the new course began part-used').toBe(0);
  });

  it('leaves a medicine that is still mid-course exactly alone', async () => {
    // The rule this must not break: a corrected prescription must never restart a
    // seven-day antibiotic on day five.
    await setUp();
    bot.now = at('10:00', 3); // day four of seven
    await bot.run(10 * MINUTE, 5 * MINUTE);
    const startedBefore = Number(med()['started_at']);
    const takenBefore = Number(med()['doses_taken']);
    await reimport({
      ...RX,
      medicines: [
        { id: 'vigalon', name: 'Vigalon', dose: '2 drops', schedule: { type: 'interval', every: '4h40m', anchor: 'wake' }, min_gap: '4h', course: { days: 7 } },
      ],
    });
    expect(Number(med()['started_at']), 'restarted a course that was half way through').toBe(startedBefore);
    expect(Number(med()['doses_taken']), 'threw away the progress of a running course').toBe(takenBefore);
  });

  it('does the same for a medicine that was stopped by hand', async () => {
    await setUp();
    await bot.send(P, '/stop vigalon');
    bot.now = at('10:00', 8);
    await reimport(again);
    await bot.run(30 * MINUTE, 5 * MINUTE);
    expect(String(med()['status'])).toBe('active');
    const started = Number(med()['started_at'] ?? 0);
    expect(started === 0 || started >= at('10:00', 8) - MINUTE, 'revived onto its old clock').toBe(true);
  });
});
