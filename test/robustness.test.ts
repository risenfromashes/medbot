import { describe, expect, it } from 'vitest';
import { plan } from '../src/core/plan.js';
import { parsePrescription } from '../src/core/prescription.js';
import { makeMed, makePatient, makeChat, TZ } from './simulate.js';
import { zoneFor, HOUR, MINUTE } from '../src/core/tz.js';
import type { Medicine, PatientState } from '../src/core/domain.js';

const z = zoneFor(TZ);
const NOW = z.wallOnDayUtc('2026-09-14', '12:00');

function stateWith(meds: Medicine[], over: Partial<PatientState> = {}): PatientState {
  return {
    patient: makePatient({ wakeState: 'awake', wakeStateSince: NOW - HOUR, lastWakeAt: NOW - HOUR }),
    chats: [makeChat({ chatId: 1 })],
    meds,
    liveDoses: [],
    openPrompts: [],
    mealDefs: [],
    mealEvents: [],
    dayCounters: new Map(),
  dosesSinceWake: new Map(),
    ...over,
  };
}

/**
 * The planner runs unattended every minute against whatever is in the database. If a
 * nonsensical row can make it throw, that patient stops getting reminders and the only
 * sign is an audit entry nobody reads. So it has to survive garbage, not merely
 * well-formed input.
 */
describe('the planner survives nonsense', () => {
  const nasty: Array<[string, Partial<Medicine>]> = [
    ['a zero interval', { intervalMs: 0, spec: { kind: 'interval', intervalMs: 0, anchor: 'wake' } }],
    ['a negative interval', { intervalMs: -5000, spec: { kind: 'interval', intervalMs: -5000, anchor: 'wake' } }],
    ['an absurd interval', { intervalMs: Number.MAX_SAFE_INTEGER }],
    ['a NaN interval', { intervalMs: Number.NaN }],
    ['a null interval on an interval medicine', { kind: 'interval', intervalMs: null }],
    ['no steps at all', { steps: [] }],
    ['a negative min gap', { minGapMs: -1 }],
    ['a NaN min gap', { minGapMs: Number.NaN }],
    ['maxPerDay of zero', { maxPerDay: 0 }],
    ['a negative maxPerDay', { maxPerDay: -3 }],
    ['fixed_times with no times', { kind: 'fixed_times', intervalMs: null, spec: { kind: 'fixed_times', times: [] } }],
    ['fixed_times with a rubbish time', { kind: 'fixed_times', intervalMs: null, spec: { kind: 'fixed_times', times: ['99:99'] } }],
    ['a meal schedule naming no meal', { kind: 'meal', intervalMs: null, spec: { kind: 'meal' } }],
    ['a meal that does not exist', { kind: 'meal', intervalMs: null, spec: { kind: 'meal', meal: { meal: 'brunch', relation: 'before', offsetMs: 0 } } }],
    ['an empty nag policy', { nagPolicy: { stepsMs: [], escalateAfterMs: 0 } }],
    ['a negative nag step', { nagPolicy: { stepsMs: [-1000], escalateAfterMs: -1 } }],
    ['a course of zero days', { courseKind: 'days', courseDays: 0, startedAt: NOW - 10 * HOUR }],
    ['a negative course', { courseKind: 'days', courseDays: -5, startedAt: NOW - 10 * HOUR }],
    ['phases with zero days', { phases: [{ spec: { kind: 'interval', intervalMs: HOUR }, intervalMs: HOUR, days: 0 }], startedAt: NOW - HOUR }],
    ['an empty phase list', { phases: [], startedAt: NOW - HOUR }],
    ['a spacing group with zero spacing', { spacingGroup: 'g', spacingMs: 0 }],
    ['a negative spacing', { spacingGroup: 'g', spacingMs: -60000 }],
    ['a start date in the future', { startedAt: NOW + 100 * HOUR, courseKind: 'days', courseDays: 3 }],
    ['a last dose in the future', { lastTakenAt: NOW + 50 * HOUR, lastCycleStartAt: NOW + 50 * HOUR }],
    ['a step index past the end', { nextStep: 99 }],
  ];

  for (const [label, patch] of nasty) {
    it(`handles ${label}`, () => {
      const med = makeMed({ id: 1, medKey: 'x', ...patch });
      expect(() => plan(stateWith([med]), NOW, z)).not.toThrow();
    });
  }

  it('handles every one of those at once', () => {
    const meds = nasty.map(([, patch], i) => makeMed({ id: i + 1, medKey: `m${i}`, ...patch }));
    expect(() => plan(stateWith(meds), NOW, z)).not.toThrow();
  });

  it('survives a patient with impossible day times', () => {
    const state = stateWith([makeMed({ id: 1, medKey: 'x' })], {
      patient: makePatient({
        morningPollAt: '99:99', presumedWakeAt: '', eveningPollAt: 'nonsense',
        presumedSleepAt: '24:00', digestAt: '-1:00',
        wakeState: 'awake', wakeStateSince: NOW - HOUR,
      }),
    });
    expect(() => plan(state, NOW, z)).not.toThrow();
  });

  it('survives prompts pointing at doses that no longer exist', () => {
    const state = stateWith([makeMed({ id: 1, medKey: 'x' })], {
      openPrompts: [{
        id: 1, patientId: 1, kind: 'dose', state: 'open',
        body: { kind: 'dose', doseIds: [999, 1000] },
        nudgeCount: 0, lastNudgeAt: null, escalatedTier: 0, createdAt: NOW - HOUR,
      }],
    });
    expect(() => plan(state, NOW, z)).not.toThrow();
  });

  it('survives a dose whose medicine has vanished', () => {
    const state = stateWith([], {
      liveDoses: [{
        id: 1, patientId: 1, medId: 404, seq: 1, step: 0, localDay: '2026-09-14',
        plannedDueAt: NOW, effectiveDueAt: NOW, anchorKind: 'grid', status: 'due',
        takenAt: null, resolvedAt: null, resolvedByChat: null, resolutionSrc: null,
        nagCount: 0, firstPromptAt: null, promptId: null,
      }],
    });
    expect(() => plan(state, NOW, z)).not.toThrow();
  });

  it('never asks for a dose at an invalid instant', () => {
    const meds = nasty.map(([, patch], i) => makeMed({ id: i + 1, medKey: `m${i}`, ...patch }));
    const actions = plan(stateWith(meds), NOW, z);
    for (const a of actions) {
      if (a.t === 'createDose') {
        expect(Number.isFinite(a.effectiveDueAt), `${a.medId}: due at ${a.effectiveDueAt}`).toBe(true);
        expect(Number.isFinite(a.plannedDueAt)).toBe(true);
        // Nothing should be scheduled centuries away.
        expect(a.effectiveDueAt).toBeLessThan(NOW + 400 * 24 * HOUR);
      }
      if (a.t === 'retimeDose') expect(Number.isFinite(a.effectiveDueAt)).toBe(true);
      if (a.t === 'setNextAction' && a.at !== null) expect(Number.isFinite(a.at)).toBe(true);
    }
  });

  it('always asks to be woken again, or says explicitly that it need not be', () => {
    const meds = nasty.map(([, patch], i) => makeMed({ id: i + 1, medKey: `m${i}`, ...patch }));
    const actions = plan(stateWith(meds), NOW, z);
    const next = actions.find((a) => a.t === 'setNextAction');
    expect(next, 'the planner never said when to look again — it would go silent').toBeDefined();
  });
});

