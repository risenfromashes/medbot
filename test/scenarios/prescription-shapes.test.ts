import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { World, makeChat, makeMed, TZ } from '../simulate.js';
import { parsePrescription, describeSchedule } from '../../src/core/prescription.js';
import { activePhase } from '../../src/core/planSchedule.js';
import { HOUR, MINUTE, zoneFor } from '../../src/core/tz.js';

const z = zoneFor(TZ);
const at = (day: number, hhmm: string): number => z.wallOnDayUtc(z.addLocalDays('2026-09-14', day), hhmm);

/**
 * A prescription exercising every shape of the format. Every assertion here is one the original
 * design got wrong, found by transcribing an actual piece of paper rather than an
 * imagined one.
 */
const doc = JSON.parse(readFileSync('examples/example.json', 'utf8'));
const parsed = parsePrescription(doc, { now: at(0, '12:00') });

describe('parsing the real prescription', () => {
  it('parses without errors', () => {
    expect(parsed.errors).toEqual([]);
  });

  it('leaves each drop on the frequency the doctor actually wrote', () => {
    const by = new Map(parsed.value!.meds.map((m) => [m.medKey, m]));
    // The lubricant is two-hourly and indefinite; folding it into a group would have
    // rewritten it to four times a day for fourteen days.
    expect(by.get('lubricant_drop')!.intervalMs).toBe(2 * HOUR);
    expect(by.get('lubricant_drop')!.courseKind).toBe('indefinite');
    expect(by.get('antibiotic_drop')!.courseDays).toBe(14);
    // Four times a day, spread from whenever she actually gets up.
    expect(by.get('antibiotic_drop')!.spec.anchor).toBe('wake');
    expect(describeSchedule(by.get('antibiotic_drop')!)).toContain('from waking');
  });

  it('keeps all three drops ten minutes apart from each other', () => {
    const drops = parsed.value!.meds.filter((m) => m.spacingGroup === 'drops');
    expect(drops.map((d) => d.medKey).sort()).toEqual(['antibiotic_drop', 'lubricant_drop', 'steroid_drop']);
    for (const d of drops) {
      expect(d.spacingMs).toBe(10 * MINUTE);
      expect(d.mergeable, 'a spaced drop must never share a message').toBe(false);
    }
  });

  it('understands the taper: 4x a day for a week, then 3x for a week', () => {
    const steroid_drop = parsed.value!.meds.find((m) => m.medKey === 'steroid_drop')!;
    expect(steroid_drop.phases).not.toBeNull();
    expect(steroid_drop.phases!.length).toBe(2);
    expect(steroid_drop.phases![0]!.days).toBe(7);
    expect(steroid_drop.phases![1]!.days).toBe(7);
    // Four doses a day in the first phase, three in the second -- so the gap widens.
    expect(steroid_drop.phases![0]!.intervalMs).toBeLessThan(steroid_drop.phases![1]!.intervalMs!);
    expect(steroid_drop.phases![0]!.spec.anchor).toBe('wake');
    // The whole course is fourteen days, not seven.
    expect(steroid_drop.courseDays).toBe(14);
  });

  it('keeps "before meal" and "after meal" genuinely different, and tied to the meals', () => {
    const by = new Map(parsed.value!.meds.map((m) => [m.medKey, m]));
    const before = by.get('stomach_capsule')!.spec.meals!;
    const after = by.get('anti_inflammatory')!.spec.meals!;

    // Both follow breakfast and dinner rather than clock times standing in for them.
    expect(before.map((r) => r.meal)).toEqual(['breakfast', 'dinner']);
    expect(after.map((r) => r.meal)).toEqual(['breakfast', 'dinner']);

    // stomach_capsule is a proton-pump inhibitor: half an hour before food actually matters.
    expect(before.every((r) => r.relation === 'before' && r.offsetMs === 30 * MINUTE)).toBe(true);
    // anti_inflammatory just needs food; inventing a delay would be its own kind of wrong.
    expect(after.every((r) => r.relation === 'after' && r.offsetMs === 0)).toBe(true);
  });
});

