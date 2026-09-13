import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { Bot } from './harness/bot.js';
import { HOUR, MINUTE, zoneFor } from '../src/core/tz.js';

/**
 * A week, through the real thing.
 *
 * The simulator drives `plan()` directly, which is the right way to test the scheduling
 * maths and a poor way to catch the rest: a wrong column name, a callback that resolves
 * the wrong dose, an id that comes back zero. This runs the same week through the
 * database, the handlers and the message rendering, and checks only the property that
 * matters -- that a medicine never quietly stops.
 */

const z = zoneFor('Asia/Dhaka');
const start = z.wallOnDayUtc('2026-09-14', '07:00');
const PATIENT = 5000;
const CARER = 6000;

const realFetch = globalThis.fetch;
let bot: Bot;

beforeEach(() => {
  bot = new Bot(start);
  bot.install();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const PRESCRIPTION = {
  version: 1,
  timezone: 'Asia/Dhaka',
  day: { morning_poll_at: '06:30', presumed_wake_at: '09:00', evening_poll_at: '22:30', presumed_sleep_at: '01:00' },
  meals: [
    { id: 'breakfast', typical_local: '08:30' },
    { id: 'lunch', typical_local: '13:30' },
    { id: 'dinner', typical_local: '20:30' },
  ],
  groups: [{ id: 'drops', spacing: '10m' }],
  medicines: [
    { id: 'moxi', name: 'Moxifloxacin', dose: '1 drop', schedule: { type: 'interval', every: '2h', anchor: 'wake' }, group: 'drops', group_seq: 1, course: { days: 7 } },
    { id: 'pred', name: 'Prednisolone', dose: '1 drop', schedule: { type: 'interval', every: '4h', anchor: 'wake' }, group: 'drops', group_seq: 2, course: { days: 7 } },
    { id: 'omep', name: 'Omeprazole 20', dose: '1 capsule', pattern: '1+0+1', relation: 'before', course: { days: 7 } },
    { id: 'ceevit', name: 'Tab. Ceevit', dose: '1 tablet', pattern: '1+1+1+1', course: { days: 7 } },
  ],
};

async function setUp(): Promise<void> {
  const { AdminDb } = await import('../src/io/adminDb.js');
  const admin = new AdminDb(bot.d1 as never);
  const enrol = await admin.createInvite('enrol', { createdBy: 'a', ttlMs: 86400_000 }, bot.now);
  await bot.send(PATIENT, `/start ${enrol.code}`);
  await bot.sendFile(PATIENT, 'p.json', JSON.stringify(PRESCRIPTION));
  await bot.tap(PATIENT, /Apply|Confirm|Yes/i);
  const patientId = Number(bot.d1.one('SELECT id FROM patients')?.['id']);
  const care = await admin.createInvite('caregiver', { createdBy: 'a', ttlMs: 86400_000, patientId }, bot.now);
  await bot.send(CARER, `/caregiver ${care.code}`);
}

/** Answer whatever is pending, the way a reasonably diligent person would. */
async function answerPending(): Promise<void> {
  const pending = bot.d1.rows(
    "SELECT id FROM doses WHERE status IN ('due','prompted') ORDER BY effective_due_at",
  );
  for (const row of pending) {
    const { encodeCallback } = await import('../src/core/callbackCodec.js');
    const data = encodeCallback({ a: 'take', doseId: Number(row['id']) });
    await bot.send(PATIENT, '/status'); // stands in for "the patient is around"
    bot.clear();
    await bot.sendCallback(PATIENT, data);
  }
}

describe('a week of it', () => {
  it('never lets a medicine go silent, and finishes the course', async () => {
    await setUp();

    const seen = new Set<string>();
    for (let day = 0; day < 8; day++) {
      const wake = start + day * 24 * HOUR + 2 * HOUR; // up at 09:00
      while (bot.now < wake) {
        await bot.tick();
        bot.now += 5 * MINUTE;
      }
      await bot.send(PATIENT, '/awake');

      const bed = start + day * 24 * HOUR + 15 * HOUR; // in bed at 22:00
      while (bot.now < bed) {
        await bot.tick();
        await answerPending();
        for (const m of bot.d1.rows('SELECT name FROM medications')) seen.add(String(m['name']));
        bot.now += 10 * MINUTE;
      }
      await bot.send(PATIENT, '/sleep');
    }

    const errors = bot.d1.rows("SELECT * FROM audit_log WHERE kind='webhook_error'");
    expect(errors, `something threw: ${JSON.stringify(errors.slice(0, 2))}`).toHaveLength(0);

    // Every medicine had a real go at its course, and none of them stalled at zero.
    for (const m of bot.d1.rows('SELECT name, doses_taken, doses_missed, status FROM medications')) {
      const total = Number(m['doses_taken']) + Number(m['doses_missed']);
      expect(total, `${String(m['name'])} was never asked for at all`).toBeGreaterThan(3);
    }

    // Seven-day courses end, rather than running on for ever.
    const finished = bot.d1.rows("SELECT * FROM medications WHERE status='completed'");
    expect(finished.length, 'nothing ever completed its course').toBeGreaterThan(0);
  });

  it('keeps every acknowledgement to one dose, however many ticks pass', async () => {
    await setUp();
    await bot.send(PATIENT, '/awake');
    await bot.run(6 * HOUR, 5 * MINUTE);

    const doses = bot.d1.rows('SELECT med_id, seq, COUNT(*) c FROM doses GROUP BY med_id, seq HAVING c > 1');
    expect(doses, 'the same dose was created twice').toHaveLength(0);

    for (const m of bot.d1.rows('SELECT id, name FROM medications')) {
      const live = bot.d1.rows(
        `SELECT * FROM doses WHERE med_id = ${Number(m['id'])}
           AND status IN ('scheduled','deferred','due','prompted')`,
      );
      expect(live.length, `${String(m['name'])} has ${live.length} live doses`).toBeLessThanOrEqual(1);
    }
  });
});
