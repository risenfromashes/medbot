import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { Bot } from './harness/bot.js';
import { HOUR, MINUTE, zoneFor } from '../src/core/tz.js';

/**
 * A second course of something already on the list.
 *
 * There was nowhere for it to go. `/add` refuses an id that already exists, `/import`
 * replaces the whole prescription (and so restarts nothing by itself), `/extend` lengthens
 * the course that is running rather than beginning a new one, and `/resume` picks a
 * medicine up where it left off. So "another seven days of this, from today" could only be
 * done by re-importing everything.
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
    { id: 'drops', name: 'Vigalon', dose: '1 drop', schedule: { type: 'interval', every: '4h', anchor: 'wake' }, min_gap: '3h', course: { days: 7 } },
    { id: 'tab', name: 'Ceevit', dose: '1 tablet', schedule: { type: 'interval', every: '6h', anchor: 'wake' }, min_gap: '5h', course: { days: 5 } },
  ],
};

async function setUp(): Promise<void> {
  const { AdminDb } = await import('../src/io/adminDb.js');
  const admin = new AdminDb(bot.d1 as never);
  const inv = await admin.createInvite('enrol', { createdBy: 'a', ttlMs: 86400_000 }, bot.now);
  await bot.send(P, `/start ${inv.code}`, { firstName: 'Ifti' });
  await bot.sendFile(P, 'p.json', JSON.stringify(RX));
  await bot.tap(P, /Apply|Confirm|Yes/i);
  const id = Number(bot.d1.one('SELECT id FROM patients')?.['id']);
  const care = await admin.createInvite('caregiver', { createdBy: 'a', ttlMs: 86400_000, patientId: id }, bot.now);
  await bot.send(C, `/caregiver ${care.code}`, { firstName: 'Ashraf' });
  await bot.send(P, '/awake');
  await bot.run(30 * MINUTE, 5 * MINUTE);
  await bot.tap(P, /Taken|✅/);
}

const med = (key: string): Record<string, unknown> =>
  bot.d1.one(`SELECT * FROM medications WHERE med_key='${key}'`)!;

describe('/restart', () => {
  it('starts the count again from today', async () => {
    await setUp();
    bot.now = at('10:00', 4);
    await bot.send(P, '/restart drops 7d');
    expect(med('drops')['started_at'], 'still counting from the old course').toBeNull();
    expect(Number(med('drops')['course_days'])).toBe(7);
    expect(Number(med('drops')['doses_taken']), 'the new course began part-used').toBe(0);
  });

  it('keeps the same length when none is given', async () => {
    await setUp();
    bot.now = at('10:00', 4);
    await bot.send(P, '/restart drops');
    expect(Number(med('drops')['course_days'])).toBe(7);
    expect(Number(med('drops')['doses_taken'])).toBe(0);
  });

  it('leaves every other medicine exactly as it was', async () => {
    await setUp();
    const before = med('tab');
    bot.now = at('10:00', 4);
    await bot.send(P, '/restart drops 7d');
    const after = med('tab');
    expect(after['started_at'], 'restarting one medicine disturbed another').toBe(before['started_at']);
    expect(after['doses_taken']).toBe(before['doses_taken']);
    expect(after['course_days']).toBe(before['course_days']);
    expect(after['status']).toBe(before['status']);
  });

  it('works on a medicine that has already finished', async () => {
    await setUp();
    bot.now = at('10:00', 8);
    await bot.run(20 * MINUTE, 5 * MINUTE);
    expect(String(med('drops')['status']), 'nothing finished, so this proves nothing').toBe('completed');
    await bot.send(P, '/restart drops 7d');
    expect(String(med('drops')['status'])).toBe('active');
    await bot.run(6 * HOUR, 10 * MINUTE);
    expect(bot.textsTo(P).join('\n'), 'restarted and stayed silent').toMatch(/Vigalon/);
  });

  it('works on one that was stopped by hand', async () => {
    await setUp();
    await bot.send(P, '/stop drops');
    await bot.send(P, '/restart drops 7d');
    expect(String(med('drops')['status'])).toBe('active');
    expect(Number(med('drops')['doses_taken'])).toBe(0);
  });

  it('keeps the old doses in the log', async () => {
    await setUp();
    const taken = bot.d1.rows("SELECT * FROM doses WHERE status='taken'").length;
    expect(taken, 'nothing was taken, so this proves nothing').toBeGreaterThan(0);
    await bot.send(P, '/restart drops 7d');
    expect(bot.d1.rows("SELECT * FROM doses WHERE status='taken'").length,
      'wiped the history along with the counters').toBe(taken);
  });

  it('will not let the new course start inside the minimum gap of the old one', async () => {
    // The counters reset; the overdose guard does not.
    await setUp();
    const lastTaken = Number(med('drops')['last_taken_at']);
    expect(lastTaken, 'nothing was taken, so this proves nothing').toBeGreaterThan(0);
    await bot.send(P, '/restart drops 7d');
    await bot.run(2 * HOUR, 5 * MINUTE);
    for (const d of bot.d1.rows("SELECT * FROM doses WHERE status IN ('scheduled','deferred','due','prompted')")) {
      expect(Number(d['effective_due_at']) - lastTaken, 'a dose inside the minimum gap')
        .toBeGreaterThanOrEqual(3 * HOUR);
    }
  });

  it('says what it did, in days from today', async () => {
    await setUp();
    bot.clear();
    await bot.send(P, '/restart drops 7d');
    expect(bot.last(P)).toMatch(/Day 1 of 7 days/);
  });

  it('tells the caregiver', async () => {
    await setUp();
    bot.clear();
    await bot.send(P, '/restart drops 7d');
    expect(bot.textsTo(C).join('\n')).toMatch(/Vigalon/);
  });

  it('leaves a record of what the old course had reached', async () => {
    await setUp();
    await bot.send(P, '/restart drops 7d');
    const rows = bot.d1.rows("SELECT * FROM audit_log WHERE kind='course_restarted'");
    expect(rows, 'restarted a course with nothing in the record').toHaveLength(1);
    expect(String(rows[0]!['detail_json'])).toMatch(/"dosesTaken":1/);
  });

  it('points at it when /add hits an id that already exists', async () => {
    await setUp();
    bot.clear();
    await bot.send(P, '/add {"id":"drops","name":"Vigalon","schedule":{"type":"interval","every":"4h"}}');
    expect(bot.last(P), 'refused without saying what to do instead').toMatch(/\/restart drops/);
  });

  it('lists the medicines when asked without one', async () => {
    await setUp();
    bot.clear();
    await bot.send(P, '/restart');
    expect(bot.last(P)).toMatch(/Vigalon/);
    expect(bot.last(P)).toMatch(/counters back to zero/i);
  });
});
