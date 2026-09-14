/**
 * Retrospective acknowledgment: "I took it at 5pm."
 *
 * This is the necessary counterweight to a bot that never stops nagging. You take the
 * drop, forget to tap, and an hour later the dose has been logged missed and the next one
 * computed from the wrong anchor. Without a way to say what actually happened, one
 * forgotten tap permanently skews the schedule -- and the patient learns to ignore the
 * bot, which is the failure mode that matters most.
 *
 * Deciding *which* dose a stated time refers to is pure, so it is tested directly.
 */

import type { Dose, Medicine } from './domain.js';
import { isLive } from './domain.js';
import { HOUR } from './tz.js';

export type RetroOutcome =
  /** Resolve the currently pending dose, backdated to the stated time. */
  | { kind: 'resolve_live'; doseId: number; takenAt: number; warning?: string }
  /** Flip an already-missed dose back to taken and re-derive from there. */
  | { kind: 'correct_past'; doseId: number; takenAt: number; warning?: string }
  /** Nothing to attach it to; record it as a standalone entry. */
  | { kind: 'record_only'; takenAt: number; warning?: string }
  | { kind: 'reject'; reason: string };

/** How far back a stated time may reach before we ask for confirmation. */
export const RETRO_LIMIT_MS = 24 * HOUR;

export interface RetroInput {
  med: Medicine;
  /** The medicine's live dose, if it has one. */
  live: Dose | null;
  /** Recently resolved doses for this medicine, newest first. */
  recent: Dose[];
  statedAt: number;
  now: number;
  /** Set once the user has confirmed an unusually old time. */
  confirmed?: boolean;
}

export function resolveRetro(input: RetroInput): RetroOutcome {
  const { med, live, recent, statedAt, now } = input;

  if (statedAt > now + 60_000) {
    return { kind: 'reject', reason: 'That time is in the future.' };
  }
  if (now - statedAt > RETRO_LIMIT_MS && input.confirmed !== true) {
    return { kind: 'reject', reason: 'needs_confirm' };
  }

  // The min-gap floor applies to a stated time exactly as it does to a scheduled one.
  // Someone mistyping 5pm for 7pm should be questioned, not silently recorded as a
  // double dose -- this is the same rule that stops the scheduler doing it.
  const previousTaken = recent
    .filter((d) => d.status === 'taken' && d.takenAt !== null && d.step === 0)
    .map((d) => d.takenAt!)
    .sort((a, b) => Math.abs(a - statedAt) - Math.abs(b - statedAt))[0];

  // The nearest recorded dose in EITHER direction. Looking only backwards missed the case
  // that matters just as much: a dose already logged at six, and "/took drops 5pm" typed
  // afterwards, is two doses an hour apart -- and went through without a word.
  let warning: string | undefined;
  if (previousTaken !== undefined && med.minGapMs > 0) {
    if (Math.abs(statedAt - previousTaken) < med.minGapMs) warning = 'min_gap';
  }

  // Which slot does the stated time actually mean? Whichever one it sits closest to.
  //
  // Two cases have to come out differently. "I took it at 5" said at 7, when the 5pm dose
  // was already written off as missed, means the 5pm one -- correct that and re-derive.
  // But "I took it at 5" said at 5, when the 5pm dose is simply not due for another hour
  // because they are up early and holding the bottle, means the pending one -- resolve it
  // and let the chain re-base from when they really did it.
  const resolvedCandidates = recent
    .filter((d) => (d.status === 'missed' || d.status === 'skipped') && d.plannedDueAt <= statedAt + HOUR)
    .sort((a, b) => Math.abs(a.plannedDueAt - statedAt) - Math.abs(b.plannedDueAt - statedAt));

  const nearestResolved = resolvedCandidates[0];
  const resolvedDistance = nearestResolved === undefined
    ? Infinity
    : Math.abs(nearestResolved.plannedDueAt - statedAt);
  const liveDistance = live !== null && isLive(live.status)
    ? Math.abs(live.effectiveDueAt - statedAt)
    : Infinity;

  // An already-written-off dose only wins if the stated time genuinely sits nearer to it,
  // and near enough to be about that slot at all.
  const slotWindow = Math.max(med.intervalMs ?? 4 * HOUR, HOUR);
  if (nearestResolved !== undefined && resolvedDistance < liveDistance && resolvedDistance <= slotWindow) {
    return { kind: 'correct_past', doseId: nearestResolved.id, takenAt: statedAt, warning };
  }

  // Otherwise it is about the dose that is currently outstanding -- whether that dose was
  // already due, or is not due for another hour because they took it early. The min-gap
  // warning above still stands; it is flagged rather than refused, because the patient is
  // telling us what happened and the record should say so.
  if (live !== null && isLive(live.status)) {
    return { kind: 'resolve_live', doseId: live.id, takenAt: statedAt, warning };
  }

  return { kind: 'record_only', takenAt: statedAt, warning };
}
