/**
 * An in-memory world for driving the planner through days of virtual time.
 *
 * The planner is pure, so this needs nothing from Cloudflare: it holds a PatientState,
 * steps a clock a minute at a time, applies the emitted actions back onto the state with
 * the same advancement logic production uses, and checks the invariants after every
 * single tick. A week of simulated behaviour runs in a few milliseconds.
 */

import { expect } from 'vitest';
import { plan } from '../src/core/plan.js';
import { advanceMedicine } from '../src/core/advance.js';
import type {
  Action, Chat, Dose, DoseStatus, MealDef, Medicine, Patient, PatientState, Prompt,
} from '../src/core/domain.js';
import { isLive } from '../src/core/domain.js';
import { HOUR, MINUTE, zoneFor } from '../src/core/tz.js';
import type { Zone } from '../src/core/tz.js';

export const TZ = 'Asia/Dhaka';

/** A message the bot would have sent, recorded instead of dispatched. */
export interface SentMessage {
  at: number;
  chatId: number;
  kind: string;
  promptId: number;
  doseIds: number[];
  nudge: boolean;
  tier: number;
}

export interface DoseLogEntry {
  at: number;
  medKey: string;
  step: number;
  seq: number;
  status: DoseStatus;
  takenAt: number | null;
  plannedDueAt: number;
}

export function makePatient(over: Partial<Patient> = {}): Patient {
  return {
    id: 1,
    displayName: 'Test',
    tz: TZ,
    morningPollAt: '07:00',
    presumedWakeAt: '09:30',
    eveningPollAt: '22:00',
    presumedSleepAt: '01:30',
    quietStart: null,
    quietEnd: null,
    wakeState: 'asleep',
    wakeConfidence: 'presumed',
    wakeStateSince: 0,
    lastWakeAt: null,
    lastSleepAt: null,
    lastActivityAt: null,
    localDay: null,
    digestAt: '21:00',
    pausedUntil: null,
    nextActionAt: null,
    ...over,
  };
}

export function makeMed(over: Partial<Medicine> & { medKey: string; id: number }): Medicine {
  return {
    patientId: 1,
    name: over.medKey,
    doseText: null,
    notes: null,
    kind: 'interval',
    spec: { kind: 'interval', intervalMs: 2 * HOUR, anchor: 'wake' },
    specHash: 'h',
    steps: [{ name: over.name ?? over.medKey }],
    stepSpacingMs: 0,
    intervalMs: 2 * HOUR,
    minGapMs: 90 * MINUTE,
    onsetOffsetMs: 0,
    maxPerDay: null,
    awakeOnly: true,
    critical: false,
    driftPolicy: 'absorb',
    driftToleranceMs: 30 * MINUTE,
    catchupGraceMs: HOUR,
    nagPolicy: { stepsMs: [10 * MINUTE, 15 * MINUTE, 20 * MINUTE, 30 * MINUTE], escalateAfterMs: 5 * MINUTE },
    mergeable: true,
    courseKind: 'indefinite',
    courseDays: null,
    courseDoses: null,
    courseUntil: null,
    startedAt: null,
    dosesTaken: 0,
    dosesMissed: 0,
    lastTakenAt: null,
    lastCycleStartAt: null,
    lastPlannedDueAt: null,
    nextSeq: 1,
    nextStep: 0,
    status: 'active',
    ...over,
  } as Medicine;
}

export function makeChat(over: Partial<Chat> & { chatId: number }): Chat {
  return {
    patientId: 1,
    role: 'patient',
    canAck: true,
    escalationTier: 0,
    escalateAfterMs: 5 * MINUTE,
    active: true,
    ...over,
  };
}

export class World {
  now: number;
  readonly z: Zone;
  state: PatientState;
  sent: SentMessage[] = [];
  doseLog: DoseLogEntry[] = [];
  notes: Array<{ at: number; kind: string; detail: Record<string, unknown> }> = [];
  /** Every dose ever created, live or resolved. */
  allDoses: Dose[] = [];

  private nextDoseId = 1;
  private nextPromptId = 1;

