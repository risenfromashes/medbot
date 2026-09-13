/**
 * The daily digest and the liveness watchdog.
 *
 * Neither of these reminds anyone to take anything. They exist because the worst failure
 * this system can have is going quiet -- a broken deploy, a stalled cron, a medicine that
 * silently stopped scheduling -- and none of those announce themselves. A summary that
 * arrives every evening is the cheapest possible way for a human to notice that it
 * didn't.
 */

import type { Action, Medicine, PatientState } from './domain.js';
import { courseComplete } from './planSchedule.js';
import type { LocalDay, Zone } from './tz.js';
import { esc } from './html.js';
import { HOUR, fmtDuration } from './tz.js';

/** How often the watchdog bothers to look. */
const WATCHDOG_INTERVAL = 6 * HOUR;
/** A medicine silent for this multiple of its own cycle is considered stuck. */
const SILENCE_FACTOR = 3;
const SILENCE_CAP = 26 * HOUR;

export interface ReportFacts {
  wakeAt: number | null;
}

export function planReports(
  state: PatientState,
  now: number,
  z: Zone,
  today: LocalDay,
  emit: (a: Action) => void,
): ReportFacts {
  const p = state.patient;
  const wakeUps: number[] = [];

  // --- daily digest ------------------------------------------------------
  const digestAt = z.wallOnDayUtc(today, p.digestAt);
  if (now >= digestAt && p.lastDigestDay !== today) {
    emit({ t: 'sendInfo', text: digestText(state, z, today), tier: 0, dedupe: `digest:${p.id}:${today}`, priority: 200 });
    emit({ t: 'markDigestSent', localDay: today });
  } else if (now < digestAt) {
    wakeUps.push(digestAt);
  } else {
    wakeUps.push(z.wallOnDayUtc(z.addLocalDays(today, 1), p.digestAt));
  }

  // --- liveness watchdog -------------------------------------------------
  if (p.lastWatchdogAt === null || now - p.lastWatchdogAt >= WATCHDOG_INTERVAL) {
    // A course that has simply run its length is finishing, not stuck. Alerting on it
    // would cry wolf at the end of every prescription, which is the fastest way to teach
    // someone to ignore the one alert that matters.
    const stuck = state.meds.filter((m) => isSilent(m, now) && !courseComplete(m, now, z, today));
    if (stuck.length > 0) {
      const names = stuck.map((m) => m.name).join(', ');
      emit({
        t: 'sendInfo',
        // Escalated, because by definition the patient is not seeing reminders for it.
        tier: 1,
        text:
          `⚠️ <b>Something looks wrong.</b>\n\n` +
          `No activity on ${names} for a long time, although it is still an active ` +
          `prescription. Check with /status, or /meds to see the schedule.`,
        dedupe: `watchdog:${p.id}:${stuck.map((m) => m.id).join('-')}:${today}`,
        priority: 50,
      });
    }
    emit({ t: 'markWatchdogRun', at: now });
    wakeUps.push(now + WATCHDOG_INTERVAL);
  } else {
    wakeUps.push(p.lastWatchdogAt + WATCHDOG_INTERVAL);
  }

  const future = wakeUps.filter((v) => v > now);
  return { wakeAt: future.length > 0 ? Math.min(...future) : null };
}

/**
 * A medicine that should have produced a dose by now and has not. Deliberately generous:
 * three cycles of silence, so an ordinary missed dose or a night's sleep never trips it.
 */
function isSilent(med: Medicine, now: number): boolean {
  if (med.status !== 'active' || med.kind === 'as_needed') return false;
  const last = Math.max(med.lastTakenAt ?? 0, med.startedAt ?? 0);
  if (last === 0) return false; // never started; nothing to be silent about yet
  const cycle = med.intervalMs ?? 12 * HOUR;
  const threshold = Math.min(cycle * SILENCE_FACTOR, SILENCE_CAP);
  return now - last > threshold;
}

function digestText(state: PatientState, z: Zone, today: LocalDay): string {
  const lines: string[] = [`📋 <b>Today</b> · ${today}`];

  let taken = 0;
  let missed = 0;
  const detail: string[] = [];

  for (const med of state.meds) {
    if (med.status !== 'active') continue;
    const c = state.dayCounters.get(med.id);
    if (c === undefined || (c.taken === 0 && c.missed === 0)) continue;
    taken += c.taken;
    missed += c.missed;
    detail.push(
      `• ${esc(med.name)} — ${c.taken} taken${c.missed > 0 ? `, <b>${c.missed} missed</b>` : ''}`,
    );
  }

  if (detail.length === 0) {
    lines.push('', 'Nothing recorded today.');
  } else {
    lines.push('', ...detail, '', missed === 0 ? `✅ All ${taken} doses taken.` : `${taken} taken · ${missed} missed.`);
  }

  // Course progress is the other thing worth seeing once a day.
  const courses = state.meds
    .filter((m) => m.status === 'active' && m.courseKind === 'days' && m.startedAt !== null)
    .map((m) => {
      const day = z.diffLocalDays(z.localDay(m.startedAt!), today) + 1;
      const left = (m.courseDays ?? 0) - day;
      return `• ${esc(m.name)} — day ${day} of ${m.courseDays}${left <= 1 ? ' <i>(nearly done)</i>' : ''}`;
    });
  if (courses.length > 0) lines.push('', '<b>Courses</b>', ...courses);

  const pending = state.liveDoses.filter((d) => d.status === 'due' || d.status === 'prompted');
  if (pending.length > 0) {
    lines.push('', `⏳ ${pending.length} still waiting on you right now.`);
  }

  void fmtDuration;
  return lines.join('\n');
}
