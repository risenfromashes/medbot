/**
 * The shapes the planner reasons about, and the actions it may ask for.
 *
 * Everything here is plain data. `plan()` receives a `PatientState` snapshot and returns
 * `Action[]`; it never performs I/O, so the entire decision layer can be simulated for a
 * week of virtual time in milliseconds.
 */

import type { LocalDay } from './tz.js';

// ---------------------------------------------------------------------------
// Day state
// ---------------------------------------------------------------------------

/**
 * There is deliberately no 'unknown'. An unknown state that only a human can clear is an
 * absorbing one: leave your phone charging and the bot goes silent for a day without ever
 * noticing. Instead the state is always awake or asleep, and `confidence` records how we
 * know. A `presumed` awake fires medicines normally; a `presumed` asleep suppresses only
 * non-critical ones. Being wrong and noisy is recoverable, being wrong and silent is not.
 */
export type WakeState = 'awake' | 'asleep';

export type WakeConfidence =
  /** The patient told us. */
  | 'confirmed'
  /** They sent the bot something, so they are demonstrably up. */
  | 'inferred'
  /** The clock passed the configured fallback time and nobody said otherwise. */
  | 'presumed';

// ---------------------------------------------------------------------------
// Doses
// ---------------------------------------------------------------------------

export type DoseStatus =
  | 'scheduled'
  /** Came due while the patient was asleep; parked until they wake. */
  | 'deferred'
  | 'due'
  | 'prompted'
  | 'taken'
  | 'skipped'
  /** Rolled forward unanswered when the next dose came due, or corrected away. */
  | 'missed'
  /** Invalidated by a prescription change or a timezone move. */
  | 'cancelled';

/** A dose in one of these states occupies the single live slot for its medicine. */
export const LIVE_DOSE_STATUSES = ['scheduled', 'deferred', 'due', 'prompted'] as const;
export const LIVE_SET: ReadonlySet<DoseStatus> = new Set(LIVE_DOSE_STATUSES);
export function isLive(status: DoseStatus): boolean {
  return LIVE_SET.has(status);
}

export type AnchorKind = 'grid' | 'actual' | 'wake' | 'meal' | 'step' | 'manual';
export type ResolutionSource = 'button' | 'command' | 'auto' | 'import' | 'correction';

export interface Dose {
  id: number;
  patientId: number;
  medId: number;
  /** Which cycle of the medicine this belongs to. */
  seq: number;
  /** Which step within a spacing group. 0 for an ordinary single-step medicine. */
  step: number;
  localDay: LocalDay;
  /** Where the schedule said this dose should land. The drift-absorption anchor. */
  plannedDueAt: number;
  /** Where it actually lands after step spacing, sleep deferral and nudges. */
  effectiveDueAt: number;
  anchorKind: AnchorKind;
  status: DoseStatus;
  takenAt: number | null;
  resolvedAt: number | null;
  resolvedByChat: number | null;
  resolutionSrc: ResolutionSource | null;
  nagCount: number;
  firstPromptAt: number | null;
  promptId: number | null;
}

// ---------------------------------------------------------------------------
// Medicines
// ---------------------------------------------------------------------------

export type ScheduleKind =
  /** Every N ms, anchored on the actual last dose (see `DriftPolicy`). */
  | 'interval'
  /** At specific wall-clock times. `times_per_day` compiles down to this at import. */
  | 'fixed_times'
  /** Relative to a meal event. */
  | 'meal'
  /** Never fires on its own; `/took` records it against a min-gap and a daily cap. */
  | 'as_needed';

export type DriftPolicy =
  /**
   * Default. Acknowledging within `driftToleranceMs` of the scheduled time re-anchors the
   * next dose on the *scheduled* time, so ordinary human lag does not accumulate. Answer
   * later than that -- a genuinely missed dose -- and it re-anchors on when you really
   * took it. Without this an every-8h course drifts about an hour a day and walks its
   * evening dose into the middle of the night by day four.
   */
  | 'absorb'
  /** Always anchor on the actual time. Simple and literal. */
  | 'strict_actual'
  /** Never move the grid; lateness never shifts the next dose. */
  | 'strict_grid';