describe('the prescription parser survives nonsense', () => {
  const junk: unknown[] = [
    null, undefined, 42, 'a string', [], {},
    { medicines: null },
    { medicines: 'not an array' },
    { medicines: [null, 42, 'x', []] },
    { medicines: [{}] },
    { medicines: [{ name: '' }] },
    { medicines: [{ name: 'X', schedule: null }] },
    { medicines: [{ name: 'X', schedule: { type: 'interval', every: -5 } }] },
    { medicines: [{ name: 'X', schedule: { type: 'interval', every: '0h' } }] },
    { medicines: [{ name: 'X', pattern: '9+9+9+9+9' }] },
    { medicines: [{ name: 'X', phases: 'nope' }] },
    { medicines: [{ name: 'X', phases: [{}] }] },
    { medicines: [{ name: 'X', phases: [{ days: -1 }] }] },
    { medicines: [{ name: 'X', schedule: { type: 'fixed_times', times: [null, 5, 'x'] } }] },
    { meals: 'no', groups: 7, medicines: [] },
    { medicines: [{ name: 'X', course: { days: 'lots' } }] },
    { medicines: [{ name: 'X', schedule: { type: 'times_per_day', n: 0 } }] },
    { medicines: [{ name: 'X', schedule: { type: 'times_per_day', n: 500 } }] },
  ];

  for (const [i, doc] of junk.entries()) {
    it(`does not throw on junk input #${i}`, () => {
      expect(() => parsePrescription(doc, { now: NOW })).not.toThrow();
    });
  }

  it('anything it does accept is then safe to plan with', () => {
    for (const doc of junk) {
      const r = parsePrescription(doc, { now: NOW });
      if (!r.ok || r.value === undefined) continue;
      const meds = r.value.meds.map((m, i) => makeMed({
        id: i + 1, medKey: m.medKey, kind: m.kind, spec: m.spec, intervalMs: m.intervalMs,
        minGapMs: m.minGapMs, steps: m.steps, phases: m.phases, courseKind: m.courseKind,
        courseDays: m.courseDays, maxPerDay: m.maxPerDay,
      }));
      expect(() => plan(stateWith(meds), NOW, z)).not.toThrow();
    }
  });
});

describe('the planner terminates', () => {
  it('does not hang on a tiny interval left unattended for a year', () => {
    const med = makeMed({
      id: 1, medKey: 'x', intervalMs: MINUTE, minGapMs: 0,
      spec: { kind: 'interval', intervalMs: MINUTE, anchor: 'clock' },
      lastCycleStartAt: NOW - 365 * 24 * HOUR, lastPlannedDueAt: NOW - 365 * 24 * HOUR,
      lastTakenAt: NOW - 365 * 24 * HOUR, startedAt: NOW - 365 * 24 * HOUR,
    });
    const started = Date.now();
    expect(() => plan(stateWith([med]), NOW, z)).not.toThrow();
    // Closed-form catch-up, not a loop: half a million intervals must not be walked.
    expect(Date.now() - started, 'catch-up appears to be looping').toBeLessThan(500);
  });
});
