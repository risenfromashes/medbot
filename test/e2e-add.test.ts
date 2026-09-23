import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { Bot } from './harness/bot.js';
import { MINUTE, zoneFor } from '../src/core/tz.js';

/**
 * Adding one medicine without touching the rest.
 *
 * The dangerous part is the boundary with /import: an attachment used to go to /import
 * whatever its caption said, so a file captioned "/add" replaced the entire prescription
 * and discontinued every medicine the file did not happen to mention.
 */

const z = zoneFor('Asia/Dhaka');
const at = (hhmm: string): number => z.wallOnDayUtc('2026-09-14', hhmm);
const P = 5000;

const realFetch = globalThis.fetch;
let bot: Bot;
beforeEach(() => { bot = new Bot(at('09:00')); bot.install(); });
afterEach(() => { globalThis.fetch = realFetch; });

async function setUp(): Promise<void> {
  const { AdminDb } = await import('../src/io/adminDb.js');
  const admin = new AdminDb(bot.d1 as never);
  const inv = await admin.createInvite('enrol', { createdBy: 'a', ttlMs: 86400_000 }, bot.now);
  await bot.send(P, `/start ${inv.code}`, { firstName: 'Ifti' });
  await bot.sendFile(P, 'p.json', JSON.stringify({
    version: 1, timezone: 'Asia/Dhaka',
    meals: [{ id: 'breakfast', typical_local: '08:30' }, { id: 'dinner', typical_local: '20:30' }],
    medicines: [
      { id: 'base', name: 'Base Drop', schedule: { type: 'interval', every: '4h', anchor: 'wake' }, course: { days: 7 } },
      { id: 'other', name: 'Other Tab', schedule: { type: 'interval', every: '8h', anchor: 'wake' }, course: { days: 7 } },
    ],
  }));
  await bot.tap(P, /Apply|Confirm|Yes/i);
  await bot.send(P, '/awake');
  await bot.run(20 * MINUTE, 5 * MINUTE);
  await bot.tap(P, /Taken|✅/);
}

const keys = (): string[] =>
  bot.d1.rows("SELECT med_key FROM medications WHERE status='active' ORDER BY med_key").map((r) => String(r['med_key']));

describe('/add', () => {
  it('adds one medicine and leaves the others exactly as they were', async () => {
    await setUp();
    const before = bot.d1.one("SELECT * FROM medications WHERE med_key='base'")!;
    await bot.send(P, '/add {"id":"para","name":"Paracetamol","dose":"1 tablet","schedule":{"type":"as_needed"},"min_gap":"6h","max_per_day":4}');
    expect(keys()).toEqual(['base', 'other', 'para']);
    const after = bot.d1.one("SELECT * FROM medications WHERE med_key='base'")!;
    expect(after['started_at'], 'adding disturbed a running course').toBe(before['started_at']);
    expect(after['doses_taken']).toBe(before['doses_taken']);
  });

  it('takes several at once', async () => {
    await setUp();
    await bot.send(P, '/add [{"id":"a1","name":"A One","schedule":{"type":"interval","every":"6h"}},{"id":"a2","name":"A Two","schedule":{"type":"interval","every":"8h"}}]');
    expect(keys()).toEqual(['a1', 'a2', 'base', 'other']);
  });

  it('resolves a pattern against the meals already on file', async () => {
    // The pasted JSON has no `meals` block of its own — the patient's does.
    await setUp();
    await bot.send(P, '/add {"id":"pat","name":"Pattern Tab","dose":"1 tablet","pattern":"1+0+1","course":{"days":5}}');
    expect(bot.last(P)).toMatch(/after breakfast and dinner/);
    expect(String(bot.d1.one("SELECT kind FROM medications WHERE med_key='pat'")?.['kind'])).toBe('meal');
  });

  it('makes up an id when none is given', async () => {
    await setUp();
    await bot.send(P, '/add {"name":"No Id Tab","schedule":{"type":"interval","every":"6h"}}');
    expect(keys()).toContain('no_id_tab');
  });

  it('accepts a fenced code block, since that is what a chatbot returns', async () => {
    await setUp();
    await bot.send(P, '/add ```json\n{"id":"fen","name":"Fenced Tab","schedule":{"type":"interval","every":"6h"}}\n```');
    expect(keys()).toContain('fen');
  });

  it('says what is wrong instead of adding something broken', async () => {
    await setUp();
    bot.clear();
    await bot.send(P, '/add {"id":"bad","name":"Bad Tab","schedule":{"type":"interval"}}');
    expect(keys()).toEqual(['base', 'other']);
    expect(bot.last(P)).toMatch(/couldn't use|every/i);
  });

  it('refuses a duplicate id and names the way out', async () => {
    await setUp();
    bot.clear();
    await bot.send(P, '/add {"id":"base","name":"Base Drop","schedule":{"type":"interval","every":"4h"}}');
    expect(keys()).toEqual(['base', 'other']);
    expect(bot.last(P)).toMatch(/\/restart base/);
  });

  it('starts reminding about the new medicine straight away', async () => {
    await setUp();
    await bot.send(P, '/add {"id":"drop2","name":"New Drop","dose":"1 drop","schedule":{"type":"interval","every":"3h","anchor":"wake"},"course":{"days":5}}');
    bot.clear();
    await bot.run(4 * 60 * MINUTE, 10 * MINUTE);
    expect(bot.textsTo(P).join('\n'), 'added and then never mentioned again').toMatch(/New Drop/);
  });
});

describe('an attachment captioned /add', () => {
  it('adds its medicines instead of replacing the prescription', async () => {
    await setUp();
    await bot.sendFile(P, 'extra.json', JSON.stringify({
      version: 1,
      medicines: [{ id: 'extra', name: 'Extra Tab', schedule: { type: 'interval', every: '6h' }, course: { days: 3 } }],
    }), '/add');
    expect(keys(), 'a file captioned /add wiped out the prescription').toEqual(['base', 'extra', 'other']);
  });

  it('does not ask for confirmation, having changed nothing else', async () => {
    await setUp();
    bot.clear();
    await bot.sendFile(P, 'extra.json', JSON.stringify({
      version: 1,
      medicines: [{ id: 'extra', name: 'Extra Tab', schedule: { type: 'interval', every: '6h' } }],
    }), '/add');
    expect(bot.last(P)).toMatch(/Added/);
  });

  it('still replaces everything when the file is sent with no caption', async () => {
    await setUp();
    await bot.sendFile(P, 'p.json', JSON.stringify({
      version: 1, timezone: 'Asia/Dhaka',
      medicines: [{ id: 'only', name: 'Only Tab', schedule: { type: 'interval', every: '6h' } }],
    }));
    await bot.tap(P, /Apply|Confirm|Yes/i);
    expect(keys(), 'a plain attachment stopped being a whole prescription').toEqual(['only']);
  });
});
