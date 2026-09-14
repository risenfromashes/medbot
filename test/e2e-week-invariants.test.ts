import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { Bot } from './harness/bot.js';
import { MINUTE, zoneFor } from '../src/core/tz.js';

/**
 * A fortnight through the real stack, checked against the rules the system claims.
 *
 * The simulator asserts invariants against `plan()`. This asserts them against the
 * database: the SQL, the handlers, the rendering. Every bug that reached a real person
 * lived in that gap.
 */

const z = zoneFor('Asia/Dhaka');
const at = (hhmm: string, day = 0): number => z.wallOnDayUtc(z.addLocalDays('2026-09-14', day), hhmm);
const PATIENT = 5000;
const CARER = 6000;

const realFetch = globalThis.fetch;
let bot: Bot;

beforeEach(() => { bot = new Bot(at('08:00')); bot.install(); });
afterEach(() => { globalThis.fetch = realFetch; });

const PRESCRIPTION = {
  version: 1,
  timezone: 'Asia/Dhaka',
  day: { morning_poll_at: '06:30', presumed_wake_at: '09:00', evening_poll_at: '22:30', presumed_sleep_at: '23:30' },
  meals: [
    { id: 'breakfast', typical_local: '08:30' },
    { id: 'lunch', typical_local: '13:30' },
    { id: 'dinner', typical_local: '20:30' },
  ],
  groups: [{ id: 'drops', spacing: '10m' }],
  medicines: [
    { id: 'moxi', name: 'Moxifloxacin', dose: '1 drop', schedule: { type: 'interval', every: '2h', anchor: 'wake' }, group: 'drops', group_seq: 1, course: { days: 10 } },
    { id: 'pred', name: 'Prednisolone', dose: '1 drop', schedule: { type: 'times_per_day', n: 4 }, group: 'drops', group_seq: 2, course: { days: 10 } },
    { id: 'taper', name: 'Tapering drop', dose: '1 drop', phases: [
      { schedule: { type: 'times_per_day', n: 4 }, days: 4, label: '4 a day' },
      { schedule: { type: 'times_per_day', n: 2 }, days: 4, label: '2 a day' },
    ] },
    { id: 'omep', name: 'Omeprazole', dose: '1 capsule', pattern: '1+0+1', relation: 'before', course: { days: 10 } },
    { id: 'night', name: 'Night tablet', dose: '1 tablet', schedule: { type: 'interval', every: '8h' }, awake_only: false, course: { days: 10 } },
  ],
};

async function household(): Promise<number> {
  const { AdminDb } = await import('../src/io/adminDb.js');
  const admin = new AdminDb(bot.d1 as never);
  const inv = await admin.createInvite('enrol', { createdBy: 'a', ttlMs: 86400_000 }, bot.now);
  await bot.send(PATIENT, `/start ${inv.code}`, { firstName: 'Ifti' });
  await bot.sendFile(PATIENT, 'p.json', JSON.stringify(PRESCRIPTION));
  await bot.tap(PATIENT, /Apply|Confirm|Yes/i);
  const id = Number(bot.d1.one('SELECT id FROM patients')?.['id']);
  const care = await admin.createInvite('caregiver', { createdBy: 'a', ttlMs: 86400_000, patientId: id }, bot.now);
  await bot.send(CARER, `/caregiver ${care.code}`, { firstName: 'Ashrafur' });
  return id;
}

interface Breach { at: string; what: string }

