import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { World, makeChat, medsFromPrescription, mealDefsFromPrescription, TZ } from '../simulate.js';
import { parsePrescription } from '../../src/core/prescription.js';
import { HOUR, MINUTE, zoneFor } from '../../src/core/tz.js';

const z = zoneFor(TZ);
const at = (day: number, hhmm: string): number => z.wallOnDayUtc(z.addLocalDays('2026-09-14', day), hhmm);

/**
 * Driven by the same JSON a patient would actually import, so these assert the real
 * prescription's behaviour rather than a convenient approximation of it.
 */
const rx = parsePrescription(JSON.parse(readFileSync('examples/post-op-eye.json', 'utf8')), { now: at(0, '06:00') });

function newDay(opts: { start: number } = { start: at(0, '05:00') }): World {
  const w = new World({
    start: opts.start,
    patient: {
      morningPollAt: rx.value!.day.morningPollAt ?? '06:30',
      presumedWakeAt: rx.value!.day.presumedWakeAt ?? '09:00',
      eveningPollAt: rx.value!.day.eveningPollAt ?? '22:30',
      presumedSleepAt: rx.value!.day.presumedSleepAt ?? '01:00',
      wakeState: 'asleep',
      wakeStateSince: opts.start - 6 * HOUR,
    },
    meds: medsFromPrescription(rx.value!.meds),
    mealDefs: mealDefsFromPrescription(rx.value!.meals),
    chats: [makeChat({ chatId: 100 })],
  });
  w.respectSchedule = true;
  return w;
}

const localTime = (w: World, ms: number): string => w.z.fmtTime(ms);

describe('waking at noon', () => {
  it('starts the schedule at noon, not at some earlier assumed time', () => {
    const w = newDay();

    // Sleep through the morning, ignoring everything.
    w.run(7 * HOUR); // 05:00 -> 12:00

    // She surfaces at 12:00 and says so.
    w.now = at(0, '12:00');
    w.declare('wake');
    w.run(5 * MINUTE);

    expect(w.state.patient.lastWakeAt).toBe(at(0, '12:00'));

    // Every wake-anchored medicine must now hang off noon, not off the earlier
    // presumed-awake time. Nothing may be scheduled before she was actually up.
    for (const med of w.state.meds) {
      if (med.spec.anchor !== 'wake') continue;
      const live = w.state.liveDoses.find((d) => d.medId === med.id);
      expect(live, `${med.medKey} has no dose after waking`).toBeDefined();
      expect(
        live!.effectiveDueAt,
        `${med.medKey} is scheduled at ${localTime(w, live!.effectiveDueAt)}, before she got up`,
      ).toBeGreaterThanOrEqual(at(0, '12:00'));
    }
  });

  it('spaces the four-hourly medicine from noon onwards', () => {
    const w = newDay();
    w.run(7 * HOUR);
    w.now = at(0, '12:00');
    w.declare('wake');

    // Answer every prompt promptly for the rest of the day.
    const taken: number[] = [];
    for (let i = 0; i < 12 * 60; i++) {
      w.tick();
      const pending = w.state.liveDoses.find(
        (d) => (d.status === 'prompted' || d.status === 'due') && w.med('drop').id === d.medId,
      );
      if (pending !== undefined) {
        w.resolve(pending.id, 'taken');
        taken.push(w.now);
      }
      w.now += MINUTE;
    }

    expect(taken.length, 'the two-hourly drop never fired after waking at noon').toBeGreaterThanOrEqual(4);
    // First dose right after waking, then roughly every two hours.
    expect(taken[0]).toBeGreaterThanOrEqual(at(0, '12:00'));
    expect(taken[0]).toBeLessThanOrEqual(at(0, '12:10'));
    for (let i = 1; i < taken.length; i++) {
      const gap = taken[i]! - taken[i - 1]!;
      expect(gap, `two-hourly drop fired ${Math.round(gap / MINUTE)}min apart`).toBeGreaterThanOrEqual(110 * MINUTE);
      expect(gap).toBeLessThanOrEqual(150 * MINUTE);
    }
  });

  it('does not fire a morning backlog all at once when she wakes late', () => {
    const w = newDay();
    w.run(7 * HOUR);
    w.now = at(0, '12:00');
    w.declare('wake');
    w.run(30 * MINUTE);

    // Whatever is asked for in the first half hour must be spread, not dumped.
    const prompts = w.sent.filter((s) => s.kind === 'dose' && !s.nudge && s.at >= at(0, '12:00'));
    const instants = new Set(prompts.map((p) => p.at));
    // Drops belonging to a spacing group must never share an instant.
    for (const inst of instants) {
      const here = prompts.filter((p) => p.at === inst);
      const dropCount = here.filter((p) =>
        p.doseIds.some((id) => {
          const d = w.allDoses.find((x) => x.id === id);
          return d !== undefined && w.state.meds.find((m) => m.id === d.medId)?.spacingGroup !== null;
        }),
      ).length;
      expect(dropCount, `${dropCount} spaced drops asked for at the same moment`).toBeLessThanOrEqual(1);
    }
  });
});

