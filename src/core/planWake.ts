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

import type { Action, PatientState, WakeConfidence, WakeState } from './domain.js';
import type { LocalDay, Zone } from './tz.js';
import { HOUR, MINUTE } from './tz.js';

export interface WakeFacts {
  state: WakeState;
  confidence: WakeConfidence;
  /** The instant the current waking day began. Anchors `anchor: 'wake'` medicines. */
  wakeAnchor: number;
  /** When the planner next wants to look at the day state. */
  wakeAt: number | null;
  /** While asleep: when sleep began, and the earliest the bot may assume it has ended. */
  asleepSince: number | null;
  earliestWake: number | null;
}

/** How often to re-ask an unanswered wake or sleep question. */
const POLL_INTERVAL = 30 * MINUTE;

/**
 * How long after going to bed an ordinary message stops counting as "I'm up".
 *
 * Tapping "🌙 in bed" and then sending one more line is the single most ordinary thing a
 * person does, and it used to start their whole day: medicines scheduled, prompts fired,
 * doses marked taken, all one minute after they said goodnight. A message is still strong
 * evidence -- much stronger than the clock -- so the window is short, not a full night.
 */
const SETTLING_PERIOD = HOUR;

function push(list: (number | null)[], v: number | null): void {
  if (v !== null) list.push(v);
}

