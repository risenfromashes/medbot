/**
 * Parsing, validating and normalising a prescription document.
 *
 * This is the contract a non-technical user meets: they photograph a prescription, ask
 * whatever chatbot they already have to turn it into this JSON, and send it to the bot.
 * So the validator's job is not only to be correct but to explain itself -- every error
 * names the medicine and the field, because the person reading it is holding a piece of
 * paper, not a debugger.
 *
 * Pure. No AI, no network; the only intelligence involved happened in someone else's
 * chat window before the JSON arrived.
 */

import type { CourseKind, DriftPolicy, MedSpec, NagPolicy, ScheduleKind, Step } from './domain.js';
import { parseDuration } from './timeparse.js';
import { HOUR, MINUTE, isValidTimeZone, parseWall } from './tz.js';

export interface NormalizedMed {
  medKey: string;
  name: string;
  doseText: string | null;
  notes: string | null;
  kind: ScheduleKind;
  spec: MedSpec;
  steps: Step[];
  stepSpacingMs: number;
  intervalMs: number | null;
  minGapMs: number;
  onsetOffsetMs: number;
  maxPerDay: number | null;
  awakeOnly: boolean;
  critical: boolean;
  driftPolicy: DriftPolicy;
  driftToleranceMs: number;
  catchupGraceMs: number;
  nagPolicy: NagPolicy;
  mergeable: boolean;
  courseKind: CourseKind;
  courseDays: number | null;
  courseDoses: number | null;
  courseUntil: number | null;
  specHash: string;
}

export interface NormalizedMeal {
  meal: string;
  typicalLocal: string;
  askAfterLocal: string;
  presumeAtLocal: string | null;
}

export interface NormalizedPrescription {
  patientName: string | null;
  tz: string | null;
  day: {
    morningPollAt?: string;
    presumedWakeAt?: string;
    eveningPollAt?: string;
    presumedSleepAt?: string;
    digestAt?: string;
  };
  meals: NormalizedMeal[];
  meds: NormalizedMed[];
}

export interface ParseResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  value?: NormalizedPrescription;
}

const DEFAULT_NAG: NagPolicy = {
  stepsMs: [10 * MINUTE, 15 * MINUTE, 20 * MINUTE, 30 * MINUTE],
  escalateAfterMs: 5 * MINUTE,
};

/** Small, stable, non-cryptographic hash. Only ever used to detect "has this changed". */
export function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

class Ctx {
  errors: string[] = [];
  warnings: string[] = [];
  err(where: string, msg: string): void {
    this.errors.push(`${where}: ${msg}`);
  }
  warn(where: string, msg: string): void {
    this.warnings.push(`${where}: ${msg}`);
  }
  /** Parse a duration field, reporting a useful message rather than silently defaulting. */
  dur(where: string, field: string, v: unknown, fallback: number | null): number | null {
    if (v === undefined || v === null) return fallback;
    if (typeof v === 'number') return v > 10_000 ? v : v * MINUTE; // ms, or minutes if small
    if (typeof v !== 'string') {
      this.err(where, `"${field}" should be a duration like "2h" or "30m"`);
      return fallback;
    }
    const d = parseDuration(v);
    if (d === null) {
      this.err(where, `could not read "${field}": "${v}" is not a duration like "2h" or "30m"`);
      return fallback;
    }
    return d;
  }
  wall(where: string, field: string, v: unknown, fallback: string | null): string | null {
    if (v === undefined || v === null) return fallback;
    if (typeof v !== 'string') {
      this.err(where, `"${field}" should be a time like "08:00"`);
      return fallback;
    }
    try {
      const { h, mi } = parseWall(v);
      return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
    } catch {
      this.err(where, `could not read "${field}": "${v}" is not a time like "08:00"`);
      return fallback;
    }
  }
}

/** 'before breakfast' style dose patterns common on South Asian prescriptions. */
const PATTERN_MEALS = ['breakfast', 'lunch', 'dinner'];

