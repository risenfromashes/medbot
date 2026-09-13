/**
 * When is the next dose due?
 *
 * Pure functions only. Everything here takes a medicine, the facts about the patient's
 * day, and an instant, and returns a number. No I/O, no clock, no randomness -- which is
 * what lets a test drive a seven-day course through this in a few milliseconds.
 *
 * Vocabulary: a medicine has one or more *steps* (three eye drops are one medicine with
 * three steps). One pass through all the steps is a *cycle*. The schedule governs when a
 * cycle starts; `stepSpacingMs` governs the gaps inside it.
 */

import type { Medicine, PatientState, Phase } from './domain.js';
import type { LocalDay, Zone } from './tz.js';
import { DAY_MS, HOUR } from './tz.js';

export interface DayFacts {
  /** Where the day's wake anchor sits, for `anchor: 'wake'` medicines. */
  wakeAnchor: number;
  awake: boolean;
  localDay: LocalDay;
  /** Resolved or predicted instants for each meal, keyed by meal id. */
  meals: Map<string, { at: number; confirmed: boolean }>;
}

export interface DueResult {
  /** Where the schedule wanted this cycle. Anchors the next round of drift absorption. */
  plannedDueAt: number;
  /** Where it actually lands after the safety floor and the daily cap. */
  effectiveDueAt: number;
  anchorKind: 'grid' | 'actual' | 'wake' | 'meal' | 'step';
  /** Cycles skipped wholesale because the medicine was left unattended for ages. */
  skipped: number;
  /** Set when the medicine cannot be scheduled yet, e.g. an after-meal dose pre-meal. */
  blocked?: 'awaiting_meal';
}

/**
 * Which phase of a tapering course is in force, and how far into it we are.
 *
 * Phases are measured in local days from when the medicine started, so a taper advances
 * on the day boundary the patient experiences rather than on a rolling 24-hour clock.
 */
export function activePhase(
  med: Medicine,
  z: Zone,
  today: LocalDay,
): { index: number; phase: Phase | null; done: boolean } {
  if (med.phases === null || med.phases.length === 0) return { index: 0, phase: null, done: false };
  if (med.startedAt === null) return { index: 0, phase: med.phases[0] ?? null, done: false };

  const elapsed = z.diffLocalDays(z.localDay(med.startedAt), today);
  let cursor = 0;
  for (let i = 0; i < med.phases.length; i++) {
    const phase = med.phases[i]!;
    if (elapsed < cursor + phase.days) return { index: i, phase, done: false };
    cursor += phase.days;
  }
  return { index: med.phases.length - 1, phase: med.phases[med.phases.length - 1] ?? null, done: true };
}

/** The medicine as it behaves right now, with the active phase's schedule applied. */
export function effectiveMed(med: Medicine, z: Zone, today: LocalDay): Medicine {
  const { phase } = activePhase(med, z, today);
  if (phase === null) return med;
  return { ...med, kind: phase.spec.kind, spec: phase.spec, intervalMs: phase.intervalMs };
}

/**
 * The raw schedule time for the next cycle, before any safety clamping.
 * Returns null when the schedule cannot answer yet.
 */
