import { describe, expect, it } from 'vitest';
import { World, makeChat, makeMed, TZ } from '../simulate.js';
import { resolveRetro } from '../../src/core/retro.js';
import { HOUR, MINUTE, zoneFor } from '../../src/core/tz.js';

const z = zoneFor(TZ);
const at = (day: number, hhmm: string): number => z.wallOnDayUtc(z.addLocalDays('2026-09-14', day), hhmm);

describe('the silent-failure guards', () => {
  it('never stops asking when the patient answers nothing at all', () => {
    // The worst realistic case: phone on charge, nobody touches it all morning.
    //
    // Asking is not enough on its own. A morning of unanswered questions once meant a
    // morning of no medicine at all, written up afterwards as three missed doses that had
    // never been sent -- so from the configured wake time the day starts on an assumption
    // and the medicines go out. The question stays open the whole time, because the
    // assumption is a guess and a real answer re-anchors everything hung off it.
    const w = new World({
      start: at(0, '05:00'),
      patient: {
        wakeState: 'asleep', wakeConfidence: 'confirmed',
        wakeStateSince: at(0, '00:00'), expectedWakeAt: at(0, '06:00'),
        morningPollAt: '06:30', presumedWakeAt: '09:00',
      },
      meds: [makeMed({ id: 1, medKey: 'drop_a', intervalMs: 2 * HOUR })],
      chats: [makeChat({ chatId: 100 }), makeChat({ chatId: 200, escalationTier: 1, escalateAfterMs: 5 * MINUTE })],
    });

    w.run(7 * HOUR); // 05:00 -> 12:00, answering nothing

    const asked = w.sent.filter((m) => m.kind === 'wake');
    expect(asked.length, 'the bot went silent instead of asking').toBeGreaterThan(2);
    expect(
      asked.some((m) => m.chatId === 200),
      'nobody else was told that she has not surfaced',
    ).toBe(true);
    // Still asking after it started dosing: the guess is never mistaken for an answer.
    expect(
      asked.some((m) => m.at >= at(0, '09:00')),
      'stopped asking the moment it started assuming',
    ).toBe(true);
    // And the medicines actually went out.
    expect(
      w.sent.filter((m) => m.kind === 'dose').length,
      'a whole morning of a two-hourly drop, never once asked for',
    ).toBeGreaterThan(0);
    // Marked as a guess, so /status and every reminder can say so.
    expect(w.state.patient.wakeState).toBe('awake');
    expect(w.state.patient.wakeConfidence, 'a guess recorded as a fact').toBe('presumed');
  });

  it('asks rather than assumes when the patient stirs', () => {
    // A message after a full night is evidence, not proof: the honest answer is often
    // "hours ago", and starting the day from the wrong moment misplaces every dose in it.
    const w = new World({
      start: at(0, '07:30'),
      patient: {
        wakeState: 'asleep', wakeConfidence: 'confirmed',
        wakeStateSince: at(0, '00:00'),
        expectedWakeAt: at(0, '12:00'), // deliberately later than now
      },
      meds: [makeMed({ id: 1, medKey: 'drop_a', intervalMs: 2 * HOUR })],
    });
    w.run(MINUTE);
    expect(w.state.patient.wakeState).toBe('asleep');

    w.state.patient.lastActivityAt = w.now; // she replied to something
    w.state.patient.nextActionAt = w.now;
    w.run(2 * MINUTE);

    expect(w.state.patient.wakeState, 'guessed a wake time from a single message').toBe('asleep');
    expect(
      w.state.openPrompts.some((q) => q.kind === 'wake'),
      'stirring produced neither a question nor a decision',
    ).toBe(true);
  });

  it('does not double-dose when a dose is taken just before declaring wake', () => {
    // The real overdose path: takes it at 06:20 half asleep, taps "I'm awake" at 07:00.
    const w = new World({
      start: at(0, '06:00'),
      patient: { wakeState: 'awake', wakeConfidence: 'inferred', wakeStateSince: at(0, '06:00'), lastWakeAt: at(0, '06:00') },
      meds: [makeMed({ id: 1, medKey: 'drop_a', intervalMs: 4 * HOUR, minGapMs: 3 * HOUR })],
    });

    w.run(MINUTE);
    w.now = at(0, '06:20');
    w.take('drop_a');

    // Now she formally declares waking at 07:00.
    w.now = at(0, '07:00');
    w.declare('wake');
    w.run(3 * HOUR);

    const times = w.takenTimes('drop_a');
    expect(times.length).toBe(1); // only the 06:20 dose so far
    const live = w.state.liveDoses[0]!;
    // The next dose must respect the three-hour floor from 06:20, i.e. not before 09:20.
    expect(live.effectiveDueAt).toBeGreaterThanOrEqual(at(0, '09:20'));
  });

  it('parks exactly one dose overnight rather than stacking a night of them', () => {
    const w = new World({
      start: at(0, '21:00'),
      patient: {
        wakeState: 'awake', wakeConfidence: 'confirmed', wakeStateSince: at(0, '08:00'),
        lastWakeAt: at(0, '08:00'),
      },
      meds: [makeMed({ id: 1, medKey: 'drop_a', intervalMs: 2 * HOUR, minGapMs: 90 * MINUTE })],
    });

    w.run(MINUTE);
    w.take('drop_a');                 // last dose of the evening
    w.now = at(0, '22:30');
    w.declare('sleep');

    w.run(8 * HOUR);                // sleep through to 06:30

    // Through the whole night: at most one live dose, and no dose messages.
    expect(w.state.liveDoses.length).toBeLessThanOrEqual(1);
    const nightMsgs = w.sent.filter((s) => s.kind === 'dose' && s.at > at(0, '22:30') && s.at < at(1, '06:00'));
    expect(nightMsgs.length, 'woke the patient with a non-critical dose').toBe(0);
  });

  it('keeps every active medicine alive across a chaotic week', () => {
    // The invariant that catches the whole "quietly stopped working" class: after seven
    // days of erratic answering, every medicine must still be scheduling doses.
    const w = new World({
      start: at(0, '06:00'),
      meds: [
        makeMed({ id: 1, medKey: 'drops', intervalMs: 2 * HOUR, steps: [{ name: 'A' }, { name: 'B' }], stepSpacingMs: 10 * MINUTE, mergeable: false }),
        makeMed({ id: 2, medKey: 'stomach', intervalMs: 12 * HOUR, minGapMs: 10 * HOUR }),
        makeMed({ id: 3, medKey: 'vitamin', kind: 'fixed_times', spec: { kind: 'fixed_times', times: ['09:00'] }, intervalMs: null, minGapMs: 20 * HOUR }),
      ],
    });

    let answered = 0;
    for (let i = 0; i < 7 * 24 * 60; i++) {
      w.tick();
      // Answer roughly two prompts in three, at a random-ish lag.
      const pending = w.state.liveDoses.find((d) => d.status === 'prompted');
      if (pending !== undefined && (i % 3 !== 0) && w.now - (pending.firstPromptAt ?? w.now) > 7 * MINUTE) {
        const med = w.state.meds.find((m) => m.id === pending.medId)!;
        w.resolve(pending.id, 'taken');
        answered++;
        void med;
      }
      if (i % (24 * 60) === 7 * 60) w.declare('wake');
      if (i % (24 * 60) === 22 * 60) w.declare('sleep');
      w.now += MINUTE;
    }

    expect(answered).toBeGreaterThan(20);
    for (const med of w.state.meds) {
      if (med.status !== 'active') continue;
      const live = w.state.liveDoses.filter((d) => d.medId === med.id);
      expect(live.length, `${med.medKey} has gone silent after a week`).toBe(1);
    }
    // A week at one-minute resolution, and the patient is now awake for far more of it
    // than when waking had to be confirmed, so there is more to plan on every tick.
  }, 30_000);
});