export function parsePrescription(raw: unknown, opts: { now: number } = { now: Date.now() }): ParseResult {
  const c = new Ctx();

  if (!isRecord(raw)) {
    return { ok: false, errors: ['The document must be a JSON object.'], warnings: [] };
  }

  const version = raw['version'];
  if (version !== undefined && version !== 1) {
    c.warn('document', `version ${String(version)} is newer than this bot understands (1); trying anyway`);
  }

  const tz = typeof raw['timezone'] === 'string' ? raw['timezone'] : null;
  if (tz !== null && !isValidTimeZone(tz)) {
    c.err('document', `"timezone": "${tz}" is not a known IANA zone (try e.g. "Asia/Dhaka")`);
  }

  const dayRaw = isRecord(raw['day']) ? raw['day'] : {};
  const day: NormalizedPrescription['day'] = {};
  const morning = c.wall('day', 'morning_poll_at', dayRaw['morning_poll_at'], null);
  const presumedWake = c.wall('day', 'presumed_wake_at', dayRaw['presumed_wake_at'], null);
  const evening = c.wall('day', 'evening_poll_at', dayRaw['evening_poll_at'], null);
  const presumedSleep = c.wall('day', 'presumed_sleep_at', dayRaw['presumed_sleep_at'], null);
  const digest = c.wall('day', 'digest_at', dayRaw['digest_at'], null);
  if (morning !== null) day.morningPollAt = morning;
  if (presumedWake !== null) day.presumedWakeAt = presumedWake;
  if (evening !== null) day.eveningPollAt = evening;
  if (presumedSleep !== null) day.presumedSleepAt = presumedSleep;
  if (digest !== null) day.digestAt = digest;

  if (morning !== null && presumedWake !== null && presumedWake < morning) {
    c.err('day', '"presumed_wake_at" must be later than "morning_poll_at"');
  }

  // --- meals -------------------------------------------------------------
  const meals: NormalizedMeal[] = [];
  const mealsRaw = Array.isArray(raw['meals']) ? raw['meals'] : [];
  for (const [i, m] of mealsRaw.entries()) {
    if (!isRecord(m)) {
      c.err(`meals[${i}]`, 'should be an object');
      continue;
    }
    const id = typeof m['id'] === 'string' ? m['id'] : null;
    if (id === null) {
      c.err(`meals[${i}]`, 'needs an "id" such as "breakfast"');
      continue;
    }
    const typical = c.wall(`meals.${id}`, 'typical_local', m['typical_local'], defaultMealTime(id));
    const ask = c.wall(`meals.${id}`, 'ask_after_local', m['ask_after_local'], addMinutesToWall(typical!, 60));
    const presume = c.wall(`meals.${id}`, 'presume_at_local', m['presume_at_local'], addMinutesToWall(typical!, 240));
    meals.push({ meal: id, typicalLocal: typical!, askAfterLocal: ask!, presumeAtLocal: presume });
  }

  // --- spacing groups ----------------------------------------------------
  const groupSpacing = new Map<string, number>();
  const groupsRaw = Array.isArray(raw['groups']) ? raw['groups'] : [];
  for (const [i, g] of groupsRaw.entries()) {
    if (!isRecord(g)) {
      c.err(`groups[${i}]`, 'should be an object');
      continue;
    }
    const id = typeof g['id'] === 'string' ? g['id'] : null;
    if (id === null) {
      c.err(`groups[${i}]`, 'needs an "id"');
      continue;
    }
    const spacing = c.dur(`groups.${id}`, 'spacing', g['spacing'], 10 * MINUTE);
    groupSpacing.set(id, spacing ?? 10 * MINUTE);
  }

  // --- medicines ---------------------------------------------------------
  const medsRaw = Array.isArray(raw['medicines']) ? raw['medicines'] : null;
  if (medsRaw === null) {
    c.err('document', 'needs a "medicines" array');
    return { ok: false, errors: c.errors, warnings: c.warnings };
  }
  if (medsRaw.length === 0) c.err('document', '"medicines" is empty -- nothing to remind about');

  interface Draft extends NormalizedMed {
    group: string | null;
    groupSeq: number;
  }
  const drafts: Draft[] = [];
  const seenKeys = new Set<string>();

  for (const [i, mr] of medsRaw.entries()) {
    if (!isRecord(mr)) {
      c.err(`medicines[${i}]`, 'should be an object');
      continue;
    }
    const name = typeof mr['name'] === 'string' ? mr['name'].trim() : '';
    const rawId = typeof mr['id'] === 'string' ? mr['id'].trim() : '';
    const where = `medicine "${name !== '' ? name : rawId !== '' ? rawId : `#${i + 1}`}"`;

    if (name === '' && rawId === '') {
      c.err(`medicines[${i}]`, 'needs at least a "name"');
      continue;
    }
    const medKey = (rawId !== '' ? rawId : slug(name)).toLowerCase();
    if (seenKeys.has(medKey)) {
      c.err(where, `duplicate id "${medKey}" -- each medicine needs a distinct id`);
      continue;
    }
    seenKeys.add(medKey);

    const parsed = parseSchedule(c, where, mr, meals);
    if (parsed === null) continue;

    const minGapDefault =
      parsed.intervalMs !== null ? Math.floor(parsed.intervalMs * 0.75) : 4 * HOUR;
    const minGapMs = c.dur(where, 'min_gap', mr['min_gap'], minGapDefault) ?? minGapDefault;

    const course = parseCourse(c, where, mr['course'], opts.now);

    const nag = parseNag(c, where, mr['nag']);

    const group = typeof mr['group'] === 'string' ? mr['group'] : null;
    if (group !== null && !groupSpacing.has(group)) {
      groupSpacing.set(group, 10 * MINUTE);
      c.warn(where, `group "${group}" was not declared in "groups"; assuming 10 minutes apart`);
    }

    const draft: Draft = {
      medKey,
      name: name !== '' ? name : medKey,
      doseText: typeof mr['dose'] === 'string' ? mr['dose'] : null,
      notes: typeof mr['notes'] === 'string' ? mr['notes'] : null,
      kind: parsed.kind,
      spec: parsed.spec,
      steps: [{ name: name !== '' ? name : medKey, ...(typeof mr['dose'] === 'string' ? { dose: mr['dose'] } : {}) }],
      stepSpacingMs: 0,
      intervalMs: parsed.intervalMs,
      minGapMs,
      onsetOffsetMs: c.dur(where, 'onset_offset', mr['onset_offset'], 0) ?? 0,
      maxPerDay: typeof mr['max_per_day'] === 'number' ? mr['max_per_day'] : null,
      awakeOnly: mr['awake_only'] === undefined ? true : mr['awake_only'] === true,
      critical: mr['critical'] === true,
      driftPolicy: parseDrift(c, where, mr['drift_policy']),
      driftToleranceMs: c.dur(where, 'drift_tolerance', mr['drift_tolerance'], 30 * MINUTE) ?? 30 * MINUTE,
      catchupGraceMs: c.dur(where, 'catchup_grace', mr['catchup_grace'], HOUR) ?? HOUR,
      nagPolicy: nag,
      mergeable: mr['mergeable'] === undefined ? true : mr['mergeable'] === true,
      courseKind: course.kind,
      courseDays: course.days,
      courseDoses: course.doses,
      courseUntil: course.until,
      specHash: '',
      group,
      groupSeq: typeof mr['group_seq'] === 'number' ? mr['group_seq'] : drafts.length,
    };

    if (draft.critical && draft.awakeOnly) draft.awakeOnly = false;
    drafts.push(draft);
  }

  // Fold each spacing group into a single medicine with ordered steps. Three eye drops
  // ten minutes apart become one medicine with three steps, which is what makes "only one
  // of them may be pending at a time" a property of the schema rather than a rule some
  // code path has to keep remembering.
  const meds: NormalizedMed[] = [];
  const byGroup = new Map<string, Draft[]>();
  for (const d of drafts) {
    if (d.group === null) {
      meds.push(stripDraft(d));
      continue;
    }
    const list = byGroup.get(d.group) ?? [];
    list.push(d);
    byGroup.set(d.group, list);
  }

  for (const [groupId, members] of byGroup) {
    members.sort((a, b) => a.groupSeq - b.groupSeq);
    const head = members[0]!;
    if (members.length === 1) {
      meds.push(stripDraft(head));
      continue;
    }
    const differing = members.filter((m) => m.intervalMs !== head.intervalMs || m.kind !== head.kind);
    if (differing.length > 0) {
      c.warn(
        `group "${groupId}"`,
        `members have different schedules; using ${head.name}'s (${describeSchedule(head)}) for the whole group`,
      );
    }
    meds.push({
      ...stripDraft(head),
      medKey: groupId,
      name: members.map((m) => m.name).join(' + '),
      doseText: null,
      steps: members.map((m) => ({
        name: m.name,
        ...(m.doseText !== null ? { dose: m.doseText } : {}),
        ...(m.notes !== null ? { note: m.notes } : {}),
      })),
      stepSpacingMs: groupSpacing.get(groupId) ?? 10 * MINUTE,
      // A group is inherently its own message sequence; never merge it with other meds.
      mergeable: false,
    });
  }

  for (const m of meds) {
    m.specHash = hashString(
      JSON.stringify([m.kind, m.spec, m.steps, m.stepSpacingMs, m.intervalMs, m.minGapMs, m.courseKind, m.courseDays, m.courseDoses]),
    );
  }

  if (meds.length === 0 && c.errors.length === 0) c.err('document', 'no usable medicines found');

  return {
    ok: c.errors.length === 0,
    errors: c.errors,
    warnings: c.warnings,
    ...(c.errors.length === 0 ? { value: { patientName: typeof raw['patient'] === 'string' ? raw['patient'] : null, tz, day, meals, meds } } : {}),
  };
}

