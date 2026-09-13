import { describe, expect, it } from 'vitest';
import { World, makeChat, makeMed, TZ } from '../simulate.js';
import { plan } from '../../src/core/plan.js';
import { resolveRetro } from '../../src/core/retro.js';
import { HOUR, MINUTE, zoneFor } from '../../src/core/tz.js';

const z = zoneFor(TZ);
const at = (day: number, hhmm: string): number => z.wallOnDayUtc(z.addLocalDays('2026-09-14', day), hhmm);

/** The scenarios the plan listed by name, each of which was previously untested. */

describe('the user confirms being awake at 2pm', () => {
  it('anchors the day on 2pm and does not fire a backlog of morning doses', () => {
    const w = new World({
      start: at(0, '06:00'),
      meds: [makeMed({ id: 1, medKey: 'drop_a', intervalMs: 2 * HOUR, minGapMs: 90 * MINUTE })],
    });

    // Nobody answers all morning. The presumed-wake fallback starts dosing at 09:30.
    w.run(8 * HOUR); // through to 14:00
    const beforeDeclare = w.allDoses.length;

    w.now = at(0, '14:00');
    w.declare('wake');
    w.run(30 * MINUTE);

    // A late confirmation must not retroactively manufacture the doses that were missed.
    expect(w.allDoses.length - beforeDeclare).toBeLessThanOrEqual(2);
    // And exactly one live dose, as always.
    expect(w.state.liveDoses.length).toBe(1);
    // No two doses closer than the safety floor (the simulator asserts this every tick).
    expect(w.state.patient.wakeState).toBe('awake');
    expect(w.state.patient.wakeConfidence).toBe('confirmed');
  });
});

describe('an eleven-hour sleep', () => {
  it('stays silent throughout and resumes in the morning', () => {
    const w = new World({
      start: at(0, '21:00'),
      patient: {
        wakeState: 'awake', wakeConfidence: 'confirmed', wakeStateSince: at(0, '08:00'),
        lastWakeAt: at(0, '08:00'),
      },
      meds: [makeMed({ id: 1, medKey: 'drop_a', intervalMs: 2 * HOUR, minGapMs: 90 * MINUTE })],
    });
    w.respectSchedule = true;

    w.now = at(0, '22:00');
    w.declare('sleep');
    const sleepStart = w.now;
    w.run(11 * HOUR); // through to 09:00

    const duringSleep = w.sent.filter(
      (s) => s.kind === 'dose' && s.at > sleepStart && s.at < at(1, '06:30'),
    );
    expect(duringSleep.length, 'woke the patient during an 11-hour sleep').toBe(0);

    // But the day does restart: something is sent once morning arrives.
    const morning = w.sent.filter((s) => s.at >= at(1, '06:30'));
    expect(morning.length, 'never came back after a long sleep').toBeGreaterThan(0);
  });
});

describe('a dose acknowledged five hours late', () => {
  it('re-bases the chain on the real time and never stacks', () => {
    const w = new World({
      start: at(0, '08:00'),
      patient: {
        wakeState: 'awake', wakeConfidence: 'confirmed', wakeStateSince: at(0, '07:00'),
        lastWakeAt: at(0, '07:00'), presumedSleepAt: '23:59', eveningPollAt: '23:50',
      },
      meds: [makeMed({ id: 1, medKey: 'drop_a', intervalMs: 4 * HOUR, minGapMs: 3 * HOUR })],
      chats: [makeChat({ chatId: 100 })],
    });

    w.run(5 * HOUR); // ignore everything until 13:00
    expect(w.state.liveDoses.length).toBe(1);

    // Answer whatever is pending now, five hours after the first one was due.
    const pending = w.state.liveDoses[0]!;
    w.resolve(pending.id, 'taken');
    const takenAt = w.now;
    w.run(MINUTE);

    const next = w.state.liveDoses[0]!;
    // Four hours after the real time, not four hours after some stale grid point.
    expect(next.effectiveDueAt).toBeGreaterThanOrEqual(takenAt + 4 * HOUR - MINUTE);
    expect(next.effectiveDueAt).toBeLessThanOrEqual(takenAt + 4 * HOUR + MINUTE);
  });
});

