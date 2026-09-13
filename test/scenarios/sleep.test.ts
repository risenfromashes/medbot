import { describe, expect, it } from 'vitest';
import { World, makeChat, makeMed, TZ } from '../simulate.js';
import { HOUR, MINUTE, zoneFor } from '../../src/core/tz.js';

const z = zoneFor(TZ);
const at = (day: number, hhmm: string): number => z.wallOnDayUtc(z.addLocalDays('2026-09-14', day), hhmm);

/**
 * Going to bed ends the day, and a night has a minimum length.
 *
 * Every case here is something that actually happened to someone. The patient imported a
 * prescription at five in the morning, the bot took that as the day beginning, fired every
 * medicine at once, and then they said goodnight a minute later -- leaving the next round
 * of drops booked for ten o'clock, in the middle of the sleep they had just declared.
 */
function nightWorld(startAt: number): World {
  const w = new World({
    start: startAt,
    patient: {
      morningPollAt: '06:30', presumedWakeAt: '09:00',
      eveningPollAt: '22:30', presumedSleepAt: '01:00',
      minSleepMs: 4 * HOUR,
      wakeState: 'awake', wakeConfidence: 'confirmed',
      wakeStateSince: startAt - HOUR, lastWakeAt: startAt - HOUR,
    },
    meds: [makeMed({
      id: 1, medKey: 'drops', intervalMs: 4 * HOUR, minGapMs: 2 * HOUR,
      spec: { kind: 'interval', intervalMs: 4 * HOUR, anchor: 'wake' },
    })],
    chats: [makeChat({ chatId: 100 })],
  });
  w.respectSchedule = true;
  return w;
}

describe('sleep ends the day', () => {
  it('does not leave the next dose booked inside the night', () => {
    // Bedtime at 05:18, having taken a dose a minute earlier -- exactly the live case.
    const w = nightWorld(at(0, '05:15'));
    w.run(3 * MINUTE);
    const pending = w.state.liveDoses.find((d) => d.status === 'due' || d.status === 'prompted');
    if (pending !== undefined) w.take('drops');
    w.declare('sleep');
    w.run(30 * MINUTE);

    // Whatever is live must not be waiting somewhere in the small hours.
    const morning = at(0, '09:18'); // bedtime + the four-hour minimum
    for (const d of w.state.liveDoses) {
      expect(d.effectiveDueAt, `dose ${d.id} is due mid-sleep`).toBeGreaterThanOrEqual(morning);
    }
  });

  it('says nothing at all while the patient is asleep', () => {
    const w = nightWorld(at(0, '05:18'));
    w.declare('sleep');
    const before = w.sent.length;
    w.run(3 * HOUR); // through the 06:30 morning poll
    expect(w.sent.slice(before), 'woke the patient inside the minimum sleep').toEqual([]);
  });

  it('waits out the minimum sleep before presuming anyone is up', () => {
    const w = nightWorld(at(0, '05:18'));
    w.declare('sleep');
    w.run(8 * HOUR);
    // 06:30 and 09:00 both fall inside the four hours; the day starts at 09:18.
    expect(w.state.patient.wakeState).toBe('awake');
    expect(w.state.patient.lastWakeAt).toBeGreaterThanOrEqual(at(0, '09:18'));
    expect(w.state.patient.lastWakeAt).toBeLessThanOrEqual(at(0, '10:00'));
  });

  it('asks before it assumes, even when the minimum ran out hours late', () => {
    // The 06:30 poll and the 09:00 fallback both fell inside the four hours. Rather than
    // the whole day's dosing arriving unannounced at 09:18, the question comes first and
    // gets the usual half hour.
    const w = nightWorld(at(0, '05:18'));
    w.declare('sleep');
    w.runUntil((x) => x.state.openPrompts.some((q) => q.kind === 'wake'), 6 * HOUR);
    const asked = w.state.openPrompts.find((q) => q.kind === 'wake');
    expect(asked, 'never asked, just assumed').toBeDefined();
    expect(asked!.createdAt).toBeGreaterThanOrEqual(at(0, '09:18'));
    expect(asked!.createdAt).toBeLessThan(at(0, '09:30'));
  });

  it('anchors the day on the minimum, not on a wake time that passed during it', () => {
    // Presumed wake is 09:00 and the floor lands at 09:18, plus half an hour's grace for
    // the question. Anchoring on 09:00 would greet the patient with a dose already
    // three-quarters of an hour overdue.
    const w = nightWorld(at(0, '05:18'));
    w.declare('sleep');
    w.run(5 * HOUR);
    expect(w.state.patient.lastWakeAt).toBe(at(0, '09:48'));
  });

  it('ignores a message sent moments after saying goodnight', () => {
    const w = nightWorld(at(0, '22:10'));
    w.declare('sleep');
    w.run(20 * MINUTE);
    w.state.patient.lastActivityAt = w.now; // "one more thing" from bed
    w.state.patient.nextActionAt = w.now;
    w.run(10 * MINUTE);
    expect(w.state.patient.wakeState, 'a text from bed restarted the day').toBe('asleep');
  });

  it('ignores a message in the middle of the night', () => {
    const w = nightWorld(at(0, '22:10'));
    w.declare('sleep');
    w.run(4 * HOUR); // 02:10, past both the settling period and the minimum
    w.state.patient.lastActivityAt = w.now;
    w.state.patient.nextActionAt = w.now;
    w.run(10 * MINUTE);
    expect(w.state.patient.wakeState, 'insomnia started the day').toBe('asleep');
  });

  it('still takes a message in the morning as proof of being up', () => {
    const w = nightWorld(at(0, '22:10'));
    w.declare('sleep');
    w.run(9 * HOUR); // 07:10, past the 06:30 morning poll
    w.state.patient.lastActivityAt = w.now;
    w.state.patient.nextActionAt = w.now;
    w.run(5 * MINUTE);
    expect(w.state.patient.wakeState).toBe('awake');
  });

  it('lets a nap end without waiting for tomorrow morning', () => {
    // No morning comes round after an afternoon doze. Without an escape hatch the
    // patient would get no reminders at all for the rest of the day -- the silence this
    // whole design exists to prevent, arrived at by way of a safety rule.
    const w = nightWorld(at(0, '14:00'));
    w.declare('sleep');
    w.run(2 * HOUR);
    w.state.patient.lastActivityAt = w.now;
    w.state.patient.nextActionAt = w.now;
    w.run(5 * MINUTE);
    expect(w.state.patient.wakeState).toBe('awake');
  });

  it('re-anchors every wake-anchored medicine on the real morning', () => {
    const w = nightWorld(at(0, '05:15'));
    w.run(3 * MINUTE);
    const pending = w.state.liveDoses.find((d) => d.status === 'due' || d.status === 'prompted');
    if (pending !== undefined) w.take('drops');
    w.declare('sleep');
    w.run(6 * HOUR);
    w.declare('wake', at(0, '11:00'));
    w.run(30 * MINUTE);

    const live = w.state.liveDoses.find((d) => d.medId === 1);
    expect(live, 'the medicine went quiet after a night').toBeDefined();
    // The day restarts when the patient does, not four hours after a 5am dose.
    expect(live!.effectiveDueAt).toBeGreaterThanOrEqual(at(0, '11:00'));
    expect(live!.effectiveDueAt).toBeLessThanOrEqual(at(0, '11:35'));
  });
});