describe('being a bit late', () => {
  it('absorbs a small delay without shifting the rest of the day', () => {
    const w = newDay({ start: at(0, '11:55') });
    w.now = at(0, '12:00');
    w.declare('wake');
    w.run(2 * MINUTE);

    const first = w.state.liveDoses.find((d) => d.medId === w.med('drop').id)!;
    const plannedFirst = first.plannedDueAt;

    // Answer 15 minutes late -- inside the half-hour tolerance.
    w.now = plannedFirst + 15 * MINUTE;
    w.tick();
    w.resolve(first.id, 'taken');
    w.run(MINUTE);

    const next = w.state.liveDoses.find((d) => d.medId === w.med('drop').id)!;
    // The grid holds: the next dose is a full interval after the PLANNED time, so a
    // quarter of an hour's lateness has not walked the whole day forwards.
    expect(next.plannedDueAt).toBe(plannedFirst + w.med('drop').intervalMs!);
  });

  it('re-bases on the real time when the delay is substantial', () => {
    const w = newDay({ start: at(0, '11:55') });
    w.now = at(0, '12:00');
    w.declare('wake');
    w.run(2 * MINUTE);

    const first = w.state.liveDoses.find((d) => d.medId === w.med('drop').id)!;
    const plannedFirst = first.plannedDueAt;

    // Two hours late -- a genuinely missed-then-taken dose.
    w.now = plannedFirst + 2 * HOUR;
    w.tick();
    const stillPending = w.state.liveDoses.find((d) => d.medId === w.med('drop').id);
    if (stillPending !== undefined) w.resolve(stillPending.id, 'taken');
    const actuallyTaken = w.now;
    w.run(MINUTE);

    const next = w.state.liveDoses.find((d) => d.medId === w.med('drop').id)!;
    // Counted from when she really took it, not from the abandoned slot.
    expect(next.effectiveDueAt).toBeGreaterThanOrEqual(actuallyTaken + w.med('drop').intervalMs! - MINUTE);
  });

  it('keeps nagging in between rather than going quiet', () => {
    const w = newDay({ start: at(0, '11:55') });
    w.now = at(0, '12:00');
    w.declare('wake');
    w.run(90 * MINUTE);

    const nudges = w.sent.filter((s) => s.nudge);
    expect(nudges.length, 'she was left alone after not answering').toBeGreaterThan(0);
    for (let i = 1; i < nudges.length; i++) {
      expect(nudges[i]!.at - nudges[i - 1]!.at).toBeLessThanOrEqual(35 * MINUTE);
    }
  });
});