describe('a tick skipped for twenty-five minutes', () => {
  it('emits one nudge on the late tick, not twenty-five', () => {
    const w = new World({
      start: at(0, '08:00'),
      patient: {
        wakeState: 'awake', wakeConfidence: 'confirmed', wakeStateSince: at(0, '07:00'),
        lastWakeAt: at(0, '07:00'), presumedSleepAt: '23:59', eveningPollAt: '23:50',
      },
      meds: [makeMed({ id: 1, medKey: 'drop_a', intervalMs: 6 * HOUR, minGapMs: 4 * HOUR })],
      chats: [makeChat({ chatId: 100 })],
    });

    w.tick();                       // prompt goes out
    const before = w.sent.length;

    // Cloudflare drops the next 25 minutes of ticks entirely.
    w.now += 25 * MINUTE;
    w.tick();

    const emitted = w.sent.length - before;
    expect(emitted, `a 25-minute outage produced ${emitted} messages at once`).toBeLessThanOrEqual(2);
  });
});

describe('a tick delivered twice', () => {
  it('is idempotent — the second produces nothing', () => {
    const w = new World({
      start: at(0, '08:00'),
      patient: {
        wakeState: 'awake', wakeConfidence: 'confirmed', wakeStateSince: at(0, '07:00'),
        lastWakeAt: at(0, '07:00'), presumedSleepAt: '23:59', eveningPollAt: '23:50',
      },
      meds: [makeMed({ id: 1, medKey: 'drop_a', intervalMs: 4 * HOUR })],
      chats: [makeChat({ chatId: 100 })],
    });

    w.tick();
    const afterFirst = { sent: w.sent.length, doses: w.allDoses.length };

    // Same instant, planned again — exactly what a duplicated cron delivery looks like.
    const second = plan(w.state, w.now, w.z);
    expect(second.filter((a) => a.t === 'createDose').length, 'duplicate tick created another dose').toBe(0);
    expect(second.filter((a) => a.t === 'createPrompt').length, 'duplicate tick re-prompted').toBe(0);

    w.tick();
    expect(w.allDoses.length).toBe(afterFirst.doses);
    expect(w.sent.length).toBe(afterFirst.sent);
  });
});

describe('retrospective wake re-anchors the day', () => {
  it('a wake time stated after the fact moves the anchor, not just the state', () => {
    const w = new World({
      start: at(0, '09:00'),
      meds: [makeMed({ id: 1, medKey: 'drop_a', intervalMs: 2 * HOUR, minGapMs: 90 * MINUTE })],
    });
    w.tick();

    // "I actually got up at 6:30" — said at 09:00.
    w.declare('wake', at(0, '06:30'));
    w.run(2 * MINUTE);

    expect(w.state.patient.lastWakeAt).toBe(at(0, '06:30'));
    // Anything anchored on waking must derive from the stated time, not from now.
    expect(w.state.patient.wakeStateSince).toBe(at(0, '06:30'));
  });

  it('refuses to attach a stated time to a dose it could not belong to', () => {
    const med = makeMed({ id: 1, medKey: 'drop_a', intervalMs: 2 * HOUR, minGapMs: 90 * MINUTE });
    const r = resolveRetro({
      med, live: null, recent: [],
      statedAt: at(0, '03:00'), now: at(0, '18:00'),
    });
    // Nothing to attach it to, so it is recorded standalone rather than silently bound
    // to an unrelated dose.
    expect(r.kind).toBe('record_only');
  });
});

describe('a prescription re-imported mid-course', () => {
  it('an unchanged medicine keeps its progress', async () => {
    const { parsePrescription } = await import('../../src/core/prescription.js');
    const doc = {
      version: 1,
      medicines: [{ id: 'drop_a', name: 'drop_a', schedule: { type: 'interval', every: '2h' }, course: { days: 7 } }],
    };
    const first = parsePrescription(doc, { now: at(0, '08:00') });
    const second = parsePrescription(doc, { now: at(3, '08:00') });

    // Identical input must produce an identical spec hash -- that equality is precisely
    // what lets the importer leave a mid-course medicine alone.
    expect(first.value!.meds[0]!.specHash).toBe(second.value!.meds[0]!.specHash);
    expect(first.value!.meds[0]!.medKey).toBe('drop_a');
  });

  it('a changed schedule produces a different hash, so it is detected', async () => {
    const { parsePrescription } = await import('../../src/core/prescription.js');
    const a = parsePrescription({ version: 1, medicines: [{ id: 'drop_a', name: 'drop_a', schedule: { type: 'interval', every: '2h' } }] }, { now: 0 });
    const b = parsePrescription({ version: 1, medicines: [{ id: 'drop_a', name: 'drop_a', schedule: { type: 'interval', every: '3h' } }] }, { now: 0 });
    expect(a.value!.meds[0]!.specHash).not.toBe(b.value!.meds[0]!.specHash);
  });
});