export interface MealRef {
  meal: string;
  relation: 'before' | 'after' | 'with';
  offsetMs: number;
}

export interface MedSpec {
  kind: ScheduleKind;
  intervalMs?: number;
  /** For `interval`: whether the day's first dose hangs off the wake-up time. */
  anchor?: 'wake' | 'clock';
  times?: string[];
  meal?: MealRef;
}

/**
 * One item within a medicine. A medicine with several steps is a spacing group: three eye
 * drops that must be ten minutes apart are one medicine with three steps, not three
 * medicines plus a constraint layer. That makes the "only one of them may be pending at a
 * time" rule fall straight out of the one-live-dose-per-medicine index, and it means an
 * unanswered first drop can never strand the other two.
 */
export interface Step {
  name: string;
  dose?: string;
  note?: string;
}

export interface NagPolicy {
  /** Gaps between nudges; the final value repeats forever. Never gives up. */
  stepsMs: number[];
  /** Silence for this long pushes the prompt up to the next escalation tier. */
  escalateAfterMs: number;
}

export type CourseKind = 'days' | 'doses' | 'until' | 'indefinite';
export type MedStatus = 'active' | 'completed' | 'discontinued' | 'paused';

export interface Medicine {
  id: number;
  patientId: number;
  /** Stable identity across re-imports, so a new prescription preserves course progress. */
  medKey: string;
  name: string;
  doseText: string | null;
  notes: string | null;
  kind: ScheduleKind;
  spec: MedSpec;
  specHash: string;
  steps: Step[];
  /** Gap between consecutive steps. Zero for a single-step medicine. */
  stepSpacingMs: number;
  intervalMs: number | null;
  /** Hard safety floor between two doses of this medicine. Never overridden by anything. */
  minGapMs: number;
  /** Delay after waking before the first dose of the day. */
  onsetOffsetMs: number;
  maxPerDay: number | null;
  awakeOnly: boolean;
  /** Pierces sleep and quiet hours. For medicines that genuinely must be taken at 03:00. */
  critical: boolean;
  driftPolicy: DriftPolicy;
  driftToleranceMs: number;
  /** Beyond this much lateness the dose is logged missed rather than prompted stale. */
  catchupGraceMs: number;
  nagPolicy: NagPolicy;
  /** May share a message with other medicines due at the same time. */
  mergeable: boolean;
  courseKind: CourseKind;
  courseDays: number | null;
  courseDoses: number | null;
  courseUntil: number | null;
  startedAt: number | null;
  dosesTaken: number;
  dosesMissed: number;
  /** The last step taken, of any cycle. Anchors step spacing and the min-gap floor. */
  lastTakenAt: number | null;
  /** When step 0 of the last cycle was taken. Anchors the interval. */
  lastCycleStartAt: number | null;
  /** Where the schedule wanted that cycle to start. Anchors drift absorption. */
  lastPlannedDueAt: number | null;
  nextSeq: number;
  /** Which step of the current cycle comes next. */
  nextStep: number;
  status: MedStatus;
}

// ---------------------------------------------------------------------------
// Patients, chats, meals
// ---------------------------------------------------------------------------

export interface Patient {
  id: number;
  displayName: string;
  tz: string;
  morningPollAt: string;
  /** Past this local time, presume awake and start dosing whatever the patient has said. */
  presumedWakeAt: string;
  eveningPollAt: string;
  presumedSleepAt: string;
  quietStart: string | null;
  quietEnd: string | null;
  wakeState: WakeState;
  wakeConfidence: WakeConfidence;
  wakeStateSince: number;
  lastWakeAt: number | null;
  lastSleepAt: number | null;
  /** Any inbound message. Demonstrates the patient is up without having to ask. */
  lastActivityAt: number | null;
  localDay: LocalDay | null;
  digestAt: string;
  pausedUntil: number | null;
  /** Earliest instant the planner wants to be woken. The whole timer wheel, in one column. */
  nextActionAt: number | null;
}