/** Run days, answering most things, and check the invariants after every tick. */
async function liveDays(days: number, answer: (i: number) => boolean): Promise<Breach[]> {
  const breaches: Breach[] = [];
  const { encodeCallback } = await import('../src/core/callbackCodec.js');
  let i = 0;

  const check = (): void => {
    const stamp = `${z.localDay(bot.now)} ${z.fmtTime12(bot.now)}`;
    const note = (what: string): void => {
      if (!breaches.some((b) => b.what === what)) breaches.push({ at: stamp, what });
    };

    // I1/I3 — at most one live dose per medicine, and every active one has something live
    // or a reason not to.
    for (const m of bot.d1.rows("SELECT id, name, status FROM medications")) {
      const live = bot.d1.rows(
        `SELECT * FROM doses WHERE med_id = ${Number(m['id'])}
           AND status IN ('scheduled','deferred','due','prompted')`,
      );
      if (live.length > 1) note(`${String(m['name'])} has ${live.length} live doses`);
      if (m['status'] === 'active' && live.length === 0) note(`${String(m['name'])} is active with nothing live`);
    }

    // I2 — no two doses of one medicine closer together than its minimum gap.
    for (const m of bot.d1.rows('SELECT id, name, min_gap_ms FROM medications')) {
      const taken = bot.d1.rows(
        `SELECT taken_at FROM doses WHERE med_id = ${Number(m['id'])} AND status = 'taken'
           AND step = 0 ORDER BY taken_at`,
      ).map((r) => Number(r['taken_at']));
      for (let k = 1; k < taken.length; k++) {
        if (taken[k]! - taken[k - 1]! < Number(m['min_gap_ms']) - MINUTE) {
          note(`${String(m['name'])} doses ${Math.round((taken[k]! - taken[k - 1]!) / MINUTE)}min apart, under its gap`);
        }
      }
    }

    // I5 — nothing asks a sleeping patient for a medicine that is confined to waking
    // hours, once the grace hour after bedtime is out.
    const p = bot.d1.one('SELECT wake_state, wake_state_since, post_bed_grace_ms FROM patients')!;
    if (p['wake_state'] === 'asleep' && bot.now >= Number(p['wake_state_since']) + Number(p['post_bed_grace_ms'])) {
      for (const m of bot.sent.filter((x) => x.at === bot.now && /💊/.test(x.text))) {
        const roundClock = /Night tablet/.test(m.text);
        if (!roundClock) note(`asked for a daytime medicine while asleep: ${m.text.slice(0, 40)}`);
      }
    }

    // No dose is ever left sitting in the small hours for an awake-only medicine.
    for (const d of bot.d1.rows(
      `SELECT d.effective_due_at, m.name, m.awake_only FROM doses d JOIN medications m ON m.id = d.med_id
        WHERE d.status IN ('scheduled','deferred','due','prompted') AND m.awake_only = 1`,
    )) {
      const hhmm = z.fmtTime(Number(d['effective_due_at']));
      const hour = Number(hhmm.slice(0, 2));
      if (hour >= 1 && hour < 6) {
        const pr = bot.d1.one('SELECT wake_state, expected_sleep_at, next_action_at FROM patients')!;
        note(`${String(d['name'])} sits at ${hhmm} | ${String(pr['wake_state'])} bed=${pr['expected_sleep_at'] ? z.fmtTime(Number(pr['expected_sleep_at'])) : '-'} next=${pr['next_action_at'] ? z.fmtTime(Number(pr['next_action_at'])) : '-'}`);
      }
    }

    const errors = bot.d1.rows("SELECT kind, detail_json FROM audit_log WHERE kind LIKE '%error%'");
    if (errors.length > 0) note(`threw: ${String(errors[0]!['detail_json']).slice(0, 90)}`);
  };

  for (let day = 0; day < days; day++) {
    // Up somewhere between eight and ten, told to the bot.
    bot.now = at(['08:00', '09:30', '07:15', '10:00'][day % 4]!, day);
    await bot.send(PATIENT, '/awake');
    const bed = at(day % 3 === 0 ? '23:00' : '22:30', day);
    while (bot.now < bed) {
      await bot.tick();
      check();
      for (const r of bot.d1.rows("SELECT id FROM doses WHERE status IN ('due','prompted')")) {
        if (answer(i++)) await bot.sendCallback(PATIENT, encodeCallback({ a: 'take', doseId: Number(r['id']) }));
      }
      for (const meal of ['breakfast', 'lunch', 'dinner']) {
        const want = { breakfast: '09:30', lunch: '14:00', dinner: '20:45' }[meal]!;
        if (bot.now >= at(want, day) && bot.now < at(want, day) + 10 * MINUTE) {
          await bot.send(PATIENT, `/ate ${meal}`);
        }
      }
      bot.now += 10 * MINUTE;
    }
    await bot.send(PATIENT, '/sleep');
    await bot.tap(PATIENT, /Leave them|I took them/i).catch(() => undefined);
    while (bot.now < at('06:00', day + 1)) {
      await bot.tick();
      check();
      bot.now += 20 * MINUTE;
    }
  }
  return breaches;
}

describe('a fortnight against the rules it claims', () => {
  it('holds every invariant for a diligent patient', async () => {
    await household();
    const breaches = await liveDays(8, () => true);
    expect(breaches, breaches.map((b) => `${b.at}: ${b.what}`).join('\n')).toEqual([]);
  }, 60_000);

  it('holds them for one who answers about half the time', async () => {
    await household();
    const breaches = await liveDays(6, (i) => i % 2 === 0);
    expect(breaches, breaches.map((b) => `${b.at}: ${b.what}`).join('\n')).toEqual([]);
  }, 60_000);

  it('holds them for one who answers nothing at all', async () => {
    await household();
    const breaches = await liveDays(4, () => false);
    expect(breaches, breaches.map((b) => `${b.at}: ${b.what}`).join('\n')).toEqual([]);
  }, 60_000);
});