function stripDraft(d: NormalizedMed & { group?: string | null; groupSeq?: number }): NormalizedMed {
  const { group, groupSeq, ...rest } = d as NormalizedMed & { group: unknown; groupSeq: unknown };
  void group;
  void groupSeq;
  return rest;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32) || 'med';
}

function defaultMealTime(id: string): string {
  switch (id) {
    case 'breakfast': return '08:00';
    case 'lunch': return '13:00';
    case 'dinner': return '20:00';
    default: return '12:00';
  }
}

function addMinutesToWall(hhmm: string, mins: number): string {
  const { h, mi } = parseWall(hhmm);
  const total = (h * 60 + mi + mins) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function parseDrift(c: Ctx, where: string, v: unknown): DriftPolicy {
  if (v === undefined || v === null) return 'absorb';
  if (v === 'absorb' || v === 'strict_actual' || v === 'strict_grid') return v;
  c.warn(where, `unknown "drift_policy": "${String(v)}"; using "absorb"`);
  return 'absorb';
}

function parseNag(c: Ctx, where: string, v: unknown): NagPolicy {
  if (!isRecord(v)) return DEFAULT_NAG;
  const steps: number[] = [];
  if (Array.isArray(v['steps'])) {
    for (const s of v['steps']) {
      const d = c.dur(where, 'nag.steps', s, null);
      if (d !== null) steps.push(d);
    }
  }
  const escalate = c.dur(where, 'nag.escalate_after', v['escalate_after'], DEFAULT_NAG.escalateAfterMs);
  return {
    stepsMs: steps.length > 0 ? steps : DEFAULT_NAG.stepsMs,
    escalateAfterMs: escalate ?? DEFAULT_NAG.escalateAfterMs,
  };
}

function parseCourse(
  c: Ctx,
  where: string,
  v: unknown,
  now: number,
): { kind: CourseKind; days: number | null; doses: number | null; until: number | null } {
  if (!isRecord(v)) return { kind: 'indefinite', days: null, doses: null, until: null };
  if (typeof v['days'] === 'number') return { kind: 'days', days: v['days'], doses: null, until: null };
  if (typeof v['doses'] === 'number') return { kind: 'doses', days: null, doses: v['doses'], until: null };
  if (typeof v['until'] === 'string') {
    const t = Date.parse(v['until']);
    if (Number.isNaN(t)) {
      c.err(where, `could not read "course.until": "${v['until']}" (use "YYYY-MM-DD")`);
      return { kind: 'indefinite', days: null, doses: null, until: null };
    }
    if (t < now) c.warn(where, 'the course end date is already in the past');
    return { kind: 'until', days: null, doses: null, until: t };
  }
  return { kind: 'indefinite', days: null, doses: null, until: null };
}

interface ParsedSchedule {
  kind: ScheduleKind;
  spec: MedSpec;
  intervalMs: number | null;
}

function parseSchedule(
  c: Ctx,
  where: string,
  mr: Record<string, unknown>,
  meals: NormalizedMeal[],
): ParsedSchedule | null {
  // Shorthand: "1+0+1" means morning + noon + night, as written on the prescription.
  if (typeof mr['pattern'] === 'string') {
    const parts = mr['pattern'].split('+').map((p) => p.trim());
    if (parts.length === 3 && parts.every((p) => /^\d+$/.test(p))) {
      const active = parts
        .map((p, idx) => ({ n: Number(p), meal: PATTERN_MEALS[idx]! }))
        .filter((x) => x.n > 0);
      if (active.length === 0) {
        c.err(where, `"pattern": "${mr['pattern']}" has no doses in it`);
        return null;
      }
      const relation = typeof mr['relation'] === 'string' ? mr['relation'] : 'after';
      if (active.length === 1) {
        return {
          kind: 'meal',
          spec: {
            kind: 'meal',
            meal: {
              meal: active[0]!.meal,
              relation: relation === 'before' ? 'before' : relation === 'with' ? 'with' : 'after',
              offsetMs: c.dur(where, 'offset', mr['offset'], 0) ?? 0,
            },
          },
          intervalMs: null,
        };
      }
      // Several meals a day: express as wall-clock slots at those meals' usual times, so
      // the patient is not blocked waiting to confirm a meal for every dose.
      const times = active.map((a) => meals.find((m) => m.meal === a.meal)?.typicalLocal ?? defaultMealTime(a.meal));
      return { kind: 'fixed_times', spec: { kind: 'fixed_times', times }, intervalMs: null };
    }
    c.err(where, `"pattern": "${mr['pattern']}" should look like "1+0+1"`);
    return null;
  }

  const sr = mr['schedule'];
  if (!isRecord(sr)) {
    c.err(where, 'needs a "schedule" object (or a "pattern" like "1+0+1")');
    return null;
  }
  const type = sr['type'];

  if (type === 'interval') {
    const every = c.dur(where, 'schedule.every', sr['every'], null);
    if (every === null) {
      c.err(where, 'an interval schedule needs "every", e.g. "every": "2h"');
      return null;
    }
    if (every < 15 * MINUTE) c.warn(where, `every ${sr['every'] as string} is unusually frequent -- please double-check`);
    const anchor = sr['anchor'] === 'clock' ? 'clock' : 'wake';
    return { kind: 'interval', spec: { kind: 'interval', intervalMs: every, anchor }, intervalMs: every };
  }

  if (type === 'fixed_times') {
    const raw = Array.isArray(sr['times']) ? sr['times'] : [];
    const times: string[] = [];
    for (const t of raw) {
      const w = c.wall(where, 'schedule.times', t, null);
      if (w !== null) times.push(w);
    }
    if (times.length === 0) {
      c.err(where, 'a fixed_times schedule needs "times", e.g. "times": ["08:00", "20:00"]');
      return null;
    }
    times.sort();
    return { kind: 'fixed_times', spec: { kind: 'fixed_times', times }, intervalMs: null };
  }

  if (type === 'times_per_day') {
    // Compiled down to wall-clock slots at import. Predictable for the patient, and it
    // removes a whole scheduling branch along with its window-compression edge cases.
    const n = typeof sr['n'] === 'number' ? sr['n'] : typeof sr['count'] === 'number' ? sr['count'] : null;
    if (n === null || n < 1) {
      c.err(where, 'a times_per_day schedule needs "n", e.g. "n": 3');
      return null;
    }
    const from = c.wall(where, 'schedule.from', sr['from'], '08:00')!;
    const to = c.wall(where, 'schedule.to', sr['to'], '22:00')!;
    const times = spreadTimes(from, to, n);
    c.warn(where, `${n}x a day became ${times.join(', ')} -- adjust with /edit if that does not suit`);
    return { kind: 'fixed_times', spec: { kind: 'fixed_times', times }, intervalMs: null };
  }

  if (type === 'meal') {
    const mealsList = Array.isArray(sr['meals']) ? sr['meals'].filter((x): x is string => typeof x === 'string') : [];
    const single = typeof sr['meal'] === 'string' ? [sr['meal']] : mealsList;
    if (single.length === 0) {
      c.err(where, 'a meal schedule needs "meals", e.g. "meals": ["breakfast"]');
      return null;
    }
    const relation = sr['relation'] === 'before' ? 'before' : sr['relation'] === 'with' ? 'with' : 'after';
    const offset = c.dur(where, 'schedule.offset', sr['offset'], 0) ?? 0;
    for (const meal of single) {
      if (!meals.some((m) => m.meal === meal)) {
        c.warn(where, `meal "${meal}" is not in "meals"; assuming a usual time of ${defaultMealTime(meal)}`);
      }
    }
    if (single.length === 1) {
      return {
        kind: 'meal',
        spec: { kind: 'meal', meal: { meal: single[0]!, relation, offsetMs: offset } },
        intervalMs: null,
      };
    }
    // Several meals: wall-clock slots derived from each meal's usual time, shifted.
    const times = single.map((meal) => {
      const base = meals.find((m) => m.meal === meal)?.typicalLocal ?? defaultMealTime(meal);
      const shift = relation === 'before' ? -offset / MINUTE : relation === 'after' ? offset / MINUTE : 0;
      return addMinutesToWall(base, Math.round(shift));
    });
    times.sort();
    return { kind: 'fixed_times', spec: { kind: 'fixed_times', times }, intervalMs: null };
  }

  if (type === 'as_needed' || type === 'prn') {
    return { kind: 'as_needed', spec: { kind: 'as_needed' }, intervalMs: null };
  }

  c.err(
    where,
    `unknown schedule type "${String(type)}" -- use interval, fixed_times, times_per_day, meal or as_needed`,
  );
  return null;
}

function spreadTimes(from: string, to: string, n: number): string[] {
  const a = parseWall(from);
  const b = parseWall(to);
  const start = a.h * 60 + a.mi;
  let end = b.h * 60 + b.mi;
  if (end <= start) end += 24 * 60;
  if (n === 1) return [from];
  const step = (end - start) / (n - 1);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const t = Math.round(start + step * i) % (24 * 60);
    out.push(`${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`);
  }
  return out;
}