/**
 * A chat linked to a patient. `escalationTier` 0 is the patient's own chat and gets every
 * prompt immediately; tier 1 is a caregiver, who is only pulled in once a prompt has gone
 * unanswered for `escalateAfterMs`. A caregiver chat needs no patient record of its own.
 */
export interface Chat {
  chatId: number;
  patientId: number;
  role: 'patient' | 'caregiver';
  canAck: boolean;
  escalationTier: number;
  escalateAfterMs: number;
  active: boolean;
}

export interface MealDef {
  patientId: number;
  meal: string;
  /** Drives "30 min before breakfast", which cannot wait for a confirmation. */
  typicalLocal: string;
  askAfterLocal: string;
  presumeAtLocal: string | null;
}

export interface MealEvent {
  patientId: number;
  meal: string;
  localDay: LocalDay;
  at: number;
  source: 'confirmed' | 'presumed' | 'skipped';
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

export type PromptKind = 'dose' | 'wake' | 'sleep' | 'meal' | 'info';
export type PromptState = 'open' | 'resolved' | 'expired' | 'cancelled';

export interface PromptBody {
  kind: PromptKind;
  /** Doses covered, for a dose prompt. Several when unspaced medicines merge. */
  doseIds: number[];
  meal?: string;
  text?: string;
}

export interface Prompt {
  id: number;
  patientId: number;
  kind: PromptKind;
  state: PromptState;
  body: PromptBody;
  nudgeCount: number;
  lastNudgeAt: number | null;
  /** How far up the escalation ladder this prompt has already been sent. */
  escalatedTier: number;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// The planner's input
// ---------------------------------------------------------------------------

export interface PatientState {
  patient: Patient;
  chats: Chat[];
  meds: Medicine[];
  /** Only doses in a live status. At most one per medicine, by database constraint. */
  liveDoses: Dose[];
  openPrompts: Prompt[];
  mealDefs: MealDef[];
  /** Meal events for the current local day only. */
  mealEvents: MealEvent[];
  /** Doses taken and missed today, per medicine id. Drives `maxPerDay`. */
  dayCounters: Map<number, { taken: number; missed: number }>;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * New rows are referenced before they exist, so the planner mints negative placeholder
 * ids and the database layer swaps in real ones when it applies the batch.
 */
export type TempId = number;

export type Action =
  | { t: 'setWake'; state: WakeState; confidence: WakeConfidence; at: number; source: string }
  | { t: 'rollDay'; localDay: LocalDay }
  | {
      t: 'createDose';
      id: TempId;
      medId: number;
      seq: number;
      step: number;
      localDay: LocalDay;
      plannedDueAt: number;
      effectiveDueAt: number;
      anchorKind: AnchorKind;
    }
  | { t: 'retimeDose'; doseId: number; effectiveDueAt: number; anchorKind?: AnchorKind }
  | { t: 'setDoseStatus'; doseId: number; status: DoseStatus }
  | {
      t: 'resolveDose';
      doseId: number;
      status: 'taken' | 'skipped' | 'missed' | 'cancelled';
      at: number;
      takenAt: number | null;
      byChat: number | null;
      src: ResolutionSource;
    }
  | { t: 'completeMed'; medId: number; reason: string }
  | { t: 'createPrompt'; id: TempId; kind: PromptKind; body: PromptBody; tier: number }
  | { t: 'nudgePrompt'; promptId: number; at: number }
  | { t: 'escalatePrompt'; promptId: number; tier: number; at: number }
  | { t: 'closePrompt'; promptId: number; state: PromptState; at: number }
  | { t: 'recordMeal'; meal: string; localDay: LocalDay; at: number; source: MealEvent['source'] }
  | { t: 'setNextAction'; at: number | null }
  | { t: 'note'; kind: string; detail: Record<string, unknown> };

/** A small helper so the planner can mint placeholder ids without touching global state. */
export function tempIds(): () => TempId {
  let n = 0;
  return () => --n;
}
