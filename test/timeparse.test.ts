import { describe, expect, it } from 'vitest';
import { parseDuration, parseTime, splitTrailingTime } from '../src/core/timeparse.js';
import { zoneFor } from '../src/core/tz.js';

const z = zoneFor('Asia/Dhaka');
const at = (day: string, hhmm: string): number => z.wallOnDayUtc(day, hhmm);
const NOW = at('2026-09-14', '18:30');

describe('parseDuration', () => {
  it('reads the ways people write durations', () => {
    expect(parseDuration('2h')).toBe(7_200_000);
    expect(parseDuration('30m')).toBe(1_800_000);
    expect(parseDuration('1h30m')).toBe(5_400_000);
    expect(parseDuration('90 min')).toBe(5_400_000);
    expect(parseDuration('2 hours')).toBe(7_200_000);
    expect(parseDuration('15')).toBe(900_000);
    expect(parseDuration('3d')).toBe(259_200_000);
    expect(parseDuration('banana')).toBeNull();
  });
});

describe('parseTime', () => {
  it('understands a bare clock time as the most recent past one', () => {
    expect(parseTime('5pm', NOW, z)!.at).toBe(at('2026-09-14', '17:00'));
    expect(parseTime('17:00', NOW, z)!.at).toBe(at('2026-09-14', '17:00'));
    expect(parseTime('5:30pm', NOW, z)!.at).toBe(at('2026-09-14', '17:30'));
    // 11pm has not happened yet today, so it means last night.
    expect(parseTime('11pm', NOW, z)!.at).toBe(at('2026-09-13', '23:00'));
  });

  it('understands relative times', () => {
    expect(parseTime('20m ago', NOW, z)!.at).toBe(NOW - 1_200_000);
    expect(parseTime('2h ago', NOW, z)!.at).toBe(NOW - 7_200_000);
    expect(parseTime('now', NOW, z)!.at).toBe(NOW);
  });

  it('understands an explicit day', () => {
    expect(parseTime('yesterday 11pm', NOW, z)!.at).toBe(at('2026-09-13', '23:00'));
    expect(parseTime('today 8:30', NOW, z)!.at).toBe(at('2026-09-14', '08:30'));
  });

  it('rejects nonsense', () => {
    expect(parseTime('sometime', NOW, z)).toBeNull();
    expect(parseTime('25:00', NOW, z)).toBeNull();
    expect(parseTime('13pm', NOW, z)).toBeNull();
  });
});

describe('splitTrailingTime', () => {
  it('separates a medicine name from a trailing time', () => {
    const r = splitTrailingTime('drop_a 5pm', NOW, z);
    expect(r.head).toBe('drop_a');
    expect(r.time!.at).toBe(at('2026-09-14', '17:00'));
  });

  it('handles a multi-word time', () => {
    const r = splitTrailingTime('eye drops 20m ago', NOW, z);
    expect(r.head).toBe('eye drops');
    expect(r.time!.at).toBe(NOW - 1_200_000);
  });

  it('leaves a bare name alone', () => {
    const r = splitTrailingTime('drop_a', NOW, z);
    expect(r.head).toBe('drop_a');
    expect(r.time).toBeNull();
  });
});