export function describeSchedule(m: Pick<NormalizedMed, 'kind' | 'spec' | 'intervalMs'>): string {
  switch (m.kind) {
    case 'interval': {
      const h = (m.intervalMs ?? 0) / HOUR;
      const every = h >= 1 && Number.isInteger(h) ? `${h}h` : `${Math.round((m.intervalMs ?? 0) / MINUTE)}m`;
      return `every ${every}${m.spec.anchor === 'wake' ? ' from waking' : ''}`;
    }
    case 'fixed_times':
      return `at ${(m.spec.times ?? []).join(', ')}`;
    case 'meal': {
      const r = m.spec.meal;
      if (r === undefined) return 'with meals';
      const off = r.offsetMs > 0 ? `${Math.round(r.offsetMs / MINUTE)} min ` : '';
      return `${off}${r.relation} ${r.meal}`;
    }
    case 'as_needed':
      return 'as needed';
  }
}

export function describeCourse(m: Pick<NormalizedMed, 'courseKind' | 'courseDays' | 'courseDoses'>): string {
  switch (m.courseKind) {
    case 'days': return `for ${m.courseDays} days`;
    case 'doses': return `for ${m.courseDoses} doses`;
    case 'until': return 'until a set date';
    case 'indefinite': return 'ongoing';
  }
}