describe('the taper in motion', () => {
  const steroid_drop = parsed.value!.meds.find((m) => m.medKey === 'steroid_drop')!;
  const med = makeMed({
    id: 1, medKey: 'steroid_drop', kind: steroid_drop.kind, spec: steroid_drop.spec,
    intervalMs: steroid_drop.intervalMs, phases: steroid_drop.phases, courseKind: 'days',
    courseDays: steroid_drop.courseDays, startedAt: at(0, '08:00'),
  });

  it('is in the four-a-day phase on day one', () => {
    const p = activePhase(med, z, z.localDay(at(0, '12:00')));
    expect(p.index).toBe(0);
    expect(p.phase!.intervalMs).toBe(steroid_drop.phases![0]!.intervalMs);
  });

  it('is still in the first phase on day seven', () => {
    expect(activePhase(med, z, z.localDay(at(6, '12:00'))).index).toBe(0);
  });

  it('steps down to three a day on day eight', () => {
    const p = activePhase(med, z, z.localDay(at(7, '12:00')));
    expect(p.index).toBe(1);
    // The step-down means a longer gap between doses.
    expect(p.phase!.intervalMs!).toBeGreaterThan(steroid_drop.phases![0]!.intervalMs!);
  });

  it('is finished after fourteen days', () => {
    expect(activePhase(med, z, z.localDay(at(14, '12:00'))).done).toBe(true);
  });

  it('tells the patient when the dose steps down', () => {
    const w = new World({
      start: at(7, '08:00'),
      patient: {
        wakeState: 'awake', wakeConfidence: 'confirmed', wakeStateSince: at(7, '07:00'),
        lastWakeAt: at(7, '07:00'), presumedSleepAt: '23:59', eveningPollAt: '23:50',
      },
      meds: [{ ...med, phaseIndex: 0 }],
      chats: [makeChat({ chatId: 100 })],
    });
    const actions = w.tick();
    expect(actions.some((a) => a.t === 'advancePhase')).toBe(true);
    expect(
      actions.some((a) => a.t === 'sendInfo' && a.text.includes('steps down')),
      'the patient was never told the dose had stepped down',
    ).toBe(true);
  });
});

describe('three differently-scheduled drops, ten minutes apart', () => {
  function world(start: number): World {
    return new World({
      start,
      patient: {
        wakeState: 'awake', wakeConfidence: 'confirmed', wakeStateSince: at(0, '07:00'),
        lastWakeAt: at(0, '07:00'), presumedSleepAt: '23:59', eveningPollAt: '23:50',
      },
      meds: [
        makeMed({ id: 1, medKey: 'antibiotic_drop', kind: 'fixed_times', intervalMs: null, minGapMs: 3 * HOUR,
          spec: { kind: 'fixed_times', times: ['08:00', '12:40', '17:20', '22:00'] },
          spacingGroup: 'drops', spacingMs: 10 * MINUTE, mergeable: false }),
        makeMed({ id: 2, medKey: 'steroid_drop', kind: 'fixed_times', intervalMs: null, minGapMs: 3 * HOUR,
          spec: { kind: 'fixed_times', times: ['08:00', '12:40', '17:20', '22:00'] },
          spacingGroup: 'drops', spacingMs: 10 * MINUTE, mergeable: false }),
        makeMed({ id: 3, medKey: 'lubricant_drop', intervalMs: 2 * HOUR, minGapMs: 90 * MINUTE,
          spec: { kind: 'interval', intervalMs: 2 * HOUR, anchor: 'wake' },
          spacingGroup: 'drops', spacingMs: 10 * MINUTE, mergeable: false }),
      ],
      chats: [makeChat({ chatId: 100 })],
    });
  }

  it('staggers three drops that all fall due at once', () => {
    const w = world(at(0, '07:55'));
    w.run(10 * MINUTE);

    const due = w.state.liveDoses.map((d) => d.effectiveDueAt).sort((a, b) => a - b);
    expect(due.length).toBe(3);
    // No two of them within ten minutes of each other.
    for (let i = 1; i < due.length; i++) {
      expect(due[i]! - due[i - 1]!, 'two drops scheduled less than ten minutes apart').toBeGreaterThanOrEqual(10 * MINUTE);
    }
  });

  it('never prompts two drops at the same moment', () => {
    const w = world(at(0, '07:00'));
    w.respectSchedule = true;
    w.run(14 * HOUR);

    const dropMessages = w.sent.filter((s) => s.kind === 'dose' && !s.nudge);
    const byInstant = new Map<number, number>();
    for (const m of dropMessages) byInstant.set(m.at, (byInstant.get(m.at) ?? 0) + 1);
    for (const [instant, n] of byInstant) {
      expect(n, `${n} drops prompted at the same instant (${new Date(instant).toISOString()})`).toBe(1);
    }
  });

  it('measures the gap from the drop actually put in, not from the plan', () => {
    const w = world(at(0, '07:59'));
    w.run(2 * MINUTE);

    const first = w.state.liveDoses.find((d) => d.status === 'prompted');
    expect(first).toBeDefined();

    // Take the first one several minutes late.
    w.now = at(0, '08:07');
    w.resolve(first!.id, 'taken');
    w.run(2 * MINUTE);

    // Everything still pending must now sit at least ten minutes after 08:07.
    for (const d of w.state.liveDoses) {
      if (d.medId === w.med('antibiotic_drop').id && d.status === 'taken') continue;
      expect(d.effectiveDueAt, 'a drop was scheduled within ten minutes of the last one').toBeGreaterThanOrEqual(at(0, '08:17'));
    }
  });

  it('keeps the two-hourly lubricant two-hourly, not four times a day', () => {
    const w = world(at(0, '07:00'));
    w.respectSchedule = true;

    for (let i = 0; i < 15 * 60; i++) {
      w.tick();
      const pending = w.state.liveDoses.find((d) => d.status === 'prompted');
      if (pending !== undefined) w.resolve(pending.id, 'taken');
      w.now += MINUTE;
    }

    // From 07:00 to 22:00 at two-hourly, that is about seven or eight doses.
    const lubricant = w.takenTimes('lubricant_drop').length;
    expect(lubricant, `lubricant only dosed ${lubricant} times in 15 hours`).toBeGreaterThanOrEqual(5);
    // While the four-times-a-day drop stays at four.
    expect(w.takenTimes('antibiotic_drop').length).toBeLessThanOrEqual(5);
  });
});

