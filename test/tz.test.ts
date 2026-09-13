import { describe, expect, it } from 'vitest';
import {
  addLocalDays, diffLocalDays, fmtDuration, lastWallAtOrBefore, localDay, nextWallAtOrAfter,
  offsetAt, startOfLocalDay, wallToUtc, zoneFor,
} from '../src/core/tz.js';

const iso = (ms: number) => new Date(ms).toISOString();

describe('offsetAt', () => {
  it('agrees with Intl longOffset across zones and seasons', () => {
    // Two independent derivations of the same number. `longOffset` is not reliable
    // enough everywhere to be the primary path, but it is a strong cross-check.
    const zones = [
      'UTC', 'Asia/Dhaka', 'Asia/Kolkata', 'Asia/Kathmandu', 'America/New_York',
      'Europe/London', 'Australia/Lord_Howe', 'America/Santiago', 'Asia/Tehran',
      'Pacific/Chatham', 'America/St_Johns',
    ];
    const instants = [
      Date.UTC(2026, 0, 15, 12), Date.UTC(2026, 3, 15, 12),
      Date.UTC(2026, 6, 15, 12), Date.UTC(2026, 9, 15, 12),
    ];
    for (const tz of zones) {
      for (const t of instants) {
        const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' });
        const name = fmt.formatToParts(new Date(t)).find((p) => p.type === 'timeZoneName')!.value;
        const m = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
        const expected = m === null ? 0 : (m[1] === '-' ? -1 : 1) * (+m[2]! * 3600_000 + +m[3]! * 60_000);
        expect(offsetAt(t, tz), `${tz} @ ${iso(t)}`).toBe(expected);
      }
    }
  });
});

describe('wallToUtc', () => {
  it('resolves an ordinary time exactly', () => {
    const r = wallToUtc('America/New_York', 2026, 6, 1, 8, 0);
    expect(r.kind).toBe('exact');
    expect(iso(r.utc)).toBe('2026-06-01T12:00:00.000Z'); // EDT, -4
  });

  it('flags the repeated hour on fall-back and picks the first occurrence', () => {
    // 2026-11-01, US fall back: 01:30 happens at 05:30Z (EDT) and again at 06:30Z (EST).
    const r = wallToUtc('America/New_York', 2026, 11, 1, 1, 30);
    expect(r.kind).toBe('ambiguous');
    expect(iso(r.utc)).toBe('2026-11-01T05:30:00.000Z');
    expect(iso(r.alt!)).toBe('2026-11-01T06:30:00.000Z');
  });

  it('never drops a dose that lands in the spring-forward gap', () => {
    // 2026-03-08, US spring forward: 02:30 does not exist.
    const r = wallToUtc('America/New_York', 2026, 3, 8, 2, 30);
    expect(r.kind).toBe('gap');
    // Must still produce a usable instant, shifted past the transition, not dropped.
    expect(iso(r.utc)).toBe('2026-03-08T07:30:00.000Z'); // = 03:30 local
    expect(localDay(r.utc, 'America/New_York')).toBe('2026-03-08');
  });

  it('handles a half-hour zone and a 45-minute zone', () => {
    expect(iso(wallToUtc('Asia/Kolkata', 2026, 6, 1, 8, 0).utc)).toBe('2026-06-01T02:30:00.000Z');
    expect(iso(wallToUtc('Asia/Kathmandu', 2026, 6, 1, 8, 0).utc)).toBe('2026-06-01T02:15:00.000Z');
  });

  it('round-trips every hour of a DST weekend in several zones', () => {
    for (const tz of ['America/New_York', 'Europe/London', 'America/Santiago', 'Australia/Lord_Howe']) {
      for (const [y, mo, d] of [[2026, 3, 8], [2026, 11, 1], [2026, 3, 29], [2026, 10, 25]] as const) {
        for (let h = 0; h < 24; h++) {
          const r = wallToUtc(tz, y, mo, d, h, 0);
          expect(Number.isFinite(r.utc), `${tz} ${y}-${mo}-${d} ${h}:00`).toBe(true);
          // An exact result must render back as exactly the requested wall time.
          if (r.kind === 'exact' || r.kind === 'ambiguous') {
            const z = zoneFor(tz);
            expect(z.partsOf(r.utc).h, `${tz} ${y}-${mo}-${d} ${h}:00`).toBe(h);
          }
        }
      }
    }
  });
});

describe('local day arithmetic', () => {
  it('adds days by the calendar, not by 86400000', () => {
    expect(addLocalDays('2026-03-07', 1)).toBe('2026-03-08');
    expect(addLocalDays('2026-02-28', 1)).toBe('2026-03-01'); // 2026 is not a leap year
    expect(addLocalDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addLocalDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(diffLocalDays('2026-03-01', '2026-03-08')).toBe(7);
  });

  it('survives a DST day when stepping through a week', () => {
    const tz = 'America/New_York';
    let day = '2026-03-06';
    for (let i = 0; i < 5; i++) {
      const start = startOfLocalDay(tz, day);
      expect(localDay(start, tz), `midnight of ${day}`).toBe(day);
      day = addLocalDays(day, 1);
    }
  });

  it('finds midnight in a zone that skips it', () => {
    // Havana springs forward at midnight: 2026-03-08 00:00 does not exist.
    const start = startOfLocalDay('America/Havana', '2026-03-08');
    expect(localDay(start, 'America/Havana')).toBe('2026-03-08');
  });
});

describe('wall-clock search', () => {
  const tz = 'Asia/Dhaka';

  it('resolves a bare time to its most recent past occurrence', () => {
    const now = Date.UTC(2026, 8, 14, 12, 0); // 18:00 Dhaka (UTC+6)
    const at5pm = lastWallAtOrBefore(tz, '17:00', now);
    expect(iso(at5pm)).toBe('2026-09-14T11:00:00.000Z'); // today 17:00 Dhaka
  });

  it('rolls back to yesterday when the time has not happened yet today', () => {
    const now = Date.UTC(2026, 8, 14, 2, 0); // 08:00 Dhaka
    const at5pm = lastWallAtOrBefore(tz, '17:00', now);
    expect(iso(at5pm)).toBe('2026-09-13T11:00:00.000Z'); // yesterday 17:00 Dhaka
  });

  it('finds the next occurrence forwards', () => {
    const now = Date.UTC(2026, 8, 14, 2, 0); // 08:00 Dhaka
    expect(iso(nextWallAtOrAfter(tz, '17:00', now))).toBe('2026-09-14T11:00:00.000Z');
    expect(iso(nextWallAtOrAfter(tz, '06:00', now))).toBe('2026-09-15T00:00:00.000Z');
  });
});

describe('fmtDuration', () => {
  it('reads the way a person would say it', () => {
    expect(fmtDuration(45_000)).toBe('45s');
    expect(fmtDuration(45 * 60_000)).toBe('45m');
    expect(fmtDuration(2 * 3_600_000)).toBe('2h');
    expect(fmtDuration(2 * 3_600_000 + 5 * 60_000)).toBe('2h 5m');
  });
});