  constructor(opts: {
    start: number;
    patient?: Partial<Patient>;
    meds: Medicine[];
    chats?: Chat[];
    mealDefs?: MealDef[];
  }) {
    this.now = opts.start;
    this.z = zoneFor(opts.patient?.tz ?? TZ);
    this.state = {
      patient: makePatient({ wakeStateSince: opts.start - 8 * HOUR, ...opts.patient }),
      chats: opts.chats ?? [makeChat({ chatId: 100 })],
      meds: opts.meds,
      liveDoses: [],
      openPrompts: [],
      mealDefs: opts.mealDefs ?? [],
      mealEvents: [],
      dayCounters: new Map(),
    };
  }

  med(key: string): Medicine {
    const m = this.state.meds.find((x) => x.medKey === key);
    if (m === undefined) throw new Error(`no medicine ${key}`);
    return m;
  }

  /**
   * When true, the world only plans when the patient's own `next_action_at` says to --
   * exactly as production does, where an idle tick is skipped by an indexed query.
   * Without this the simulator ticks every minute regardless, which silently papers over
   * any failure to schedule the next wake-up.
   */
  respectSchedule = false;

  /** Ticks where planning was skipped because nothing was scheduled. */
  skipped = 0;

  /** One tick: plan, apply, assert. */
  tick(): Action[] {
    if (this.respectSchedule) {
      const next = this.state.patient.nextActionAt;
      if (next !== null && next > this.now) {
        this.skipped++;
        this.assertInvariants();
        return [];
      }
    }
    const actions = plan(this.state, this.now, this.z);
    this.apply(actions);
    this.assertInvariants();
    return actions;
  }

  /** Advance the clock, ticking every minute, for `ms`. */
  run(ms: number): void {
    const end = this.now + ms;
    while (this.now < end) {
      this.tick();
      this.now += MINUTE;
    }
  }

  /** Advance until `predicate` holds or the budget runs out. Returns whether it held. */
  runUntil(predicate: (w: World) => boolean, maxMs: number): boolean {
    const end = this.now + maxMs;
    while (this.now < end) {
      this.tick();
      if (predicate(this)) return true;
      this.now += MINUTE;
    }
    return false;
  }

  // --- user actions -------------------------------------------------------

  /** The patient (or a caregiver) answers a dose prompt. */
  resolve(
    doseId: number,
    status: 'taken' | 'skipped',
    opts: { takenAt?: number; byChat?: number } = {},
  ): void {
    const dose = this.state.liveDoses.find((d) => d.id === doseId);
    if (dose === undefined) throw new Error(`dose ${doseId} is not live`);
    this.applyResolution(dose, status, opts.takenAt ?? this.now, opts.byChat ?? 100, 'button');
  }

  /** Answer whatever dose prompt is currently open for a medicine. */
  take(medKey: string, opts: { takenAt?: number; byChat?: number } = {}): void {
    const med = this.med(medKey);
    const dose = this.state.liveDoses.find((d) => d.medId === med.id && (d.status === 'due' || d.status === 'prompted'));
    if (dose === undefined) throw new Error(`no pending dose for ${medKey}`);
    this.resolve(dose.id, 'taken', opts);
  }

  declare(kind: 'wake' | 'sleep', at?: number): void {
    const when = at ?? this.now;
    const p = this.state.patient;
    p.wakeState = kind === 'wake' ? 'awake' : 'asleep';
    p.wakeConfidence = 'confirmed';
    p.wakeStateSince = when;
    if (kind === 'wake') p.lastWakeAt = when;
    else p.lastSleepAt = when;
    p.lastActivityAt = this.now;
    p.nextActionAt = this.now;
    for (const q of this.state.openPrompts) {
      if (q.kind === kind) q.state = 'resolved';
    }
    this.state.openPrompts = this.state.openPrompts.filter((q) => q.state === 'open');
  }