describe('taking a dose before the bot asks', () => {
  const med = makeMed({ id: 1, medKey: 'drop_a', intervalMs: 4 * HOUR, minGapMs: 3 * HOUR });

  it('resolves the pending dose and re-bases from the real time', async () => {
    const { resolveRetro } = await import('../../src/core/retro.js');
    // Dose is not due until 19:00; she put the drop in at 18:00 because she was up.
    const live = { id: 5, status: 'scheduled', effectiveDueAt: at(0, '19:00'), plannedDueAt: at(0, '19:00') } as never;
    const r = resolveRetro({ med, live, recent: [], statedAt: at(0, '18:00'), now: at(0, '18:02') });
    expect(r.kind).toBe('resolve_live');
    if (r.kind === 'resolve_live') expect(r.takenAt).toBe(at(0, '18:00'));
  });

  it('accepts it even hours early, as long as the safety gap holds', async () => {
    const { resolveRetro } = await import('../../src/core/retro.js');
    const prior = { id: 4, status: 'taken', takenAt: at(0, '10:00'), step: 0, plannedDueAt: at(0, '10:00') } as never;
    const live = { id: 5, status: 'scheduled', effectiveDueAt: at(0, '19:00'), plannedDueAt: at(0, '19:00') } as never;
    const r = resolveRetro({ med, live, recent: [prior], statedAt: at(0, '15:00'), now: at(0, '15:01') });
    expect(r.kind).toBe('resolve_live');
    if (r.kind === 'resolve_live') expect(r.warning).toBeUndefined();
  });

  it('still flags one taken too soon after the last', async () => {
    const { resolveRetro } = await import('../../src/core/retro.js');
    const prior = { id: 4, status: 'taken', takenAt: at(0, '17:00'), step: 0, plannedDueAt: at(0, '17:00') } as never;
    const live = { id: 5, status: 'scheduled', effectiveDueAt: at(0, '21:00'), plannedDueAt: at(0, '21:00') } as never;
    const r = resolveRetro({ med, live, recent: [prior], statedAt: at(0, '18:00'), now: at(0, '18:01') });
    // An hour after a dose with a three-hour floor: recorded, because she says it happened,
    // but flagged so nobody doubles up on the strength of it.
    expect(r.kind).toBe('resolve_live');
    if (r.kind === 'resolve_live') expect(r.warning).toBe('min_gap');
  });

  it('the whole chain moves when a dose is taken early', () => {
    const w = new World({
      start: at(0, '08:00'),
      patient: {
        wakeState: 'awake', wakeConfidence: 'confirmed', wakeStateSince: at(0, '07:00'),
        lastWakeAt: at(0, '07:00'), presumedSleepAt: '23:59', eveningPollAt: '23:50',
      },
      meds: [makeMed({ id: 1, medKey: 'drop_a', intervalMs: 4 * HOUR, minGapMs: 3 * HOUR, driftPolicy: 'strict_actual' })],
      chats: [makeChat({ chatId: 100 })],
    });

    w.tick();
    w.take('drop_a');                      // first dose at 08:00
    w.run(2 * HOUR);                     // next is due 12:00

    const pending = w.state.liveDoses[0]!;
    expect(pending.effectiveDueAt).toBe(at(0, '12:00'));

    // She takes it at 11:00, an hour early, before being asked.
    w.now = at(0, '11:00');
    w.resolve(pending.id, 'taken');
    w.run(MINUTE);

    // The next dose follows the real time, not the abandoned 12:00 slot.
    expect(w.state.liveDoses[0]!.effectiveDueAt).toBe(at(0, '15:00'));
  });
});

