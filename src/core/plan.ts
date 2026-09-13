/**
 * The planner. Every scheduling decision in the system passes through this function.
 *
 *   plan(state, now, zone) -> Action[]
 *
 * It is pure: no fetch, no database, no Date.now(), no randomness. The tick loads a
 * snapshot, calls this, applies the resulting actions in one batch, then sends whatever
 * messages came out. That separation is the whole reason a week of behaviour can be
 * simulated deterministically in a unit test, which for medication scheduling is the
 * difference between "seems to work" and "known to work".
 */

import type { Action, Dose, Medicine, PatientState, Prompt, PromptBody } from './domain.js';
import { tempIds } from './domain.js';
import { planMeals } from './planMeals.js';
import { planWake } from './planWake.js';
import { courseComplete, nextDue, reviveAtWake, rollForwardAfter } from './planSchedule.js';
import { advanceMedicine } from './advance.js';
import type { DayFacts } from './planSchedule.js';
import type { Zone } from './tz.js';
import { MINUTE } from './tz.js';

/**
 * Doses landing within this window of each other share one message. Five minutes is
 * clinically irrelevant and turns "three notifications ninety seconds apart" into one
 * checklist. Spacing-group steps are exempt -- their whole point is to be separated.
 */
const MERGE_WINDOW = 5 * MINUTE;

