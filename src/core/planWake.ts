/**
 * The wake/sleep state machine.
 *
 * Everything downstream depends on this: interval medicines anchor their first dose on
 * the wake time, and awake-only medicines are suppressed while the patient is asleep. So
 * the one property this module must have is that it can never get stuck. There is no
 * "unknown" state that waits indefinitely for a human -- the patient is always either
 * awake or asleep, with a `confidence` recording how firmly we believe it, and every
 * uncertain state is bounded by a clock time that resolves it without any input.
 */

import type { Action, PatientState, PromptKind, WakeConfidence, WakeState } from './domain.js';
import type { LocalDay, Zone } from './tz.js';
import { HOUR, MINUTE } from './tz.js';

export interface WakeFacts {
  state: WakeState;
  confidence: WakeConfidence;
  /** The instant the current waking day began. Anchors `anchor: 'wake'` medicines. */
  wakeAnchor: number;
  /** When the planner next wants to look at the day state. */
  wakeAt: number | null;
  /** Tonight's expected bedtime while awake, so the day can be planned around it. */
  expectedSleepAt: number | null;
  /** While asleep: when sleep began, and the earliest the bot may assume it has ended. */
  asleepSince: number | null;
  earliestWake: number | null;
}

/**
 * How long after going to bed an ordinary message stops counting as "I'm up".
 *
 * Tapping "🌙 in bed" and then sending one more line is the single most ordinary thing a
 * person does, and it used to start their whole day: medicines scheduled, prompts fired,
 * doses marked taken, all one minute after they said goodnight. A message is still strong
 * evidence -- much stronger than the clock -- so the window is short, not a full night.
 */
const SETTLING_PERIOD = HOUR;

/**
 * How long the patient has to be quiet before the clock may call it a night.
 *
 * Passing the presumed-sleep time is not evidence of being asleep -- it is evidence of
 * the time. Someone still answering reminders at half past one is plainly up, and
 * writing them off as asleep stops their medicines for the rest of the night. The clock
 * gets the last word, but only once nothing contradicts it.
 */
const STILL_UP_GRACE = 45 * MINUTE;

function push(list: (number | null)[], v: number | null): void {
  if (v !== null) list.push(v);
}