function rawCycleStart(
  med: Medicine,
  facts: DayFacts,
  now: number,
  z: Zone,
): { at: number; anchor: DueResult['anchorKind'] } | null {
  switch (med.kind) {
    case 'interval': {
      const interval = med.intervalMs ?? HOUR;
      const onWake = med.spec.anchor === 'wake';

      // The first cycle of *this* waking day.
      //
      // Not just the first ever: if nothing has been taken since the patient got up, the
      // day starts from when they got up. That matters when they surface at noon after
      // the bot had already presumed them awake at nine -- saying "I'm up" has to move the
      // whole schedule to noon, not continue a grid anchored on a morning that did not
      // happen. The min-gap floor applied by the caller still prevents a double dose if
      // they did take something just beforehand.
      const staleCycle = med.lastCycleStartAt === null || (onWake && med.lastCycleStartAt < facts.wakeAnchor);
      if (staleCycle) {
        if (onWake) {
          return { at: Math.max(facts.wakeAnchor + med.onsetOffsetMs, now), anchor: 'wake' };
        }
        if (med.lastCycleStartAt === null) return { at: now, anchor: 'actual' };
      }

      const lastCycleStartAt = med.lastCycleStartAt ?? now;
      switch (med.driftPolicy) {
        case 'strict_actual':
          return { at: lastCycleStartAt + interval, anchor: 'actual' };

        case 'strict_grid':
          return {
            at: (med.lastPlannedDueAt ?? lastCycleStartAt) + interval,
            anchor: 'grid',
          };

        case 'absorb': {
          // The default, and the reason a week-long course does not walk into the night.
          // A dose acknowledged within tolerance of its scheduled time keeps the grid; a
          // genuinely late one re-bases on when it was actually taken, which is the
          // "I missed it, carry on from here" behaviour people expect.
          const planned = med.lastPlannedDueAt;
          if (planned !== null && lastCycleStartAt <= planned + med.driftToleranceMs) {
            return { at: planned + interval, anchor: 'grid' };
          }
          return { at: lastCycleStartAt + interval, anchor: 'actual' };
        }
      }
    }

    case 'fixed_times': {
      const times = med.spec.times ?? [];
      if (times.length === 0) return null;
      // The next slot strictly after the later of now and the previous cycle, searching
      // today and then tomorrow. wallOnDayUtc handles the DST gap and repeat internally.
      const after = Math.max(now, med.lastCycleStartAt ?? 0);
      let best: number | null = null;
      for (const day of [z.addLocalDays(facts.localDay, -1), facts.localDay, z.addLocalDays(facts.localDay, 1)]) {
        for (const t of times) {
          const at = z.wallOnDayUtc(day, t);
          if (at > after && (best === null || at < best)) best = at;
        }
      }
      return best === null ? null : { at: best, anchor: 'grid' };
    }

    case 'meal': {
      const ref = med.spec.meal;
      if (ref === undefined) return null;
      const m = facts.meals.get(ref.meal);
      if (m === undefined) return null;

      if (ref.relation === 'before') {
        // Fires against the *prediction*: by the time someone confirms they have eaten,
        // the "30 minutes before" window is already gone.
        return { at: m.at - ref.offsetMs, anchor: 'meal' };
      }
      if (ref.relation === 'with') return { at: m.at, anchor: 'meal' };
      // 'after' genuinely needs the meal to have happened.
      if (!m.confirmed) return null;
      return { at: m.at + ref.offsetMs, anchor: 'meal' };
    }

    case 'as_needed':
      // Never schedules itself. `/took` records it against the min gap and daily cap.
      return null;
  }
}

/**
 * How long an unanswered dose is allowed to stay pending before it rolls forward.
 *
 * The bot never stops nagging, but a prompt must not be able to wedge a medicine: when
 * the *next* dose would be due, the outstanding one is logged missed and the chain moves
 * on. Without this, one ignored reminder silently freezes that medicine for good.
 */
export function rollForwardAfter(med: Medicine): number {
  switch (med.kind) {
    case 'interval':
      return Math.max(med.intervalMs ?? HOUR, 30 * 60_000);
    case 'fixed_times': {
      const n = med.spec.times?.length ?? 1;
      return Math.max(Math.floor(DAY_MS / Math.max(n, 1)), HOUR);
    }
    default:
      return 4 * HOUR;
  }
}

/** True when the course has run its length and the medicine should stop. */
export function courseComplete(med: Medicine, now: number, z: Zone, today: LocalDay): boolean {
  // A tapering course runs until its last phase has run out, whatever courseKind says.
  if (med.phases !== null && med.phases.length > 0) {
    if (med.startedAt === null) return false;
    const total = med.phases.reduce((n, p) => n + p.days, 0);
    return z.diffLocalDays(z.localDay(med.startedAt), today) >= total;
  }
  switch (med.courseKind) {
    case 'indefinite':
      return false;
    case 'doses':
      return med.courseDoses !== null && med.dosesTaken >= med.courseDoses;
    case 'until':
      return med.courseUntil !== null && now >= med.courseUntil;
    case 'days': {
      if (med.courseDays === null || med.startedAt === null) return false;
      const startDay = z.localDay(med.startedAt);
      return z.diffLocalDays(startDay, today) >= med.courseDays;
    }
  }
}