describe('escalation to the caregiver', () => {
  const chats = [
    makeChat({ chatId: 100, role: 'patient', escalationTier: 0 }),
    makeChat({ chatId: 200, role: 'caregiver', escalationTier: 1, escalateAfterMs: 5 * MINUTE }),
  ];

  it('leaves the caregiver alone when the patient answers in time', () => {
    const w = new World({
      start: at(0, '08:00'),
      patient: { wakeState: 'awake', wakeConfidence: 'confirmed', wakeStateSince: at(0, '07:00'), lastWakeAt: at(0, '07:00') },
      meds: [makeMed({ id: 1, medKey: 'drop_a', intervalMs: 4 * HOUR })],
      chats,
    });

    w.run(MINUTE);
    w.now += 4 * MINUTE;       // answers after four minutes
    w.take('drop_a');
    w.run(10 * MINUTE);

    expect(w.sent.some((s) => s.chatId === 200), 'caregiver was bothered unnecessarily').toBe(false);
    expect(w.sent.some((s) => s.chatId === 100)).toBe(true);
  });

  it('pulls the caregiver in after five minutes of silence', () => {
    const w = new World({
      start: at(0, '08:00'),
      patient: { wakeState: 'awake', wakeConfidence: 'confirmed', wakeStateSince: at(0, '07:00'), lastWakeAt: at(0, '07:00') },
      meds: [makeMed({ id: 1, medKey: 'drop_a', intervalMs: 4 * HOUR })],
      chats,
    });

    w.run(10 * MINUTE);

    const toCaregiver = w.sent.filter((s) => s.chatId === 200);
    expect(toCaregiver.length, 'caregiver never heard about it').toBeGreaterThan(0);
    expect(toCaregiver[0]!.at - w.sent[0]!.at).toBeGreaterThanOrEqual(5 * MINUTE);
  });

  it('lets the caregiver answer on the patient behalf, once', () => {
    const w = new World({
      start: at(0, '08:00'),
      patient: { wakeState: 'awake', wakeConfidence: 'confirmed', wakeStateSince: at(0, '07:00'), lastWakeAt: at(0, '07:00') },
      meds: [makeMed({ id: 1, medKey: 'drop_a', intervalMs: 4 * HOUR })],
      chats,
    });

    w.run(6 * MINUTE);
    const dose = w.state.liveDoses[0]!;
    w.resolve(dose.id, 'taken', { byChat: 200 });
    w.run(MINUTE);

    expect(w.takenTimes('drop_a').length).toBe(1);
    const taken = w.allDoses.find((d) => d.status === 'taken')!;
    expect(taken.resolvedByChat).toBe(200);
  });
});