describe('a DST weekend at the scheduler level', () => {
  it('keeps dosing across spring forward without stacking or skipping', () => {
    // America/New_York springs forward 2026-03-08 at 02:00.
    const ny = zoneFor('America/New_York');
    const start = ny.wallOnDayUtc('2026-03-07', '08:00');
    const w = new World({
      start,
      patient: {
        tz: 'America/New_York',
        wakeState: 'awake', wakeConfidence: 'confirmed', wakeStateSince: start,
        lastWakeAt: start, presumedSleepAt: '23:59', eveningPollAt: '23:50',
      },
      meds: [makeMed({
        id: 1, medKey: 'antibiotic', intervalMs: 8 * HOUR, minGapMs: 6 * HOUR,
        awakeOnly: false, spec: { kind: 'interval', intervalMs: 8 * HOUR, anchor: 'clock' },
      })],
      chats: [makeChat({ chatId: 100 })],
    });

    for (let i = 0; i < 3 * 24 * 60; i++) {
      w.tick();
      const pending = w.state.liveDoses.find((d) => d.status === 'prompted');
      if (pending !== undefined && w.now - pending.effectiveDueAt >= 5 * MINUTE) {
        w.resolve(pending.id, 'taken');
      }
      w.now += MINUTE;
    }

    // Three days of an 8-hourly medicine is nine doses; allow for edges.
    w.assertDosingRate('antibiotic', 8);
    expect(w.state.liveDoses.length).toBe(1);
  });

  it('keeps dosing across fall back without firing an hour twice', () => {
    const ny = zoneFor('America/New_York');
    const start = ny.wallOnDayUtc('2026-10-31', '08:00');
    const w = new World({
      start,
      patient: {
        tz: 'America/New_York',
        wakeState: 'awake', wakeConfidence: 'confirmed', wakeStateSince: start,
        lastWakeAt: start, presumedSleepAt: '23:59', eveningPollAt: '23:50',
      },
      meds: [makeMed({
        id: 1, medKey: 'vitamin', kind: 'fixed_times', intervalMs: null,
        spec: { kind: 'fixed_times', times: ['01:30'] }, minGapMs: 20 * HOUR, awakeOnly: false,
      })],
      chats: [makeChat({ chatId: 100 })],
    });

    for (let i = 0; i < 3 * 24 * 60; i++) {
      w.tick();
      const pending = w.state.liveDoses.find((d) => d.status === 'prompted');
      if (pending !== undefined) w.resolve(pending.id, 'taken');
      w.now += MINUTE;
    }

    // 01:30 happens twice on the fall-back night. It must still produce one dose a day.
    const taken = w.takenTimes('vitamin');
    expect(taken.length).toBeLessThanOrEqual(4);
    expect(taken.length).toBeGreaterThanOrEqual(2);
  });
});

describe('the dosing-rate invariant over a long run', () => {
  it('a compliant fortnight resolves close to the expected number of doses', () => {
    const w = new World({
      start: at(0, '06:00'),
      patient: { presumedSleepAt: '23:59', eveningPollAt: '23:50' },
      meds: [makeMed({
        id: 1, medKey: 'antibiotic', intervalMs: 8 * HOUR, minGapMs: 6 * HOUR, awakeOnly: false,
        spec: { kind: 'interval', intervalMs: 8 * HOUR, anchor: 'clock' },
      })],
      chats: [makeChat({ chatId: 100 })],
    });
    w.respectSchedule = true;

    for (let i = 0; i < 14 * 24 * 60; i++) {
      w.tick();
      const pending = w.state.liveDoses.find((d) => d.status === 'prompted');
      if (pending !== undefined && w.now - pending.effectiveDueAt >= 10 * MINUTE) {
        w.resolve(pending.id, 'taken');
      }
      w.now += MINUTE;
    }

    // Fourteen days at three a day is 42.
    w.assertDosingRate('antibiotic', 42);
  });
});
