import { describe, expect, it } from 'vitest';
import { World, makeChat, makeMed, TZ } from '../simulate.js';
import { HOUR, MINUTE, zoneFor } from '../../src/core/tz.js';

const z = zoneFor(TZ);
const at = (day: number, hhmm: string): number => z.wallOnDayUtc(z.addLocalDays('2026-09-14', day), hhmm);

/**
 * "Every four hours" means every four hours of the day you are actually having. A dose at
 * half past two in the morning is not a dose, it is an alarm clock.
 */
function dayWorld(over: Partial<Parameters<typeof makeMed>[0]> = {}): World {
  const w = new World({
    start: at(0, '07:55'),
    patient: {
      morningPollAt: '07:00', presumedWakeAt: '09:00',
      eveningPollAt: '22:00', presumedSleepAt: '23:00',
      wakeState: 'awake', wakeConfidence: 'confirmed',
      wakeStateSince: at(0, '08:00'), lastWakeAt: at(0, '08:00'),
    },
    meds: [makeMed({
      id: 1, medKey: 'drops', intervalMs: 4 * HOUR, minGapMs: 3 * HOUR,
      spec: { kind: 'interval', intervalMs: 4 * HOUR, anchor: 'wake' },
      ...over,
    })],
    chats: [makeChat({ chatId: 100 })],
  });
  w.respectSchedule = true;
  return w;
}

describe('doses live inside waking hours', () => {
  it('never schedules a four-hourly dose into the night', () => {
    const w = dayWorld();

    // A full day, answering everything promptly.
    for (let i = 0; i < 20 * 60; i++) {
      w.tick();
      const pending = w.state.liveDoses.find((d) => d.status === 'prompted' || d.status === 'due');
      if (pending !== undefined) w.resolve(pending.id, 'taken');
      if (w.now === at(0, '23:00')) w.declare('sleep');
      w.now += MINUTE;
    }

    const taken = w.takenTimes('drops');
    expect(taken.length).toBeGreaterThanOrEqual(3);
    for (const t of taken) {
      const [h] = t.slice(11).split(':').map(Number);
      expect(h! >= 7 && h! <= 23, `a dose landed at ${t} -- during the night`).toBe(true);
    }
  });

  it('puts the dose that would fall at 2am on the morning instead', () => {
    const w = dayWorld();

    // Take doses through the evening so the next one would land overnight.
    for (let i = 0; i < 16 * 60; i++) {
      w.tick();
      const pending = w.state.liveDoses.find((d) => d.status === 'prompted' || d.status === 'due');
      if (pending !== undefined) w.resolve(pending.id, 'taken');
      w.now += MINUTE;
    }
    // It is now midnight-ish; whatever is scheduled must not be in the small hours.
    const next = w.state.liveDoses[0]!;
    const hour = Number(z.fmtTime(next.effectiveDueAt).slice(0, 2));
    expect(
      hour >= 7,
      `next dose scheduled at ${z.fmtTime(next.effectiveDueAt)}, in the middle of the night`,
    ).toBe(true);
  });

  it('still wakes you for something marked critical', () => {
    const w = dayWorld({ critical: true, awakeOnly: false });

    for (let i = 0; i < 20 * 60; i++) {
      w.tick();
      const pending = w.state.liveDoses.find((d) => d.status === 'prompted' || d.status === 'due');
      if (pending !== undefined) w.resolve(pending.id, 'taken');
      if (w.now === at(0, '23:00')) w.declare('sleep');
      w.now += MINUTE;
    }

    const overnight = w.takenTimes('drops').filter((t) => {
      const [h] = t.slice(11).split(':').map(Number);
      return h! < 6;
    });
    expect(overnight.length, 'a critical medicine was silently confined to daytime').toBeGreaterThan(0);
  });

  it('fits more doses into a long day than a short one', () => {
    const early = dayWorld();
    const late = new World({
      start: at(0, '11:55'),
      patient: {
        morningPollAt: '07:00', presumedWakeAt: '09:00',
        eveningPollAt: '22:00', presumedSleepAt: '23:00',
        wakeState: 'awake', wakeConfidence: 'confirmed',
        wakeStateSince: at(0, '12:00'), lastWakeAt: at(0, '12:00'),
      },
      meds: [makeMed({
        id: 1, medKey: 'drops', intervalMs: 4 * HOUR, minGapMs: 3 * HOUR,
        spec: { kind: 'interval', intervalMs: 4 * HOUR, anchor: 'wake' },
      })],
      chats: [makeChat({ chatId: 100 })],
    });
    late.respectSchedule = true;

    for (const w of [early, late]) {
      for (let i = 0; i < 15 * 60; i++) {
        w.tick();
        const p = w.state.liveDoses.find((d) => d.status === 'prompted' || d.status === 'due');
        if (p !== undefined) w.resolve(p.id, 'taken');
        w.now += MINUTE;
      }
    }

    // Getting up at eight leaves room for more four-hourly doses than getting up at noon,
    // which is the point of measuring the day from when it actually starts.
    expect(early.takenTimes('drops').length).toBeGreaterThan(late.takenTimes('drops').length);
  });

  it('resumes first thing the next morning', () => {
    const w = dayWorld();
    for (let i = 0; i < 30 * 60; i++) {
      w.tick();
      const pending = w.state.liveDoses.find((d) => d.status === 'prompted' || d.status === 'due');
      if (pending !== undefined) w.resolve(pending.id, 'taken');
      if (w.now === at(0, '23:00')) w.declare('sleep');
      if (w.now === at(1, '07:30')) w.declare('wake');
      w.now += MINUTE;
    }

    const nextMorning = w.takenTimes('drops').filter((t) => t.startsWith('2026-09-15'));
    expect(nextMorning.length, 'nothing was taken the following morning').toBeGreaterThan(0);
    const [h, m] = nextMorning[0]!.slice(11).split(':').map(Number);
    // First thing, not hours into the day.
    expect(h! * 60 + m!).toBeLessThanOrEqual(8 * 60);
  });
});
