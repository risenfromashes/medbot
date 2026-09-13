import { describe, expect, it } from 'vitest';
import { World, makeChat, makeMed, TZ } from '../simulate.js';
import { resolveRetro } from '../../src/core/retro.js';
import { HOUR, MINUTE, zoneFor } from '../../src/core/tz.js';

const z = zoneFor(TZ);
const at = (day: number, hhmm: string): number => z.wallOnDayUtc(z.addLocalDays('2026-09-14', day), hhmm);

describe('the silent-failure guards', () => {
  it('doses anyway when the patient never answers at all', () => {
    // The worst realistic case: phone on charge, nobody touches it all morning.
    const w = new World({
      start: at(0, '05:00'),
      meds: [makeMed({ id: 1, medKey: 'drop_a', intervalMs: 2 * HOUR })],
    });

    w.run(7 * HOUR); // 05:00 -> 12:00, answering nothing

    // Presumed awake at 09:30 must have started the schedule regardless.
    const doseMsgs = w.sent.filter((s) => s.kind === 'dose');
    expect(doseMsgs.length, 'no medicine reminders at all -- the bot went silent').toBeGreaterThan(0);
    expect(w.state.patient.wakeState).toBe('awake');
    expect(w.state.patient.wakeConfidence).toBe('presumed');
    // And it anchored on the fallback time, not on whenever the tick happened to run.
    expect(z.fmtTime(w.state.patient.lastWakeAt!)).toBe('09:30');
  });

  it('treats any inbound message as proof the patient is up', () => {
    const w = new World({
      start: at(0, '07:30'),
      meds: [makeMed({ id: 1, medKey: 'drop_a', intervalMs: 2 * HOUR })],
    });
    w.run(MINUTE);
    expect(w.state.patient.wakeState).toBe('asleep');

    w.state.patient.lastActivityAt = w.now; // she replied to something
    w.run(2 * MINUTE);

    expect(w.state.patient.wakeState).toBe('awake');
    expect(w.state.patient.wakeConfidence).toBe('inferred');
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
  });
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