describe('the questions it asks, beyond medicines', () => {
  it('asks whether she is awake in the morning', () => {
    const w = newDay();
    w.run(3 * HOUR); // 05:00 -> 08:00, past the 06:30 morning poll

    const wakeAsks = w.sent.filter((s) => s.kind === 'wake');
    expect(wakeAsks.length, 'never asked whether she was up').toBeGreaterThan(0);
    expect(wakeAsks[0]!.at).toBeGreaterThanOrEqual(at(0, '06:30'));
  });

  it('asks about meals relative to waking, not to the clock', () => {
    const early = newDay();
    early.now = at(0, '08:00');
    early.declare('wake');
    early.run(4 * HOUR);
    const earlyAsk = early.sent.find((s) => s.kind === 'meal');
    expect(earlyAsk, 'never asked about a meal').toBeDefined();

    const late = newDay();
    late.now = at(0, '12:00');
    late.declare('wake');
    late.run(4 * HOUR);
    const lateAsk = late.sent.find((s) => s.kind === 'meal');
    expect(lateAsk).toBeDefined();

    // Someone who got up at noon is not late for breakfast: the question follows the day
    // they are actually having, four hours later than the early riser's.
    expect(lateAsk!.at - earlyAsk!.at).toBeGreaterThanOrEqual(3 * HOUR);
    expect(earlyAsk!.at - at(0, '08:00')).toBeLessThanOrEqual(90 * MINUTE);
    expect(lateAsk!.at - at(0, '12:00')).toBeLessThanOrEqual(90 * MINUTE);
  });

  it('stops asking about a meal once she says she has eaten', () => {
    const w = newDay();
    w.now = at(0, '08:00');
    w.declare('wake');
    w.run(2 * HOUR); // past the 09:30 breakfast window

    const before = w.sent.filter((s) => s.kind === 'meal').length;
    expect(before).toBeGreaterThan(0);

    w.eat('breakfast');
    w.run(90 * MINUTE);

    const after = w.sent.filter((s) => s.kind === 'meal' && s.at > w.now - 90 * MINUTE);
    // Any further meal questions must be about a different meal, not breakfast again.
    for (const m of after) {
      const prompt = w.state.openPrompts.find((q) => q.id === m.promptId);
      if (prompt !== undefined) expect(prompt.body.meal).not.toBe('breakfast');
    }
  });

  it('asks whether she has gone to bed in the evening', () => {
    const w = newDay({ start: at(0, '21:00') });
    w.now = at(0, '21:00');
    w.declare('wake');
    w.run(3 * HOUR); // past the 22:30 evening poll

    const sleepAsks = w.sent.filter((s) => s.kind === 'sleep');
    expect(sleepAsks.length, 'never asked whether she had turned in').toBeGreaterThan(0);
    expect(sleepAsks[0]!.at).toBeGreaterThanOrEqual(at(0, '22:30'));
  });

  it('reminds about the before-meal tablet separately from the after-meal one', () => {
    const w = newDay({ start: at(0, '06:00') });
    w.now = at(0, '07:00');
    w.declare('wake');
    w.run(4 * HOUR);

    const stomach capsule = w.allDoses.filter((d) => d.medId === w.med('stomach capsule').id);
    const flexi = w.allDoses.filter((d) => d.medId === w.med('flexi').id);
    expect(stomach capsule.length, 'the before-meal tablet was never scheduled').toBeGreaterThan(0);
    expect(flexi.length, 'the after-meal tablet was never scheduled').toBeGreaterThan(0);
    // Before-meal comes first, and they are not the same moment.
    expect(stomach capsule[0]!.plannedDueAt).toBeLessThan(flexi[0]!.plannedDueAt);
  });
});

describe('a full day, end to end', () => {
  it('wakes at noon, doses all afternoon, asks about meals and bedtime, never goes silent', () => {
    const w = newDay();
    w.run(7 * HOUR);
    w.now = at(0, '12:00');
    w.declare('wake');

    // Answer everything within ten minutes, like a person doing their best.
    for (let i = 0; i < 13 * 60; i++) {
      w.tick();
      const pending = w.state.liveDoses.find((d) => d.status === 'prompted');
      if (pending !== undefined && w.now - (pending.firstPromptAt ?? w.now) >= 8 * MINUTE) {
        w.resolve(pending.id, 'taken');
      }
      if (w.now === at(0, '13:30')) w.eat('lunch');
      if (w.now === at(0, '20:30')) w.eat('dinner');
      w.now += MINUTE;
    }

    // Something was taken from every active medicine that could fire this afternoon.
    for (const key of ['drop', 'drop', 'drop']) {
      expect(w.takenTimes(key).length, `${key} was never taken after waking at noon`).toBeGreaterThan(0);
    }
    // Nothing scheduled before she was up.
    for (const d of w.allDoses) {
      if (d.status !== 'taken' || d.takenAt === null) continue;
      expect(d.takenAt, 'a dose was recorded before she woke').toBeGreaterThanOrEqual(at(0, '12:00'));
    }
    // And every medicine is still alive at the end of the day.
    for (const med of w.state.meds) {
      if (med.status !== 'active' || med.kind === 'as_needed') continue;
      expect(w.state.liveDoses.filter((d) => d.medId === med.id).length, `${med.medKey} went silent`).toBe(1);
    }
  });
});

