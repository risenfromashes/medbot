import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parsePrescription, describeSchedule } from '../src/core/prescription.js';
import { HOUR, MINUTE } from '../src/core/tz.js';

const NOW = Date.UTC(2026, 8, 14, 12);
const load = (p: string): unknown => JSON.parse(readFileSync(p, 'utf8'));

describe('the real prescription', () => {
  const r = parsePrescription(load('examples/eye-drops.json'), { now: NOW });

  it('parses without errors', () => {
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('folds the three eye drops into one medicine with three steps', () => {
    const drops = r.value!.meds.find((m) => m.medKey === 'eye_drops')!;
    expect(drops).toBeDefined();
    expect(drops.steps.map((s) => s.name)).toEqual([
      'antibiotic drop',
      'steroid drop',
      'lubricating drop',
    ]);
    expect(drops.stepSpacingMs).toBe(10 * MINUTE);
    expect(drops.intervalMs).toBe(2 * HOUR);
    expect(drops.minGapMs).toBe(90 * MINUTE);
    // A spacing group is its own message sequence and must never be merged with others.
    expect(drops.mergeable).toBe(false);
  });

  it('keeps the standalone medicines separate', () => {
    const keys = r.value!.meds.map((m) => m.medKey).sort();
    expect(keys).toEqual(['eye_drops', 'stomach capsule', 'painkiller']);
    const stomach capsule = r.value!.meds.find((m) => m.medKey === 'stomach capsule')!;
    expect(describeSchedule(stomach capsule)).toBe('30 min before breakfast');
    const para = r.value!.meds.find((m) => m.medKey === 'painkiller')!;
    expect(para.kind).toBe('as_needed');
    expect(para.maxPerDay).toBe(4);
  });
});

describe('error reporting', () => {
  it('names the medicine and the field it could not read', () => {
    const r = parsePrescription({
      medicines: [{ name: 'antibiotic drop', schedule: { type: 'interval', every: 'twice' } }],
    }, { now: NOW });
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toContain('antibiotic drop');
    expect(r.errors.join('\n')).toContain('every');
  });

  it('rejects an unknown timezone with a hint', () => {
    const r = parsePrescription({ timezone: 'Asia/Dacca-ish', medicines: [] }, { now: NOW });
    expect(r.errors.join('\n')).toContain('Asia/Dhaka');
  });

  it('rejects a duplicate id', () => {
    const r = parsePrescription({
      medicines: [
        { id: 'a', name: 'A', schedule: { type: 'interval', every: '2h' } },
        { id: 'a', name: 'B', schedule: { type: 'interval', every: '2h' } },
      ],
    }, { now: NOW });
    expect(r.errors.join('\n')).toContain('duplicate');
  });

  it('explains an unknown schedule type', () => {
    const r = parsePrescription({
      medicines: [{ name: 'X', schedule: { type: 'whenever' } }],
    }, { now: NOW });
    expect(r.errors.join('\n')).toContain('interval, fixed_times');
  });
});

describe('prescription shorthands', () => {
  it('reads a 1+0+1 pattern as morning and night doses', () => {
    const r = parsePrescription({
      medicines: [{ id: 'x', name: 'Losartan', pattern: '1+0+1' }],
    }, { now: NOW });
    expect(r.ok).toBe(true);
    const m = r.value!.meds[0]!;
    expect(m.kind).toBe('fixed_times');
    expect(m.spec.times).toEqual(['08:00', '20:00']);
  });

  it('reads a single-dose pattern as a meal-relative dose', () => {
    const r = parsePrescription({
      medicines: [{ id: 'x', name: 'Y', pattern: '0+0+1' }],
    }, { now: NOW });
    expect(r.value!.meds[0]!.kind).toBe('meal');
    expect(r.value!.meds[0]!.spec.meal!.meal).toBe('dinner');
  });

  it('spreads times_per_day across the waking window and says so', () => {
    const r = parsePrescription({
      medicines: [{ id: 'x', name: 'Y', schedule: { type: 'times_per_day', n: 3, from: '08:00', to: '20:00' } }],
    }, { now: NOW });
    expect(r.value!.meds[0]!.spec.times).toEqual(['08:00', '14:00', '20:00']);
    expect(r.warnings.join('\n')).toContain('3x a day became');
  });

  it('forces a critical medicine to be allowed to wake the patient', () => {
    const r = parsePrescription({
      medicines: [{ id: 'x', name: 'Y', critical: true, awake_only: true, schedule: { type: 'interval', every: '6h' } }],
    }, { now: NOW });
    expect(r.value!.meds[0]!.awakeOnly).toBe(false);
  });
});
