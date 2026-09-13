import { describe, expect, it } from 'vitest';
import { World, makeChat, makeMed, TZ } from '../simulate.js';
import { planReports } from '../../src/core/planReport.js';
import { parsePrescription } from '../../src/core/prescription.js';
import { PRESCRIPTION_PROMPT_PARTS } from '../../src/core/promptText.js';
import { HOUR, MINUTE, zoneFor } from '../../src/core/tz.js';
import type { Action } from '../../src/core/domain.js';

const z = zoneFor(TZ);
const at = (day: number, hhmm: string): number => z.wallOnDayUtc(z.addLocalDays('2026-09-14', day), hhmm);

function collect(w: World, now: number): Action[] {
  const out: Action[] = [];
  planReports(w.state, now, w.z, w.z.localDay(now), (a) => out.push(a));
  return out;
}

describe('the daily digest', () => {
  it('fires once after the digest time, and not again that day', () => {
    const w = new World({
      start: at(0, '20:00'),
      patient: { digestAt: '21:00', wakeState: 'awake', wakeStateSince: at(0, '07:00') },
      meds: [makeMed({ id: 1, medKey: 'antibiotic drop' })],
    });

    expect(collect(w, at(0, '20:30')).some((a) => a.t === 'sendInfo')).toBe(false);

    const fired = collect(w, at(0, '21:05'));
    expect(fired.some((a) => a.t === 'sendInfo')).toBe(true);
    expect(fired.some((a) => a.t === 'markDigestSent')).toBe(true);

    // Once recorded for the day, it must not repeat on every subsequent tick.
    w.state.patient.lastDigestDay = z.localDay(at(0, '21:05'));
    expect(collect(w, at(0, '21:30')).some((a) => a.t === 'sendInfo')).toBe(false);
  });

  it('summarises what was taken and what was missed', () => {
    const w = new World({
      start: at(0, '21:05'),
      patient: { digestAt: '21:00', wakeState: 'awake', wakeStateSince: at(0, '07:00') },
      meds: [makeMed({ id: 1, medKey: 'antibiotic drop', name: 'antibiotic drop' })],
    });
    w.state.dayCounters.set(1, { taken: 5, missed: 2 });

    const info = collect(w, at(0, '21:05')).find((a) => a.t === 'sendInfo');
    expect(info).toBeDefined();
    if (info?.t === 'sendInfo') {
      expect(info.text).toContain('antibiotic drop');
      expect(info.text).toContain('5 taken');
      expect(info.text).toContain('2 missed');
    }
  });

  it('says so plainly when nothing was recorded', () => {
    const w = new World({
      start: at(0, '21:05'),
      patient: { digestAt: '21:00', wakeState: 'awake', wakeStateSince: at(0, '07:00') },
      meds: [makeMed({ id: 1, medKey: 'antibiotic drop' })],
    });
    const info = collect(w, at(0, '21:05')).find((a) => a.t === 'sendInfo');
    if (info?.t === 'sendInfo') expect(info.text).toContain('Nothing recorded today');
  });
});

describe('the liveness watchdog', () => {
  it('stays quiet while a medicine is behaving', () => {
    const w = new World({
      start: at(0, '12:00'),
      meds: [makeMed({ id: 1, medKey: 'antibiotic drop', intervalMs: 2 * HOUR })],
    });
    w.state.meds[0]!.lastTakenAt = at(0, '11:00');
    w.state.meds[0]!.startedAt = at(0, '08:00');

    const alerts = collect(w, at(0, '12:00')).filter((a) => a.t === 'sendInfo');
    expect(alerts.length).toBe(0);
  });

  it('escalates a medicine that has gone quiet for far longer than its cycle', () => {
    const w = new World({
      start: at(1, '12:00'),
      meds: [makeMed({ id: 1, medKey: 'antibiotic drop', name: 'antibiotic drop', intervalMs: 2 * HOUR })],
    });
    // Last dose was well over three cycles ago.
    w.state.meds[0]!.lastTakenAt = at(0, '08:00');
    w.state.meds[0]!.startedAt = at(0, '08:00');

    const alert = collect(w, at(1, '12:00')).find((a) => a.t === 'sendInfo');
    expect(alert).toBeDefined();
    if (alert?.t === 'sendInfo') {
      expect(alert.text).toContain('antibiotic drop');
      // Goes above the patient's own chat: by definition they are not seeing reminders.
      expect(alert.tier).toBe(1);
    }
  });

  it('does not fire for a medicine that has never started', () => {
    const w = new World({
      start: at(1, '12:00'),
      meds: [makeMed({ id: 1, medKey: 'antibiotic drop', intervalMs: 2 * HOUR })],
    });
    expect(collect(w, at(1, '12:00')).filter((a) => a.t === 'sendInfo').length).toBe(0);
  });

  it('leaves as-needed medicines alone', () => {
    const w = new World({
      start: at(1, '12:00'),
      meds: [makeMed({ id: 1, medKey: 'painkiller', kind: 'as_needed', intervalMs: null, spec: { kind: 'as_needed' } })],
    });
    w.state.meds[0]!.lastTakenAt = at(0, '08:00');
    w.state.meds[0]!.startedAt = at(0, '08:00');
    expect(collect(w, at(1, '12:00')).filter((a) => a.t === 'sendInfo').length).toBe(0);
  });
});

