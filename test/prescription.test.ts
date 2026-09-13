import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parsePrescription, describeSchedule } from '../src/core/prescription.js';
import { MINUTE } from '../src/core/tz.js';

const NOW = Date.UTC(2026, 8, 14, 12);
const load = (p: string): unknown => JSON.parse(readFileSync(p, 'utf8'));

describe('the real prescription', () => {
  const r = parsePrescription(load('examples/example.json'), { now: NOW });

  it('parses without errors', () => {
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('keeps each eye drop on its own schedule, constrained to stay 10 minutes apart', () => {
    // Drops needing a gap between them often have genuinely different
    // frequencies. Merging them into one medicine -- the original design -- silently
    // rewrote two of the three, so they stay separate and the gap is a constraint.
    const drops = r.value!.meds.filter((m) => m.spacingGroup === 'drops');
    expect(drops.length).toBe(3);
    for (const d of drops) {
      expect(d.spacingMs).toBe(10 * MINUTE);
      // A member of a spacing group must never share a message with anything else.
      expect(d.mergeable).toBe(false);
    }
    // And each keeps its own course, rather than inheriting the first one's.
    // Each keeps its own course rather than inheriting the first one's.
    const byKey = new Map(drops.map((d) => [d.medKey, d]));
    expect(byKey.get('antibiotic_drop')!.courseDays).toBe(14);
    expect(byKey.get('steroid_drop')!.courseDays).toBe(14);
    expect(byKey.get('lubricant_drop')!.courseKind).toBe('indefinite');
  });

  it('keeps the standalone medicines separate', () => {
    const keys = r.value!.meds.map((m) => m.medKey).sort();
    expect(keys).toEqual(['anti_inflammatory', 'antibiotic_drop', 'lubricant_drop', 'painkiller', 'steroid_drop', 'stomach_capsule']);
    const stomach = r.value!.meds.find((m) => m.medKey === 'stomach_capsule')!;
    expect(describeSchedule(stomach)).toBe('30 min before breakfast and dinner');
    const para = r.value!.meds.find((m) => m.medKey === 'painkiller')!;
    expect(para.kind).toBe('as_needed');
    expect(para.maxPerDay).toBe(4);
  });
});

describe('error reporting', () => {
  it('names the medicine and the field it could not read', () => {
    const r = parsePrescription({
      medicines: [{ name: 'Antibiotic drop', schedule: { type: 'interval', every: 'twice' } }],
    }, { now: NOW });
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toContain('Antibiotic drop');
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
  it('reads a 1+0+1 pattern as doses tied to breakfast and dinner', () => {
    // Genuinely tied to the meals, not flattened to clock times standing in for them --
    // so the dose follows whenever the patient says they are actually eating.
    const r = parsePrescription({
      medicines: [{ id: 'x', name: 'Blood pressure tablet', pattern: '1+0+1' }],
    }, { now: NOW });
    expect(r.ok).toBe(true);
    const m = r.value!.meds[0]!;
    expect(m.kind).toBe('meal');
    expect(m.spec.meals!.map((x) => x.meal)).toEqual(['breakfast', 'dinner']);
    expect(m.spec.meals!.every((x) => x.relation === 'after')).toBe(true);
  });

  it('keeps before-meal and after-meal patterns genuinely different', () => {
    const before = parsePrescription({
      medicines: [{ id: 'x', name: 'PPI', pattern: '1+0+1', relation: 'before' }],
    }, { now: NOW }).value!.meds[0]!;
    const after = parsePrescription({
      medicines: [{ id: 'y', name: 'NSAID', pattern: '1+0+1', relation: 'after' }],
    }, { now: NOW }).value!.meds[0]!;
    // A proton-pump inhibitor wants a real gap before food; an NSAID just wants food.
    expect(before.spec.meals![0]!.relation).toBe('before');
    expect(before.spec.meals![0]!.offsetMs).toBe(30 * MINUTE);
    expect(after.spec.meals![0]!.relation).toBe('after');
    expect(after.spec.meals![0]!.offsetMs).toBe(0);
  });

  it('reads a single-dose pattern as a meal-relative dose', () => {
    const r = parsePrescription({
      medicines: [{ id: 'x', name: 'Y', pattern: '0+0+1' }],
    }, { now: NOW });
    expect(r.value!.meds[0]!.kind).toBe('meal');
    expect(r.value!.meds[0]!.spec.meal!.meal).toBe('dinner');
  });

  it('reads "3 times a day" as three doses spread from waking', () => {
    // Four times a day means four times across the day the patient actually has. Pinning
    // it to the clock would greet a late riser with a dose already hours overdue.
    const r = parsePrescription({
      medicines: [{ id: 'x', name: 'Y', schedule: { type: 'times_per_day', n: 3, from: '08:00', to: '20:00' } }],
    }, { now: NOW });
    const m = r.value!.meds[0]!;
    expect(m.kind).toBe('interval');
    expect(m.spec.anchor).toBe('wake');
    expect(m.intervalMs).toBe(6 * 60 * 60_000); // 12h window, 3 doses -> 6h apart
    expect(r.warnings.join('\n')).toContain('one dose on waking');
  });

  it('still pins to the clock when asked to', () => {
    const r = parsePrescription({
      medicines: [{ id: 'x', name: 'Y', schedule: { type: 'times_per_day', n: 3, from: '08:00', to: '20:00', anchor: 'clock' } }],
    }, { now: NOW });
    expect(r.value!.meds[0]!.spec.times).toEqual(['08:00', '14:00', '20:00']);
  });

  it('forces a critical medicine to be allowed to wake the patient', () => {
    const r = parsePrescription({
      medicines: [{ id: 'x', name: 'Y', critical: true, awake_only: true, schedule: { type: 'interval', every: '6h' } }],
    }, { now: NOW });
    expect(r.value!.meds[0]!.awakeOnly).toBe(false);
  });
});
