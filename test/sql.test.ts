import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

/**
 * Static checks over the SQL.
 *
 * These exist because a real bug got through: an INSERT gained three columns in the bind
 * list but not in the column list, and nothing caught it until a live import failed with
 * "Wrong number of parameter bindings". The planner is covered by simulation; the SQL was
 * covered by nothing, because running it needs a database.
 */

const db = readFileSync('src/io/db.ts', 'utf8');
const adminDb = readFileSync('src/io/adminDb.ts', 'utf8');
const sources = { 'db.ts': db, 'adminDb.ts': adminDb };

/** Read the balanced contents of the `.bind(` that follows `from`. */
function bindArgsAfter(src: string, from: number): string | null {
  const idx = src.indexOf('.bind(', from);
  if (idx === -1) return null;
  let depth = 0;
  for (let i = idx + 5; i < src.length; i++) {
    const ch = src[i]!;
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return src.slice(idx + 6, i);
    }
  }
  return null;
}

/** Split a bind(...) argument list on top-level commas. */
function countArgs(raw: string): number {
  // A trailing comma is legal in a JS argument list and does not add an argument.
  const args = raw.trim().replace(/,\s*$/, '');
  let depth = 0;
  let count = args === '' ? 0 : 1;
  let inStr: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const ch = args[i]!;
    if (inStr !== null) {
      if (ch === inStr && args[i - 1] !== '\\') inStr = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') inStr = ch;
    else if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    else if (ch === ',' && depth === 0) count++;
  }
  return count;
}

describe('every INSERT agrees with its bindings', () => {
  for (const [name, src] of Object.entries(sources)) {
    it(`${name}`, () => {
      const re = /INSERT INTO (\w+) \(([\s\S]*?)\)\s*\n?\s*VALUES \(([^)]*)\)/g;
      let m: RegExpExecArray | null;
      let checked = 0;
      while ((m = re.exec(src)) !== null) {
        const [, table, colText, valText] = m;
        const columns = colText!.replace(/\s+/g, ' ').split(',').filter((c) => c.trim() !== '').length;
        const values = valText!.split(',').filter((v) => v.trim() !== '');

        // A placeholder may legitimately appear twice -- `VALUES (?1, ?2, ?3, ?3)` binds
        // one timestamp into two columns -- so what must match the bind list is the count
        // of DISTINCT placeholders, not of occurrences.
        const distinct = new Set(valText!.match(/\?\d+/g) ?? []);
        const bindText = bindArgsAfter(src, m.index);
        if (bindText === null) continue; // an INSERT built elsewhere; nothing to compare

        expect(columns, `${table}: ${columns} columns but ${values.length} values`).toBe(values.length);
        const bound = countArgs(bindText);
        expect(
          bound,
          `${table}: ${distinct.size} distinct placeholders but ${bound} bound arguments`,
        ).toBe(distinct.size);
        checked++;
      }
      expect(checked, `no INSERTs found in ${name} — the pattern has drifted`).toBeGreaterThan(0);
    });
  }
});

describe('every migration column is actually read back', () => {
  it('medications columns added by migrations appear in the row mapper', () => {
    const migrations = readdirSync('migrations')
      .filter((f) => f.endsWith('.sql'))
      .map((f) => readFileSync(`migrations/${f}`, 'utf8'))
      .join('\n');
    const added = [...migrations.matchAll(/ALTER TABLE (\w+) ADD COLUMN (\w+)/g)];
    expect(added.length).toBeGreaterThan(0);
    for (const [, table, column] of added) {
      // A column nobody reads is a column that silently does nothing.
      expect(
        db.includes(`'${column}'`),
        `${table}.${column} was added by a migration but is never read in db.ts`,
      ).toBe(true);
    }
  });
});
