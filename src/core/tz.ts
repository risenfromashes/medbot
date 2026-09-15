/**
 * Timezone maths with zero dependencies, safe for the Workers runtime.
 *
 * The Worker always runs in UTC. Everything we store is an absolute epoch-millisecond
 * instant. Wall-clock concepts -- "08:00", "the start of today", "tomorrow" -- have to be
 * projected into the patient's IANA zone, and that projection is the single most
 * bug-prone thing in the whole system. It lives here, alone, and it is heavily tested.
 *
 * Rules that this module exists to enforce:
 *   - Intervals ("every 2h") stay in absolute UTC ms and are therefore DST-immune for free.
 *     They never come through here.
 *   - Anything with a wall-clock meaning goes through `wallToUtc`, including midnight --
 *     some zones genuinely skip it (Havana), and assuming midnight exists produces an
 *     off-by-one-day bug in local-day attribution that silently corrupts dose counting.
 *   - "Tomorrow" is `addLocalDays`, never `+ 86_400_000`. On a 23h or 25h day the latter
 *     shifts the entire schedule grid by an hour.
 */

export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY_MS = 86_400_000;

/** A calendar date in a patient's zone, as 'YYYY-MM-DD'. Never a Date object. */
export type LocalDay = string;

export type WallKind =
  /** The wall time exists exactly once. The overwhelmingly common case. */
  | 'exact'
  /** DST fall-back: the wall time happened twice. We return the first occurrence. */
  | 'ambiguous'
  /** DST spring-forward: the wall time never happened. We shift past the transition. */
  | 'gap';

export interface WallResult {
  utc: number;
  kind: WallKind;
  /** The other candidate, for 'ambiguous' and 'gap'. Diagnostic only. */
  alt?: number;
}

export interface Parts {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

/**
 * Constructing an Intl.DateTimeFormat costs roughly a millisecond; reusing one costs
 * microseconds. On a 10ms CPU budget that difference is the single largest performance
 * risk in the system, so formatters are cached at module scope, which survives across
 * invocations within a Worker isolate.
 */
const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = FORMATTERS.get(tz);
  if (f === undefined) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      // Each of these three pins a real footgun:
      //   calendar        -- some locales default to a non-Gregorian calendar, giving a
      //                      year like 1447 that silently breaks every comparison.
      //   numberingSystem -- some emit Arabic-Indic digits, and `+value` is then NaN.
      //   hourCycle       -- `hour12: false` can render midnight as hour "24" in some
      //                      ICU builds. 'h23' cannot.
      calendar: 'gregory',
      numberingSystem: 'latn',
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    FORMATTERS.set(tz, f);
  }
  return f;
}

