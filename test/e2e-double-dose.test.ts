import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { Bot } from './harness/bot.js';
import { HOUR, MINUTE, zoneFor } from '../src/core/tz.js';

/**
 * The tap that lands in the middle of a tick.
 *
 * The planner works from a snapshot up to a minute old. When a "Taken" arrives while that
 * tick is in flight, the medicine's `last_taken_at` moves but the snapshot's does not, so
 * `due = max(due, last_taken_at + min_gap)` is computed against a stale figure. The
 * unique index cannot catch the successor: the dose that won has already left the index
 * by becoming `taken`.
 *
 * Live consequence: Vigalon, four-hour gap, taken at 1:31pm and asked for again at 1:41pm.
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
  day: { morning_poll_at: '09:00', presumed_wake_at: '11:00', evening_poll_at: '23:30', presumed_sleep_at: '01:00' },
  medicines: [
    { id: 'vigalon', name: 'Vigalon', dose: '1 drop', schedule: { type: 'interval', every: '4h40m', anchor: 'wake' }, min_gap: '4h', course: { days: 14 } },
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
}

const liveDoses = (): Record<string, unknown>[] =>
  bot.d1.rows("SELECT * FROM doses WHERE status IN ('scheduled','deferred','due','prompted')");

describe('a medicine is never asked for twice inside its minimum gap', () => {
  it('refuses a successor written against a stale last_taken_at', async () => {
    await setUp();
    await bot.run(20 * MINUTE, 5 * MINUTE);
    await bot.tap(P, /Taken|✅ Vig/);
    const takenAt = Number(bot.d1.one('SELECT last_taken_at FROM medications')?.['last_taken_at']);

    // Whatever the planner does next, nothing may land inside the four-hour gap.
    await bot.run(3 * HOUR, 5 * MINUTE);
    for (const d of liveDoses()) {
      expect(Number(d['effective_due_at']) - takenAt,
        'a second dose inside the overdose guard').toBeGreaterThanOrEqual(4 * HOUR);
    }
  });

  it('writes nothing at all rather than a dose it must refuse', async () => {
    await setUp();
    await bot.run(20 * MINUTE, 5 * MINUTE);
    await bot.tap(P, /Taken|✅ Vig/);
    await bot.run(2 * HOUR, 5 * MINUTE);
    const perMed = bot.d1.rows(
      "SELECT med_id, COUNT(*) c FROM doses WHERE status IN ('scheduled','deferred','due','prompted') GROUP BY med_id",
    );
    for (const r of perMed) expect(Number(r['c']), 'two live doses for one medicine').toBeLessThanOrEqual(1);
  });

  it('never prompts about a dose it refused to create', async () => {
    await setUp();
    await bot.run(20 * MINUTE, 5 * MINUTE);
    await bot.tap(P, /Taken|✅ Vig/);
    bot.clear();
    await bot.run(90 * MINUTE, 5 * MINUTE);
    expect(bot.textsTo(P).filter((t) => /Time for|hasn't confirmed/.test(t)),
      'asked for a drop it had just been told was taken').toEqual([]);
  });

  it('leaves a record when it refuses one', async () => {
    // Simulate the race directly: a dose already taken, and a planner action that would
    // schedule the next one ten minutes later.
    await setUp();
    await bot.run(20 * MINUTE, 5 * MINUTE);
    await bot.tap(P, /Taken|✅ Vig/);
    const med = bot.d1.one('SELECT id, last_taken_at FROM medications')!;
    const { Db } = await import('../src/io/db.js');
    const db = new Db(bot.d1 as never);
    const patientId = Number(bot.d1.one('SELECT id FROM patients')!['id']);
    const day = z.localDay(bot.now);
    const state = await db.loadState(patientId, day, day);
    await db.applyActions(state!, [{
      t: 'createDose', id: -1, medId: Number(med['id']), seq: 99, step: 0,
      localDay: day, plannedDueAt: Number(med['last_taken_at']) + 10 * MINUTE,
      effectiveDueAt: Number(med['last_taken_at']) + 10 * MINUTE, anchorKind: 'actual',
    }] as never, bot.now);
    expect(bot.d1.rows("SELECT * FROM audit_log WHERE kind='dose_refused'"),
      'refused it silently').toHaveLength(1);
    expect(bot.d1.rows('SELECT * FROM doses WHERE seq=99'), 'wrote it anyway').toHaveLength(0);
  });

  it('still allows the next dose once the gap has passed', async () => {
    await setUp();
    await bot.run(20 * MINUTE, 5 * MINUTE);
    await bot.tap(P, /Taken|✅ Vig/);
    const takenAt = Number(bot.d1.one('SELECT last_taken_at FROM medications')?.['last_taken_at']);
    bot.clear();
    await bot.run(6 * HOUR, 5 * MINUTE);
    expect(bot.textsTo(P).join('\n'), 'the medicine went silent after one dose').toMatch(/Vigalon/);
    const next = bot.d1.one(
      "SELECT MIN(effective_due_at) e FROM doses WHERE status IN ('scheduled','deferred','due','prompted')",
    );
    expect(Number(next?.['e']) - takenAt, 'the successor never came').toBeGreaterThanOrEqual(4 * HOUR);
  });

  it('does not block the second drop of a spacing group', async () => {
    // Ten minutes apart by design, and the medicine's own gap is hours. Applying the gap
    // to steps would silence every spaced drop after the first.
    const { AdminDb } = await import('../src/io/adminDb.js');
    const admin = new AdminDb(bot.d1 as never);
    const inv = await admin.createInvite('enrol', { createdBy: 'a', ttlMs: 86400_000 }, bot.now);
    await bot.send(P, `/start ${inv.code}`, { firstName: 'Ifti' });
    await bot.sendFile(P, 'p.json', JSON.stringify({
      version: 1, timezone: 'Asia/Dhaka',
      groups: [{ id: 'drops', spacing: '10m', ordered: true }],
      medicines: [
        { id: 'a', name: 'Drop A', schedule: { type: 'interval', every: '2h', anchor: 'wake' }, min_gap: '90m', group: 'drops', group_seq: 1 },
        { id: 'b', name: 'Drop B', schedule: { type: 'interval', every: '2h', anchor: 'wake' }, min_gap: '90m', group: 'drops', group_seq: 2 },
      ],
    }));
    await bot.tap(P, /Apply|Confirm|Yes/i);
    await bot.send(P, '/awake');
    await bot.run(20 * MINUTE, 5 * MINUTE);
    await bot.tap(P, /Taken|✅/);
    await bot.run(30 * MINUTE, 5 * MINUTE);
    expect(bot.d1.rows("SELECT * FROM audit_log WHERE kind='dose_refused'"),
      'refused a spaced step that was ten minutes apart on purpose').toEqual([]);
  });
});
