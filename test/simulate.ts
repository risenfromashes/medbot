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
import type { NormalizedMed, NormalizedPrescription } from '../src/core/prescription.js';
import { rollForwardAfter } from '../src/core/planSchedule.js';
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
    minSleepMs: 4 * HOUR,
    expectedSleepAt: null,
    expectedWakeAt: null,
    wakeAskAfter: null,
    lastWakeCheckAt: null,
    bedLeadFirstMs: HOUR,
    bedLeadSecondMs: 30 * MINUTE,
    postBedGraceMs: HOUR,
    wakeCheckEveryMs: HOUR,
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
    lastDigestDay: null,
    lastWatchdogAt: null,
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
    spacingGroup: null,
    spacingMs: 0,
    groupSeq: null,
    phases: null,
    phaseIndex: 0,
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
    displayName: null,
    role: 'patient',
    canAck: true,
    escalationTier: 0,
    escalateAfterMs: 5 * MINUTE,
    active: true,
    ...over,
  };
}

/**
 * Turn a parsed prescription into simulator medicines, so a scenario can be driven by the
 * same JSON a patient would actually import rather than by a hand-built approximation.
 */
export function medsFromPrescription(meds: NormalizedMed[]): Medicine[] {
  return meds.map((m, i) =>
    makeMed({
      id: i + 1,
      medKey: m.medKey,
      name: m.name,
      doseText: m.doseText,
      kind: m.kind,
      spec: m.spec,
      steps: m.steps,
      stepSpacingMs: m.stepSpacingMs,
      spacingGroup: m.spacingGroup,
      spacingMs: m.spacingMs,
      groupSeq: m.groupSeq,
      phases: m.phases,
      intervalMs: m.intervalMs,
      minGapMs: m.minGapMs,
      onsetOffsetMs: m.onsetOffsetMs,
      maxPerDay: m.maxPerDay,
      awakeOnly: m.awakeOnly,
      critical: m.critical,
      driftPolicy: m.driftPolicy,
      driftToleranceMs: m.driftToleranceMs,
      catchupGraceMs: m.catchupGraceMs,
      nagPolicy: m.nagPolicy,
      mergeable: m.mergeable,
      courseKind: m.courseKind,
      courseDays: m.courseDays,
      courseDoses: m.courseDoses,
      courseUntil: m.courseUntil,
    }),
  );
}

