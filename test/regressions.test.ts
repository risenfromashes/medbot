import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { Bot } from './harness/bot.js';
import { HOUR, MINUTE, zoneFor } from '../src/core/tz.js';
import { clampToBedtime } from '../src/core/planSchedule.js';
import { decodeCallback, encodeCallback } from '../src/core/callbackCodec.js';
import { resolveRetro } from '../src/core/retro.js';
import { makeMed } from './simulate.js';

/**
 * Defects found by review, each pinned so it cannot come back.
 *
 * Every one of these was reachable by an ordinary patient doing an ordinary thing, and
 * none was caught by the tests that existed at the time.
 */

const z = zoneFor('Asia/Dhaka');
const at = (hhmm: string, day = 0): number => z.wallOnDayUtc(z.addLocalDays('2026-09-14', day), hhmm);
const PATIENT = 5000;

const realFetch = globalThis.fetch;
let bot: Bot;
beforeEach(() => { bot = new Bot(at('08:00')); bot.install(); });
afterEach(() => { globalThis.fetch = realFetch; });

async function setUp(doc: unknown): Promise<number> {
  const { AdminDb } = await import('../src/io/adminDb.js');
  const admin = new AdminDb(bot.d1 as never);
  const inv = await admin.createInvite('enrol', { createdBy: 'a', ttlMs: 86400_000 }, bot.now);
  await bot.send(PATIENT, `/start ${inv.code}`, { firstName: 'Ifti' });
  await bot.sendFile(PATIENT, 'p.json', JSON.stringify(doc));
  await bot.tap(PATIENT, /Apply|Confirm|Yes/i);
  await bot.send(PATIENT, '/awake');
  return Number(bot.d1.one('SELECT id FROM patients')?.['id']);
}

describe('a tap is never overwritten by the tick that was about to give up', () => {
  it('leaves the answer, the cursor and the day’s counters alone', async () => {
    // The tick loads its snapshot a second before the patient answers, decides the dose is
    // past its catch-up grace, and writes 'missed' over the tap — erasing it from the
    // record and counting the same dose twice.
    await setUp({
      version: 1, timezone: 'Asia/Dhaka',
      day: { morning_poll_at: '06:30', presumed_wake_at: '09:00', evening_poll_at: '22:30', presumed_sleep_at: '23:00' },
      medicines: [{ id: 'drops', name: 'Drops', schedule: { type: 'interval', every: '2h', anchor: 'wake' }, course: { days: 7 } }],
    });
    await bot.run(10 * MINUTE, 5 * MINUTE);
    const live = bot.d1.one("SELECT id FROM doses WHERE status IN ('due','prompted')");
    expect(live).not.toBeNull();
    const id = Number(live!['id']);

    // The patient answers...
    await bot.sendCallback(PATIENT, encodeCallback({ a: 'take', doseId: id }));
    // ...and a stale tick tries to write it off.
    const { Db } = await import('../src/io/db.js');
    const db = new Db(bot.d1 as never);
    const state = await db.loadState(1, z.localDay(bot.now));
    await db.applyActions(state!, [
      { t: 'resolveDose', doseId: id, status: 'missed', at: bot.now, takenAt: null, byChat: null, src: 'auto' },
    ], bot.now);

    const dose = bot.d1.one(`SELECT status, taken_at FROM doses WHERE id = ${id}`)!;
    expect(dose['status'], 'the tick overwrote the patient’s answer').toBe('taken');
    expect(dose['taken_at']).not.toBeNull();
    const counters = bot.d1.one('SELECT taken, missed FROM day_counters')!;
    expect(Number(counters['taken']), 'the tap was counted more than once').toBe(1);
    expect(Number(counters['missed']), 'a dose was counted as both taken and missed').toBe(0);
    const med = bot.d1.one('SELECT doses_taken, doses_missed FROM medications')!;
    expect(Number(med['doses_taken'])).toBe(1);
    expect(Number(med['doses_missed'])).toBe(0);
  });
});

describe('a meal-anchored dose is not offered again a min-gap later', () => {
  it('gives a once-daily after-breakfast tablet exactly once', async () => {
    await setUp({
      version: 1, timezone: 'Asia/Dhaka',
      day: { morning_poll_at: '06:30', presumed_wake_at: '09:00', evening_poll_at: '22:30', presumed_sleep_at: '23:00' },
      meals: [{ id: 'breakfast', typical_local: '08:30' }],
      medicines: [{
        id: 'napa', name: 'Napa', dose: '1 tablet', min_gap: '30m',
        schedule: { type: 'meal', meals: ['breakfast'], relation: 'after' },
      }],
    });
    const { encodeCallback: enc } = await import('../src/core/callbackCodec.js');
    while (bot.now < at('14:00')) {
      await bot.tick();
      for (const r of bot.d1.rows("SELECT id FROM doses WHERE status IN ('due','prompted')")) {
        await bot.sendCallback(PATIENT, enc({ a: 'take', doseId: Number(r['id']) }));
      }
      bot.now += 5 * MINUTE;
    }
    const taken = bot.d1.rows("SELECT * FROM doses WHERE status='taken'");
    expect(taken.length, 'a once-daily tablet was taken repeatedly through the morning').toBe(1);
  });
});

