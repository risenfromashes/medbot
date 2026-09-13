import { describe, expect, it } from 'vitest';
import { World, makeChat, makeMed, TZ } from '../simulate.js';
import { HOUR, MINUTE, zoneFor } from '../../src/core/tz.js';

const z = zoneFor(TZ);
const at = (day: number, hhmm: string): number => z.wallOnDayUtc(z.addLocalDays('2026-09-14', day), hhmm);

/**
 * Production does not plan every minute -- it plans when `next_action_at` says to. If the
 * planner ever forgets to ask for a wake-up, the bot goes quiet without any error. These
 * run with that gate switched on, so a missing wake-up shows up as silence.
 */
describe('with the wake-up gate on, as in production', () => {
  const chats = [
    makeChat({ chatId: 100, role: 'patient', escalationTier: 0 }),
    makeChat({ chatId: 200, role: 'caregiver', escalationTier: 1, escalateAfterMs: 5 * MINUTE }),
  ];

  it('still escalates to the caregiver five minutes after a prompt it created itself', () => {
    const w = new World({
      start: at(0, '08:00'),
      patient: { wakeState: 'awake', wakeConfidence: 'confirmed', wakeStateSince: at(0, '07:00'), lastWakeAt: at(0, '07:00') },
      meds: [makeMed({ id: 1, medKey: 'drop_a', intervalMs: 4 * HOUR })],
      chats,
    });
    w.respectSchedule = true;

    w.run(20 * MINUTE);

    expect(w.skipped, 'the gate was never actually exercised').toBeGreaterThan(5);
    const toCaregiver = w.sent.filter((s) => s.chatId === 200);
    expect(toCaregiver.length, 'caregiver never got the escalation').toBeGreaterThan(0);
    expect(toCaregiver[0]!.at - at(0, '08:00')).toBeGreaterThanOrEqual(5 * MINUTE);
    expect(toCaregiver[0]!.at - at(0, '08:00')).toBeLessThanOrEqual(7 * MINUTE);
  });

  it('still nags on schedule', () => {
    const w = new World({
      start: at(0, '08:00'),
      patient: {
        wakeState: 'awake', wakeConfidence: 'confirmed', wakeStateSince: at(0, '07:00'),
        lastWakeAt: at(0, '07:00'), presumedSleepAt: '23:59', eveningPollAt: '23:50',
      },
      meds: [makeMed({ id: 1, medKey: 'drop_a', intervalMs: 6 * HOUR, minGapMs: 4 * HOUR })],
      chats: [makeChat({ chatId: 100 })],
    });
    w.respectSchedule = true;

    w.run(90 * MINUTE);
    const nudges = w.sent.filter((s) => s.nudge);
    expect(nudges.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < nudges.length; i++) {
      expect(nudges[i]!.at - nudges[i - 1]!.at).toBeLessThanOrEqual(30 * MINUTE);
    }
  });

  it('wakes up in the morning after a quiet night', () => {
    const w = new World({
      start: at(0, '22:00'),
      patient: { wakeState: 'awake', wakeConfidence: 'confirmed', wakeStateSince: at(0, '08:00'), lastWakeAt: at(0, '08:00') },
      meds: [makeMed({ id: 1, medKey: 'drop_a', intervalMs: 2 * HOUR })],
      chats: [makeChat({ chatId: 100 })],
    });
    w.respectSchedule = true;

    w.now = at(0, '22:30');
    w.declare('sleep');
    w.run(10 * HOUR); // through to 08:30 the next morning

    const morning = w.sent.filter((s) => s.at >= at(1, '06:00'));
    expect(morning.length, 'the bot never woke up again after the night').toBeGreaterThan(0);
  });

  it('survives a whole week without ever going quiet', () => {
    const w = new World({
      start: at(0, '06:00'),
      meds: [
        makeMed({ id: 1, medKey: 'drops', intervalMs: 2 * HOUR, steps: [{ name: 'A' }, { name: 'B' }], stepSpacingMs: 10 * MINUTE, mergeable: false }),
        makeMed({ id: 2, medKey: 'stomach', intervalMs: 12 * HOUR, minGapMs: 10 * HOUR }),
      ],
      chats,
    });
    w.respectSchedule = true;

    for (let i = 0; i < 7 * 24 * 60; i++) {
      w.tick();
      const pending = w.state.liveDoses.find((d) => d.status === 'prompted');
      if (pending !== undefined && i % 3 !== 0) w.resolve(pending.id, 'taken');
      if (i % (24 * 60) === 7 * 60) w.declare('wake');
      if (i % (24 * 60) === 22 * 60) w.declare('sleep');
      w.now += MINUTE;
    }

    for (const med of w.state.meds) {
      if (med.status !== 'active') continue;
      expect(w.state.liveDoses.filter((d) => d.medId === med.id).length, `${med.medKey} went silent`).toBe(1);
    }
    // And it genuinely used the gate rather than ticking every minute.
    expect(w.skipped).toBeGreaterThan(5000);
  });
});
