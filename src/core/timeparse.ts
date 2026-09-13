/**
 * Parsing the times people actually type.
 *
 * "I took it at 5pm" has to work, because the alternative is that a forgotten tap
 * permanently skews the schedule. Deterministic and timezone-aware; no AI anywhere near it.
 */

import type { Zone } from './tz.js';
import { HOUR, MINUTE } from './tz.js';

/** '2h', '30m', '1h30m', '90 min', '2 hours', '45s'. Returns ms, or null. */
export function parseDuration(input: string): number | null {
  const s = input.trim().toLowerCase();
  if (s === '') return null;

  // Bare number means minutes -- '/snooze 15'.
  if (/^\d+$/.test(s)) return Number(s) * MINUTE;

  const re = /(\d+(?:\.\d+)?)\s*(h(?:ours?|rs?)?|m(?:in(?:ute)?s?)?|s(?:ec(?:ond)?s?)?|d(?:ays?)?)/g;
  let total = 0;
  let matched = false;
  // Track how much of the input the tokens actually account for. Without this,
  // 'drops 20m' would parse as twenty minutes and 'eye drops 20m ago' would be read as a
  // time rather than a medicine called "eye drops" -- a quiet misparse that would attach
  // a dose to the wrong medicine.
  let consumed = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    matched = true;
    consumed += m[0].length;
    const n = Number(m[1]);
    const unit = m[2]![0];
    total += unit === 'h' ? n * HOUR : unit === 'm' ? n * MINUTE : unit === 'd' ? n * 24 * HOUR : n * 1000;
  }
  if (!matched) return null;
  // Everything outside the matched tokens must be whitespace or separators.
  const leftover = s.replace(re, '').replace(/[\s,and]+/g, '');
  if (leftover !== '') return null;
  void consumed;
  return Math.round(total);
}

export interface ParsedTime {
  at: number;
  /** How it was understood, so the bot can echo it back for confirmation. */
  how: string;
}

/**
 * Resolve a user-typed time to an instant.
 *
 * A bare wall-clock time resolves to its most recent occurrence in the past, which is
 * what "at 5pm" means whether it is said at 6pm or at 2am the following night. Future
 * times are left for the caller to reject, so it can explain rather than silently
 * reinterpret.
 */
export function parseTime(input: string, now: number, z: Zone): ParsedTime | null {
  const s = input.trim().toLowerCase().replace(/\s+/g, ' ');
  if (s === '' || s === 'now') return { at: now, how: 'now' };

  // '20m ago', '2h ago', '1h30m ago'
  const agoMatch = /^(.+?)\s*ago$/.exec(s);
  if (agoMatch !== null) {
    const d = parseDuration(agoMatch[1]!);
    if (d !== null) return { at: now - d, how: `${agoMatch[1]!.trim()} ago` };
    return null;
  }

  // 'yesterday 11pm' / 'today 8:30'
  let dayShift = 0;
  let rest = s;
  const dayMatch = /^(yesterday|today|last night)\s+(.*)$/.exec(s);
  if (dayMatch !== null) {
    dayShift = dayMatch[1] === 'today' ? 0 : -1;
    rest = dayMatch[2]!;
  }

  const wall = parseWallish(rest);
  if (wall === null) return null;

  const hhmm = `${String(wall.h).padStart(2, '0')}:${String(wall.mi).padStart(2, '0')}`;
  if (dayShift === 0 && dayMatch === null) {
    // Unqualified: the most recent time it was that o'clock.
    return { at: z.lastWallAtOrBefore(hhmm, now), how: hhmm };
  }
  const day = z.addLocalDays(z.localDay(now), dayShift);
  return { at: z.wallOnDayUtc(day, hhmm), how: `${day} ${hhmm}` };
}

/** '5pm', '5:30 pm', '17:00', '1730', '5'. */
function parseWallish(s: string): { h: number; mi: number } | null {
  const t = s.replace(/\s+/g, '');

  let m = /^(\d{1,2})(?::(\d{2}))?(am|pm)$/.exec(t);
  if (m !== null) {
    let h = Number(m[1]);
    const mi = m[2] === undefined ? 0 : Number(m[2]);
    if (h > 12 || mi > 59) return null;
    if (m[3] === 'pm' && h !== 12) h += 12;
    if (m[3] === 'am' && h === 12) h = 0;
    return { h, mi };
  }

  m = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (m !== null) {
    const h = Number(m[1]);
    const mi = Number(m[2]);
    if (h > 23 || mi > 59) return null;
    return { h, mi };
  }

  m = /^(\d{2})(\d{2})$/.exec(t);
  if (m !== null) {
    const h = Number(m[1]);
    const mi = Number(m[2]);
    if (h > 23 || mi > 59) return null;
    return { h, mi };
  }

  return null;
}

/** Split a trailing time expression off a command argument: 'moxi 5pm' -> ['moxi', '5pm']. */
export function splitTrailingTime(
  args: string,
  now: number,
  z: Zone,
): { head: string; time: ParsedTime | null } {
  const parts = args.trim().split(' ').filter((p) => p !== '');
  for (let take = Math.min(3, parts.length); take >= 1; take--) {
    const tail = parts.slice(parts.length - take).join(' ');
    const parsed = parseTime(tail, now, z);
    if (parsed !== null && !(take === 1 && parsed.how === 'now' && tail !== 'now')) {
      return { head: parts.slice(0, parts.length - take).join(' '), time: parsed };
    }
  }
  return { head: parts.join(' '), time: null };
}
