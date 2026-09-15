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
import { planReports } from './planReport.js';
import {
  activePhase, clampToBedtime, courseComplete, effectiveMed, nextDue, reviveAtWake, rollForwardAfter,
} from './planSchedule.js';
import { applySpacing } from './planGroups.js';
import { sanitizeMedicine, sanitizePatient, saneNagSteps } from './sanitize.js';
import { advanceMedicine } from './advance.js';
import type { DayFacts } from './planSchedule.js';
import type { Zone } from './tz.js';
import { HOUR, MINUTE, mealDayOf } from './tz.js';
import { esc } from './html.js';

/**
 * Doses landing within this window of each other share one message. Five minutes is
 * clinically irrelevant and turns "three notifications ninety seconds apart" into one
 * checklist. Spacing-group steps are exempt -- their whole point is to be separated.
 */
const MERGE_WINDOW = 5 * MINUTE;

export function plan(rawState: PatientState, now: number, z: Zone): Action[] {
  // Everything downstream assumes sane numbers and readable times. One malformed row
  // must not be able to throw, because an exception here means this patient silently
  // stops being reminded and nothing says so.
  const state: PatientState = {
    ...rawState,
    patient: sanitizePatient(rawState.patient),
    meds: rawState.meds.map(sanitizeMedicine),
  };

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

  // Nobody with nothing to take should be asked whether they are awake. The day-state
  // machine still runs -- it costs nothing and is right when a prescription arrives -- but
  // the questions are for people who have a reason to be asked.
  const hasActiveMeds = state.meds.some((m) => m.status === 'active');

  let createdPrompt = false;
  const emitWatching = (a: Action): void => {
    if (a.t === 'createPrompt' && !hasActiveMeds) return;
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
    (kind) => openPrompts.filter((q) => q.kind === kind).map((q) => q.id),
    (stage) => openPrompts.some((q) => q.kind === 'sleep' && q.body.bedStage === stage),
  );
  push(wake.wakeAt);

  // --- 2. meals -----------------------------------------------------------
  const mealFacts = planMeals(
    state,
    now,
    z,
    mealDayOf(z, wake.state === 'awake' ? wake.wakeAnchor : p.lastWakeAt, now),
    wake.state === 'awake',
    emitWatching,
    (meal, stage) => openPrompts.some((q) => q.kind === 'meal' && q.body.meal === meal && q.body.stage === stage),
    wake.wakeAnchor,
  );
  push(mealFacts.wakeAt);

  // --- 2b. digest and watchdog -------------------------------------------
  const reports = planReports(state, now, z, today, emit);
  push(reports.wakeAt);

  // Tonight's expected sleep, and the earliest the patient is expected up again. Used to
  // keep doses inside the day they are actually having; the real wake time re-anchors
  // anything scheduled against the expected one.
  //
  // While the patient is actually asleep, the night in question is the one they are in,
  // not the one the clock predicts. Without this the schedule carried on planning around
  // them -- someone who went to bed at five in the morning had the next round of drops
  // booked for ten, in the middle of the sleep they had just declared.
  const sleepFrom =
    wake.state === 'asleep'
      ? Math.min(wake.asleepSince ?? now, now)
      : (wake.expectedSleepAt ?? z.nextWallAtOrAfter(p.presumedSleepAt, Math.max(wake.wakeAnchor, now - 12 * HOUR)));
  const wakeNext =
    wake.state === 'asleep'
      ? (wake.earliestWake ?? z.nextWallAtOrAfter(p.morningPollAt, now))
      : z.nextWallAtOrAfter(p.morningPollAt, sleepFrom);

  /**
   * How long outstanding reminders survive after bedtime. Measured from the moment sleep
   * actually began -- including one presumed on this very tick.
   */
  const graceUntil = (wake.asleepSince ?? p.wakeStateSince) + p.postBedGraceMs;

  const facts: DayFacts = {
    wakeAnchor: wake.wakeAnchor,
    awake: wake.state === 'awake',
    localDay: today,
    sleepFrom,
    wakeNext,
    postBedGraceMs: p.postBedGraceMs,
    dosesSinceWake: state.dosesSinceWake,
    meals: mealFacts.meals,
    skipped: mealFacts.skipped,
  };

  // --- 3. per medicine: keep exactly one correctly-timed live dose --------
  const liveByMed = new Map<number, Dose>();
  for (const d of state.liveDoses) liveByMed.set(d.medId, d);

  /** Doses that are due right now and still need a prompt. */
  const readyToPrompt: Array<{ dose: Dose; med: Medicine }> = [];
  /** Every medicine's live dose after scheduling, before spacing and prompting. */
  const settled: Array<{ dose: Dose; med: Medicine }> = [];

  for (const rawMed of state.meds) {
    if (rawMed.status !== 'active') continue;
    if (rawMed.kind === 'as_needed') continue; // only ever recorded by hand

    // Rolling a dose forward advances the medicine's cursor, and the successor has to be
    // built from the advanced one. Planning from the stale snapshot would recreate the
    // step that was just missed -- so drop two of an eye-drop group would be asked for
    // again instead of the group starting cleanly from drop one.
    // A tapering course changes schedule partway through, so everything below works on
    // the medicine as it behaves *today*, not as it was first prescribed.
    const phase = activePhase(rawMed, z, today);
    const phaseChanged = rawMed.phases !== null && phase.index !== rawMed.phaseIndex && !phase.done;
    if (phaseChanged) {
      emit({
        t: 'advancePhase',
        medId: rawMed.id,
        phaseIndex: phase.index,
        label: phase.phase?.label ?? `phase ${phase.index + 1}`,
      });
      emit({
        t: 'sendInfo',
        tier: 0,
        priority: 150,
        dedupe: `phase:${rawMed.id}:${phase.index}`,
        text:
          `📉 <b>${esc(rawMed.name)}</b> steps down today.\n\n` +
          `From now on: ${esc(phase.phase?.label ?? 'the next phase of the course')}.`,
      });
    }

    let med = effectiveMed(rawMed, z, today);
    let live = liveByMed.get(med.id) ?? null;

    // A phase advance cancels whatever was scheduled under the old phase. Leaving the
    // stale dose in hand meant this pass believed the medicine was covered and created
    // nothing, so it had no live dose at all until the next tick -- a gap /status
    // reported as "working out the next one" and a minute in which nothing was pending.
    if (phaseChanged && live !== null) {
      if (live.promptId !== null) emit({ t: 'closePrompt', promptId: live.promptId, state: 'cancelled', at: now });
      live = null;
    }

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
        emit({
          t: 'sendInfo',
          tier: 0,
          priority: 150,
          dedupe: `course:${med.id}`,
          text:
            `🎉 <b>${esc(med.name)} — course finished.</b>\n\n` +
            `${med.dosesTaken} dose${med.dosesTaken === 1 ? '' : 's'} taken` +
            `${med.dosesMissed > 0 ? `, ${med.dosesMissed} missed` : ' — every single one'}.\n\n` +
            `I'll stop reminding you about this one. Use /import if the doctor extends it.`,
        });
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

    // A meal that is not happening cannot be waited on. Resolve whatever depended on it
    // rather than leaving a dose hanging for the rest of the day.
    if (med.kind === 'meal' && live.takenAt === null) {
      const refs = med.spec.meals ?? (med.spec.meal === undefined ? [] : [med.spec.meal]);
      const anchors = refs.filter((r) => !(facts.skipped?.has(r.meal) ?? false));
      if (refs.length > 0 && anchors.length === 0) {
        emit({
          t: 'resolveDose', doseId: live.id, status: 'skipped', at: now,
          takenAt: null, byChat: null, src: 'auto',
        });
        if (live.promptId !== null) {
          emit({ t: 'closePrompt', promptId: live.promptId, state: 'resolved', at: now });
        }
        push(z.startOfLocalDay(z.addLocalDays(today, 1)));
        continue;
      }
    }

    // A meal-anchored dose was scheduled against whatever was known at the time -- very
    // often a prediction, because the patient had not yet said when they were eating.
    // Once they do say, the dose has to follow: a tablet meant for half an hour before
    // breakfast is worthless if it stays pinned to a guess.
    if (med.kind === 'meal' && live.status !== 'deferred' && live.takenAt === null) {
      // Re-derived with the medicine's real cursor, not a blanked one. Nulling
      // `lastCycleStartAt` made the meal that had just been used eligible again, and
      // `nextDue` then floored the result at exactly `lastTakenAt + minGap` -- which the
      // `>=` below accepted. A once-daily tablet taken after breakfast was prompted again
      // half an hour later, and again after that: one real repeat dose per min-gap.
      const desired = nextDue({ ...med, nextStep: 0 }, state, facts, now, z);
      if (desired !== null && desired.blocked === undefined) {
        const drift = Math.abs(desired.effectiveDueAt - live.effectiveDueAt);
        const clearsGap =
          med.lastTakenAt === null || desired.effectiveDueAt > med.lastTakenAt + med.minGapMs;
        // This block exists to follow a meal whose *time* moved, not to re-choose which
        // meal the dose belongs to. Once today's meals are an hour behind, the schedule
        // starts answering with the next one along -- and an unanswered breakfast dose
        // was quietly becoming the dinner dose, or tomorrow's breakfast, prompt cancelled
        // and nothing logged. Beyond the roll-forward horizon it is no longer the same
        // dose: leave it where it is and let it be recorded missed, honestly.
        const sameMeal =
          desired.effectiveDueAt <= live.effectiveDueAt ||
          desired.effectiveDueAt - live.effectiveDueAt <= rollForwardAfter(med);
        if (drift > MINUTE && clearsGap && sameMeal) {
          emit({
            t: 'retimeDose',
            doseId: live.id,
            effectiveDueAt: desired.effectiveDueAt,
            anchorKind: 'meal',
          });
          live = { ...live, effectiveDueAt: desired.effectiveDueAt, plannedDueAt: desired.plannedDueAt };
          if (live.promptId !== null && desired.effectiveDueAt > now) {
            emit({ t: 'closePrompt', promptId: live.promptId, state: 'cancelled', at: now });
            live = { ...live, promptId: null, status: 'scheduled' };
          }
        }
      }
    }

    // The first dose of a waking day belongs to the moment the patient actually got up,
    // and that moment keeps moving until they say so. Two ways it goes wrong, and both
    // have to be caught here:
    //
    //  - too early: presumed awake at nine, actually surfaced at noon. The morning's
    //    reminders would otherwise sit in the past and all fire at once.
    //  - too late: the dose was scheduled while they were asleep, so the night-skip put
    //    it at tomorrow's wake time. Getting up early then meant no drops at all until
    //    the following morning -- silent, and the worst failure this system has.
    if (
      med.spec.anchor === 'wake' &&
      (live.status === 'scheduled' || live.status === 'due' || live.status === 'prompted') &&
      (med.lastTakenAt === null || med.lastTakenAt < facts.wakeAnchor)
    ) {
      // A medicine already at its daily cap was deliberately pushed into tomorrow; that
      // is a safety decision, not a stale anchor, and must not be undone here.
      const capped =
        med.maxPerDay !== null && (state.dayCounters.get(med.id)?.taken ?? 0) >= med.maxPerDay;
      // Where the schedule wants it, floored only by the min-gap -- never by `now`, or
      // the comparison below would drift by a minute on every tick.
      const target = Math.max(
        facts.wakeAnchor + med.onsetOffsetMs,
        med.lastCycleStartAt === null ? -Infinity : med.lastCycleStartAt + med.minGapMs,
      );
      const desired = Math.max(target, now);
      const stranded = live.effectiveDueAt < facts.wakeAnchor;
      const parkedPastTheDay = live.effectiveDueAt > desired + MINUTE;
      if (!capped && (stranded || parkedPastTheDay) && desired !== live.effectiveDueAt) {
        emit({ t: 'retimeDose', doseId: live.id, effectiveDueAt: desired, anchorKind: 'wake' });
        // The planned time moves with it: this dose belongs to today, not to the morning
        // that never happened, and drift absorption should measure from the new grid.
        live = { ...live, effectiveDueAt: desired, plannedDueAt: desired, anchorKind: 'wake' };
        if (live.promptId !== null) {
          emit({ t: 'closePrompt', promptId: live.promptId, state: 'cancelled', at: now });
          live = { ...live, promptId: null, status: 'scheduled' };
        }
      }
    }

    // And again every tick, in case bedtime has moved since. Computed from the schedule's
    // own intent rather than from the last answer, so it is idempotent -- and so pushing
    // bedtime back brings the dose back with it.
    if ((live.status === 'scheduled' || live.status === 'due') && live.takenAt === null && live.step === 0) {
      // The safety floor is reapplied before clamping. Re-deriving from the plan alone
      // would quietly undo it: a dose the min-gap had pushed later would be dragged back
      // to its planned time, and two doses would land ten minutes apart.
      // A medicine already at its daily cap was deliberately pushed into tomorrow. Nothing
      // here may drag it back: re-deriving from the plan alone did exactly that, and a
      // three-a-day medicine took eight.
      const capped =
        med.maxPerDay !== null && (state.dayCounters.get(med.id)?.taken ?? 0) >= med.maxPerDay;
      const floor = Math.max(
        live.plannedDueAt,
        med.lastTakenAt === null ? -Infinity : med.lastTakenAt + med.minGapMs,
        med.lastCycleStartAt === null ? -Infinity : med.lastCycleStartAt + med.minGapMs,
      );
      const desired = capped ? live.effectiveDueAt : clampToBedtime(med, floor, facts, now);
      if (Math.abs(desired - live.effectiveDueAt) > MINUTE) {
        emit({ t: 'retimeDose', doseId: live.id, effectiveDueAt: desired });
        live = { ...live, effectiveDueAt: desired };
      }
    }

    // Sleep gating. Critical medicines pierce it; everything else parks as a single
    // deferred dose rather than accumulating one per missed interval.
    //
    // Anything landing before the patient is expected up parks now, not when it comes
    // due. Going to sleep resets the day: whatever was still pending, and whatever the
    // schedule had lined up for the small hours, waits for the morning and re-anchors on
    // the moment they actually get up.
    if (med.awakeOnly && !med.critical) {
      const duringSleep =
        live.effectiveDueAt <= now ||
        (typeof facts.wakeNext === 'number' && live.effectiveDueAt < facts.wakeNext);
      // A dose that was already being asked about when bedtime arrived keeps being asked
      // about for the grace hour. Parking it the instant the clock said "asleep" is what
      // made the grace period meaningless: there was never anything left outstanding.
      const chasingInGrace =
        (live.status === 'due' || live.status === 'prompted') && now < graceUntil;
      if (!facts.awake && duringSleep && !chasingInGrace && live.status !== 'deferred') {
        emit({ t: 'setDoseStatus', doseId: live.id, status: 'deferred' });
        settled.push({ dose: { ...live, status: 'deferred' }, med });
        continue;
      }
      if (live.status === 'deferred') {
        if (!facts.awake) {
          settled.push({ dose: live, med });
          continue;
        }
        const at = reviveAtWake(med, facts, now);
        emit({ t: 'retimeDose', doseId: live.id, effectiveDueAt: at, anchorKind: 'wake' });
        live = { ...live, effectiveDueAt: at, status: 'scheduled' };
      }
    }

    // Collected rather than prompted here: the spacing constraint below may still move
    // this dose, and prompting before that would defeat the whole point.
    settled.push({ dose: live, med });
  }

  // --- 3b. keep spaced medicines apart ------------------------------------
  applySpacing(settled, now, emit);

  // Spacing is the last thing that can move a dose, and it knows nothing about bedtime:
  // three drops staggered ten minutes apart can walk the last one over the line. So the
  // rule is applied once more, here, where nothing else will touch the time again. One
  // guarantee in one place beats four creation paths each remembering to be careful.
  for (const item of settled) {
    const { med } = item;
    const d = item.dose;
    // Not mid-cycle steps: the ten minutes between two drops is a step gap, and the
    // min-gap the clamp respects governs the space between cycles, not inside one.
    if (d.step > 0) continue;
    if (d.takenAt !== null || (d.status !== 'scheduled' && d.status !== 'due')) continue;
    if (med.maxPerDay !== null && (state.dayCounters.get(med.id)?.taken ?? 0) >= med.maxPerDay) continue;
    const clamped = clampToBedtime(med, d.effectiveDueAt, facts, now);
    if (Math.abs(clamped - d.effectiveDueAt) > MINUTE) {
      emit({ t: 'retimeDose', doseId: d.id, effectiveDueAt: clamped });
      item.dose = { ...d, effectiveDueAt: clamped };
    }
  }

  for (const item of settled) {
    const { med } = item;
    let live = item.dose;

    // "After food" waits for there to have been food.
    //
    // The dose is still scheduled against the predicted meal -- the medicine is never
    // left with nothing -- but it does not come due until the meal has actually happened.
    // Asking for an after-breakfast tablet at twenty past nine, from a patient who did
    // not get up until eleven, is simply the wrong instruction. The wait is bounded: an
    // unanswered meal is presumed two hours past its assumed time, which releases it.
    const waitingOnFood =
      med.kind === 'meal' &&
      (() => {
        const refs = med.spec.meals ?? (med.spec.meal === undefined ? [] : [med.spec.meal]);
        const after = refs.filter((r) => r.relation !== 'before');
        if (after.length === 0) return false;
        return !after.some((r) => {
          const m = facts.meals.get(r.meal);
          return m !== undefined && m.confirmed && m.at + r.offsetMs <= now;
        });
      })();

    if (live.status === 'scheduled' && live.effectiveDueAt <= now && !waitingOnFood) {
      emit({ t: 'setDoseStatus', doseId: live.id, status: 'due' });
      live = { ...live, status: 'due' };
    }
    if (waitingOnFood) push(now + 15 * MINUTE);

    if (live.status === 'due' && live.promptId === null) {
      // Awake, or the medicine says the night is no obstacle. A dose marked not
      // awake-only was reaching 'due' and then sitting there unasked-for until morning,
      // because only `critical` was checked here while the deferral above looked at both.
      if (facts.awake || med.critical || !med.awakeOnly || now < graceUntil) {
        readyToPrompt.push({ dose: live, med });
      }
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
    const body: PromptBody = {
      kind: 'dose',
      doseIds: bucket.map((b) => b.dose.id),
      ...beforeMealContext(bucket[0]!.med, mealFacts, now),
    };
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
      body: { kind: 'dose', doseIds: [r.dose.id], ...beforeMealContext(r.med, mealFacts, now) },
      tier: 0,
    });
    scheduleFollowUps(r.med);
  }

  // --- 4b. tell the bedtime question what is still to be taken ------------
  // Asking "still turning in at one?" without naming the two drops still outstanding
  // wastes the one moment someone is actually thinking about going to bed.
  const bedtimeOpen = openPrompts.some((q) => q.kind === 'sleep' && q.body.bedStage !== undefined);
  const bedtimeNew = out.filter((a) => a.t === 'createPrompt' && a.kind === 'sleep' && a.body.bedStage !== undefined);
  if (bedtimeOpen || bedtimeNew.length > 0) {
    const beforeBed = settled
      .filter((x) => x.dose.takenAt === null && x.dose.effectiveDueAt <= (facts.sleepFrom ?? Infinity))
      .sort((a, b) => a.dose.effectiveDueAt - b.dose.effectiveDueAt)
      .slice(0, 6)
      .map((x) => ({
        doseId: x.dose.id,
        label: x.med.steps.length > 1 ? `${x.med.steps[x.dose.step]?.name ?? x.med.name}` : x.med.name,
        at: x.dose.effectiveDueAt,
      }));
    if (beforeBed.length > 0) {
      // The prompt created this tick is still just an action, so its body is patched in
      // place; an older one already in the database is updated through an action of its own.
      for (const a of bedtimeNew) {
        if (a.t === 'createPrompt') a.body = { ...a.body, beforeBed };
      }
      for (const prompt of openPrompts) {
        if (prompt.kind !== 'sleep' || prompt.body.bedStage === undefined || (prompt.body.beforeBed ?? []).length > 0) continue;
        emit({ t: 'setPromptBody', promptId: prompt.id, body: { ...prompt.body, beforeBed } });
      }
    }
  }

  // --- 5. nag and escalate open prompts -----------------------------------
  for (const prompt of openPrompts) {
    // Don't nag a sleeping patient about a non-critical dose. The prompt stays open and
    // resumes in the morning rather than being lost.
    // Sleep silences new nagging, but not for the first hour: a dose still outstanding at
    // ten past one is chased, because "assumed asleep" is an assumption and an unanswered
    // medicine is a fact.
    const inGrace = !facts.awake && now < graceUntil;
    const suppressed =
      prompt.kind === 'dose' && !facts.awake && !inGrace && !promptPiercesSleep(prompt, state);
    if (suppressed) continue;

    const policy = nagPolicyFor(prompt, state);
    // An empty ladder would mean never following up, which is the one thing this must
    // not do.
    const steps = saneNagSteps(policy.stepsMs);
    const stepMs = steps[Math.min(prompt.nudgeCount, steps.length - 1)] ?? 10 * MINUTE;
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
      const nextStep = steps[Math.min(prompt.nudgeCount + 1, steps.length - 1)] ?? stepMs;
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

/**
 * If this dose is meant to be taken before a meal, say which meal and how soon -- "take
 * this now, you're eating in about 30 minutes" is a reason, and a reason is what makes
 * someone actually do it.
 */
function beforeMealContext(
  med: Medicine,
  mealFacts: { meals: Map<string, { at: number; confirmed: boolean; planned: boolean }> },
  now: number,
): { beforeMeal?: { meal: string; inMs: number } } {
  const ref = med.spec.meal;
  if (ref === undefined || ref.relation !== 'before') return {};
  const m = mealFacts.meals.get(ref.meal);
  if (m === undefined || !m.planned) return {};
  const inMs = m.at - now;
  if (inMs < 0 || inMs > 6 * 60 * 60_000) return {};
  return { beforeMeal: { meal: ref.meal, inMs } };
}

/**
 * Does this prompt go out even while the patient is asleep?
 *
 * Critical medicines, obviously. But also anything explicitly marked as not awake-only:
 * that flag exists precisely to say "round the clock", and the scheduler already refuses
 * to park such a dose overnight. Suppressing its *prompt* meant the dose sat due and
 * unasked-for until morning -- the two halves of the same rule disagreeing.
 */
function promptPiercesSleep(prompt: Prompt, state: PatientState): boolean {
  return prompt.body.doseIds.some((id) => {
    const dose = state.liveDoses.find((d) => d.id === id);
    if (dose === undefined) return false;
    const med = state.meds.find((m) => m.id === dose.medId);
    if (med === undefined) return false;
    return med.critical || !med.awakeOnly;
  });
}

function nagPolicyFor(prompt: Prompt, state: PatientState): { stepsMs: number[]; escalateAfterMs: number } {
  // The "are you up?" question runs on its own cadence -- hourly by default -- because it
  // may go unanswered all night and a half-hourly buzz through the small hours is the
  // opposite of what it is for.
  if (prompt.kind === 'wake') {
    return { stepsMs: [state.patient.wakeCheckEveryMs], escalateAfterMs: 15 * MINUTE };
  }
  for (const id of prompt.body.doseIds) {
    const dose = state.liveDoses.find((d) => d.id === id);
    if (dose === undefined) continue;
    const med = state.meds.find((m) => m.id === dose.medId);
    if (med !== undefined) return med.nagPolicy;
  }
  // Wake, sleep and meal prompts: persistent but unhurried.
  return { stepsMs: [30 * MINUTE], escalateAfterMs: 15 * MINUTE };
}