describe('retrospective acknowledgment', () => {
  const med = makeMed({ id: 1, medKey: 'drop_a', intervalMs: 2 * HOUR, minGapMs: 90 * MINUTE });

  it('attaches a stated time to the dose currently pending', () => {
    const live = { id: 5, status: 'prompted', effectiveDueAt: at(0, '17:00'), plannedDueAt: at(0, '17:00') } as never;
    const r = resolveRetro({ med, live, recent: [], statedAt: at(0, '17:05'), now: at(0, '18:30') });
    expect(r.kind).toBe('resolve_live');
    if (r.kind === 'resolve_live') expect(r.takenAt).toBe(at(0, '17:05'));
  });

  it('corrects a dose that was already logged missed', () => {
    // Nagged at 17:00, rolled forward as missed at 19:00, user says "took it at 5pm".
    const missed = { id: 5, status: 'missed', effectiveDueAt: at(0, '17:00'), plannedDueAt: at(0, '17:00'), step: 0 } as never;
    const live = { id: 6, status: 'prompted', effectiveDueAt: at(0, '19:00'), plannedDueAt: at(0, '19:00') } as never;
    const r = resolveRetro({ med, live, recent: [missed], statedAt: at(0, '17:00'), now: at(0, '19:30') });
    expect(r.kind).toBe('correct_past');
    if (r.kind === 'correct_past') expect(r.doseId).toBe(5);
  });

  it('refuses a time in the future', () => {
    const r = resolveRetro({ med, live: null, recent: [], statedAt: at(0, '20:00'), now: at(0, '18:00') });
    expect(r.kind).toBe('reject');
  });

  it('asks before accepting something more than a day old', () => {
    const r = resolveRetro({ med, live: null, recent: [], statedAt: at(-2, '17:00'), now: at(0, '18:00') });
    expect(r.kind).toBe('reject');
    if (r.kind === 'reject') expect(r.reason).toBe('needs_confirm');
  });

  it('flags a stated time that would imply a double dose', () => {
    const prior = { id: 4, status: 'taken', takenAt: at(0, '16:30'), step: 0, plannedDueAt: at(0, '16:30') } as never;
    const live = { id: 5, status: 'prompted', effectiveDueAt: at(0, '17:00'), plannedDueAt: at(0, '17:00') } as never;
    const r = resolveRetro({ med, live, recent: [prior], statedAt: at(0, '17:00'), now: at(0, '17:30') });
    expect(r.kind).toBe('resolve_live');
    if (r.kind === 'resolve_live') expect(r.warning).toBe('min_gap');
  });
});