  eat(meal: string, at?: number): void {
    const when = at ?? this.now;
    const day = this.z.localDay(when);
    this.state.mealEvents = this.state.mealEvents.filter((e) => !(e.meal === meal && e.localDay === day));
    this.state.mealEvents.push({ patientId: 1, meal, localDay: day, at: when, source: 'confirmed' });
    this.state.patient.nextActionAt = this.now;
    for (const q of this.state.openPrompts) {
      if (q.kind === 'meal' && q.body.meal === meal) q.state = 'resolved';
    }
    this.state.openPrompts = this.state.openPrompts.filter((q) => q.state === 'open');
  }

  // --- reducer ------------------------------------------------------------

  private applyResolution(
    dose: Dose,
    status: 'taken' | 'skipped' | 'missed' | 'cancelled',
    takenAt: number | null,
    byChat: number | null,
    src: Dose['resolutionSrc'],
  ): void {
    const med = this.state.meds.find((m) => m.id === dose.medId);
    if (med === undefined) return;

    dose.status = status;
    dose.takenAt = status === 'taken' ? takenAt : null;
    dose.resolvedAt = this.now;
    dose.resolvedByChat = byChat;
    dose.resolutionSrc = src;

    const adv = advanceMedicine(med, dose, status, takenAt);
    Object.assign(med, adv);

    if (status === 'taken' || status === 'missed') {
      const day = this.z.localDay(this.now);
      const key = med.id;
      const c = this.state.dayCounters.get(key) ?? { taken: 0, missed: 0 };
      if (dose.step === 0 || med.steps.length === 1) {
        if (status === 'taken') c.taken += 1;
        else c.missed += 1;
      }
      this.state.dayCounters.set(key, c);
      void day;
    }

    this.doseLog.push({
      at: this.now,
      medKey: med.medKey,
      step: dose.step,
      seq: dose.seq,
      status,
      takenAt: dose.takenAt,
      plannedDueAt: dose.plannedDueAt,
    });

    // Close the prompt this dose belonged to, once none of its doses are live.
    if (dose.promptId !== null) {
      const prompt = this.state.openPrompts.find((q) => q.id === dose.promptId);
      if (prompt !== undefined) {
        const stillLive = prompt.body.doseIds.some((id) => {
          const d = this.state.liveDoses.find((x) => x.id === id);
          return d !== undefined && d.id !== dose.id && isLive(d.status);
        });
        if (!stillLive) prompt.state = 'resolved';
      }
    }

    this.state.liveDoses = this.state.liveDoses.filter((d) => isLive(d.status));
    this.state.openPrompts = this.state.openPrompts.filter((q) => q.state === 'open');
    // Answering something is exactly when the schedule needs recomputing.
    this.state.patient.nextActionAt = this.now;
  }

