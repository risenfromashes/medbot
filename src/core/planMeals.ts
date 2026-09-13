/**
 * Meals, without assuming when they happen.
 *
 * Two problems with a fixed meal time. It is wrong -- someone recovering at home who woke
 * at noon is not late for a half-past-eight breakfast. And it makes "half an hour before
 * breakfast" unschedulable, because by the time they confirm they have eaten, the window
 * has gone.
 *
 * So the bot asks *when* they are going to eat, and works backwards from the answer:
 *
 *   1. a while after waking, ask "when are you having breakfast?";
 *   2. they say "in an hour", which fixes a planned time;
 *   3. the before-meal tablet is scheduled for half an hour before that, and its reminder
 *      says why -- "you're eating in about 30 minutes";
 *   4. at the planned time, ask whether they are eating now, which confirms it and
 *      releases anything due after the meal.
 *
 * Every step is a question rather than an assumption, and every step has a fallback so
 * that someone who answers nothing still gets their medicines.
 */

import type { Action, MealDef, MealEvent, PatientState } from './domain.js';
import type { LocalDay, Zone } from './tz.js';
import { HOUR, MINUTE } from './tz.js';

export interface MealFacts {
  /** Per meal id: when to schedule against, and how firm that is. */
  meals: Map<string, { at: number; confirmed: boolean; planned: boolean }>;
  /** Meals the patient has said they are not having today. */
  skipped: Set<string>;
  wakeAt: number | null;
}

/** How often to re-ask an unanswered meal question. */
const MEAL_POLL = 45 * MINUTE;
/** Assumed gap from waking to the first meal of the day. */
const DEFAULT_AFTER_WAKE = 45 * MINUTE;
/**
 * How far ahead of an assumed meal to ask about it.
 *
 * This is the whole point of asking early: a tablet due half an hour before food needs
 * that half hour to exist. The lead is widened to cover the longest before-meal offset of
 * any medicine tied to this meal, so there is always time to take it.
 */
const MIN_LEAD = 30 * MINUTE;
/** How long after a planned time to keep asking before assuming it happened. */
const PRESUME_AFTER_PLAN = 2 * HOUR;

function ordered(defs: MealDef[]): MealDef[] {
  return [...defs].sort((a, b) => {
    const as = a.seq ?? 0;
    const bs = b.seq ?? 0;
    if (as !== bs) return as - bs;
    return (a.afterWakeMs ?? 0) - (b.afterWakeMs ?? 0);
  });
}

/** Sensible spacing when a prescription did not say. */
function defaultAfterWake(index: number): number {
  return DEFAULT_AFTER_WAKE + index * 5.25 * HOUR;
}

/** How far ahead of this meal we must ask, given what is meant to be taken before it. */
function leadFor(state: PatientState, meal: string): number {
  let lead = MIN_LEAD;
  for (const med of state.meds) {
    if (med.status !== 'active') continue;
    const refs = med.spec.meals ?? (med.spec.meal === undefined ? [] : [med.spec.meal]);
    for (const ref of refs) {
      if (ref.meal === meal && ref.relation === 'before') {
        // Ten minutes of slack on top, so the tablet is not due the instant we ask.
        lead = Math.max(lead, ref.offsetMs + 10 * MINUTE);
      }
    }
  }
  return lead;
}

