import { describe, expect, it } from 'vitest';
import { World, makeMed, TZ } from '../simulate.js';
import { HOUR, MINUTE, zoneFor } from '../../src/core/tz.js';

const z = zoneFor(TZ);
/** Midnight local on a fixed, DST-free date, so tests read in local time. */
const at = (day: number, hhmm: string): number => z.wallOnDayUtc(z.addLocalDays('2026-09-14', day), hhmm);

describe('a normal day', () => {
  it('stays silent overnight, asks in the morning, then doses on waking', () => {
    const w = new World({
      start: at(0, '05:00'),
      meds: [makeMed({ id: 1, medKey: 'drop_a', name: 'Antibiotic drop', intervalMs: 2 * HOUR })],
    });

    // 05:00 -> 07:00: asleep, nothing at all should be sent.
    w.run(2 * HOUR - MINUTE);
    expect(w.sent.length, 'bot spoke before the morning poll').toBe(0);

    // The morning poll opens at 07:00 and it should ask whether she is up.
    w.run(2 * MINUTE);
    const wakeAsks = w.sent.filter((s) => s.kind === 'wake');
    expect(wakeAsks.length).toBeGreaterThan(0);
    // But still no medicine, because we do not know she is up.
    expect(w.sent.some((s) => s.kind === 'dose')).toBe(false);

    // She confirms at 07:30.
    w.now = at(0, '07:30');
    w.declare('wake');
    w.run(2 * MINUTE);

    const firstDose = w.sent.find((s) => s.kind === 'dose');
    expect(firstDose, 'no dose prompt after waking').toBeDefined();
    expect(z.fmtTime(firstDose!.at)).toBe('07:30');
  });

  it('anchors the next dose on the scheduled time when answered promptly', () => {
    const w = new World({
      start: at(0, '07:00'),
      patient: { wakeState: 'awake', wakeConfidence: 'confirmed', wakeStateSince: at(0, '07:00'), lastWakeAt: at(0, '07:00') },
      meds: [makeMed({ id: 1, medKey: 'drop_a', intervalMs: 2 * HOUR })],
    });

    w.run(MINUTE);
    // Answer 12 minutes late -- inside the 30-minute absorb tolerance.
    w.now = at(0, '07:12');
    w.take('drop_a');
    w.run(2 * HOUR);

    // The next dose must land at 09:00 (grid preserved), not 09:12 (drift).
    const due = w.state.liveDoses[0]!;
    expect(z.fmtTime(due.plannedDueAt)).toBe('09:00');
  });

  it('re-bases on the real time when the dose was genuinely late', () => {
    const w = new World({
      start: at(0, '07:00'),
      patient: { wakeState: 'awake', wakeConfidence: 'confirmed', wakeStateSince: at(0, '07:00'), lastWakeAt: at(0, '07:00') },
      meds: [makeMed({ id: 1, medKey: 'drop_a', intervalMs: 2 * HOUR })],
    });

    w.run(MINUTE);
    // 50 minutes late -- beyond tolerance, so this is a genuinely missed-then-taken dose.
    w.now = at(0, '07:50');
    w.take('drop_a');
    w.run(MINUTE);

    const due = w.state.liveDoses[0]!;
    expect(z.fmtTime(due.plannedDueAt)).toBe('09:50');
  });
});

describe('drift over a week', () => {
  it('does not walk an 8-hourly course into the night', () => {
    const w = new World({
      start: at(0, '06:00'),
      patient: {
        wakeState: 'awake', wakeConfidence: 'confirmed', wakeStateSince: at(0, '06:00'),
        lastWakeAt: at(0, '06:00'), presumedSleepAt: '23:59', eveningPollAt: '23:50',
      },
      meds: [makeMed({
        id: 1, medKey: 'antibiotic', name: 'Antibiotic', intervalMs: 8 * HOUR,
        minGapMs: 6 * HOUR, awakeOnly: false, spec: { kind: 'interval', intervalMs: 8 * HOUR, anchor: 'clock' },
      })],
    });

    // Answer every prompt 20 minutes late, every time, for four days.
    for (let i = 0; i < 4 * 24 * 60; i++) {
      w.tick();
      const pending = w.state.liveDoses.find((d) => d.status === 'prompted' || d.status === 'due');
      if (pending !== undefined && w.now - pending.effectiveDueAt >= 20 * MINUTE) {
        w.take('antibiotic');
      }
      w.now += MINUTE;
    }

    const times = w.takenTimes('antibiotic');
    expect(times.length).toBeGreaterThanOrEqual(10);
    // With naive "actual + 8h" this drifts an hour a day and the grid rots. Absorption
    // keeps every dose within tolerance of the original three-a-day slots.
    const minutesOfDay = times.map((s) => {
      const [h, m] = s.slice(11).split(':').map(Number);
      return h! * 60 + m!;
    });
    const slots = new Set(minutesOfDay.map((m) => Math.round(m / 60)));
    expect(slots.size, `doses landed at too many distinct hours: ${times.join(', ')}`).toBeLessThanOrEqual(4);
  });
});