export function mealDefsFromPrescription(meals: NormalizedPrescription['meals']): MealDef[] {
  return meals.map((m, i) => ({
    patientId: 1,
    meal: m.meal,
    typicalLocal: m.typicalLocal,
    askAfterLocal: m.askAfterLocal,
    presumeAtLocal: m.presumeAtLocal,
    afterWakeMs: null,
    minGapAfterPrevMs: 3 * HOUR,
    seq: i,
  }));
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
  /** Every prompt ever created, open or closed. */
  allPrompts: Prompt[] = [];

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
      dosesSinceWake: new Map(),
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
    if (kind === 'wake') {
      p.lastWakeAt = when;
      this.state.dosesSinceWake = new Map();
    } else {
      p.lastSleepAt = when;
    }
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
    this.state.mealEvents.push({ patientId: 1, meal, localDay: day, at: when, source: 'confirmed', plannedAt: null, askedAt: null });
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
    // The waking day's tally, which is what a "four times a day" quota is counted against.
    if (status === 'taken' || status === 'missed' || status === 'skipped') {
      if (dose.step === 0 || med.steps.length === 1) {
        this.state.dosesSinceWake.set(med.id, (this.state.dosesSinceWake.get(med.id) ?? 0) + 1);
      }
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
          if (a.state === 'awake') {
            p.lastWakeAt = a.at;
            // A new waking day starts its own count.
            this.state.dosesSinceWake = new Map();
          } else {
            p.lastSleepAt = a.at;
          }
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
            // Mirrors db.ts exactly. A dose moved onto a new wake or meal anchor belongs
            // to that anchor, so its planned time moves with it and drift is measured
            // from the new grid. Leaving this out made the simulator quietly disagree
            // with production about where the grid was.
            if ((a.anchorKind === 'wake' || a.anchorKind === 'meal') && a.effectiveDueAt > this.now) {
              d.plannedDueAt = a.effectiveDueAt;
              if (d.promptId !== null) {
                const q = this.state.openPrompts.find((x) => x.id === d.promptId);
                if (q !== undefined) q.state = 'cancelled';
                d.promptId = null;
              }
              if (d.status === 'due' || d.status === 'prompted') d.status = 'scheduled';
            } else if (a.anchorKind === 'wake' || a.anchorKind === 'meal') {
              d.plannedDueAt = a.effectiveDueAt;
            }
            if (d.status === 'deferred') d.status = 'scheduled';
          }
          this.state.openPrompts = this.state.openPrompts.filter((q) => q.state === 'open');
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
          this.allPrompts.push(prompt);
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
            plannedAt: a.plannedAt ?? null,
            askedAt: null,
          });
          break;
        }

        case 'closeMealPrompt': {
          for (const q of this.state.openPrompts) {
            if (q.kind === 'meal' && q.body.meal === a.meal) q.state = 'resolved';
          }
          this.state.openPrompts = this.state.openPrompts.filter((q) => q.state === 'open');
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
    //
    // With one precise exception: a medicine to be taken AFTER a meal genuinely cannot be
    // scheduled until that meal has happened. That is waiting on a precondition, not
    // going silent, and the distinction matters -- weakening the invariant to "sometimes
    // there is no dose" would hide the failure it exists to catch. The meal tests assert
    // separately that such a medicine does get its dose once the meal is confirmed.
    const today = this.z.localDay(this.now);
    for (const med of this.state.meds) {
      if (med.status !== 'active' || med.kind === 'as_needed') continue;

      const refs = med.spec.meals ?? (med.spec.meal === undefined ? [] : [med.spec.meal]);
      if (refs.length > 0) {
        // A medicine tied only to meals the patient has said they are skipping has
        // nothing to be scheduled against today. That is an answered question, not
        // silence -- and it comes back tomorrow.
        const anyMealToday = refs.some((ref) => {
          const event = this.state.mealEvents.find((e) => e.meal === ref.meal && e.localDay === today);
          return event === undefined || event.source !== 'skipped';
        });
        if (!anyMealToday) continue;
      }

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

    // I4 -- no hang. A prompted dose must never outlive the point at which its own
    // successor would be due; if it does, that medicine is wedged.
    for (const d of this.state.liveDoses) {
      if (d.status !== 'prompted' && d.status !== 'due') continue;
      const med = this.state.meds.find((m) => m.id === d.medId);
      if (med === undefined) continue;
      // Measured against the medicine's OWN roll-forward horizon, which is what the
      // planner uses. Guessing a limit here just asserts a different rule than the one
      // the code implements -- a once-daily medicine legitimately stays pending for hours,
      // because its successor is not due yet and the bot is still asking.
      const limit = rollForwardAfter(med) * 1.5;
      const asleepAllowance = this.state.patient.wakeState === 'asleep' ? 14 * HOUR : 0;
      expect(
        this.now - d.effectiveDueAt <= limit + asleepAllowance,
        `${t}: ${med.medKey} has been pending ${Math.round((this.now - d.effectiveDueAt) / 60000)}min — wedged`,
      ).toBe(true);
    }

    // I5 -- quiet. Nothing reaches a sleeping patient unless it has earned the right:
    // the medicine is critical, or says outright that it is not confined to waking hours,
    // or the bedtime grace hour is still running and the dose was already outstanding.
    const graceUntil = this.state.patient.wakeStateSince + this.state.patient.postBedGraceMs;
    if (this.state.patient.wakeState === 'asleep' && this.now >= graceUntil) {
      const justSent = this.sent.filter((s) => s.at === this.now && s.kind === 'dose');
      for (const s of justSent) {
        const critical = s.doseIds.some((id) => {
          const d = this.allDoses.find((x) => x.id === id);
          const m = d === undefined ? undefined : this.state.meds.find((mm) => mm.id === d.medId);
          return m === undefined ? false : m.critical || !m.awakeOnly;
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

  /**
   * I6 -- dosing rate. Over a long run, a medicine should resolve roughly as many doses as
   * its schedule implies. This is the invariant that catches the whole "quietly stopped
   * working" class: everything else can pass while the bot simply does less and less.
   */
  assertDosingRate(medKey: string, expected: number, tolerance = 0.9): void {
    const med = this.med(medKey);
    const resolved = this.allDoses.filter(
      (d) => d.medId === med.id && (d.status === 'taken' || d.status === 'missed' || d.status === 'skipped'),
    ).length;
    expect(
      resolved >= expected * tolerance,
      `${medKey}: only ${resolved} doses resolved, expected at least ${Math.floor(expected * tolerance)} of ${expected}`,
    ).toBe(true);
  }

  countByStatus(medKey: string, status: DoseStatus): number {
    const med = this.med(medKey);
    return this.allDoses.filter((d) => d.medId === med.id && d.status === status).length;
  }
}
