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

/**
 * One phase of a tapering course: a schedule, and how many days it runs before the next
 * phase takes over. "4 times a day for 7 days, then 3 times a day for 7 days" is two of
 * these, and it is an entirely routine thing for an eye prescription to say.
 */
export interface Phase {
  spec: MedSpec;
  intervalMs: number | null;
  days: number;
  label?: string;
}

export interface MedSpec {
  kind: ScheduleKind;
  intervalMs?: number;
  /** For `interval`: whether the day's first dose hangs off the wake-up time. */
  anchor?: 'wake' | 'clock';
  /**
   * How many doses a day the prescription asked for, when it said so as a count.
   *
   * "Four times a day" is compiled to an interval across the waking hours, and the four
   * used to be thrown away at that point -- so nothing downstream knew the day's quota
   * was met, and a fifth dose was cheerfully computed for quarter past three in the
   * morning. It decides whether a dose landing past bedtime is worth pulling forward or
   * simply belongs to tomorrow.
   */
  dosesPerDay?: number;
  times?: string[];
  meal?: MealRef;
  /**
   * Several meals a day -- "1+0+1 before food" is one medicine tied to both breakfast and
   * dinner. Each dose anchors on whichever of them comes next, so the tablet follows the
   * meals the patient actually reports rather than a clock time standing in for them.
   */
  meals?: MealRef[];
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
  /**
   * Medicines sharing this name must not be prompted within `spacingMs` of each other --
   * eye drops needing ten minutes between them. Unlike the old group model this is a
   * constraint, not a merge: each medicine keeps its own schedule and its own course.
   */
  spacingGroup: string | null;
  spacingMs: number;
  /** Explicit order within a spacing group, when the prescription gives one. */
  groupSeq: number | null;
  /** A tapering course. Null for the ordinary single-phase case. */
  phases: Phase[] | null;
  phaseIndex: number;
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
  /**
   * The shortest stretch that counts as a night's sleep.
   *
   * Nothing the clock says can declare the patient awake before this has elapsed, so
   * going to bed at five in the morning does not get you a 06:30 "are you awake?" and a
   * 09:00 start to the day. An explicit /awake always wins -- the person is the
   * authority; this only governs what the bot is allowed to assume.
   */
  minSleepMs: number;
  /**
   * Tonight's bedtime as currently understood -- the reference time to begin with, then
   * whatever the patient last said when asked. Null before the day's first tick.
   *
   * This, not `presumedSleepAt`, is what the evening is planned around. The wall time is
   * where the negotiation starts; this is where it has got to.
   */
  expectedSleepAt: number | null;
  /** While asleep: the earliest the bot will start asking whether they are up. */
  expectedWakeAt: number | null;
  lastWakeCheckAt: number | null;
  /** Leads for the two "still turning in?" prompts before the expected bedtime. */
  bedLeadFirstMs: number;
  bedLeadSecondMs: number;
  /** How long outstanding reminders keep going after the expected bedtime. */
  postBedGraceMs: number;
  /** How often to ask whether they are up, once the minimum sleep has elapsed. */
  wakeCheckEveryMs: number;
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
  /** Local day the daily digest was last sent, so it fires once whatever the tick cadence. */
  lastDigestDay: LocalDay | null;
  /** When the liveness watchdog last ran. */
  lastWatchdogAt: number | null;
}

/**
 * A chat linked to a patient. `escalationTier` 0 is the patient's own chat and gets every
 * prompt immediately; tier 1 is a caregiver, who is only pulled in once a prompt has gone
 * unanswered for `escalateAfterMs`. A caregiver chat needs no patient record of its own.
 */
export interface Chat {
  chatId: number;
  patientId: number;
  /** Who this chat belongs to, so lists name people rather than numbers. */
  displayName: string | null;
  role: 'patient' | 'caregiver';
  canAck: boolean;
  escalationTier: number;
  escalateAfterMs: number;
  active: boolean;
}