export function planMeals(
  state: PatientState,
  now: number,
  z: Zone,
  today: LocalDay,
  awake: boolean,
  emit: (a: Action) => void,
  hasOpenMealPrompt: (meal: string, stage: 'plan' | 'confirm') => boolean,
  wakeAnchor: number,
): MealFacts {
  const meals = new Map<string, { at: number; confirmed: boolean; planned: boolean }>();
  const skipped = new Set<string>();
  const wakeUps: number[] = [];
  const defs = ordered(state.mealDefs);

  let previousMealAt: number | null = null;

  for (const [index, def] of defs.entries()) {
    const event = state.mealEvents.find((e) => e.meal === def.meal && e.localDay === today);

    // --- already dealt with -------------------------------------------------
    if (event !== undefined && (event.source === 'confirmed' || event.source === 'presumed')) {
      // A presumed meal counts as having happened. Treating it as merely planned would
      // strand every after-meal medicine on a day the patient never answered, which is
      // precisely the silence presuming exists to prevent.
      meals.set(def.meal, { at: event.at, confirmed: true, planned: true });
      previousMealAt = event.at;
      continue;
    }
    if (event !== undefined && event.source === 'skipped') {
      // Explicitly skipped. Anything depending on it is resolved rather than left
      // hanging on a meal that is not going to happen.
      skipped.add(def.meal);
      previousMealAt = event.at;
      continue;
    }

    // --- when is this meal assumed to be? ----------------------------------
    // Derived from waking rather than the clock, and never bunched against the previous
    // meal. Someone who got up at noon is not late for breakfast.
    const afterWake = def.afterWakeMs ?? defaultAfterWake(index);
    let assumedAt = wakeAnchor + afterWake;
    if (previousMealAt !== null) {
      assumedAt = Math.max(assumedAt, previousMealAt + (def.minGapAfterPrevMs || 3 * HOUR));
    }
    const lead = leadFor(state, def.meal);

    // Two different times, and conflating them is a trap.
    //
    // `originalAssumed` is where the day suggests this meal falls, and it is what the
    // give-up deadline is measured against -- otherwise pushing the proposal forward on
    // every tick would mean the meal is never presumed and every after-meal tablet waits
    // for ever.
    //
    // `assumedAt` is what we actually propose, never in the past, because asking
    // "breakfast around half past?" at a quarter to is confusing and leaves no room for
    // the tablet that goes before it.
    const originalAssumed = assumedAt;
    if (awake && assumedAt < now + lead) assumedAt = now + lead;

    // --- they told us when they are eating ----------------------------------
    if (event !== undefined && event.source === 'planned') {
      meals.set(def.meal, { at: event.at, confirmed: false, planned: true });
      previousMealAt = event.at;

      // At the planned time, ask whether it is happening now. That confirmation is what
      // releases any after-meal medicine.
      if (awake && now >= event.at) {
        if (now >= event.at + PRESUME_AFTER_PLAN) {
          emit({ t: 'recordMeal', meal: def.meal, localDay: today, at: event.at, source: 'presumed', plannedAt: event.at });
          emit({ t: 'closeMealPrompt', meal: def.meal });
          // Effective immediately, so anything waiting on this meal is released on this
          // tick rather than a minute later.
          meals.set(def.meal, { at: event.at, confirmed: true, planned: true });
        } else {
          if (!hasOpenMealPrompt(def.meal, 'confirm')) {
            emit({
              t: 'createPrompt', id: 0, kind: 'meal', tier: 0,
              body: { kind: 'meal', doseIds: [], meal: def.meal, stage: 'confirm', proposedAt: event.at },
            });
          }
          wakeUps.push(now + MEAL_POLL);
          wakeUps.push(event.at + PRESUME_AFTER_PLAN);
        }
      } else {
        wakeUps.push(event.at);
      }
      continue;
    }

    // --- nothing said yet: assume, but ask in time to act on the answer ------
    // The assumption stands in so a before-meal tablet always has something to aim at,
    // and someone who answers nothing still gets their medicines. But it is a proposal,
    // not a decision: the patient is asked to confirm or push it back, far enough ahead
    // that the tablet due before the meal still has its half hour.
    meals.set(def.meal, { at: assumedAt, confirmed: false, planned: false });
    previousMealAt = assumedAt;

    const askAt = assumedAt - lead;

    if (awake && now >= askAt) {
      if (!hasOpenMealPrompt(def.meal, 'plan')) {
        emit({
          t: 'createPrompt', id: 0, kind: 'meal', tier: 0,
          body: { kind: 'meal', doseIds: [], meal: def.meal, stage: 'plan', proposedAt: assumedAt },
        });
      }
      wakeUps.push(now + MEAL_POLL);
      // And once the originally assumed time is well past, fall through to presuming it
      // happened rather than leaving after-meal medicines waiting indefinitely.
      wakeUps.push(originalAssumed + PRESUME_AFTER_PLAN);

      if (now >= originalAssumed + PRESUME_AFTER_PLAN) {
        emit({ t: 'recordMeal', meal: def.meal, localDay: today, at: originalAssumed, source: 'presumed', plannedAt: null });
        emit({ t: 'closeMealPrompt', meal: def.meal });
        meals.set(def.meal, { at: originalAssumed, confirmed: true, planned: true });
      }
    } else if (askAt > now) {
      wakeUps.push(askAt);
    }
  }

  const future = wakeUps.filter((v) => Number.isFinite(v) && v > now);
  return { meals, skipped, wakeAt: future.length > 0 ? Math.min(...future) : null };
}

/** How a planned meal time is derived from "in about an hour". */
export function plannedMealAt(now: number, inMs: number): number {
  return now + Math.max(0, Math.min(inMs, 12 * HOUR));
}

export function mealEventFor(
  state: PatientState,
  meal: string,
  today: LocalDay,
): MealEvent | undefined {
  return state.mealEvents.find((e) => e.meal === meal && e.localDay === today);
}
