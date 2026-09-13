/**
 * A D1 stand-in over node:sqlite, so the real database layer can be tested.
 *
 * `plan()` being pure means the scheduling maths is covered without any of this. What it
 * does not cover is everything between a person typing `/import` and a row changing: the
 * SQL, the command handlers, the callbacks, the message that comes back. Nearly every
 * bug that reached a real user lived there, so it needs a harness of its own.
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

type Row = Record<string, unknown>;
type Bindable = null | number | bigint | string | Uint8Array;

interface Meta {
  changes: number;
  last_row_id: number;
  duration: number;
}

/** D1 takes `?1`-style placeholders; node:sqlite wants named ones. */
function rewrite(sql: string): string {
  return sql.replace(/\?(\d+)/g, '$p$1');
}

function bindObject(args: unknown[]): Record<string, Bindable> {
  const out: Record<string, Bindable> = {};
  for (const [i, v] of args.entries()) {
    // node:sqlite takes null, number, bigint, string and Uint8Array. Booleans are not on
    // that list; D1 quietly stores them as 0/1, so do the same rather than throwing.
    out[`p${i + 1}`] =
      typeof v === 'boolean' ? (v ? 1 : 0) : v === undefined || v === null ? null : (v as Bindable);
  }
  return out;
}

class FakeStatement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly args: unknown[] = [],
  ) {}

  bind(...args: unknown[]): FakeStatement {
    return new FakeStatement(this.db, this.sql, args);
  }

  /**
   * Run it and report back the way D1 does.
   *
   * The `last_row_id` matters more than it looks: `applyActions` inserts a dose, reads the
   * id out of the batch result, and stitches it into the prompt that follows. A harness
   * that returned zero there would quietly test a different program.
   */
  private exec<T>(): { results: T[]; meta: Meta } {
    const rows = this.db.prepare(rewrite(this.sql)).all(bindObject(this.args)) as T[];
    const after = this.db.prepare('SELECT last_insert_rowid() AS id, changes() AS c').get() as {
      id: number | bigint;
      c: number | bigint;
    };
    return {
      results: rows,
      meta: { changes: Number(after.c), last_row_id: Number(after.id), duration: 0 },
    };
  }

  async run(): Promise<{ success: boolean; meta: Meta }> {
    const { meta } = this.exec();
    return { success: true, meta };
  }

  async all<T = Row>(): Promise<{ results: T[]; success: boolean; meta: Meta }> {
    const { results, meta } = this.exec<T>();
    return { results, success: true, meta };
  }

  async first<T = Row>(): Promise<T | null> {
    const { results } = this.exec<T>();
    return results.length > 0 ? results[0]! : null;
  }
}

export class FakeD1 {
  readonly sqlite: DatabaseSync;
  /** Every statement that ran, for tests that want to assert on the SQL itself. */
  readonly log: string[] = [];

  constructor() {
    this.sqlite = new DatabaseSync(':memory:');
    this.sqlite.exec('PRAGMA foreign_keys = ON');
    for (const file of readdirSync('migrations').sort()) {
      if (!file.endsWith('.sql')) continue;
      this.sqlite.exec(readFileSync(`migrations/${file}`, 'utf8'));
    }
  }

  prepare(sql: string): FakeStatement {
    this.log.push(sql);
    return new FakeStatement(this.sqlite, sql);
  }

  async batch<T = Row>(statements: FakeStatement[]): Promise<Array<{ results: T[]; success: boolean; meta: Meta }>> {
    // D1 runs a batch as one transaction; so does this, which is what makes the
    // three-phase apply in db.ts testable at all.
    this.sqlite.exec('BEGIN');
    try {
      const out = [];
      for (const s of statements) out.push(await s.all<T>());
      this.sqlite.exec('COMMIT');
      return out;
    } catch (e) {
      this.sqlite.exec('ROLLBACK');
      throw e;
    }
  }

  /** Read straight out, for assertions. */
  rows(sql: string): Row[] {
    return this.sqlite.prepare(sql).all() as Row[];
  }

  one(sql: string): Row | null {
    const r = this.rows(sql);
    return r.length > 0 ? r[0]! : null;
  }
}
