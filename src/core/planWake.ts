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
import { MINUTE } from './tz.js';

export interface WakeFacts {
  state: WakeState;
  confidence: WakeConfidence;
  /** The instant the current waking day began. Anchors `anchor: 'wake'` medicines. */
  wakeAnchor: number;
  /** When the planner next wants to look at the day state. */
  wakeAt: number | null;
}

/** How often to re-ask an unanswered wake or sleep question. */
const POLL_INTERVAL = 30 * MINUTE;

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
    if (s === 'awake') anchor = at;
    emit({ t: 'setWake', state: s, confidence: c, at, source });
    const stale = openPromptId(s === 'awake' ? 'wake' : 'sleep');
    if (stale !== null) emit({ t: 'closePrompt', promptId: stale, state: 'resolved', at: now });
  };

  if (wakeState === 'asleep') {
    // (a) Anything the patient sent the bot proves they are up. Free, and it removes most
    //     of the reason to ever ask.
    if (
      p.lastActivityAt !== null &&
      p.lastActivityAt > p.wakeStateSince &&
      p.lastActivityAt >= lastMorning
    ) {
      setState('awake', 'inferred', p.lastActivityAt, 'activity');
    }
    // (b) The clock passed the fallback and nobody said otherwise. Dose anyway. The
    //     anchor is the fallback time, not now, so a late tick does not shift the day.
    else if (now >= lastPresumedWake && lastPresumedWake > p.wakeStateSince) {
      setState('awake', 'presumed', lastPresumedWake, 'presumed');
      emit({
        t: 'note',
        kind: 'presumed_wake',
        detail: { at: lastPresumedWake },
      });
    }
    // (c) Morning has arrived but the fallback has not. Ask, and keep asking.
    else if (now >= lastMorning && lastMorning > p.wakeStateSince) {
      if (!hasOpenPrompt('wake')) {
        emit({ t: 'createPrompt', id: 0, kind: 'wake', body: { kind: 'wake', doseIds: [] }, tier: 0 });
      }
      push(wakeUps, Math.min(now + POLL_INTERVAL, lastPresumedWake > now ? lastPresumedWake : now + POLL_INTERVAL));
      push(wakeUps, z.nextWallAtOrAfter(p.presumedWakeAt, now));
    }
    // (d) Still night. Come back at the morning poll.
    else {
      push(wakeUps, z.nextWallAtOrAfter(p.morningPollAt, now));
      push(wakeUps, z.nextWallAtOrAfter(p.presumedWakeAt, now));
    }
  }

  if (wakeState === 'awake') {
    // (e) Past the presumed-sleep time with no word: treat as asleep. This only suppresses
    //     non-critical awake-only medicines, so presuming wrongly here costs a delayed
    //     reminder, never a missed critical one.
    if (now >= lastPresumedSleep && lastPresumedSleep > p.wakeStateSince) {
      setState('asleep', 'presumed', lastPresumedSleep, 'presumed');
      push(wakeUps, z.nextWallAtOrAfter(p.morningPollAt, now));
    }
    // (f) Evening: ask whether they have turned in.
    else if (now >= lastEvening && lastEvening > p.wakeStateSince) {
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
