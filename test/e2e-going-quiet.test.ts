import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { Bot } from './harness/bot.js';
import { HOUR, MINUTE, zoneFor } from '../src/core/tz.js';

/**
 * The ways a reminder stopped arriving.
 *
 * None of these showed up as an error. The scheduler ticked every minute, no tick threw
 * in six days, the outbox was empty and the chats were live -- and medicines were still
 * being missed. Each one here is a path where the bot stops speaking while believing it
 * has spoken, which is the failure this whole system is built to prevent.
 */

const z = zoneFor('Asia/Dhaka');
const at = (hhmm: string, day = 0): number => z.wallOnDayUtc(z.addLocalDays('2026-09-14', day), hhmm);
const P = 5000;
const C = 6000;

const realFetch = globalThis.fetch;
let bot: Bot;
beforeEach(() => { bot = new Bot(at('09:00')); bot.install(); });
afterEach(() => { globalThis.fetch = realFetch; });

const RX = {
  version: 1, timezone: 'Asia/Dhaka', patient: 'Ifti',
  day: { morning_poll_at: '09:00', presumed_wake_at: '11:00', evening_poll_at: '23:30', presumed_sleep_at: '01:00' },
  meals: [
    { id: 'breakfast', typical_local: '08:30' },
    { id: 'lunch', typical_local: '13:30' },
    { id: 'dinner', typical_local: '20:30' },
  ],
  medicines: [
    { id: 'aqua', name: 'Aquafresh', dose: '1 drop', schedule: { type: 'interval', every: '2h', anchor: 'wake' }, min_gap: '90m' },
  ],
};

async function invite(kind: 'enrol' | 'caregiver', patientId?: number): Promise<string> {
  const { AdminDb } = await import('../src/io/adminDb.js');
  const admin = new AdminDb(bot.d1 as never);
  const inv = await admin.createInvite(kind, {
    createdBy: 'a', ttlMs: 86400_000, ...(patientId === undefined ? {} : { patientId }),
  }, bot.now);
  return inv.code;
}

async function setUp(withCarer = false): Promise<void> {
  await bot.send(P, `/start ${await invite('enrol')}`, { firstName: 'Ifti' });
  await bot.sendFile(P, 'p.json', JSON.stringify(RX));
  await bot.tap(P, /Apply|Confirm|Yes/i);
  if (withCarer) {
    const id = Number(bot.d1.one('SELECT id FROM patients')?.['id']);
    await bot.send(C, `/caregiver ${await invite('caregiver', id)}`, { firstName: 'Ashraf' });
  }
  await bot.send(P, '/awake');
}

describe('a nudge that cannot send must not delete the one already there', () => {
  it('leaves the standing reminder alone when the replacement fails', async () => {
    await setUp();
    await bot.run(40 * MINUTE, 5 * MINUTE); // a dose prompt, then a nudge due

    // Every further send fails the way a 429 or a blip does.
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (/sendMessage$/.test(String(input))) {
        return new Response(JSON.stringify({ ok: false, error_code: 429, description: 'Too Many Requests' }), { status: 429 });
      }
      return real(input, init);
    }) as typeof fetch;

    const before = bot.calls.filter((c) => c.method === 'deleteMessage').length;
    await bot.run(60 * MINUTE, 5 * MINUTE);
    const deletes = bot.calls.filter((c) => c.method === 'deleteMessage').length - before;
    globalThis.fetch = real;

    expect(deletes, 'took the only reminder off the screen and could not replace it').toBe(0);
  });

  it('still replaces it when the send works', async () => {
    await setUp();
    await bot.run(90 * MINUTE, 5 * MINUTE);
    expect(bot.calls.filter((c) => c.method === 'deleteMessage').length,
      'the chat fills with duplicate reminders').toBeGreaterThan(0);
    // One live message per chat per prompt: the replacement landed and the old one went.
    const perChat = bot.d1.rows(
      "SELECT chat_id, COUNT(*) c FROM prompt_messages WHERE send_state='sent' GROUP BY chat_id",
    );
    for (const r of perChat) {
      expect(Number(r['c']), 'stacked reminders for one prompt').toBeLessThanOrEqual(2);
    }
  });
});