describe('the order drops are asked for', () => {
  function dropWorld(): World {
    return new World({
      start: at(0, '07:59'),
      patient: {
        wakeState: 'awake', wakeConfidence: 'confirmed', wakeStateSince: at(0, '07:00'),
        lastWakeAt: at(0, '07:00'), presumedSleepAt: '23:59', eveningPollAt: '23:50',
      },
      meds: [
        // Declared out of order on purpose, and the tapering one listed first.
        makeMed({ id: 1, medKey: 'tapering', name: 'Tapering drop', kind: 'fixed_times', intervalMs: null,
          spec: { kind: 'fixed_times', times: ['08:00'] }, minGapMs: 3 * HOUR,
          spacingGroup: 'drops', spacingMs: 10 * MINUTE, mergeable: false,
          phases: [
            { spec: { kind: 'fixed_times', times: ['08:00'] }, intervalMs: null, days: 7, label: 'a' },
            { spec: { kind: 'fixed_times', times: ['08:00'] }, intervalMs: null, days: 7, label: 'b' },
          ] }),
        makeMed({ id: 2, medKey: 'steady', name: 'Steady drop', kind: 'fixed_times', intervalMs: null,
          spec: { kind: 'fixed_times', times: ['08:00'] }, minGapMs: 3 * HOUR,
          spacingGroup: 'drops', spacingMs: 10 * MINUTE, mergeable: false }),
      ],
      chats: [makeChat({ chatId: 100 })],
    });
  }

  it('puts the plain drop before the tapering one when both fall due together', () => {
    const w = dropWorld();
    w.run(5 * MINUTE);

    const byMed = new Map(w.state.liveDoses.map((d) => [d.medId, d.effectiveDueAt]));
    const steady = byMed.get(2)!;
    const tapering = byMed.get(1)!;
    // The part of the routine that never changes stays put; the taper moves around it.
    expect(steady, 'the tapering drop was asked for first').toBeLessThan(tapering);
    expect(tapering - steady).toBeGreaterThanOrEqual(10 * MINUTE);
  });

  it('honours an explicit order from the prescription over that default', () => {
    const w = dropWorld();
    w.state.meds[0]!.groupSeq = 1; // tapering one explicitly first
    w.state.meds[1]!.groupSeq = 2;
    w.run(5 * MINUTE);

    const byMed = new Map(w.state.liveDoses.map((d) => [d.medId, d.effectiveDueAt]));
    expect(byMed.get(1)!, 'the explicit group_seq was ignored').toBeLessThan(byMed.get(2)!);
  });

  it('keeps the same order day after day', () => {
    const w = dropWorld();
    w.respectSchedule = true;
    const sequences: string[] = [];

    for (let i = 0; i < 3 * 24 * 60; i++) {
      w.tick();
      const prompted = w.state.liveDoses.filter((d) => d.status === 'prompted');
      if (prompted.length === 1) {
        const key = w.state.meds.find((m) => m.id === prompted[0]!.medId)!.medKey;
        if (sequences[sequences.length - 1] !== key) sequences.push(key);
        w.resolve(prompted[0]!.id, 'taken');
      }
      w.now += MINUTE;
    }

    // Every pair should read steady-then-tapering, never the reverse.
    for (let i = 0; i + 1 < sequences.length; i += 2) {
      expect([sequences[i], sequences[i + 1]]).toEqual(['steady', 'tapering']);
    }
  });
});

