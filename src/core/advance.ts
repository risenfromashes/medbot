/**
 * What resolving a dose does to its medicine.
 *
 * This is shared, on purpose, between the in-memory simulator and the SQL writer. If the
 * two ever computed cycle advancement differently, the seven-day simulation would be
 * validating something other than what production runs, and the tests would be worth
 * nothing.
 */

import type { Dose, Medicine } from './domain.js';

export interface MedAdvance {
  lastTakenAt: number | null;
  lastCycleStartAt: number | null;
  lastPlannedDueAt: number | null;
  nextSeq: number;
  nextStep: number;
  dosesTaken: number;
  dosesMissed: number;
  startedAt: number | null;
}

export type Resolution = 'taken' | 'skipped' | 'missed' | 'cancelled';

export function advanceMedicine(
  med: Medicine,
  dose: Pick<Dose, 'seq' | 'step' | 'plannedDueAt'>,
  resolution: Resolution,
  takenAt: number | null,
): MedAdvance {
  const stepCount = Math.max(med.steps.length, 1);
  const isLastStep = dose.step >= stepCount - 1;

  const base: MedAdvance = {
    lastTakenAt: med.lastTakenAt,
    lastCycleStartAt: med.lastCycleStartAt,
    lastPlannedDueAt: med.lastPlannedDueAt,
    nextSeq: med.nextSeq,
    nextStep: med.nextStep,
    dosesTaken: med.dosesTaken,
    dosesMissed: med.dosesMissed,
    startedAt: med.startedAt,
  };

  if (resolution === 'cancelled') {
    // Invalidated by a prescription change or a timezone move. The same slot will be
    // recomputed from scratch; nothing about the medicine's history moves.
    return base;
  }

  if (resolution === 'taken') {
    const at = takenAt ?? dose.plannedDueAt;
    base.lastTakenAt = at;
    if (base.startedAt === null) base.startedAt = at;

    if (dose.step === 0) {
      // A cycle has begun. These two fields together are what the drift policy reads:
      // where the cycle actually started, and where the grid wanted it.
      base.lastCycleStartAt = at;
      base.lastPlannedDueAt = dose.plannedDueAt;
    }

    if (isLastStep) {
      base.nextSeq = dose.seq + 1;
      base.nextStep = 0;
      base.dosesTaken = med.dosesTaken + 1;
    } else {
      base.nextSeq = dose.seq;
      base.nextStep = dose.step + 1;
    }
    return base;
  }

  // Skipped or missed. The cycle is abandoned -- a spacing group does not continue to
  // drops two and three once drop one has gone -- and the grid advances so the next
  // cycle lands where the schedule always intended rather than chasing a stale anchor.
  base.nextSeq = dose.seq + 1;
  base.nextStep = 0;
  if (resolution === 'missed') base.dosesMissed = med.dosesMissed + 1;

  if (dose.step === 0) {
    base.lastPlannedDueAt = dose.plannedDueAt;
    // Advance the actual-time anchor to the planned time too, so `strict_actual` keeps
    // its grid instead of falling behind and triggering catch-up. As this also feeds the
    // min-gap floor it errs towards waiting longer, which is the safe direction.
    base.lastCycleStartAt = Math.max(med.lastCycleStartAt ?? 0, dose.plannedDueAt);
  }
  return base;
}