/** Throws if the zone is not one the runtime knows. Used to validate user input. */
export function isValidTimeZone(tz: string): boolean {
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

/** The wall-clock parts an instant shows in a given zone. */
export function partsOf(utcMs: number, tz: string): Parts {
  const parts = formatter(tz).formatToParts(new Date(utcMs));
  let y = 0, mo = 0, d = 0, h = 0, mi = 0, s = 0;
  for (const p of parts) {
    switch (p.type) {
      case 'year': y = +p.value; break;
      case 'month': mo = +p.value; break;
      case 'day': d = +p.value; break;
      // 'h23' should never produce 24, but the modulo costs nothing and removes a
      // whole class of off-by-one-day bug if an ICU build misbehaves.
      case 'hour': h = +p.value % 24; break;
      case 'minute': mi = +p.value; break;
      case 'second': s = +p.value; break;
    }
  }
  return { y, mo, d, h, mi, s };
}

/** Offset in ms east of UTC that `tz` was observing at the given instant. */
export function offsetAt(utcMs: number, tz: string): number {
  const p = partsOf(utcMs, tz);
  const asIfUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  // The formatted parts carry no milliseconds, so compare against a floored instant.
  return asIfUtc - Math.floor(utcMs / 1000) * 1000;
}

/** The local calendar date an instant falls on, as 'YYYY-MM-DD'. */
export function localDay(utcMs: number, tz: string): LocalDay {
  const p = partsOf(utcMs, tz);
  return fmtDay(p.y, p.mo, p.d);
}

function fmtDay(y: number, mo: number, d: number): LocalDay {
  return `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function parseLocalDay(day: LocalDay): { y: number; mo: number; d: number } {
  const y = +day.slice(0, 4);
  const mo = +day.slice(5, 7);
  const d = +day.slice(8, 10);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) {
    throw new Error(`bad local day: ${day}`);
  }
  return { y, mo, d };
}

/**
 * 'HH:MM' -> {h, mi}, or null. The forgiving form.
 *
 * Anything reaching the planner has already been through the importer, but "already
 * validated" is an assumption, and a single malformed time in the database must not be
 * able to kill the tick -- that patient would simply stop being reminded, with nothing to
 * show for it but an audit row nobody reads.
 */
export function tryParseWall(hhmm: unknown): { h: number; mi: number } | null {
  if (typeof hhmm !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (m === null) return null;
  const h = +m[1]!;
  const mi = +m[2]!;
  if (!Number.isFinite(h) || !Number.isFinite(mi) || h > 23 || mi > 59) return null;
  return { h, mi };
}

/** 'HH:MM' -> {h, mi}. Throws. Used by the importer, where a bad time is a real error. */
export function parseWall(hhmm: string): { h: number; mi: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (m === null) throw new Error(`bad wall time: ${hhmm}`);
  const h = +m[1]!;
  const mi = +m[2]!;
  if (h > 23 || mi > 59) throw new Error(`bad wall time: ${hhmm}`);
  return { h, mi };
}

/**
 * Calendar arithmetic on local days. Parts-based, so a 23- or 25-hour DST day does not
 * shift the result. `Date.UTC` is used purely as a civil-calendar calculator here -- no
 * timezone is involved in the normalisation of, say, Jan 32nd into Feb 1st.
 */
export function addLocalDays(day: LocalDay, n: number): LocalDay {
  const parsed = parseLocalDay0(day) ?? { y: 2000, mo: 1, d: 1 };
  const { y, mo, d } = parsed;
  const t = Date.UTC(y, mo - 1, d + (Number.isFinite(n) ? n : 0));
  const dt = new Date(t);
  return fmtDay(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

/** Whole days from `a` to `b` (b - a). Both are local days in the same zone. */
export function diffLocalDays(a: LocalDay, b: LocalDay): number {
  const pa = parseLocalDay0(a) ?? { y: 2000, mo: 1, d: 1 };
  const pb = parseLocalDay0(b) ?? { y: 2000, mo: 1, d: 1 };
  return Math.round(
    (Date.UTC(pb.y, pb.mo - 1, pb.d) - Date.UTC(pa.y, pa.mo - 1, pa.d)) / DAY_MS,
  );
}

/**
 * The inverse projection: a wall-clock time in a zone back to a UTC instant.
 *
 * The obvious implementation -- guess, take the offset at the guess, subtract, done --
 * is wrong in a way that hides. On a fall-back day it "converges" on one answer and
 * never reveals that a second valid instant exists; on a spring-forward day it returns
 * an instant whose local time is not the one that was asked for, with no signal.
 *
 * So instead: probe the offsets in force a day either side of the target (no real zone
 * has two transitions inside 24 hours, so those bracket every possibility), build a
 * candidate from each, and round-trip both back through `partsOf` to see which actually
 * render as the requested wall time. The count of survivors classifies the case:
 * two means ambiguous, one means exact, zero means the time falls in a gap.
 *
 * Costs ~4 formatToParts calls with a warm formatter -- tens of microseconds -- and runs
 * only when scheduling a future event, never on an idle tick.
 */
export function wallToUtc(
  tz: string,
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
): WallResult {
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0);

  const early = guess - offsetAt(guess - DAY_MS, tz);
  const late = guess - offsetAt(guess + DAY_MS, tz);

  const matches = (u: number): boolean => {
    const p = partsOf(u, tz);
    return p.y === y && p.mo === mo && p.d === d && p.h === h && p.mi === mi;
  };

  if (early === late) {
    // No transition nearby. One candidate, and it is either right or we are in a gap
    // whose two candidates happen to coincide (possible for odd historical offsets).
    return { utc: early, kind: matches(early) ? 'exact' : 'gap' };
  }

  const okEarly = matches(early);
  const okLate = matches(late);

  // Fall-back: the wall time occurred twice. Take the first occurrence. Firing twice is
  // the real danger here, and that is prevented structurally by the one-live-dose-per-
  // medicine index rather than by this choice.
  if (okEarly && okLate) return { utc: early, kind: 'ambiguous', alt: late };
  if (okEarly) return { utc: early, kind: 'exact' };
  if (okLate) return { utc: late, kind: 'exact' };

  // Spring-forward: the wall time never existed. We must NOT drop the dose -- a silently
  // skipped dose is the exact failure this whole system is built to avoid. `early` uses
  // the pre-transition offset, which lands the requested offset-past-the-hour just after
  // the jump (02:30 becomes 03:30), preserving the intent.
  return { utc: early, kind: 'gap', alt: late };
}

/**
 * Convenience: 'YYYY-MM-DD' + 'HH:MM' in a zone -> instant.
 *
 * Deliberately forgiving: a time it cannot read becomes midday rather than an exception,
 * because the alternative is the whole schedule failing over one bad row.
 */
export function wallOnDay(tz: string, day: LocalDay, hhmm: string, fallback = '12:00'): WallResult {
  let parsed = parseLocalDay0(day);
  if (parsed === null) parsed = { y: 2000, mo: 1, d: 1 };
  const wall = tryParseWall(hhmm) ?? tryParseWall(fallback) ?? { h: 12, mi: 0 };
  return wallToUtc(tz, parsed.y, parsed.mo, parsed.d, wall.h, wall.mi);
}

function parseLocalDay0(day: LocalDay): { y: number; mo: number; d: number } | null {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const y = +day.slice(0, 4);
  const mo = +day.slice(5, 7);
  const d = +day.slice(8, 10);
  if (!Number.isFinite(y) || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return { y, mo, d };
}

/** Shorthand when the caller only wants the instant. */
export function wallOnDayUtc(tz: string, day: LocalDay, hhmm: string, fallback = '12:00'): number {
  return wallOnDay(tz, day, hhmm, fallback).utc;
}

/**
 * Midnight at the start of a local day. Goes through the full projection because in a
 * handful of zones midnight itself is skipped by a DST transition.
 */
export function startOfLocalDay(tz: string, day: LocalDay): number {
  const { y, mo, d } = parseLocalDay0(day) ?? { y: 2000, mo: 1, d: 1 };
  return wallToUtc(tz, y, mo, d, 0, 0).utc;
}

/**
 * The most recent instant at or before `notAfter` whose local wall time is `hhmm`.
 * This is what "I took it at 5pm" means when it is said at 6pm -- and equally what it
 * means when said at 2am the following night.
 */
export function lastWallAtOrBefore(tz: string, hhmm: string, notAfter: number): number {
  let day = localDay(notAfter, tz);
  for (let i = 0; i < 3; i++) {
    const candidate = wallOnDayUtc(tz, day, hhmm);
    if (candidate <= notAfter) return candidate;
    day = addLocalDays(day, -1);
  }
  return wallOnDayUtc(tz, day, hhmm);
}

/**
 * The earliest instant at or after `notBefore` whose local wall time is `hhmm`.
 * Used for "the next 08:00 dose".
 */
export function nextWallAtOrAfter(tz: string, hhmm: string, notBefore: number): number {
  let day = localDay(notBefore, tz);
  for (let i = 0; i < 3; i++) {
    const candidate = wallOnDayUtc(tz, day, hhmm);
    if (candidate >= notBefore) return candidate;
    day = addLocalDays(day, 1);
  }
  return wallOnDayUtc(tz, day, hhmm);
}

/** Render an instant as 'HH:MM' in a zone. For message text. */
export function fmtTime(utcMs: number, tz: string): string {
  const p = partsOf(utcMs, tz);
  return `${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`;
}

/** Render an instant as a friendly 12-hour time, e.g. '4:12pm'. */
export function fmtTime12(utcMs: number, tz: string): string {
  const p = partsOf(utcMs, tz);
  const suffix = p.h < 12 ? 'am' : 'pm';
  const h12 = p.h % 12 === 0 ? 12 : p.h % 12;
  return `${h12}:${String(p.mi).padStart(2, '0')}${suffix}`;
}

/** A duration in ms as a compact human string: '2h 5m', '45m', '30s'. */
export function fmtDuration(ms: number): string {
  const abs = Math.abs(ms);
  if (abs < MINUTE) return `${Math.round(abs / 1000)}s`;
  const totalMin = Math.round(abs / MINUTE);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/**
 * A `Zone` binds a timezone once so the planner can do calendar work without repeating
 * the tz string, and so tests can substitute a fake zone with synthetic DST rules.
 * Every method is pure.
 */
export interface Zone {
  readonly tz: string;
  localDay(utcMs: number): LocalDay;
  startOfLocalDay(day: LocalDay): number;
  addLocalDays(day: LocalDay, n: number): LocalDay;
  diffLocalDays(a: LocalDay, b: LocalDay): number;
  wallOnDay(day: LocalDay, hhmm: string, fallback?: string): WallResult;
  wallOnDayUtc(day: LocalDay, hhmm: string, fallback?: string): number;
  lastWallAtOrBefore(hhmm: string, notAfter: number): number;
  nextWallAtOrAfter(hhmm: string, notBefore: number): number;
  fmtTime(utcMs: number): string;
  fmtTime12(utcMs: number): string;
  partsOf(utcMs: number): Parts;
}

const ZONES = new Map<string, Zone>();

export function zoneFor(requested: string): Zone {
  // An unknown zone -- a typo, a corrupted row, a zone this runtime's ICU lacks -- falls
  // back to UTC rather than throwing on every single call downstream.
  const tz = isValidTimeZone(requested) ? requested : 'UTC';
  let z = ZONES.get(tz);
  if (z === undefined) {
    z = {
      tz,
      localDay: (u) => localDay(u, tz),
      startOfLocalDay: (day) => startOfLocalDay(tz, day),
      addLocalDays,
      diffLocalDays,
      wallOnDay: (day, hhmm, fallback) => wallOnDay(tz, day, hhmm, fallback),
      wallOnDayUtc: (day, hhmm, fallback) => wallOnDayUtc(tz, day, hhmm, fallback),
      lastWallAtOrBefore: (hhmm, notAfter) => lastWallAtOrBefore(tz, hhmm, notAfter),
      nextWallAtOrAfter: (hhmm, notBefore) => nextWallAtOrAfter(tz, hhmm, notBefore),
      fmtTime: (u) => fmtTime(u, tz),
      fmtTime12: (u) => fmtTime12(u, tz),
      partsOf: (u) => partsOf(u, tz),
    };
    ZONES.set(tz, z);
  }
  return z;
}

/**
 * Which day's meals a moment belongs to.
 *
 * The waking day, not the calendar one. Going to sleep is what ends a day of meals and
 * starts the next: someone still up at half past midnight has not earned a fresh
 * breakfast, lunch and dinner, and someone who wakes at eleven has not already had them.
 * Readers and writers must agree on this or a confirmed dinner becomes invisible to the
 * tick that asked for it -- and then reappears the next morning as a meal already eaten,
 * silencing the question and stranding every tablet that hangs off it.
 */
export function mealDayOf(z: Zone, lastWakeAt: number | null, now: number): LocalDay {
  return z.localDay(lastWakeAt === null ? now : Math.min(lastWakeAt, now));
}