describe('"ask me again in an hour"', () => {
  it('does not silence that hour’s medicines', async () => {
    await setUp();
    await bot.send(P, '/sleep');
    await bot.tap(P, /turning in/i).catch(() => undefined);
    // Through the night and past the minimum sleep, until it asks whether she is up.
    for (let i = 0; i < 24 * 12 && !bot.sent.some((m) => /just wake up/i.test(m.text)); i++) {
      await bot.tick();
      bot.now += 5 * MINUTE;
    }
    expect(bot.sent.some((m) => /just wake up/i.test(m.text)), 'never asked').toBe(true);

    await bot.tap(P, /\+1 hour/);
    const patientId = Number(bot.d1.one('SELECT id FROM patients')?.['id']);
    const nextAction = Number(bot.d1.one(`SELECT next_action_at FROM patients WHERE id=${patientId}`)?.['next_action_at']);
    expect(nextAction - bot.now, 'parked the whole patient an hour out, medicines included')
      .toBeLessThan(55 * MINUTE);
  });

  it('stops re-asking, even though tapping the button is itself activity', async () => {
    await setUp();
    await bot.send(P, '/sleep');
    await bot.tap(P, /turning in/i).catch(() => undefined);
    for (let i = 0; i < 24 * 12 && !bot.sent.some((m) => /just wake up/i.test(m.text)); i++) {
      await bot.tick();
      bot.now += 5 * MINUTE;
    }
    await bot.tap(P, /\+1 hour/);
    bot.clear();
    await bot.run(45 * MINUTE, 5 * MINUTE);
    expect(bot.textsTo(P).filter((t) => /just wake up/i.test(t)),
      'asked again straight away because the tap counted as stirring').toEqual([]);
  });

  it('asks again once the hour is up', async () => {
    await setUp();
    await bot.send(P, '/sleep');
    await bot.tap(P, /turning in/i).catch(() => undefined);
    for (let i = 0; i < 24 * 12 && !bot.sent.some((m) => /just wake up/i.test(m.text)); i++) {
      await bot.tick();
      bot.now += 5 * MINUTE;
    }
    await bot.tap(P, /\+1 hour/);
    bot.clear();
    await bot.run(3 * HOUR, 5 * MINUTE);
    expect(bot.textsTo(P).join('\n'), 'went quiet for good').toMatch(/just wake up/i);
  });

  it('a prediction of when they will wake still lets stirring earn a question', async () => {
    // The bot's own guess must never suppress the question -- only the patient saying so.
    await setUp();
    await bot.send(P, '/sleep');
    await bot.tap(P, /turning in/i).catch(() => undefined);
    for (let i = 0; i < 24 * 12 && !bot.sent.some((m) => /just wake up/i.test(m.text)); i++) {
      await bot.tick();
      bot.now += 5 * MINUTE;
    }
    expect(bot.sent.some((m) => /just wake up/i.test(m.text))).toBe(true);
  });
});

describe('answered prompts do not stay on screen', () => {
  it('takes down a meal question once it has been answered', async () => {
    await setUp();
    for (let i = 0; i < 24 * 12 && !bot.sent.some((m) => m.chatId === P && m.buttons.flat().some((b) => /Yes,/.test(b.text))); i++) {
      await bot.tick();
      bot.now += 5 * MINUTE;
    }
    await bot.tap(P, /Yes,/);
    await bot.run(5 * MINUTE, MINUTE);
    const openMeal = bot.d1.rows(
      "SELECT pm.* FROM prompt_messages pm JOIN prompts p ON p.id=pm.prompt_id WHERE pm.send_state='sent' AND p.kind='meal' AND p.state!='open'",
    );
    expect(openMeal, 'answered meal questions left in the chat with live buttons').toEqual([]);
  });

  it('sweeps up anything the close paths missed', async () => {
    await setUp(true);
    await bot.run(3 * HOUR, 5 * MINUTE);
    // A message the cleanup lost track of -- a delete that ran out of budget, say.
    const prompt = bot.d1.one("SELECT id FROM prompts WHERE state!='open' ORDER BY id DESC");
    expect(prompt, 'no closed prompt to test with').not.toBeNull();
    bot.d1.rows(
      `INSERT OR REPLACE INTO prompt_messages (prompt_id, chat_id, message_id, send_state, updated_at)
       VALUES (${Number(prompt!['id'])}, ${P}, 99123, 'sent', ${bot.now})`,
    );
    await bot.run(5 * MINUTE, MINUTE);
    const left = bot.d1.rows(
      "SELECT pm.* FROM prompt_messages pm JOIN prompts p ON p.id=pm.prompt_id WHERE pm.send_state='sent' AND p.state!='open'",
    );
    expect(left, 'a stranded reminder stays in the chat for ever').toEqual([]);
    expect(bot.calls.some((c) => c.method === 'deleteMessage' && c.body['message_id'] === 99123)).toBe(true);
  });
});