  private apply(actions: Action[]): void {
    const doseIdMap = new Map<number, number>();
    const promptIdMap = new Map<number, number>();
    const realDoseId = (id: number): number => doseIdMap.get(id) ?? id;

    for (const a of actions) {
      switch (a.t) {
        case 'setWake': {
          const p = this.state.patient;
          p.wakeState = a.state;
          p.wakeConfidence = a.confidence;
          p.wakeStateSince = a.at;
          if (a.state === 'awake') p.lastWakeAt = a.at;
          else p.lastSleepAt = a.at;
          break;
        }

        case 'rollDay':
          this.state.patient.localDay = a.localDay;
          this.state.dayCounters = new Map();
          break;

        case 'createDose': {
          const id = this.nextDoseId++;
          doseIdMap.set(a.id, id);
          const dose: Dose = {
            id,
            patientId: this.state.patient.id,
            medId: a.medId,
            seq: a.seq,
            step: a.step,
            localDay: a.localDay,
            plannedDueAt: a.plannedDueAt,
            effectiveDueAt: a.effectiveDueAt,
            anchorKind: a.anchorKind,
            status: 'scheduled',
            takenAt: null,
            resolvedAt: null,
            resolvedByChat: null,
            resolutionSrc: null,
            nagCount: 0,
            firstPromptAt: null,
            promptId: null,
          };
          this.state.liveDoses.push(dose);
          this.allDoses.push(dose);
          break;
        }

        case 'retimeDose': {
          const d = this.state.liveDoses.find((x) => x.id === realDoseId(a.doseId));
          if (d !== undefined) {
            d.effectiveDueAt = a.effectiveDueAt;
            if (a.anchorKind !== undefined) d.anchorKind = a.anchorKind;
            if (d.status === 'deferred') d.status = 'scheduled';
          }
          break;
        }

        case 'setDoseStatus': {
          const d = this.state.liveDoses.find((x) => x.id === realDoseId(a.doseId));
          if (d !== undefined) d.status = a.status;
          break;
        }

        case 'resolveDose': {
          const d = this.state.liveDoses.find((x) => x.id === realDoseId(a.doseId));
          if (d !== undefined) this.applyResolution(d, a.status, a.takenAt, a.byChat, a.src);
          break;
        }

        case 'completeMed': {
          const m = this.state.meds.find((x) => x.id === a.medId);
          if (m !== undefined) m.status = 'completed';
          break;
        }

        case 'createPrompt': {
          const id = this.nextPromptId++;
          promptIdMap.set(a.id, id);
          const doseIds = a.body.doseIds.map(realDoseId);
          const prompt: Prompt = {
            id,
            patientId: this.state.patient.id,
            kind: a.kind,
            state: 'open',
            body: { ...a.body, doseIds },
            nudgeCount: 0,
            lastNudgeAt: null,
            escalatedTier: 0,
            createdAt: this.now,
          };
          this.state.openPrompts.push(prompt);
          for (const did of doseIds) {
            const d = this.state.liveDoses.find((x) => x.id === did);
            if (d !== undefined) {
              d.promptId = id;
              d.status = 'prompted';
              if (d.firstPromptAt === null) d.firstPromptAt = this.now;
            }
          }
          this.fanOut(prompt, 0, false);
          break;
        }

        case 'nudgePrompt': {
          const q = this.state.openPrompts.find((x) => x.id === (promptIdMap.get(a.promptId) ?? a.promptId));
          if (q !== undefined) {
            q.nudgeCount += 1;
            q.lastNudgeAt = a.at;
            for (const did of q.body.doseIds) {
              const d = this.state.liveDoses.find((x) => x.id === did);
              if (d !== undefined) d.nagCount += 1;
            }
            this.fanOut(q, q.escalatedTier, true);
          }
          break;
        }

        case 'escalatePrompt': {
          const q = this.state.openPrompts.find((x) => x.id === (promptIdMap.get(a.promptId) ?? a.promptId));
          if (q !== undefined) {
            q.escalatedTier = a.tier;
            this.fanOutTier(q, a.tier, false);
          }
          break;
        }

        case 'closePrompt': {
          const q = this.state.openPrompts.find((x) => x.id === (promptIdMap.get(a.promptId) ?? a.promptId));
          if (q !== undefined) q.state = a.state;
          this.state.openPrompts = this.state.openPrompts.filter((x) => x.state === 'open');
          break;
        }

        case 'recordMeal': {
          this.state.mealEvents = this.state.mealEvents.filter(
            (e) => !(e.meal === a.meal && e.localDay === a.localDay),
          );
          this.state.mealEvents.push({
            patientId: this.state.patient.id,
            meal: a.meal,
            localDay: a.localDay,
            at: a.at,
            source: a.source,
          });
          break;
        }

        case 'setNextAction':
          this.state.patient.nextActionAt = a.at;
          break;

        case 'note':
          this.notes.push({ at: this.now, kind: a.kind, detail: a.detail });
          break;
      }
    }

    this.state.liveDoses = this.state.liveDoses.filter((d) => isLive(d.status));
  }

  private fanOut(prompt: Prompt, tier: number, nudge: boolean): void {
    for (const chat of this.state.chats) {
      if (!chat.active || chat.escalationTier > tier) continue;
      this.sent.push({
        at: this.now,
        chatId: chat.chatId,
        kind: prompt.kind,
        promptId: prompt.id,
        doseIds: prompt.body.doseIds,
        nudge,
        tier: chat.escalationTier,
      });
    }
  }