describe('the daily cap is never undone', () => {
  it('stops at max_per_day however the evening is re-planned', async () => {
    await setUp({
      version: 1, timezone: 'Asia/Dhaka',
      day: { morning_poll_at: '06:30', presumed_wake_at: '09:00', evening_poll_at: '22:30', presumed_sleep_at: '23:00' },
      medicines: [{
        id: 'prn', name: 'Painkiller', dose: '1 tablet', max_per_day: 3,
        schedule: { type: 'interval', every: '2h', anchor: 'wake' },
      }],
    });
    const { encodeCallback: enc } = await import('../src/core/callbackCodec.js');
    while (bot.now < at('22:30')) {
      await bot.tick();
      for (const r of bot.d1.rows("SELECT id FROM doses WHERE status IN ('due','prompted')")) {
        await bot.sendCallback(PATIENT, enc({ a: 'take', doseId: Number(r['id']) }));
      }
      bot.now += 5 * MINUTE;
    }
    const taken = bot.d1.rows("SELECT * FROM doses WHERE status='taken' AND local_day='2026-09-14'");
    expect(taken.length, `took ${taken.length} against a cap of 3`).toBeLessThanOrEqual(3);
  });
});

describe('the bedtime clamp', () => {
  const med = (over: Record<string, unknown> = {}): never => ({
    ...makeMed({ id: 1, medKey: 'm' }), awakeOnly: true, critical: false, minGapMs: 3 * HOUR,
    lastTakenAt: at('22:00'), lastCycleStartAt: at('22:00'),
    spec: { kind: 'interval', intervalMs: 4 * HOUR, anchor: 'wake', dosesPerDay: 4 },
    ...over,
  }) as never;
  const facts = (over: Record<string, unknown> = {}): never => ({
    awake: true, sleepFrom: at('23:00'), wakeNext: at('06:30', 1), postBedGraceMs: HOUR,
    dosesSinceWake: new Map([[1, 4]]), wakeAnchor: at('08:00'), localDay: '2026-09-14', meals: new Map(),
    ...over,
  }) as never;

  it('never drags a dose that is already before bedtime backwards', () => {
    // This collapsed three drops ten minutes apart onto one instant — the single thing a
    // spacing group exists to prevent.
    const unquota = { spec: { kind: 'interval', intervalMs: 2 * HOUR, anchor: 'wake' } };
    for (const t of ['22:20', '22:30', '22:40', '22:59']) {
      expect(clampToBedtime(med(unquota), at(t), facts(), at('22:10')), `moved the dose at ${t}`).toBe(at(t));
    }
  });

  it('sends a dose past a met daily count to tomorrow', () => {
    expect(clampToBedtime(med(), at('23:00'), facts(), at('22:10'))).toBe(at('06:30', 1));
    expect(clampToBedtime(med(), at('02:40', 1), facts(), at('22:10'))).toBe(at('06:30', 1));
  });

  it('never lands a dose in the small hours, whatever the gap allows', () => {
    const owed = facts({ dosesSinceWake: new Map([[1, 3]]) });
    const got = clampToBedtime(med(), at('23:10'), owed, at('22:10'));
    const smallHours = got > at('00:30', 1) && got < at('06:00', 1);
    expect(smallHours, `landed at ${z.fmtTime(got)}`).toBe(false);
  });
});

