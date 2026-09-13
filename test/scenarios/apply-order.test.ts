import { describe, expect, it } from 'vitest';
import { plan } from '../../src/core/plan.js';
import { World, makeChat, makeMed, TZ } from '../simulate.js';
import { HOUR, MINUTE, zoneFor } from '../../src/core/tz.js';

const z = zoneFor(TZ);
const at = (day: number, hhmm: string): number => z.wallOnDayUtc(z.addLocalDays('2026-09-14', day), hhmm);

/**
 * `uq_dose_live` allows one live dose per medicine. Any plan that frees the slot and
 * refills it in the same pass must emit those in that order, or the database rejects the
 * insert and the tick fails -- wedging the exact medicine the roll-forward is meant to
 * keep moving. The database enforces this; these assert the planner never asks for the
 * impossible in the first place.
 */
describe('action ordering against the one-live-dose constraint', () => {
  it('resolves the outgoing dose before creating its successor', () => {
    const w = new World({
      start: at(0, '08:00'),
      patient: {
        wakeState: 'awake', wakeConfidence: 'confirmed', wakeStateSince: at(0, '07:00'),
        lastWakeAt: at(0, '07:00'), presumedSleepAt: '23:59', eveningPollAt: '23:50',
      },
      meds: [makeMed({ id: 1, medKey: 'drop_a', intervalMs: 2 * HOUR, minGapMs: 90 * MINUTE })],
      chats: [makeChat({ chatId: 100 })],
    });

    // Ignore it long enough that the dose has to roll forward.
    let sawRollForward = false;
    for (let i = 0; i < 5 * 60; i++) {
      const actions = plan(w.state, w.now, w.z);

      // Replay the database's rule: a createDose for a medicine whose live dose has not
      // yet been resolved earlier in this same list is exactly the failure we hit.
      const freed = new Set<number>();
      for (const a of actions) {
        if (a.t === 'resolveDose') {
          const d = w.state.liveDoses.find((x) => x.id === a.doseId);
          if (d !== undefined) freed.add(d.medId);
        }
        if (a.t === 'createDose') {
          const occupied = w.state.liveDoses.some((d) => d.medId === a.medId);
          if (occupied) {
            sawRollForward = true;
            expect(
              freed.has(a.medId),
              'createDose for a medicine whose live dose was not resolved first — this is the UNIQUE violation',
            ).toBe(true);
          }
        }
      }

      w.tick();
      w.now += MINUTE;
    }

    expect(sawRollForward, 'the roll-forward path never ran, so nothing was actually tested').toBe(true);
  });

  it('never leaves a medicine without a live dose after a roll-forward', () => {
    const w = new World({
      start: at(0, '08:00'),
      patient: {
        wakeState: 'awake', wakeConfidence: 'confirmed', wakeStateSince: at(0, '07:00'),
        lastWakeAt: at(0, '07:00'), presumedSleepAt: '23:59', eveningPollAt: '23:50',
      },
      meds: [makeMed({ id: 1, medKey: 'drop_a', intervalMs: 2 * HOUR, minGapMs: 90 * MINUTE })],
      chats: [makeChat({ chatId: 100 })],
    });
    w.respectSchedule = true;
    w.run(8 * HOUR);

    expect(w.countByStatus('drop_a', 'missed')).toBeGreaterThanOrEqual(2);
    expect(w.state.liveDoses.length, 'medicine wedged after rolling forward').toBe(1);
  });
});
