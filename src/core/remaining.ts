/**
 * How much of the course is left.
 *
 * "Four more today, nineteen to go" is the question anyone on a week of eye drops actually
 * has, and the one the bot was worst at answering: it could say when the next dose was and
 * nothing about the shape of the thing. It is an estimate -- an interval medicine's count
 * depends on when the patient gets up and goes to bed -- so it is stated as one, never as
 * a number that implies more precision than the day allows.
 *
 * Pure, like everything in core: takes a medicine and the facts, returns numbers.
 */

import type { Medicine, Patient } from './domain.js';
import type { LocalDay, Zone } from './tz.js';
import { DAY_MS, HOUR, MINUTE, tryParseWall } from './tz.js';

/** The patient's waking day, in milliseconds, from their own settings. */
export function wakingSpanMs(patient: Patient): number {
  const wake = tryParseWall(patient.morningPollAt) ?? { h: 7, mi: 0 };
  const sleep = tryParseWall(patient.presumedSleepAt) ?? { h: 23, mi: 0 };
  let span = (sleep.h * 60 + sleep.mi) - (wake.h * 60 + wake.mi);
  if (span <= 0) span += 24 * 60;
  // A day with no room in it would make every count either zero or enormous.
  return Math.min(Math.max(span * MINUTE, 6 * HOUR), 20 * HOUR);
}

/**
 * Doses of this medicine in a day.
 *
 * An interval medicine confined to waking hours gets one on waking and then one per
 * interval until bedtime -- which is what "four times a day, six hourly" means at home,
 * and why this is not simply 24h / interval.
 */
export function dosesPerDay(med: Medicine, patient: Patient): number {
  switch (med.kind) {
    case 'interval': {
      const interval = med.intervalMs ?? 0;
      if (interval <= 0) return 0;
      const span = med.awakeOnly && !med.critical ? wakingSpanMs(patient) : DAY_MS;
      return Math.max(1, Math.floor(span / interval) + (med.awakeOnly && !med.critical ? 1 : 0));
    }
    case 'fixed_times':
      return Math.max(med.spec.times?.length ?? 1, 1);
    case 'meal': {
      const refs = med.spec.meals ?? (med.spec.meal === undefined ? [] : [med.spec.meal]);
      return Math.max(refs.length, 1);
    }
    case 'as_needed':
      // Never scheduled; there is no "left" to count.
      return 0;
  }
}

export interface Remaining {
  /** Still to come today, after what has already been taken or written off. */
  today: number;
  /** Still to come in the whole course, or null when the course has no end. */
  course: number | null;
  perDay: number;
}

/**
 * What is left of this medicine, today and altogether.
 *
 * `doneToday` is taken plus missed: a dose that was missed is not still to come.
 */
export function remainingFor(
  med: Medicine,
  patient: Patient,
  doneToday: number,
  now: number,
  z: Zone,
  today: LocalDay,
): Remaining {
  const perDay = dosesPerDay(med, patient);
  if (med.status !== 'active' || perDay === 0) return { today: 0, course: 0, perDay };

  const todayLeft = Math.max(perDay - doneToday, 0);

  switch (med.courseKind) {
    case 'doses': {
      if (med.courseDoses === null) return { today: todayLeft, course: null, perDay };
      return { today: todayLeft, course: Math.max(med.courseDoses - med.dosesTaken, 0), perDay };
    }
    case 'days': {
      if (med.courseDays === null) return { today: todayLeft, course: null, perDay };
      // Phases override the plain day count: a taper runs for as long as its phases do.
      const total = med.phases !== null && med.phases.length > 0
        ? med.phases.reduce((n, p) => n + p.days, 0)
        : med.courseDays;
      const elapsed = med.startedAt === null ? 0 : z.diffLocalDays(z.localDay(med.startedAt), today);
      const fullDaysLeft = Math.max(total - elapsed - 1, 0);
      return { today: todayLeft, course: todayLeft + fullDaysLeft * perDay, perDay };
    }
    case 'until': {
      if (med.courseUntil === null) return { today: todayLeft, course: null, perDay };
      const fullDaysLeft = Math.max(Math.floor((med.courseUntil - now) / DAY_MS), 0);
      return { today: todayLeft, course: todayLeft + fullDaysLeft * perDay, perDay };
    }
    case 'indefinite':
      return { today: todayLeft, course: null, perDay };
  }
}

/**
 * "3 left today · 19 to go in all" -- the one-line version, or '' when there is nothing
 * to say. `openEnded` counts the medicines with no end date: their doses are real but
 * uncountable, so they are named rather than folded into a total that would be wrong.
 */
export function summarise(totalToday: number, totalCourse: number, openEnded: boolean): string {
  if (totalToday === 0 && totalCourse === 0) return '';
  const parts = [`${totalToday} left today`];
  if (totalCourse > totalToday) parts.push(`${totalCourse} to go in all`);
  return parts.join(' · ') + (openEnded ? ' (plus the ongoing ones)' : '');
}