export function plan(state: PatientState, now: number, z: Zone): Action[] {
  const out: Action[] = [];
  const nextTemp = tempIds();

  // createDose / createPrompt reference rows that do not exist yet, so they carry a
  // negative placeholder id that the database layer swaps for a real one.
  const emit = (a: Action): void => {
    if ((a.t === 'createDose' || a.t === 'createPrompt') && a.id === 0) a.id = nextTemp();
    out.push(a);
  };

  const p = state.patient;
  const wakeUps: number[] = [];
  const push = (at: number | null | undefined): void => {
    if (typeof at === 'number' && at > now) wakeUps.push(at);
  };

  // --- 0. paused ----------------------------------------------------------
  if (p.pausedUntil !== null && now < p.pausedUntil) {
    return [{ t: 'setNextAction', at: p.pausedUntil }];
  }

  const today = z.localDay(now);
  if (today !== p.localDay) emit({ t: 'rollDay', localDay: today });
  push(z.startOfLocalDay(z.addLocalDays(today, 1)));

  // --- 1. day state -------------------------------------------------------
  const openPrompts = state.openPrompts;
  const findOpen = (kind: Prompt['kind'], meal?: string): Prompt | undefined =>
    openPrompts.find((q) => q.kind === kind && (meal === undefined || q.body.meal === meal));

  let createdPrompt = false;
  const emitWatching = (a: Action): void => {
    if (a.t === 'createPrompt') createdPrompt = true;
    emit(a);
  };

  const wake = planWake(
    state,
    now,
    z,
    today,
    emitWatching,
    (kind) => findOpen(kind) !== undefined,
    (kind) => findOpen(kind)?.id ?? null,
  );
  push(wake.wakeAt);

  // --- 2. meals -----------------------------------------------------------
  const mealFacts = planMeals(
    state,
    now,
    z,
    today,
    wake.state === 'awake',
    emitWatching,
    (meal) => findOpen('meal', meal) !== undefined,
  );
  push(mealFacts.wakeAt);

  const facts: DayFacts = {
    wakeAnchor: wake.wakeAnchor,
    awake: wake.state === 'awake',
    localDay: today,
    meals: mealFacts.meals,
  };

  // --- 3. per medicine: keep exactly one correctly-timed live dose --------
  const liveByMed = new Map<number, Dose>();
  for (const d of state.liveDoses) liveByMed.set(d.medId, d);

  /** Doses that are due right now and still need a prompt. */
  const readyToPrompt: Array<{ dose: Dose; med: Medicine }> = [];

  for (const rawMed of state.meds) {
    if (rawMed.status !== 'active') continue;
    if (rawMed.kind === 'as_needed') continue; // only ever recorded by hand

    // Rolling a dose forward advances the medicine's cursor, and the successor has to be
    // built from the advanced one. Planning from the stale snapshot would recreate the
    // step that was just missed -- so drop two of an eye-drop group would be asked for
    // again instead of the group starting cleanly from drop one.
    let med = rawMed;
    let live = liveByMed.get(med.id) ?? null;

    // Roll-forward. The bot never stops nagging, but an unanswered prompt must never be
    // able to wedge a medicine: once the next dose would have been due, log the old one
    // missed and carry on. Falling through to create the successor in the same pass is
    // mandatory -- a terminal path that does not schedule the next dose kills the
    // medicine silently for the rest of the course.
    if (live !== null && (live.status === 'prompted' || live.status === 'due')) {
      if (now >= live.effectiveDueAt + rollForwardAfter(med)) {
        emit({
          t: 'resolveDose',
          doseId: live.id,
          status: 'missed',
          at: now,
          takenAt: null,
          byChat: null,
          src: 'auto',
        });
        if (live.promptId !== null) {
          emit({ t: 'closePrompt', promptId: live.promptId, state: 'expired', at: now });
        }
        med = { ...med, ...advanceMedicine(med, live, 'missed', null) };
        live = null;
      }
    }

    if (live === null) {
      if (courseComplete(med, now, z, today)) {
        emit({ t: 'completeMed', medId: med.id, reason: 'course_complete' });
        continue;
      }

      const due = nextDue(med, state, facts, now, z);
      if (due === null) continue;
      if (due.blocked === 'awaiting_meal') {
        push(now + 30 * MINUTE);
        continue;
      }
      if (due.skipped > 0) {
        emit({
          t: 'note',
          kind: 'catchup_skip',
          detail: { medId: med.id, skipped: due.skipped, from: due.plannedDueAt },
        });
      }

      const id = nextTemp();
      emit({
        t: 'createDose',
        id,
        medId: med.id,
        seq: med.nextSeq,
        step: med.nextStep,
        localDay: z.localDay(due.effectiveDueAt),
        plannedDueAt: due.plannedDueAt,
        effectiveDueAt: due.effectiveDueAt,
        anchorKind: due.anchorKind,
      });

      live = {
        id,
        patientId: p.id,
        medId: med.id,
        seq: med.nextSeq,
        step: med.nextStep,
        localDay: z.localDay(due.effectiveDueAt),
        plannedDueAt: due.plannedDueAt,
        effectiveDueAt: due.effectiveDueAt,
        anchorKind: due.anchorKind,
        status: 'scheduled',
        takenAt: null,
        resolvedAt: null,
        resolvedByChat: null,
        resolutionSrc: null,
        nagCount: 0,
        firstPromptAt: null,
        promptId: null,
      };
    }

    // Sleep gating. Critical medicines pierce it; everything else parks as a single
    // deferred dose rather than accumulating one per missed interval.
    if (med.awakeOnly && !med.critical) {
      if (!facts.awake && live.effectiveDueAt <= now && live.status !== 'deferred') {
        emit({ t: 'setDoseStatus', doseId: live.id, status: 'deferred' });
        continue;
      }
      if (live.status === 'deferred') {
        if (!facts.awake) continue;
        const at = reviveAtWake(med, facts, now);
        emit({ t: 'retimeDose', doseId: live.id, effectiveDueAt: at, anchorKind: 'wake' });
        live = { ...live, effectiveDueAt: at, status: 'scheduled' };
      }
    }

    if (live.status === 'scheduled' && live.effectiveDueAt <= now) {
      emit({ t: 'setDoseStatus', doseId: live.id, status: 'due' });
      live = { ...live, status: 'due' };
    }

    if (live.status === 'due' && live.promptId === null) {
      if (facts.awake || med.critical) readyToPrompt.push({ dose: live, med });
      else push(now + 15 * MINUTE);
    }

    push(live.effectiveDueAt);
  }

  // --- 4. turn due doses into prompts -------------------------------------
  // Unspaced medicines coming due together share one checklist; a spacing-group step
  // always gets its own message, because separating them is the entire point.
  const mergeable = readyToPrompt
    .filter((r) => r.med.mergeable && r.med.steps.length <= 1)
    .sort((a, b) => a.dose.effectiveDueAt - b.dose.effectiveDueAt);
  const solo = readyToPrompt.filter((r) => !(r.med.mergeable && r.med.steps.length <= 1));

  /**
   * A prompt created during this tick is not in `openPrompts`, so section 5 will not see
   * it and will not schedule its follow-ups. Its first nudge and its escalation deadlines
   * therefore have to be registered here -- otherwise the next wake-up is whenever the
   * following dose happens to fall, which could be hours away, and the caregiver would
   * never be pulled in at all.
   */
  const scheduleFollowUps = (med: Medicine | null): void => {
    const policy = med?.nagPolicy ?? { stepsMs: [30 * MINUTE], escalateAfterMs: 15 * MINUTE };
    push(now + (policy.stepsMs[0] ?? 10 * MINUTE));
    for (const chat of state.chats) {
      if (chat.active && chat.escalationTier > 0) push(now + chat.escalateAfterMs);
    }
  };

  let bucket: Array<{ dose: Dose; med: Medicine }> = [];
  const flush = (): void => {
    if (bucket.length === 0) return;
    const body: PromptBody = { kind: 'dose', doseIds: bucket.map((b) => b.dose.id) };
    emit({ t: 'createPrompt', id: 0, kind: 'dose', body, tier: 0 });
    scheduleFollowUps(bucket[0]!.med);
    bucket = [];
  };
  for (const r of mergeable) {
    if (bucket.length > 0 && r.dose.effectiveDueAt - bucket[0]!.dose.effectiveDueAt > MERGE_WINDOW) {
      flush();
    }
    bucket.push(r);
  }
  flush();

  for (const r of solo) {
    emit({
      t: 'createPrompt',
      id: 0,
      kind: 'dose',
      body: { kind: 'dose', doseIds: [r.dose.id] },
      tier: 0,
    });
    scheduleFollowUps(r.med);
  }

  // --- 5. nag and escalate open prompts -----------------------------------
  for (const prompt of openPrompts) {
    // Don't nag a sleeping patient about a non-critical dose. The prompt stays open and
    // resumes in the morning rather than being lost.
    const suppressed = prompt.kind === 'dose' && !facts.awake && !promptIsCritical(prompt, state);
    if (suppressed) continue;

    const policy = nagPolicyFor(prompt, state);
    const stepMs = policy.stepsMs[Math.min(prompt.nudgeCount, policy.stepsMs.length - 1)] ?? 10 * MINUTE;
    const nextNudgeAt = (prompt.lastNudgeAt ?? prompt.createdAt) + stepMs;

    // Escalation is a property of the prompt, not of doses -- wake, sleep and meal
    // questions climb the same ladder, so no kind of prompt can quietly die unanswered
    // in a chat nobody is looking at.
    const higher = state.chats
      .filter((c) => c.active && c.escalationTier > prompt.escalatedTier)
      .sort((a, b) => a.escalationTier - b.escalationTier);
    for (const chat of higher) {
      if (now - prompt.createdAt >= chat.escalateAfterMs) {
        emit({ t: 'escalatePrompt', promptId: prompt.id, tier: chat.escalationTier, at: now });
        break;
      }
      push(prompt.createdAt + chat.escalateAfterMs);
    }

    if (now >= nextNudgeAt) {
      emit({ t: 'nudgePrompt', promptId: prompt.id, at: now });
      const nextStep = policy.stepsMs[Math.min(prompt.nudgeCount + 1, policy.stepsMs.length - 1)] ?? stepMs;
      push(now + nextStep);
    } else {
      push(nextNudgeAt);
    }
  }

  // Wake, sleep and meal questions climb the same escalation ladder as doses, so a
  // prompt created by either of those this tick needs its deadlines registered too.
  if (createdPrompt) {
    push(now + 30 * MINUTE);
    for (const chat of state.chats) {
      if (chat.active && chat.escalationTier > 0) push(now + chat.escalateAfterMs);
    }
  }

  // --- 6. when to wake up next -------------------------------------------
  emit({ t: 'setNextAction', at: wakeUps.length > 0 ? Math.min(...wakeUps) : null });
  return out;
}

function promptIsCritical(prompt: Prompt, state: PatientState): boolean {
  return prompt.body.doseIds.some((id) => {
    const dose = state.liveDoses.find((d) => d.id === id);
    if (dose === undefined) return false;
    return state.meds.find((m) => m.id === dose.medId)?.critical ?? false;
  });
}

function nagPolicyFor(prompt: Prompt, state: PatientState): { stepsMs: number[]; escalateAfterMs: number } {
  for (const id of prompt.body.doseIds) {
    const dose = state.liveDoses.find((d) => d.id === id);
    if (dose === undefined) continue;
    const med = state.meds.find((m) => m.id === dose.medId);
    if (med !== undefined) return med.nagPolicy;
  }
  // Wake, sleep and meal prompts: persistent but unhurried.
  return { stepsMs: [30 * MINUTE], escalateAfterMs: 15 * MINUTE };
}