export function planWake(
  state: PatientState,
  now: number,
  z: Zone,
  today: LocalDay,
  emit: (a: Action) => void,
  hasOpenPrompt: (kind: 'wake' | 'sleep') => boolean,
  openPromptId: (kind: 'wake' | 'sleep') => number | null,
): WakeFacts {
  const p = state.patient;
  let wakeState: WakeState = p.wakeState;
  let confidence: WakeConfidence = p.wakeConfidence;
  let anchor = p.lastWakeAt ?? p.wakeStateSince;
  // The state machine can change state within a single call -- inferred awake, then the
  // evening checks below. Those must see the state as it now is. Reading the stored
  // wakeStateSince instead meant that waking up after the presumed-sleep wall time put
  // the patient straight back to sleep in the same tick: "I'm up" at 07:00 was undone
  // because 01:00 was still, technically, after last night's bedtime.
  let stateSince = p.wakeStateSince;

  // These are resolved as "the most recent occurrence of this wall time", rather than
  // being pinned to today's calendar date, so the logic behaves correctly across
  // midnight -- a 01:30 presumed-sleep time belongs to the night that is still running,
  // not to the morning that has just started.
  const lastMorning = z.lastWallAtOrBefore(p.morningPollAt, now);
  const lastPresumedWake = z.lastWallAtOrBefore(p.presumedWakeAt, now);
  const lastEvening = z.lastWallAtOrBefore(p.eveningPollAt, now);
  const lastPresumedSleep = z.lastWallAtOrBefore(p.presumedSleepAt, now);

  const wakeUps: (number | null)[] = [];

  const setState = (s: WakeState, c: WakeConfidence, at: number, source: string): void => {
    wakeState = s;
    confidence = c;
    stateSince = at;
    if (s === 'awake') anchor = at;
    emit({ t: 'setWake', state: s, confidence: c, at, source });
    const stale = openPromptId(s === 'awake' ? 'wake' : 'sleep');
    if (stale !== null) emit({ t: 'closePrompt', promptId: stale, state: 'resolved', at: now });
  };

  // Sleep has a minimum length, and the clock is not allowed to end it early. Someone who
  // goes to bed at five in the morning should not be asked "awake?" at half past six and
  // should not have their day's dosing started at nine.
  const sleepFloor = p.wakeStateSince + p.minSleepMs;
  const settled = p.wakeStateSince + SETTLING_PERIOD;

  // The two morning times, held back by the minimum. Asking still comes before assuming:
  // a late night should be met with "awake?" and half an hour's grace, not with the whole
  // day's dosing arriving unannounced the moment the minimum runs out.
  const morningAt = Math.max(lastMorning, sleepFloor);
  const presumeAt = Math.max(lastPresumedWake, sleepFloor + POLL_INTERVAL);

  // Is it daytime for this patient right now? The last boundary crossed was the morning
  // poll rather than the evening one. This, not the bare clock, is what separates getting
  // up from being awake at three in the morning -- and it works for an afternoon nap,
  // which has no morning to wait for and would otherwise silence every reminder until
  // tomorrow, the exact quiet this system exists to prevent.
  const daytime = lastMorning > lastEvening;

  if (wakeState === 'asleep') {
    // (a) Anything the patient sent the bot proves they are up -- once they have been
    //     down long enough for it to mean that, and once the night is actually over.
    if (
      p.lastActivityAt !== null &&
      p.lastActivityAt > settled &&
      p.lastActivityAt > p.wakeStateSince &&
      daytime
    ) {
      setState('awake', 'inferred', p.lastActivityAt, 'activity');
    }
    // (b) The clock passed the fallback and nobody said otherwise. Dose anyway. The
    //     anchor is the fallback time, not now, so a late tick does not shift the day --
    //     unless the minimum sleep pushed it later, in which case the day starts there.
    else if (now >= presumeAt && lastPresumedWake > p.wakeStateSince) {
      setState('awake', 'presumed', presumeAt, 'presumed');
      emit({
        t: 'note',
        kind: 'presumed_wake',
        detail: { at: presumeAt },
      });
    }
    // (c) Morning has arrived but the fallback has not. Ask, and keep asking.
    else if (now >= morningAt && lastMorning > p.wakeStateSince) {
      if (!hasOpenPrompt('wake')) {
        emit({ t: 'createPrompt', id: 0, kind: 'wake', body: { kind: 'wake', doseIds: [] }, tier: 0 });
      }
      push(wakeUps, now + POLL_INTERVAL);
      push(wakeUps, presumeAt);
    }
    // (d) Still night, or not yet slept long enough. Come back when that changes.
    else {
      push(wakeUps, morningAt > now ? morningAt : null);
      push(wakeUps, presumeAt > now ? presumeAt : null);
      push(wakeUps, settled > now ? settled : null);
      push(wakeUps, z.nextWallAtOrAfter(p.morningPollAt, now));
      push(wakeUps, z.nextWallAtOrAfter(p.presumedWakeAt, now));
    }
  }

  if (wakeState === 'awake') {
    // (e) Past the presumed-sleep time with no word: treat as asleep. This only suppresses
    //     non-critical awake-only medicines, so presuming wrongly here costs a delayed
    //     reminder, never a missed critical one.
    if (now >= lastPresumedSleep && lastPresumedSleep > stateSince) {
      setState('asleep', 'presumed', lastPresumedSleep, 'presumed');
      push(wakeUps, z.nextWallAtOrAfter(p.morningPollAt, now));
    }
    // (f) Evening: ask whether they have turned in.
    else if (now >= lastEvening && lastEvening > stateSince) {
      if (!hasOpenPrompt('sleep')) {
        emit({ t: 'createPrompt', id: 0, kind: 'sleep', body: { kind: 'sleep', doseIds: [] }, tier: 0 });
      }
      push(wakeUps, now + POLL_INTERVAL);
      push(wakeUps, z.nextWallAtOrAfter(p.presumedSleepAt, now));
    } else {
      push(wakeUps, z.nextWallAtOrAfter(p.eveningPollAt, now));
      push(wakeUps, z.nextWallAtOrAfter(p.presumedSleepAt, now));
    }
  }

  const future = wakeUps.filter((v): v is number => v !== null && v > now);
  return {
    state: wakeState,
    confidence,
    wakeAnchor: anchor,
    wakeAt: future.length > 0 ? Math.min(...future) : null,
    asleepSince: wakeState === 'asleep' ? p.wakeStateSince : null,
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