describe('eye drops the moment she is up', () => {
  it('asks for the first drop within a minute of waking, not later', () => {
    const w = newDay();
    w.run(7 * HOUR);               // asleep all morning, answering nothing

    w.now = at(0, '12:00');
    w.declare('wake');
    w.run(3 * MINUTE);

    const firstDrop = w.sent.find(
      (s) => s.kind === 'dose' && s.at >= at(0, '12:00') &&
        s.doseIds.some((id) => {
          const d = w.allDoses.find((x) => x.id === id);
          const m = d === undefined ? undefined : w.state.meds.find((mm) => mm.id === d.medId);
          return m?.spacingGroup === 'eye_drops';
        }),
    );
    expect(firstDrop, 'no eye drop was asked for after waking').toBeDefined();
    expect(
      firstDrop!.at - at(0, '12:00'),
      'the first drop was not asked for promptly after waking',
    ).toBeLessThanOrEqual(MINUTE);
  });

  it('staggers the other two behind it rather than asking all at once', () => {
    const w = newDay();
    w.run(7 * HOUR);
    w.now = at(0, '12:00');
    w.declare('wake');
    w.run(5 * MINUTE);

    const drops = w.state.liveDoses
      .filter((d) => w.state.meds.find((m) => m.id === d.medId)?.spacingGroup === 'eye_drops')
      .map((d) => d.effectiveDueAt)
      .sort((a, b) => a - b);

    expect(drops.length).toBe(3);
    expect(drops[0]! - at(0, '12:00')).toBeLessThanOrEqual(MINUTE);
    for (let i = 1; i < drops.length; i++) {
      expect(drops[i]! - drops[i - 1]!).toBeGreaterThanOrEqual(10 * MINUTE);
    }
  });

  it('keeps nagging about the first drop if she ignores it', () => {
    const w = newDay();
    w.run(7 * HOUR);
    w.now = at(0, '12:00');
    w.declare('wake');
    w.run(75 * MINUTE);            // ignore everything

    const nudges = w.sent.filter((s) => s.nudge && s.at > at(0, '12:00'));
    expect(nudges.length, 'she was left alone after ignoring the first drop').toBeGreaterThanOrEqual(3);
    for (let i = 1; i < nudges.length; i++) {
      expect(nudges[i]!.at - nudges[i - 1]!.at).toBeLessThanOrEqual(31 * MINUTE);
    }
  });

  it('works the same on an ordinary morning, not just a late one', () => {
    const w = newDay({ start: at(0, '06:00') });
    w.now = at(0, '06:45');
    w.declare('wake');
    w.run(3 * MINUTE);

    const firstDrop = w.sent.find((s) => s.kind === 'dose' && s.at >= at(0, '06:45'));
    expect(firstDrop, 'nothing was asked for on waking').toBeDefined();
    expect(firstDrop!.at - at(0, '06:45')).toBeLessThanOrEqual(MINUTE);
  });
});

describe('the safety floor still applies on waking', () => {
  it('waits out the minimum gap if the last dose was very late the night before', () => {
    const w = newDay({ start: at(0, '02:00') });
    w.now = at(0, '02:00');
    w.declare('wake');
    w.run(2 * MINUTE);

    // A drop at 02:00, then straight back to sleep, up again at 04:00.
    const pending = w.state.liveDoses.find(
      (d) => w.state.meds.find((m) => m.id === d.medId)?.medKey === 'drop',
    );
    if (pending !== undefined) w.resolve(pending.id, 'taken');

    w.now = at(0, '02:05');
    w.declare('sleep');
    w.now = at(0, '04:00');
    w.declare('wake');
    w.run(5 * MINUTE);

    const next = w.state.liveDoses.find(
      (d) => w.state.meds.find((m) => m.id === d.medId)?.medKey === 'drop',
    );
    expect(next, 'the drop disappeared entirely').toBeDefined();
    // Waking does not override the minimum gap -- that is the one rule nothing may break.
    const minGap = w.med('drop').minGapMs;
    expect(
      next!.effectiveDueAt,
      'waking up was allowed to short-circuit the safety gap',
    ).toBeGreaterThanOrEqual(at(0, '02:00') + minGap);
  });
});