  private fanOutTier(prompt: Prompt, tier: number, nudge: boolean): void {
    for (const chat of this.state.chats) {
      if (!chat.active || chat.escalationTier !== tier) continue;
      this.sent.push({
        at: this.now,
        chatId: chat.chatId,
        kind: prompt.kind,
        promptId: prompt.id,
        doseIds: prompt.body.doseIds,
        nudge,
        tier,
      });
    }
  }

  // --- invariants ---------------------------------------------------------

  /**
   * Checked after every single tick. These are the properties that make the difference
   * between a reminder system and a liability.
   */
  assertInvariants(): void {
    const t = new Date(this.now).toISOString();

    // I3 -- no stacking. At most one live dose per medicine, ever.
    const perMed = new Map<number, number>();
    for (const d of this.state.liveDoses) {
      perMed.set(d.medId, (perMed.get(d.medId) ?? 0) + 1);
    }
    for (const [medId, n] of perMed) {
      expect(n, `${t}: medicine ${medId} has ${n} live doses`).toBe(1);
    }

    // I1 -- liveness. Every active, self-scheduling medicine has a live dose.
    for (const med of this.state.meds) {
      if (med.status !== 'active' || med.kind === 'as_needed') continue;
      expect(
        perMed.get(med.id) ?? 0,
        `${t}: active medicine ${med.medKey} has no live dose -- it has gone silent`,
      ).toBe(1);
    }

    // I2 -- safety. No two doses of a medicine closer together than its min gap.
    const takenByMed = new Map<number, number[]>();
    for (const d of this.allDoses) {
      if (d.status !== 'taken' || d.takenAt === null || d.step !== 0) continue;
      const list = takenByMed.get(d.medId) ?? [];
      list.push(d.takenAt);
      takenByMed.set(d.medId, list);
    }
    for (const [medId, times] of takenByMed) {
      const med = this.state.meds.find((m) => m.id === medId);
      if (med === undefined) continue;
      times.sort((a, b) => a - b);
      for (let i = 1; i < times.length; i++) {
        const gap = times[i]! - times[i - 1]!;
        expect(
          gap >= med.minGapMs,
          `${t}: ${med.medKey} doses ${gap}ms apart, min gap is ${med.minGapMs}ms`,
        ).toBe(true);
      }
    }

    // I7 -- cursor consistency. A newly created dose must match the medicine's cursor.
    // Without this, a rolled-forward step quietly repeats itself instead of starting the
    // next cycle, and nothing else in the system notices.
    for (const d of this.state.liveDoses) {
      const med = this.state.meds.find((m) => m.id === d.medId);
      if (med === undefined || d.status === 'deferred') continue;
      expect(
        `${d.seq}.${d.step}`,
        `${t}: live dose of ${med.medKey} is cycle ${d.seq} step ${d.step}, but the medicine cursor says ${med.nextSeq}.${med.nextStep}`,
      ).toBe(`${med.nextSeq}.${med.nextStep}`);
    }

    // I5 -- quiet. No non-critical dose message while the patient is asleep.
    if (this.state.patient.wakeState === 'asleep') {
      const justSent = this.sent.filter((s) => s.at === this.now && s.kind === 'dose');
      for (const s of justSent) {
        const critical = s.doseIds.some((id) => {
          const d = this.allDoses.find((x) => x.id === id);
          const m = d === undefined ? undefined : this.state.meds.find((mm) => mm.id === d.medId);
          return m?.critical ?? false;
        });
        expect(critical, `${t}: non-critical dose message sent while asleep`).toBe(true);
      }
    }
  }

  // --- reporting ----------------------------------------------------------

  takenTimes(medKey: string): string[] {
    const med = this.med(medKey);
    return this.allDoses
      .filter((d) => d.medId === med.id && d.status === 'taken' && d.takenAt !== null)
      .sort((a, b) => a.takenAt! - b.takenAt!)
      .map((d) => `${this.z.localDay(d.takenAt!)} ${this.z.fmtTime(d.takenAt!)}`);
  }

  countByStatus(medKey: string, status: DoseStatus): number {
    const med = this.med(medKey);
    return this.allDoses.filter((d) => d.medId === med.id && d.status === status).length;
  }
}
