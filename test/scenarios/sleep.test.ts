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

  it('asks rather than assuming, once the minimum sleep has run out', () => {
    // Bed at 05:18 with a four-hour minimum: the 06:30 reference falls inside it, so the
    // question waits until 09:18. And it stays a question -- nothing here decides the
    // patient is up, because a guessed wake time misplaces every dose hung off it.
    const w = nightWorld(at(0, '05:18'));
    w.declare('sleep');
    w.runUntil((x) => x.state.openPrompts.some((q) => q.kind === 'wake'), 8 * HOUR);
    const asked = w.state.openPrompts.find((q) => q.kind === 'wake');
    expect(asked, 'never asked at all').toBeDefined();
    expect(asked!.createdAt).toBeGreaterThanOrEqual(at(0, '09:18'));
    expect(w.state.patient.wakeState, 'decided they were up without being told').toBe('asleep');
  });

  it('keeps asking, on its own cadence, until it gets an answer', () => {
    const w = nightWorld(at(0, '05:18'));
    w.declare('sleep');
    w.run(14 * HOUR);
    const asks = w.sent.filter((m) => m.kind === 'wake');
    expect(asks.length, 'asked once and gave up').toBeGreaterThan(1);
  });

  it('anchors the day on what the patient says, not on the clock', () => {
    const w = nightWorld(at(0, '05:18'));
    w.declare('sleep');
    w.run(6 * HOUR);
    w.declare('wake', at(0, '10:40'));
    w.run(10 * MINUTE);
    expect(w.state.patient.lastWakeAt).toBe(at(0, '10:40'));
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

  it('asks the moment they stir in the morning, rather than waiting for the hour', () => {
    // A message after a full night does not start the day by itself -- it earns the
    // question straight away, instead of waiting for the next scheduled check.
    const w = nightWorld(at(0, '22:10'));
    w.declare('sleep');
    w.run(8 * HOUR); // 06:10, inside the four-hour minimum having passed
    const before = w.sent.filter((m) => m.kind === 'wake').length;
    w.state.patient.lastActivityAt = w.now;
    w.state.patient.nextActionAt = w.now;
    w.run(5 * MINUTE);
    expect(w.sent.filter((m) => m.kind === 'wake').length, 'stirring produced no question')
      .toBeGreaterThan(before);
    expect(w.state.patient.wakeState, 'a single message started the whole day').toBe('asleep');
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

/**
 * The clock does not get to overrule the person.
 *
 * "Assumed awake until they say otherwise, or it is past the cutoff *and* there is no
 * activity." Passing the presumed-sleep time is evidence of the time, not of being
 * asleep, and treating it as the latter stopped someone's medicines for the rest of a
 * night they were still very much awake for.
 */
describe('being up late', () => {
  function lateWorld(): World {
    const w = new World({
      start: at(0, '22:00'),
      patient: {
        morningPollAt: '06:30', presumedWakeAt: '09:00',
        eveningPollAt: '22:30', presumedSleepAt: '01:00',
        minSleepMs: 4 * HOUR,
        wakeState: 'awake', wakeConfidence: 'confirmed',
        wakeStateSince: at(0, '08:35'), lastWakeAt: at(0, '08:35'),
        lastActivityAt: at(0, '22:00'),
      },
      // Last taken at half past eight, so the next one falls at 01:10 -- ten minutes the
      // wrong side of a presumed bedtime the patient has not reached yet.
      meds: [makeMed({
        id: 1, medKey: 'tab', intervalMs: 4 * HOUR + 40 * MINUTE, minGapMs: 3 * HOUR,
        spec: { kind: 'interval', intervalMs: 4 * HOUR + 40 * MINUTE, anchor: 'wake' },
        startedAt: at(0, '08:35'),
        lastTakenAt: at(0, '20:30'),
        lastCycleStartAt: at(0, '20:30'),
        lastPlannedDueAt: at(0, '20:30'),
        nextSeq: 2,
      })],
      chats: [makeChat({ chatId: 100 })],
    });
    w.respectSchedule = true;
    return w;
  }

  it('does not write off a dose that lands just past the cutoff', () => {
    // Due at 01:10 against a 01:00 presumed bedtime. Skipping it to the morning assumes
    // a night that has not started.
    const w = lateWorld();
    w.run(30 * MINUTE);
    const live = w.state.liveDoses.find((d) => d.medId === 1);
    expect(live, 'the medicine went quiet').toBeDefined();
    expect(live!.effectiveDueAt, 'pushed to tomorrow morning while the patient is awake')
      .toBeLessThan(at(1, '06:00'));
  });

  it('stays awake while they are still answering', () => {
    const w = lateWorld();
    for (let i = 0; i < 4 * 60; i++) {
      w.tick();
      w.state.patient.lastActivityAt = w.now; // still using the bot
      w.state.patient.nextActionAt = w.now;
      w.now += MINUTE;
    }
    // 02:00, well past the 01:00 cutoff, and plainly not asleep.
    expect(w.state.patient.wakeState).toBe('awake');
  });

  it('calls it a night once they go quiet, dating it from when they stopped', () => {
    const w = lateWorld();
    w.state.patient.lastActivityAt = at(0, '23:40');
    w.run(4 * HOUR); // past 01:00, with nothing since twenty to midnight
    expect(w.state.patient.wakeState).toBe('asleep');
    // Not 01:00 on the nose: they were demonstrably up until twenty to midnight.
    expect(w.state.patient.lastSleepAt ?? w.state.patient.wakeStateSince)
      .toBeGreaterThanOrEqual(at(0, '23:40'));
  });

  it('parks an overnight dose rather than prompting for it', () => {
    const w = lateWorld();
    w.run(6 * HOUR); // through the night, no activity
    const live = w.state.liveDoses.find((d) => d.medId === 1);
    expect(live).toBeDefined();
    expect(['deferred', 'scheduled']).toContain(live!.status);
    expect(live!.status, 'nagged someone at three in the morning').not.toBe('prompted');
  });
});
