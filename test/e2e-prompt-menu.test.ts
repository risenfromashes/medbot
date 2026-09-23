import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { Bot } from './harness/bot.js';
import { zoneFor } from '../src/core/tz.js';

/**
 * Getting the JSON written for you.
 *
 * /add takes a medicine as JSON, which is a great deal to ask of someone typing on a
 * phone. The same trick that handles a whole prescription handles one medicine: the bot
 * hands out a message to paste into a chatbot, and the chatbot writes it.
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
    medicines: [{ id: 'vigalon', name: 'Vigalon', schedule: { type: 'interval', every: '4h', anchor: 'wake' }, course: { days: 7 } }],
  }));
  await bot.tap(P, /Apply|Confirm|Yes/i);
}

const all = (): string => bot.textsTo(P).join('\n');

describe('/prompt', () => {
  it('asks which one rather than assuming', async () => {
    await setUp();
    bot.clear();
    await bot.send(P, '/prompt');
    expect(bot.last(P)).toMatch(/What are you setting up/i);
    const labels = bot.sent.flatMap((m) => m.buttons.flat()).map((b) => b.text);
    expect(labels.some((t) => /whole prescription/i.test(t))).toBe(true);
    expect(labels.some((t) => /one more medicine/i.test(t))).toBe(true);
  });

  it('gives the one-medicine prompt when that button is tapped', async () => {
    await setUp();
    await bot.send(P, '/prompt');
    const before = bot.textsTo(P).length;
    await bot.tap(P, /One more medicine/i);
    const after = bot.textsTo(P).slice(before).join('\n');
    expect(after, 'did not hand out a prompt at all').toMatch(/Adding one medicine/i);
    expect(after, 'the prompt does not ask for something /add can take').toMatch(/starting with \/add/);
  });

  it('still gives the whole-prescription prompt from the other button', async () => {
    await setUp();
    await bot.send(P, '/prompt');
    const before = bot.textsTo(P).length;
    await bot.tap(P, /whole prescription/i);
    expect(bot.textsTo(P).slice(before).join('\n')).toMatch(/Turning a prescription into JSON/i);
  });

  it('skips the menu when asked outright', async () => {
    await setUp();
    bot.clear();
    await bot.send(P, '/prompt add');
    expect(all()).toMatch(/Adding one medicine/i);
    expect(bot.sent.flatMap((m) => m.buttons.flat()), 'asked anyway').toEqual([]);
  });

  it('names the ids already in use, since /add refuses a clash', async () => {
    await setUp();
    bot.clear();
    await bot.send(P, '/prompt add');
    expect(all(), 'the chatbot has no way to avoid picking a clashing id').toMatch(/vigalon/);
  });

  it('names the meals on file, so a meal schedule resolves', async () => {
    await setUp();
    bot.clear();
    await bot.send(P, '/prompt add');
    expect(all()).toMatch(/breakfast, dinner/);
  });

  it('warns against a meal schedule when there are no meals', async () => {
    const { AdminDb } = await import('../src/io/adminDb.js');
    const admin = new AdminDb(bot.d1 as never);
    const inv = await admin.createInvite('enrol', { createdBy: 'a', ttlMs: 86400_000 }, bot.now);
    await bot.send(P, `/start ${inv.code}`, { firstName: 'Ifti' });
    bot.clear();
    await bot.send(P, '/prompt add');
    expect(all(), 'would have produced a medicine that never fires').toMatch(/no meals set up/i);
  });

  it('fits inside what Telegram will carry', async () => {
    await setUp();
    bot.clear();
    await bot.send(P, '/prompt add');
    for (const m of bot.sent) expect(m.text.length).toBeLessThanOrEqual(4096);
  });

  it('produces a prompt whose own example /add line actually works', async () => {
    // The shape the prompt tells the chatbot to emit has to be one /add accepts.
    await setUp();
    bot.clear();
    await bot.send(P, '/add {"id":"para","name":"Paracetamol","dose":"1 tablet","schedule":{"type":"as_needed"},"min_gap":"6h","max_per_day":4}');
    expect(bot.last(P)).toMatch(/Added/);
  });
});