describe('the retrospective guards', () => {
  it('questions a stated time too close to a dose recorded AFTER it', () => {
    // The check only looked backwards, so "/took drops 5pm" after a 6pm dose was already
    // recorded went through without a word — two doses an hour apart.
    const m = { ...makeMed({ id: 1, medKey: 'm' }), minGapMs: 3 * HOUR };
    const out = resolveRetro({
      med: m as never,
      live: null,
      recent: [{ id: 1, medId: 1, status: 'taken', takenAt: at('18:00'), step: 0, plannedDueAt: at('18:00') } as never],
      statedAt: at('17:00'),
      now: at('19:00'),
    });
    expect(out.kind).not.toBe('reject');
    expect(
      out.kind === 'reject' ? null : out.warning,
      'two doses an hour apart, recorded without a word',
    ).toBe('min_gap');
  });

  it('opens the menu instead of inventing a time half an hour ago', () => {
    // The "🕐 Taken earlier…" button and the menu's own "30 min ago" choice encoded
    // identically, so the first tap silently logged a dose 30 minutes in the past.
    const open = encodeCallback({ a: 'earlierMenu', doseId: 7 });
    const choice = encodeCallback({ a: 'earlier', doseId: 7, minutesAgo: 30 });
    expect(open).not.toBe(choice);
    expect(decodeCallback(open)).toEqual({ a: 'earlierMenu', doseId: 7 });
    expect(decodeCallback(choice)).toEqual({ a: 'earlier', doseId: 7, minutesAgo: 30 });
  });
});

describe('meals belong to the waking day, and "after food" waits for food', () => {
  const MEALY = {
    version: 1, timezone: 'Asia/Dhaka',
    day: { morning_poll_at: '06:30', presumed_wake_at: '09:00', evening_poll_at: '22:30', presumed_sleep_at: '02:00' },
    meals: [{ id: 'breakfast', typical_local: '08:30' }, { id: 'dinner', typical_local: '20:30' }],
    medicines: [{
      id: 'flexi', name: 'Flexi', dose: '1 tablet',
      schedule: { type: 'meal', meals: ['breakfast', 'dinner'], relation: 'after' }, course: { days: 7 },
    }],
  };

  it('does not carry last night’s dinner into a new day', async () => {
    // Confirmed after midnight, so the calendar day had rolled: the meal was written
    // against tomorrow, and the next morning the bot found dinner already eaten, asked
    // nothing all day, and had an after-dinner tablet overdue before breakfast.
    await setUp(MEALY);
    bot.now = at('00:20', 1); // still up, past midnight
    await bot.send(PATIENT, '/ate dinner');
    const written = bot.d1.one("SELECT local_day FROM meal_events WHERE meal='dinner'")!;
    expect(written['local_day'], 'dinner was filed under the next day').toBe('2026-09-14');

    // Now sleep, and get up on the 15th: the meals start again from nothing.
    await bot.send(PATIENT, '/sleep');
    await bot.tap(PATIENT, /Leave them|I took them/i).catch(() => undefined);
    bot.now = at('11:04', 1);
    await bot.send(PATIENT, '/awake');
    await bot.run(20 * MINUTE, 5 * MINUTE);
    bot.clear();
    await bot.send(PATIENT, '/status');
    const status = bot.textsTo(PATIENT).join('\n');
    expect(status, "showed yesterday's meals as today's").not.toMatch(/✅ dinner/);
  });

  it('does not ask for an after-food tablet before there has been food', async () => {
    await setUp(MEALY);
    await bot.run(90 * MINUTE, 5 * MINUTE);
    const asked = bot.textsTo(PATIENT).some((t) => /Time for <b>Flexi/.test(t));
    expect(asked, 'asked for an after-breakfast tablet before breakfast').toBe(false);
    // The medicine is not lost, though: it still has a dose waiting.
    expect(bot.d1.rows("SELECT * FROM doses WHERE status IN ('scheduled','due','prompted')").length)
      .toBeGreaterThan(0);
  });

  it('releases it the moment the meal is confirmed', async () => {
    await setUp(MEALY);
    await bot.run(60 * MINUTE, 5 * MINUTE);
    await bot.send(PATIENT, '/ate breakfast');
    await bot.run(15 * MINUTE, 5 * MINUTE);
    expect(
      bot.textsTo(PATIENT).some((t) => /Time for <b>Flexi/.test(t)),
      'the tablet stayed locked away after the meal was confirmed',
    ).toBe(true);
  });

  it('releases it anyway if the meal is never answered', async () => {
    // The wait has to be bounded, or a patient who ignores meal questions never gets the
    // tablet at all.
    await setUp(MEALY);
    await bot.run(5 * HOUR, 10 * MINUTE);
    expect(
      bot.textsTo(PATIENT).some((t) => /Time for <b>Flexi/.test(t)),
      'the tablet was never released, though the meal was presumed hours ago',
    ).toBe(true);
  });

  it('never carries an unanswered meal dose off to tomorrow', async () => {
    await setUp(MEALY);
    await bot.run(3 * HOUR, 10 * MINUTE);
    const live = bot.d1.one("SELECT effective_due_at FROM doses WHERE status IN ('scheduled','due','prompted')");
    if (live !== null) {
      expect(Number(live['effective_due_at']), 'the dose was quietly moved to tomorrow')
        .toBeLessThan(at('00:00', 1));
    }
  });
});
