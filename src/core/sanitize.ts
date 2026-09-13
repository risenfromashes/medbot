/**
 * Making garbage harmless.
 *
 * The planner runs unattended against whatever is in the database. Rows get there through
 * an importer that validates, but "it was validated once" is an assumption, not a
 * guarantee -- a botched migration, a hand-edited row, a future version writing a field
 * this one does not understand. And the cost of being wrong is the worst one available:
 * an exception in the tick means that patient silently stops being reminded.
 *
 * So every medicine passes through here first and comes out in a shape the scheduler can
 * reason about, however implausible the input. Values are clamped rather than rejected --
 * a medicine with a nonsensical interval should still be asked about at some sane
 * frequency, not dropped.
 */

import type { Medicine, Patient, Phase } from './domain.js';
import { DAY_MS, HOUR, MINUTE, tryParseWall } from './tz.js';

/** Nothing is scheduled more often than this, whatever a row claims. */
const MIN_INTERVAL = 5 * MINUTE;
/** Nor less often than this; beyond a year it is indistinguishable from stopped. */
const MAX_INTERVAL = 365 * DAY_MS;
const MAX_COURSE_DAYS = 3650;

function finite(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function wall(value: string, fallback: string): string {
  const p = tryParseWall(value);
  if (p === null) return fallback;
  return `${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`;
}

function sanePhases(phases: Phase[] | null): Phase[] | null {
  if (phases === null) return null;
  if (!Array.isArray(phases)) return null;
  const out = phases
    .filter((p): p is Phase => p !== null && typeof p === 'object')
    .map((p) => ({
      ...p,
      days: clamp(Math.round(finite(p.days, 1)), 1, MAX_COURSE_DAYS),
      intervalMs: p.intervalMs === null ? null : clamp(finite(p.intervalMs, HOUR), MIN_INTERVAL, MAX_INTERVAL),
      spec: p.spec ?? { kind: 'interval' },
    }));
  // An empty or single-entry phase list is not a taper; treat it as an ordinary course.
  return out.length > 1 ? out : null;
}

export function sanitizeMedicine(med: Medicine): Medicine {
  const steps = Array.isArray(med.steps) && med.steps.length > 0
    ? med.steps.filter((s) => s !== null && typeof s === 'object' && typeof s.name === 'string')
    : [];

  const spec = med.spec !== null && typeof med.spec === 'object' ? med.spec : { kind: med.kind };

  // An interval medicine with no usable interval still has to be asked about; six hours
  // is a defensible stand-in until someone corrects it.
  const rawInterval = med.kind === 'interval'
    ? finite(med.intervalMs ?? spec.intervalMs, 6 * HOUR)
    : finite(med.intervalMs, Number.NaN);
  const intervalMs = Number.isFinite(rawInterval)
    ? clamp(rawInterval, MIN_INTERVAL, MAX_INTERVAL)
    : null;

  // The safety floor may never exceed the interval itself, or the medicine could never
  // become due; and it may never be negative, which would disable it entirely.
  const minGapMs = clamp(
    finite(med.minGapMs, 0),
    0,
    intervalMs === null ? 12 * HOUR : intervalMs,
  );

  const phases = sanePhases(med.phases);

  return {
    ...med,
    steps: steps.length > 0 ? steps : [{ name: typeof med.name === 'string' && med.name !== '' ? med.name : 'your medicine' }],
    name: typeof med.name === 'string' && med.name !== '' ? med.name : 'your medicine',
    spec: { ...spec, ...(intervalMs !== null && spec.kind === 'interval' ? { intervalMs } : {}) },
    intervalMs,
    minGapMs,
    stepSpacingMs: clamp(finite(med.stepSpacingMs, 0), 0, 12 * HOUR),
    spacingMs: clamp(finite(med.spacingMs, 0), 0, 12 * HOUR),
    onsetOffsetMs: clamp(finite(med.onsetOffsetMs, 0), 0, 12 * HOUR),
    // maxPerDay of zero would mean "never", which is a way of going silent; treat any
    // non-positive value as no limit at all.
    maxPerDay: typeof med.maxPerDay === 'number' && Number.isFinite(med.maxPerDay) && med.maxPerDay > 0
      ? Math.round(med.maxPerDay)
      : null,
    driftToleranceMs: clamp(finite(med.driftToleranceMs, 30 * MINUTE), 0, 12 * HOUR),
    catchupGraceMs: clamp(finite(med.catchupGraceMs, HOUR), 0, 7 * DAY_MS),
    nagPolicy: {
      stepsMs: (Array.isArray(med.nagPolicy?.stepsMs) ? med.nagPolicy.stepsMs : [])
        .map((v) => clamp(finite(v, 10 * MINUTE), MINUTE, 6 * HOUR)),
      escalateAfterMs: clamp(finite(med.nagPolicy?.escalateAfterMs, 5 * MINUTE), MINUTE, DAY_MS),
    },
    phases,
    phaseIndex: clamp(Math.round(finite(med.phaseIndex, 0)), 0, phases === null ? 0 : phases.length - 1),
    nextStep: clamp(Math.round(finite(med.nextStep, 0)), 0, Math.max(steps.length - 1, 0)),
    nextSeq: Math.max(1, Math.round(finite(med.nextSeq, 1))),
    courseDays: med.courseDays === null ? null : clamp(Math.round(finite(med.courseDays, 1)), 1, MAX_COURSE_DAYS),
    courseDoses: med.courseDoses === null ? null : clamp(Math.round(finite(med.courseDoses, 1)), 1, 100_000),
    dosesTaken: Math.max(0, Math.round(finite(med.dosesTaken, 0))),
    dosesMissed: Math.max(0, Math.round(finite(med.dosesMissed, 0))),
  };
}

/**
 * A nag ladder with nothing in it would mean never following up, which is the one thing
 * this bot must not do.
 */
export function saneNagSteps(steps: number[]): number[] {
  return steps.length > 0 ? steps : [10 * MINUTE, 15 * MINUTE, 20 * MINUTE, 30 * MINUTE];
}

export function sanitizePatient(patient: Patient): Patient {
  const morning = wall(patient.morningPollAt, '07:00');
  return {
    ...patient,
    displayName: typeof patient.displayName === 'string' && patient.displayName !== '' ? patient.displayName : 'there',
    morningPollAt: morning,
    presumedWakeAt: wall(patient.presumedWakeAt, '09:30'),
    eveningPollAt: wall(patient.eveningPollAt, '22:00'),
    presumedSleepAt: wall(patient.presumedSleepAt, '01:30'),
    digestAt: wall(patient.digestAt, '21:00'),
    wakeState: patient.wakeState === 'awake' ? 'awake' : 'asleep',
    wakeStateSince: finite(patient.wakeStateSince, 0),
    lastWakeAt: patient.lastWakeAt === null ? null : finite(patient.lastWakeAt, 0),
    lastSleepAt: patient.lastSleepAt === null ? null : finite(patient.lastSleepAt, 0),
    // A zero or absurd minimum would either reinstate the bug or lock the patient out of
    // their own day, so it is clamped to something a human night could plausibly be.
    minSleepMs: clamp(finite(patient.minSleepMs, 4 * HOUR), 15 * 60_000, 12 * HOUR),
  };
}