export function planWake(
  state: PatientState,
  now: number,
  z: Zone,
  today: LocalDay,
  emit: (a: Action) => void,
  hasOpenPrompt: (kind: PromptKind) => boolean,
  openPromptIds: (kind: PromptKind) => number[],
  hasBedPrompt: (stage: 'first' | 'second') => boolean,
): WakeFacts {
  const p = state.patient;
  let wakeState: WakeState = p.wakeState;
  let confidence: WakeConfidence = p.wakeConfidence;
  let anchor = p.lastWakeAt ?? p.wakeStateSince;
  /** Tonight's bedtime as it now stands, for the rest of the planner to schedule around. */
  let bedAt: number | null = null;
  // The state machine can change state within this call, and everything downstream needs
  // the instant it just set rather than the one it was loaded with. The grace hour after
  // bedtime is measured from here, so reading the stale value meant the hour had already
  // expired on the very tick sleep began.
  let stateSince = p.wakeStateSince;


  const wakeUps: (number | null)[] = [];

  const setState = (s: WakeState, c: WakeConfidence, at: number, source: string): void => {
    wakeState = s;
    confidence = c;
    stateSince = at;
    if (s === 'awake') anchor = at;
    emit({ t: 'setWake', state: s, confidence: c, at, source });
    // All of them, not the first found: two bedtime questions can be open at once -- the
    // hour-before and the half-hour-before -- and leaving one behind meant it nagged
    // through the night about a bedtime that had already happened.
    for (const kind of s === 'awake' ? (['wake'] as const) : (['sleep'] as const)) {
      for (const stale of openPromptIds(kind)) {
        emit({ t: 'closePrompt', promptId: stale, state: 'resolved', at: now });
      }
    }
  };

  // Sleep has a minimum length, and the clock is not allowed to end it early. Someone who
  // goes to bed at five in the morning should not be asked "awake?" at half past six and
  // should not have their day's dosing started at nine.
  const sleepFloor = p.wakeStateSince + p.minSleepMs;
  const settled = p.wakeStateSince + SETTLING_PERIOD;


  if (wakeState === 'asleep') {
    // --- night ------------------------------------------------------------
    //
    // Waking is never assumed from the clock. The configured morning time says where to
    // start asking, nothing more: a patient who sleeps in is not dosed at nine because
    // nine has arrived, and one who is up at five is not left waiting for it. Until the
    // minimum sleep has elapsed the bot is simply quiet; after that it asks, and keeps
    // asking, escalating to whoever backs them up if the asking goes unanswered.
    //
    // Two floors, and the morning reference is the important one: "after the minimum
    // sleep" on its own would start asking at three in the morning for anyone who went to
    // bed at eleven. The configured morning time says where asking may begin -- it never
    // says they are up.
    const morningRef = z.nextWallAtOrAfter(p.morningPollAt, p.wakeStateSince);
    const askFrom = Math.max(sleepFloor, morningRef, p.expectedWakeAt ?? 0);

    // Anything they do after a full night's sleep is evidence, not proof. It earns a
    // question -- "did you just wake up?" -- rather than a decision, because the answer
    // is often "hours ago", and starting the day from the wrong moment misplaces every
    // dose in it.
    const stirred = p.lastActivityAt !== null && p.lastActivityAt >= sleepFloor && p.lastActivityAt > p.wakeStateSince;

    if (now >= askFrom || stirred) {
      const open = openPromptIds('wake')[0] ?? null;
      const due = p.lastWakeCheckAt === null || now >= p.lastWakeCheckAt + p.wakeCheckEveryMs;
      if (open === null && (now >= askFrom || stirred) && (due || stirred)) {
        emit({
          t: 'createPrompt', id: 0, kind: 'wake', tier: 0,
          body: { kind: 'wake', doseIds: [], proposedAt: p.wakeStateSince },
        });
        emit({ t: 'markWakeCheck', at: now });
      }
      push(wakeUps, (p.lastWakeCheckAt ?? now) + p.wakeCheckEveryMs);
    } else {
      push(wakeUps, askFrom);
      push(wakeUps, settled > now ? settled : null);
    }
  }

  if (wakeState === 'awake') {
    // --- evening ----------------------------------------------------------
    //
    // Bedtime is a negotiation, not a wall time. The configured hour is where tonight's
    // expectation starts; two prompts before it ask whether it still holds, and every
    // "+1 hour" moves it and restarts the same logic against the new time.
    const referenceBed = z.nextWallAtOrAfter(p.presumedSleepAt, Math.max(anchor, now - 18 * HOUR));
    const expectedBed =
      p.expectedSleepAt !== null && p.expectedSleepAt > anchor ? p.expectedSleepAt : referenceBed;
    if (p.expectedSleepAt !== expectedBed) emit({ t: 'setExpectedSleep', at: expectedBed });
    bedAt = expectedBed;

    if (now >= expectedBed) {
      // Bedtime has arrived and nothing has moved it. Sleep is assumed -- but the grace
      // period keeps outstanding reminders alive, so a dose still hanging at ten past one
      // is chased rather than parked, and anything the patient does in that hour reopens
      // the question.
      const stillUp = p.lastActivityAt !== null && now < p.lastActivityAt + STILL_UP_GRACE;
      if (stillUp) {
        push(wakeUps, p.lastActivityAt! + STILL_UP_GRACE);
      } else {
        const at = p.lastActivityAt !== null && p.lastActivityAt > expectedBed ? p.lastActivityAt : expectedBed;
        setState('asleep', 'presumed', at, 'presumed');
        emit({ t: 'setExpectedSleep', at: null });
        emit({ t: 'setExpectedWake', at: at + p.minSleepMs });
        push(wakeUps, at + p.minSleepMs);
      }
    } else {
      // The two "still turning in?" prompts. The second only goes out if the first went
      // unanswered, and both name the time they are asking about so a tap is enough.
      const firstAt = expectedBed - p.bedLeadFirstMs;
      const secondAt = expectedBed - p.bedLeadSecondMs;
      const stage: 'first' | 'second' | null =
        now >= secondAt ? 'second' : now >= firstAt ? 'first' : null;

      if (stage !== null && !hasBedPrompt(stage)) {
        // The half-hour question replaces the hour one rather than piling on top of it.
        if (stage === 'second') {
          for (const stale of openPromptIds('sleep')) {
            emit({ t: 'closePrompt', promptId: stale, state: 'expired', at: now });
          }
        }
        emit({
          t: 'createPrompt', id: 0, kind: 'sleep', tier: 0,
          body: { kind: 'sleep', doseIds: [], proposedAt: expectedBed, bedStage: stage },
        });
      }
      push(wakeUps, firstAt > now ? firstAt : null);
      push(wakeUps, secondAt > now ? secondAt : null);
      push(wakeUps, expectedBed);
    }
  }

  const future = wakeUps.filter((v): v is number => v !== null && v > now);
  return {
    state: wakeState,
    confidence,
    wakeAnchor: anchor,
    wakeAt: future.length > 0 ? Math.min(...future) : null,
    expectedSleepAt: bedAt,
    asleepSince: wakeState === 'asleep' ? stateSince : null,
    // What the schedule should treat as "the morning": no earlier than the minimum sleep,
    // and no earlier than the time the patient is normally asked about.
    earliestWake:
      wakeState === 'asleep'
        ? Math.max(
            sleepFloor,
            Math.min(z.nextWallAtOrAfter(p.morningPollAt, now), z.nextWallAtOrAfter(p.presumedWakeAt, now)),
          )
        : null,
  };
}

/**
 * Apply an explicit wake/sleep declaration, including a retrospective one.
 * Returns the actions; the caller decides what to do about medicines that were parked.
 */
export function declareWake(
  kind: 'wake' | 'sleep',
  at: number,
  source: string,
): Action[] {
  return [
    {
      t: 'setWake',
      state: kind === 'wake' ? 'awake' : 'asleep',
      confidence: 'confirmed',
      at,
      source,
    },
  ];
}
