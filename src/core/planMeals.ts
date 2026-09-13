/**
 * Meal resolution.
 *
 * A meal has three clocks: when it usually happens (so "30 minutes before breakfast" has
 * something to aim at), when to start asking whether it has happened, and when to give up
 * asking and assume it did. Only the second and third involve the patient at all.
 */

import type { Action, PatientState } from './domain.js';
import type { LocalDay, Zone } from './tz.js';
import { MINUTE } from './tz.js';

export interface MealFacts {
  /** Per meal id: the instant to schedule against, and whether it is a real confirmation. */
  meals: Map<string, { at: number; confirmed: boolean }>;
  wakeAt: number | null;
}

const MEAL_POLL_INTERVAL = 45 * MINUTE;

export function planMeals(
  state: PatientState,
  now: number,
  z: Zone,
  today: LocalDay,
  awake: boolean,
  emit: (a: Action) => void,
  hasOpenMealPrompt: (meal: string) => boolean,
): MealFacts {
  const meals = new Map<string, { at: number; confirmed: boolean }>();
  const wakeUps: number[] = [];

  for (const def of state.mealDefs) {
    const event = state.mealEvents.find((e) => e.meal === def.meal && e.localDay === today);

    if (event !== undefined && event.source !== 'skipped') {
      meals.set(def.meal, { at: event.at, confirmed: event.source === 'confirmed' });
      continue;
    }
    if (event !== undefined && event.source === 'skipped') {
      // Explicitly skipped today. Dependent doses resolve rather than hang.
      continue;
    }

    // No event yet: schedule against the prediction, and start asking once the window
    // has opened.
    const typical = z.wallOnDayUtc(today, def.typicalLocal);
    meals.set(def.meal, { at: typical, confirmed: false });

    const askAfter = z.wallOnDayUtc(today, def.askAfterLocal);
    const presumeAt = def.presumeAtLocal === null ? null : z.wallOnDayUtc(today, def.presumeAtLocal);

    if (presumeAt !== null && now >= presumeAt) {
      emit({ t: 'recordMeal', meal: def.meal, localDay: today, at: typical, source: 'presumed' });
      meals.set(def.meal, { at: typical, confirmed: false });
      continue;
    }

    if (awake && now >= askAfter) {
      if (!hasOpenMealPrompt(def.meal)) {
        emit({
          t: 'createPrompt',
          id: 0,
          kind: 'meal',
          body: { kind: 'meal', doseIds: [], meal: def.meal },
          tier: 0,
        });
      }
      wakeUps.push(now + MEAL_POLL_INTERVAL);
      if (presumeAt !== null) wakeUps.push(presumeAt);
    } else if (now < askAfter) {
      wakeUps.push(askAfter);
    }
  }

  const future = wakeUps.filter((v) => v > now);
  return { meals, wakeAt: future.length > 0 ? Math.min(...future) : null };
}