describe('the spacing group', () => {
  it('serialises three eye drops ten minutes apart, measured from the actual drop', () => {
    const w = new World({
      start: at(0, '07:00'),
      patient: { wakeState: 'awake', wakeConfidence: 'confirmed', wakeStateSince: at(0, '07:00'), lastWakeAt: at(0, '07:00') },
      meds: [makeMed({
        id: 1, medKey: 'drops', name: 'Eye drops', intervalMs: 2 * HOUR,
        steps: [{ name: 'Drop one' }, { name: 'Drop two' }, { name: 'Drop three' }],
        stepSpacingMs: 10 * MINUTE, mergeable: false,
      })],
    });

    w.run(MINUTE);
    // Only ONE drop may be pending at a time.
    expect(w.state.liveDoses.length).toBe(1);
    expect(w.state.liveDoses[0]!.step).toBe(0);

    w.take('drops');            // drop 1 at 07:01
    const t1 = w.now;
    w.run(20 * MINUTE);

    // Drop 2 should have been prompted ten minutes after drop 1 was actually taken.
    const drop2 = w.allDoses.find((d) => d.step === 1);
    expect(drop2).toBeDefined();
    expect(drop2!.effectiveDueAt - t1).toBe(10 * MINUTE);

    w.now = drop2!.effectiveDueAt + 5 * MINUTE;   // answer drop 2 five minutes late
    w.tick();
    w.take('drops');
    const t2 = w.now;
    w.run(20 * MINUTE);

    const drop3 = w.allDoses.find((d) => d.step === 2);
    expect(drop3).toBeDefined();
    // Spacing is measured from the ACTUAL previous drop, not from a fixed grid.
    expect(drop3!.effectiveDueAt - t2).toBe(10 * MINUTE);
  });

  it('never lets an unanswered first drop strand the other two', () => {
    const w = new World({
      start: at(0, '07:00'),
      patient: {
        wakeState: 'awake', wakeConfidence: 'confirmed', wakeStateSince: at(0, '07:00'),
        lastWakeAt: at(0, '07:00'), presumedSleepAt: '23:59', eveningPollAt: '23:50',
      },
      meds: [makeMed({
        id: 1, medKey: 'drops', intervalMs: 2 * HOUR,
        steps: [{ name: 'A' }, { name: 'B' }, { name: 'C' }],
        stepSpacingMs: 10 * MINUTE, mergeable: false,
      })],
    });

    // Ignore everything for six hours.
    w.run(6 * HOUR);

    // The medicine must still be alive and cycling, not wedged behind drop 1.
    expect(w.state.liveDoses.length).toBe(1);
    expect(w.countByStatus('drops', 'missed')).toBeGreaterThanOrEqual(2);
    // And it is still asking.
    const recent = w.sent.filter((s) => s.at > w.now - HOUR);
    expect(recent.length).toBeGreaterThan(0);
  });
});

describe('never gives up, but never wedges', () => {
  it('keeps nagging with a capped backoff', () => {
    const w = new World({
      start: at(0, '07:00'),
      patient: {
        wakeState: 'awake', wakeConfidence: 'confirmed', wakeStateSince: at(0, '07:00'),
        lastWakeAt: at(0, '07:00'), presumedSleepAt: '23:59', eveningPollAt: '23:50',
      },
      meds: [makeMed({ id: 1, medKey: 'drop_a', intervalMs: 6 * HOUR, minGapMs: 4 * HOUR })],
    });

    w.run(90 * MINUTE);
    const nudges = w.sent.filter((s) => s.kind === 'dose' && s.nudge && s.tier === 0);
    // 10, 15, 20, 30, 30, ... -> at least four nudges in ninety minutes, and never a
    // gap longer than the thirty-minute cap.
    expect(nudges.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < nudges.length; i++) {
      expect(nudges[i]!.at - nudges[i - 1]!.at).toBeLessThanOrEqual(30 * MINUTE);
    }
  });

  it('rolls an unanswered dose forward when the next one falls due', () => {
    const w = new World({
      start: at(0, '07:00'),
      patient: {
        wakeState: 'awake', wakeConfidence: 'confirmed', wakeStateSince: at(0, '07:00'),
        lastWakeAt: at(0, '07:00'), presumedSleepAt: '23:59', eveningPollAt: '23:50',
      },
      meds: [makeMed({ id: 1, medKey: 'drop_a', intervalMs: 2 * HOUR, minGapMs: 90 * MINUTE })],
    });

    w.run(5 * HOUR);
    expect(w.countByStatus('drop_a', 'missed')).toBeGreaterThanOrEqual(2);
    // Crucially, the medicine is still live and still being asked about.
    expect(w.state.liveDoses.length).toBe(1);
  });
});
