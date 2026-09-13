import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { World, makeChat, makeMed, TZ } from '../simulate.js';
import { parsePrescription, describeSchedule } from '../../src/core/prescription.js';
import { activePhase } from '../../src/core/planSchedule.js';
import { HOUR, MINUTE, zoneFor } from '../../src/core/tz.js';

const z = zoneFor(TZ);
const at = (day: number, hhmm: string): number => z.wallOnDayUtc(z.addLocalDays('2026-09-14', day), hhmm);

/**
 * A real post-operative eye prescription. Every assertion here is something the original
 * design got wrong, found by transcribing an actual piece of paper rather than an
 * imagined one.
 */
const doc = JSON.parse(readFileSync('examples/post-op-eye.json', 'utf8'));
const parsed = parsePrescription(doc, { now: at(0, '12:00') });

describe('parsing the real prescription', () => {
  it('parses without errors', () => {
    expect(parsed.errors).toEqual([]);
  });

  it('leaves each drop on the frequency the doctor actually wrote', () => {
    const by = new Map(parsed.value!.meds.map((m) => [m.medKey, m]));
    // The lubricant is two-hourly and indefinite; folding it into a group would have
    // rewritten it to four times a day for fourteen days.
    expect(by.get('drop')!.intervalMs).toBe(2 * HOUR);
    expect(by.get('drop')!.courseKind).toBe('indefinite');
    expect(by.get('drop')!.courseDays).toBe(14);
    expect(describeSchedule(by.get('drop')!)).toContain('at ');
  });

  it('keeps all three drops ten minutes apart from each other', () => {
    const drops = parsed.value!.meds.filter((m) => m.spacingGroup === 'eye_drops');
    expect(drops.map((d) => d.medKey).sort()).toEqual(['drop', 'drop', 'drop']);
    for (const d of drops) {
      expect(d.spacingMs).toBe(10 * MINUTE);
      expect(d.mergeable, 'a spaced drop must never share a message').toBe(false);
    }
  });

  it('understands the taper: 4x a day for a week, then 3x for a week', () => {
    const drop = parsed.value!.meds.find((m) => m.medKey === 'drop')!;
    expect(drop.phases).not.toBeNull();
    expect(drop.phases!.length).toBe(2);
    expect(drop.phases![0]!.days).toBe(7);
    expect(drop.phases![1]!.days).toBe(7);
    // Four slots in the first phase, three in the second.
    expect(drop.phases![0]!.spec.times!.length).toBe(4);
    expect(drop.phases![1]!.spec.times!.length).toBe(3);
    // The whole course is fourteen days, not seven.
    expect(drop.courseDays).toBe(14);
  });

  it('keeps "before meal" and "after meal" genuinely different', () => {
    const by = new Map(parsed.value!.meds.map((m) => [m.medKey, m]));
    const before = by.get('stomach capsule')!.spec.times!;
    const after = by.get('flexi')!.spec.times!;
    // stomach capsule is a proton-pump inhibitor: half an hour before food actually matters.
    expect(before).toEqual(['08:00', '20:00']);
    expect(after).toEqual(['08:30', '20:30']);
    expect(before).not.toEqual(after);
  });
});

describe('the taper in motion', () => {
  const drop = parsed.value!.meds.find((m) => m.medKey === 'drop')!;
  const med = makeMed({
    id: 1, medKey: 'drop', kind: drop.kind, spec: drop.spec,
    intervalMs: drop.intervalMs, phases: drop.phases, courseKind: 'days',
    courseDays: drop.courseDays, startedAt: at(0, '08:00'),
  });

  it('is in the four-a-day phase on day one', () => {
    const p = activePhase(med, z, z.localDay(at(0, '12:00')));
    expect(p.index).toBe(0);
    expect(p.phase!.spec.times!.length).toBe(4);
  });

  it('is still in the first phase on day seven', () => {
    expect(activePhase(med, z, z.localDay(at(6, '12:00'))).index).toBe(0);
  });

  it('steps down to three a day on day eight', () => {
    const p = activePhase(med, z, z.localDay(at(7, '12:00')));
    expect(p.index).toBe(1);
    expect(p.phase!.spec.times!.length).toBe(3);
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
        makeMed({ id: 1, medKey: 'drop', kind: 'fixed_times', intervalMs: null, minGapMs: 3 * HOUR,
          spec: { kind: 'fixed_times', times: ['08:00', '12:40', '17:20', '22:00'] },
          spacingGroup: 'drops', spacingMs: 10 * MINUTE, mergeable: false }),
        makeMed({ id: 2, medKey: 'drop', kind: 'fixed_times', intervalMs: null, minGapMs: 3 * HOUR,
          spec: { kind: 'fixed_times', times: ['08:00', '12:40', '17:20', '22:00'] },
          spacingGroup: 'drops', spacingMs: 10 * MINUTE, mergeable: false }),
        makeMed({ id: 3, medKey: 'drop', intervalMs: 2 * HOUR, minGapMs: 90 * MINUTE,
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
      if (d.medId === w.med('drop').id && d.status === 'taken') continue;
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
    const lubricant = w.takenTimes('drop').length;
    expect(lubricant, `lubricant only dosed ${lubricant} times in 15 hours`).toBeGreaterThanOrEqual(5);
    // While the four-times-a-day drop stays at four.
    expect(w.takenTimes('drop').length).toBeLessThanOrEqual(5);
  });
});
