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
    .filter((t) => t <= statedAt)
    .sort((a, b) => b - a)[0];

  let warning: string | undefined;
  if (previousTaken !== undefined && med.minGapMs > 0) {
    const gap = statedAt - previousTaken;
    if (gap < med.minGapMs) warning = 'min_gap';
  }

  // A live dose is the usual target, provided the stated time is plausibly about it --
  // that is, at or after the point the dose became due, less a little slack for someone
  // who took it slightly early.
  if (live !== null && isLive(live.status)) {
    const slack = Math.min(med.minGapMs, HOUR);
    if (statedAt >= live.effectiveDueAt - slack) {
      return { kind: 'resolve_live', doseId: live.id, takenAt: statedAt, warning };
    }
  }

  // Otherwise the stated time probably belongs to a dose we already gave up on. Find the
  // missed dose whose slot best covers it and correct that one, so the chain re-derives
  // from the truth rather than from an auto-logged miss.
  const candidates = recent
    .filter((d) => (d.status === 'missed' || d.status === 'skipped') && d.plannedDueAt <= statedAt + HOUR)
    .sort((a, b) => Math.abs(a.plannedDueAt - statedAt) - Math.abs(b.plannedDueAt - statedAt));

  const best = candidates[0];
  if (best !== undefined && Math.abs(best.plannedDueAt - statedAt) <= Math.max(med.intervalMs ?? 4 * HOUR, HOUR)) {
    return { kind: 'correct_past', doseId: best.id, takenAt: statedAt, warning };
  }

  return { kind: 'record_only', takenAt: statedAt, warning };
}