describe('course completion', () => {
  it('announces the end of a course rather than just going silent', () => {
    const w = new World({
      start: at(0, '08:00'),
      patient: {
        wakeState: 'awake', wakeConfidence: 'confirmed', wakeStateSince: at(0, '07:00'),
        lastWakeAt: at(0, '07:00'), presumedSleepAt: '23:59', eveningPollAt: '23:50',
      },
      meds: [makeMed({
        id: 1, medKey: 'antibiotic drop', name: 'antibiotic drop', intervalMs: 4 * HOUR,
        minGapMs: 3 * HOUR, courseKind: 'days', courseDays: 1,
        startedAt: at(-1, '08:00'),
      })],
    });

    const actions = w.tick();
    expect(actions.some((a) => a.t === 'completeMed')).toBe(true);
    const infos = actions.filter((a) => a.t === 'sendInfo');
    expect(infos.some((a) => a.t === 'sendInfo' && a.text.includes('course finished'))).toBe(true);
    // And it must NOT also cry wolf: a course ending normally is not a malfunction.
    expect(infos.some((a) => a.t === 'sendInfo' && a.text.includes('Something looks wrong'))).toBe(false);
  });
});

describe('the prescription prompt the bot hands out', () => {
  it('fits inside Telegram message limits', () => {
    for (const part of PRESCRIPTION_PROMPT_PARTS) {
      expect(part.length, 'a prompt chunk exceeds the 4096-character limit').toBeLessThan(4096);
    }
  });

  it('describes every schedule type the parser actually accepts', () => {
    const all = PRESCRIPTION_PROMPT_PARTS.join('\n');
    for (const kind of ['interval', 'fixed_times', 'times_per_day', 'meal', 'as_needed']) {
      expect(all, `the prompt never mentions "${kind}"`).toContain(kind);
    }
    expect(all).toContain('group_seq');
    expect(all).toContain('min_gap');
  });

  it('produces an example the parser accepts, so the instructions are not a lie', () => {
    // Lifted from the prompt's own worked example.
    const example = {
      version: 1,
      timezone: 'Asia/Dhaka',
      meals: [{ id: 'breakfast', typical_local: '08:30', ask_after_local: '09:30' }],
      groups: [{ id: 'eye_drops', spacing: '10m' }],
      medicines: [
        {
          id: 'antibiotic drop', name: 'antibiotic drop', dose: '1 drop, right eye',
          schedule: { type: 'interval', every: '2h', anchor: 'wake' },
          min_gap: '90m', group: 'eye_drops', group_seq: 1, course: { days: 7 },
        },
      ],
    };
    const parsed = parsePrescription(example, { now: Date.now() });
    expect(parsed.errors).toEqual([]);
    expect(parsed.ok).toBe(true);
  });
});

describe('adding one medicine without replacing the prescription', () => {
  it('validates a single medicine object the same way an import would', () => {
    const wrapped = {
      version: 1,
      medicines: [{
        id: 'painkiller', name: 'painkiller', dose: '1 tablet',
        schedule: { type: 'as_needed' }, min_gap: '6h', max_per_day: 4,
      }],
    };
    const r = parsePrescription(wrapped, { now: Date.now() });
    expect(r.ok).toBe(true);
    expect(r.value!.meds[0]!.kind).toBe('as_needed');
    expect(r.value!.meds[0]!.maxPerDay).toBe(4);
  });

  it('rejects a malformed one with a useful message', () => {
    const r = parsePrescription({ version: 1, medicines: [{ name: 'X', schedule: { type: 'interval' } }] }, { now: Date.now() });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('every');
  });
});

describe('reports do not disturb the scheduler', () => {
  it('a week with digests and watchdogs still keeps every medicine alive', () => {
    const w = new World({
      start: at(0, '06:00'),
      patient: { digestAt: '21:00' },
      meds: [
        makeMed({ id: 1, medKey: 'drops', intervalMs: 2 * HOUR, steps: [{ name: 'A' }, { name: 'B' }], stepSpacingMs: 10 * MINUTE, mergeable: false }),
        makeMed({ id: 2, medKey: 'stomach capsule', intervalMs: 12 * HOUR, minGapMs: 10 * HOUR }),
      ],
      chats: [makeChat({ chatId: 100 }), makeChat({ chatId: 200, role: 'caregiver', escalationTier: 1 })],
    });
    w.respectSchedule = true;

    for (let i = 0; i < 7 * 24 * 60; i++) {
      w.tick();
      const pending = w.state.liveDoses.find((d) => d.status === 'prompted');
      if (pending !== undefined && i % 3 !== 0) w.resolve(pending.id, 'taken');
      if (i % (24 * 60) === 7 * 60) w.declare('wake');
      if (i % (24 * 60) === 22 * 60) w.declare('sleep');
      w.now += MINUTE;
    }

    for (const med of w.state.meds) {
      if (med.status !== 'active') continue;
      expect(w.state.liveDoses.filter((d) => d.medId === med.id).length, `${med.medKey} went silent`).toBe(1);
    }
  });
});