export interface MealDef {
  patientId: number;
  meal: string;
  /** A hint of last resort, used only when there is nothing better to go on. */
  typicalLocal: string;
  askAfterLocal: string;
  presumeAtLocal: string | null;
  /**
   * When to first ask about this meal, measured from waking rather than from the clock.
   * Someone who gets up at noon is not late for breakfast.
   */
  afterWakeMs: number | null;
  /** And not sooner than this after the previous meal, so questions do not bunch up. */
  minGapAfterPrevMs: number;
  seq: number;
}

export interface MealEvent {
  patientId: number;
  meal: string;
  localDay: LocalDay;
  at: number;
  /** `planned` is what the patient said they were about to do; the rest is what happened. */
  source: 'planned' | 'confirmed' | 'presumed' | 'skipped';
  plannedAt: number | null;
  askedAt: number | null;
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

export type PromptKind =
  | 'dose'
  | 'meal'
  | 'info'
  /** "Are you up?" -- the periodic check, and the one triggered by late-night activity. */
  | 'wake'
  /**
   * Bedtime. With `bedStage` on the body it is the negotiation -- "still turning in at
   * one? sleep now / -30 / on time / +30 / +1h" -- and without it, the older bare
   * "heading to bed?", which open rows from before the change still carry.
   */
  | 'sleep';
export type PromptState = 'open' | 'resolved' | 'expired' | 'cancelled';

export interface PromptBody {
  kind: PromptKind;
  /** Doses covered, for a dose prompt. Several when unspaced medicines merge. */
  doseIds: number[];
  meal?: string;
  /**
   * Which question is being asked about the meal. `plan` proposes a time and asks whether
   * it is right -- asked far enough ahead that a before-meal tablet still has time to be
   * taken. `confirm` asks, at that time, whether the meal is actually happening.
   */
  stage?: 'plan' | 'confirm';
  /** The time being proposed, so the question can name it rather than ask openly. */
  proposedAt?: number;
  /**
   * Which of the two pre-bed questions this is. Its presence is also what marks a sleep
   * prompt as the negotiated kind rather than the old bare one.
   */
  bedStage?: 'first' | 'second';
  /** Medicines worth taking before bed, named in the bedtime prompt. */
  beforeBed?: Array<{ doseId: number; label: string; at: number }>;
  /** For a dose prompt tied to an upcoming meal, so the message can say why. */
  beforeMeal?: { meal: string; inMs: number };
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
  /** Move tonight's expected bedtime, or the estimate of when they will be up. */
  | { t: 'setExpectedSleep'; at: number | null }
  | { t: 'setExpectedWake'; at: number | null }
  | { t: 'markWakeCheck'; at: number }
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
  | { t: 'advancePhase'; medId: number; phaseIndex: number; label: string }
  | { t: 'createPrompt'; id: TempId; kind: PromptKind; body: PromptBody; tier: number }
  | { t: 'nudgePrompt'; promptId: number; at: number }
  | { t: 'escalatePrompt'; promptId: number; tier: number; at: number }
  | { t: 'closePrompt'; promptId: number; state: PromptState; at: number }
  | { t: 'setPromptBody'; promptId: number; body: PromptBody }
  | {
      t: 'recordMeal';
      meal: string;
      localDay: LocalDay;
      at: number;
      source: MealEvent['source'];
      plannedAt?: number | null;
    }
  | { t: 'closeMealPrompt'; meal: string }
  | { t: 'setNextAction'; at: number | null }
  /** A message that needs no answer: digests, watchdog alerts, course completions. */
  | { t: 'sendInfo'; text: string; tier: number; dedupe: string; priority?: number }
  | { t: 'markDigestSent'; localDay: LocalDay }
  | { t: 'markWatchdogRun'; at: number }
  | { t: 'note'; kind: string; detail: Record<string, unknown> };

/** A small helper so the planner can mint placeholder ids without touching global state. */
export function tempIds(): () => TempId {
  let n = 0;
  return () => --n;
}
