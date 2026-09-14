import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { decodeCallback, encodeCallback } from '../src/core/callbackCodec.js';
import type { Callback } from '../src/core/callbackCodec.js';

/**
 * Whole-codebase consistency, of the kind a type checker cannot see.
 *
 * Each of these is a rule the code is supposed to obey everywhere, and each has been
 * broken at least once: a callback that decoded as a different action, a column added by
 * a migration that nothing ever read, two places computing the same quantity differently.
 */

const read = (f: string): string => readFileSync(f, 'utf8');

describe('inline button payloads', () => {
  it('survive a round trip and fit in Telegram’s 64 bytes', () => {
    const samples: Callback[] = [
      { a: 'take', doseId: 12345 }, { a: 'skip', doseId: 9 }, { a: 'snooze', doseId: 7, minutes: 15 },
      { a: 'earlier', doseId: 7, minutesAgo: 60 }, { a: 'takeAll', promptId: 88 },
      { a: 'wake' }, { a: 'sleep' }, { a: 'bedtime', choice: 'took' }, { a: 'bedtime', choice: 'skip' },
      { a: 'bedtime', choice: 'leave' }, { a: 'sleepAnyway' },
      { a: 'bedAt', shiftMinutes: -30 }, { a: 'bedAt', shiftMinutes: 0 }, { a: 'bedAt', shiftMinutes: 60 },
      { a: 'bedNow' }, { a: 'wokeNow' }, { a: 'wokeEarlier' }, { a: 'wokeAgo', minutesAgo: 180 },
      { a: 'sleepOn', minutes: 120 }, { a: 'tookPast', doseId: 4242 },
      { a: 'ate', meal: 'breakfast' }, { a: 'planMeal', meal: 'lunch', inMinutes: 60 },
      { a: 'mealAt', meal: 'dinner', at: 1789448400000 }, { a: 'skipMeal', meal: 'lunch' },
      { a: 'confirmImport', versionId: 3 }, { a: 'cancelImport', versionId: 3 },
      { a: 'editMenu', medId: 5 }, { a: 'editSet', medId: 5, field: 'perday', value: '3' },
      { a: 'unlink', chatId: -100123, patientId: 4 }, { a: 'noop' },
    ];
    for (const cb of samples) {
      const wire = encodeCallback(cb);
      expect(new TextEncoder().encode(wire).length, `${wire} exceeds 64 bytes`).toBeLessThanOrEqual(64);
      expect(decodeCallback(wire), `${JSON.stringify(cb)} did not survive the round trip`).toEqual(cb);
    }
  });

  it('never let two actions share an encoding prefix', () => {
    // Two actions encoding as the same letter means one silently does the other's job.
    const src = read('src/core/callbackCodec.ts');
    const enc = src.slice(src.indexOf('export function encodeCallback'), src.indexOf('export function decodeCallback'));
    const seen = new Map<string, string>();
    for (const m of enc.matchAll(/case '(\w+)': return `?'?([A-Za-z-])/g)) {
      const [, action, head] = m;
      const clash = seen.get(head!);
      expect(clash, `"${action}" and "${clash}" both encode as "${head}"`).toBeUndefined();
      seen.set(head!, action!);
    }
    expect(seen.size, 'the encoder pattern has drifted').toBeGreaterThan(20);
  });

  it('decode every prefix the encoder can produce', () => {
    const src = read('src/core/callbackCodec.ts');
    const enc = src.slice(src.indexOf('export function encodeCallback'), src.indexOf('export function decodeCallback'));
    const dec = src.slice(src.indexOf('export function decodeCallback'));
    for (const m of enc.matchAll(/case '(\w+)': return `?'?([A-Za-z-])/g)) {
      const [, action, head] = m;
      if (action === 'noop') continue; // deliberately falls through to the default case
      expect(dec.includes(`case '${head}'`), `"${action}" encodes as "${head}" but nothing decodes it`).toBe(true);
    }
  });
});

describe('the schema and the code agree', () => {
  it('reads back every column a migration adds', () => {
    const migrations = readdirSync('migrations').filter((f) => f.endsWith('.sql'))
      .map((f) => read(`migrations/${f}`)).join('\n');
    const db = read('src/io/db.ts');
    for (const [, table, column] of migrations.matchAll(/ALTER TABLE (\w+) ADD COLUMN (\w+)/g)) {
      expect(db.includes(`'${column}'`), `${table}.${column} is added by a migration and never read`).toBe(true);
    }
  });

  it('never writes a prompt kind the schema rejects', () => {
    const allowed = /CHECK \(kind IN \(([^)]*)\)\)/.exec(read('migrations/0001_init.sql').slice(
      read('migrations/0001_init.sql').indexOf('CREATE TABLE prompts'),
    ))?.[1];
    expect(allowed, 'could not find the prompts.kind constraint').toBeDefined();
    const permitted = new Set([...allowed!.matchAll(/'(\w+)'/g)].map((m) => m[1]));
    for (const file of ['src/core/planWake.ts', 'src/core/plan.ts', 'src/core/planMeals.ts', 'src/core/planReport.ts']) {
      for (const m of read(file).matchAll(/createPrompt', id: 0, kind: '(\w+)'|kind: '(\w+)', tier:/g)) {
        const kind = m[1] ?? m[2];
        if (kind === undefined) continue;
        expect(permitted.has(kind), `${file} creates a "${kind}" prompt; the schema allows ${[...permitted].join(', ')}`).toBe(true);
      }
    }
  });
});

describe('one rule, one place', () => {
  it('spreads "n times a day" through a single function', () => {
    // These were two calculations over two different windows, so the same "4 times a day"
    // meant one thing in a prescription and another through the /meds menu.
    const callbacks = read('src/handlers/callbacks.ts');
    expect(callbacks, '/edit perday computes its own interval again')
      .toMatch(/dosesPerDayInterval\(SPREAD_FROM, SPREAD_TO/);
  });

  it('keeps the prescribed daily count wherever the schedule is rewritten', () => {
    // Losing it means the bot forgets this is a four-a-day medicine and plans a fifth.
    const callbacks = read('src/handlers/callbacks.ts');
    const perday = callbacks.slice(callbacks.indexOf("case 'perday'"), callbacks.indexOf("case 'perday'") + 900);
    expect(perday, 'the /edit perday menu drops dosesPerDay from the spec').toContain('dosesPerDay');
  });

  it('asks the medicine, not the arithmetic, how many doses a day it has', () => {
    const remaining = read('src/core/remaining.ts');
    expect(remaining, '/status derives a count the scheduler would disagree with')
      .toMatch(/med\.spec\.dosesPerDay/);
  });
});

describe('nothing is left referring to a rule that was removed', () => {
  it('does not claim to presume anyone awake', () => {
    // Waking stopped being assumed; anything still saying otherwise is telling the user
    // about behaviour that no longer exists.
    for (const file of ['src/handlers/commands.ts', 'src/handlers/views.ts']) {
      expect(read(file), `${file} still promises to presume the patient awake`)
        .not.toMatch(/presumed? awake|Assume awake/i);
    }
  });

  it('keeps no exported planner helper that nothing calls', () => {
    const core = readdirSync('src/core').filter((f) => f.endsWith('.ts'));
    const all = [
      ...core.map((f) => `src/core/${f}`),
      ...readdirSync('src/handlers').map((f) => `src/handlers/${f}`),
      ...readdirSync('src/io').map((f) => `src/io/${f}`),
      'src/index.ts',
    ].map((f) => read(f)).join('\n');
    for (const f of core) {
      for (const m of read(`src/core/${f}`).matchAll(/export function (\w+)/g)) {
        const name = m[1]!;
        const uses = all.split(name).length - 1;
        expect(uses, `core/${f}: ${name} is exported but nothing calls it`).toBeGreaterThan(1);
      }
    }
  });
});