describe('changing how many doses a day', () => {
  it('lands on the same schedule an import of that number would have', async () => {
    const { dosesPerDayInterval, parsePrescription } = await import('../../src/core/prescription.js');

    // What /edit perday 3 computes...
    const edited = dosesPerDayInterval('08:00', '22:00', 3);
    // ...must match what importing "3 times a day" produces, or the two drift apart.
    const imported = parsePrescription({
      medicines: [{ id: 'x', name: 'X', schedule: { type: 'times_per_day', n: 3, from: '08:00', to: '22:00' } }],
    }, { now: 0 }).value!.meds[0]!;

    expect(edited).toBe(imported.intervalMs);
    expect(imported.spec.anchor).toBe('wake');
  });

  it('spreads more doses closer together, fewer further apart', async () => {
    const { dosesPerDayInterval } = await import('../../src/core/prescription.js');
    const four = dosesPerDayInterval('07:00', '22:00', 4);
    const three = dosesPerDayInterval('07:00', '22:00', 3);
    const two = dosesPerDayInterval('07:00', '22:00', 2);
    expect(four).toBeLessThan(three);
    expect(three).toBeLessThan(two);
    // Four doses across a fifteen-hour day is five hours apart.
    expect(Math.round(four / (60 * 60_000))).toBe(5);
  });

  it('fits the doses inside a shorter waking day', async () => {
    const { dosesPerDayInterval } = await import('../../src/core/prescription.js');
    const long = dosesPerDayInterval('06:00', '23:00', 4);
    const short = dosesPerDayInterval('10:00', '20:00', 4);
    expect(short).toBeLessThan(long);
  });

  it('treats once a day as daily, not as an impossible division', async () => {
    const { dosesPerDayInterval } = await import('../../src/core/prescription.js');
    expect(dosesPerDayInterval('08:00', '22:00', 1)).toBe(24 * HOUR);
  });

  it('actually changes the dosing rate when applied to a live medicine', () => {
    const w = new World({
      start: at(0, '07:55'),
      patient: {
        morningPollAt: '08:00', eveningPollAt: '22:00',
        presumedSleepAt: '23:00', presumedWakeAt: '09:00',
        wakeState: 'awake', wakeConfidence: 'confirmed',
        wakeStateSince: at(0, '08:00'), lastWakeAt: at(0, '08:00'),
      },
      meds: [makeMed({
        id: 1, medKey: 'tablet', intervalMs: 7 * HOUR, minGapMs: 5 * HOUR,
        spec: { kind: 'interval', intervalMs: 7 * HOUR, anchor: 'wake' },
      })],
      chats: [makeChat({ chatId: 100 })],
    });
    w.respectSchedule = true;

    // Two a day at first.
    for (let i = 0; i < 15 * 60; i++) {
      w.tick();
      const p = w.state.liveDoses.find((d) => d.status === 'prompted' || d.status === 'due');
      if (p !== undefined) w.resolve(p.id, 'taken');
      w.now += MINUTE;
    }
    const before = w.takenTimes('tablet').length;

    // The doctor says make it four a day.
    const med = w.med('tablet');
    const ms = Math.round(((22 - 8) * 60 / 3) * MINUTE);
    med.intervalMs = ms;
    med.spec = { kind: 'interval', intervalMs: ms, anchor: 'wake' };
    med.minGapMs = Math.floor(ms * 0.75);
    w.state.liveDoses = [];
    w.state.patient.nextActionAt = w.now;

    w.now = at(1, '07:55');
    w.state.patient.wakeStateSince = at(1, '08:00');
    w.state.patient.lastWakeAt = at(1, '08:00');
    for (let i = 0; i < 15 * 60; i++) {
      w.tick();
      const p = w.state.liveDoses.find((d) => d.status === 'prompted' || d.status === 'due');
      if (p !== undefined) w.resolve(p.id, 'taken');
      w.now += MINUTE;
    }
    const after = w.takenTimes('tablet').length - before;

    expect(after, `${before} doses before, ${after} after the change`).toBeGreaterThan(before);
  });
});