/**
 * The next due time for a medicine that has no live dose, fully clamped.
 *
 * The clamping order matters and is the safety-critical part of this module:
 *   1. the schedule proposes a time;
 *   2. absurd lateness is collapsed in closed form rather than replayed dose by dose;
 *   3. the min-gap floor is applied -- the one rule nothing may override;
 *   4. a medicine already at its daily cap is pushed into tomorrow.
 */
export function nextDue(
  med: Medicine,
  state: PatientState,
  facts: DayFacts,
  now: number,
  z: Zone,
): DueResult | null {
  // Mid-cycle: the next step of a spacing group, measured from the step actually taken.
  // The min-gap floor deliberately does NOT apply here -- it governs the gap between
  // cycles, and applying it to a ten-minute step gap would stall the group for an hour.
  if (med.nextStep > 0) {
    const base = med.lastTakenAt ?? now;
    const at = base + med.stepSpacingMs;
    return { plannedDueAt: at, effectiveDueAt: at, anchorKind: 'step', skipped: 0 };
  }

  const raw = rawCycleStart(med, facts, now, z);
  if (raw === null) {
    return med.kind === 'meal'
      ? { plannedDueAt: 0, effectiveDueAt: 0, anchorKind: 'meal', skipped: 0, blocked: 'awaiting_meal' }
      : null;
  }

  let planned = raw.at;
  let skipped = 0;

  // Closed-form catch-up. A medicine left alone for six hours must not materialise three
  // back-dated prompts, and must not be walked forward in a loop either -- that would
  // burn the CPU budget as easily as it would spam the patient.
  if (planned < now - med.catchupGraceMs) {
    const interval = med.kind === 'interval' ? (med.intervalMs ?? 0) : 0;
    if (interval > 0) {
      skipped = Math.ceil((now - med.catchupGraceMs - planned) / interval);
      planned += skipped * interval;
    } else {
      // Non-interval schedules re-derive forwards from now instead.
      const again = rawCycleStart({ ...med, lastCycleStartAt: now }, facts, now, z);
      if (again !== null) {
        skipped = 1;
        planned = again.at;
      }
    }
  }

  let effective = planned;

  // The hard safety floor. This is the single check standing between the scheduler and a
  // double dose -- it survives the wake anchor, a meal moving, a retrospective
  // correction and a re-import, and it is never conditional on anything.
  if (med.lastCycleStartAt !== null) {
    effective = Math.max(effective, med.lastCycleStartAt + med.minGapMs);
  }
  if (med.lastTakenAt !== null) {
    effective = Math.max(effective, med.lastTakenAt + Math.min(med.minGapMs, med.stepSpacingMs || med.minGapMs));
  }

  // Daily cap, counted in the patient's local days, not rolling 24-hour windows.
  if (med.maxPerDay !== null) {
    const taken = state.dayCounters.get(med.id)?.taken ?? 0;
    if (taken >= med.maxPerDay) {
      effective = Math.max(effective, z.startOfLocalDay(z.addLocalDays(facts.localDay, 1)));
    }
  }

  return { plannedDueAt: planned, effectiveDueAt: effective, anchorKind: raw.anchor, skipped };
}

/**
 * Where a dose parked overnight should land once the patient is actually up.
 * Still subject to the min-gap floor: waking up is not a licence to double-dose, which is
 * exactly the trap of "took it at 06:20 half asleep, tapped I'm awake at 07:00".
 */
export function reviveAtWake(med: Medicine, facts: DayFacts, now: number): number {
  let at = Math.max(facts.wakeAnchor + med.onsetOffsetMs, now);
  if (med.nextStep > 0) {
    if (med.lastTakenAt !== null) at = Math.max(at, med.lastTakenAt + med.stepSpacingMs);
    return at;
  }
  if (med.lastCycleStartAt !== null) at = Math.max(at, med.lastCycleStartAt + med.minGapMs);
  return at;
}
