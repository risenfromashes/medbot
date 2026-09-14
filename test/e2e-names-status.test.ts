import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { Bot } from './harness/bot.js';
import { MINUTE, zoneFor } from '../src/core/tz.js';
import { looksLikeRealName } from '../src/core/names.js';

const z = zoneFor('Asia/Dhaka');
const at = (hhmm: string, day = 0): number => z.wallOnDayUtc(z.addLocalDays('2026-09-14', day), hhmm);
const PATIENT = 5000;

const realFetch = globalThis.fetch;
let bot: Bot;

beforeEach(() => {
  bot = new Bot(at('09:00'));
  bot.install();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const PRESCRIPTION = {
  version: 1,
  timezone: 'Asia/Dhaka',
  day: { morning_poll_at: '06:30', presumed_wake_at: '09:00', evening_poll_at: '22:30', presumed_sleep_at: '23:00' },
  medicines: [
    { id: 'drops', name: 'Moxifloxacin', dose: '1 drop', schedule: { type: 'interval', every: '4h', anchor: 'wake' }, course: { days: 7 } },
    { id: 'tab', name: 'Tab. Ceevit', dose: '1 tablet', schedule: { type: 'times_per_day', n: 2, anchor: 'clock' }, course: { doses: 20 } },
  ],
};

async function enrol(firstName?: string): Promise<void> {
  const { AdminDb } = await import('../src/io/adminDb.js');
  const admin = new AdminDb(bot.d1 as never);
  const inv = await admin.createInvite('enrol', { createdBy: 'a', ttlMs: 86400_000 }, bot.now);
  await bot.send(PATIENT, `/start ${inv.code}`, firstName === undefined ? {} : { firstName });
}

describe('knowing what to call someone', () => {
  it('takes the name Telegram gives and says nothing more about it', async () => {
    await enrol('Ayesha');
    expect(bot.d1.one('SELECT display_name FROM patients')?.['display_name']).toBe('Ayesha');
    expect(bot.textsTo(PATIENT).join('\n'), 'asked for a name it already had')
      .not.toMatch(/what should I call you/i);
  });

  it('asks when Telegram gives it a placeholder instead of a name', async () => {
    // "Member" is what a chat with no first name on it hands over, and it used to become
    // the patient's name in every reminder for the rest of the course.
    await enrol('Member');
    expect(bot.last(PATIENT)).toMatch(/what should I call you/i);
  });

  it('asks when Telegram gives nothing at all', async () => {
    await enrol('');
    expect(bot.last(PATIENT)).toMatch(/what should I call you/i);
  });

  it('takes the next thing they send as the answer', async () => {
    await enrol('Member');
    await bot.send(PATIENT, 'Ayesha');
    expect(bot.d1.one('SELECT display_name FROM patients')?.['display_name']).toBe('Ayesha');
    expect(bot.last(PATIENT)).toContain('Ayesha');
  });

  it('does not swallow a command sent instead of a name', async () => {
    await enrol('Member');
    bot.clear();
    await bot.send(PATIENT, '/status');
    expect(bot.d1.one('SELECT display_name FROM patients')?.['display_name']).not.toBe('/status');
    expect(bot.sent.length).toBeGreaterThan(0);
  });

  it('stops treating messages as the answer after an hour', async () => {
    await enrol('Member');
    bot.now += 2 * 60 * MINUTE;
    await bot.send(PATIENT, 'hello?');
    expect(bot.d1.one('SELECT display_name FROM patients')?.['display_name']).not.toBe('hello?');
  });

  it('knows a name when it sees one', () => {
    expect(looksLikeRealName('Ayesha')).toBe(true);
    expect(looksLikeRealName('Md. Ashrafur')).toBe(true);
    expect(looksLikeRealName('Member')).toBe(false);
    expect(looksLikeRealName('user')).toBe(false);
    expect(looksLikeRealName('')).toBe(false);
    expect(looksLikeRealName('+8801712345678')).toBe(false);
    expect(looksLikeRealName(null)).toBe(false);
  });
});

describe('how much is left', () => {
  it('says how many doses remain today and in the course', async () => {
    await enrol('Ayesha');
    await bot.sendFile(PATIENT, 'p.json', JSON.stringify(PRESCRIPTION));
    await bot.tap(PATIENT, /Apply|Confirm|Yes/i);
    await bot.send(PATIENT, '/awake');
    bot.clear();
    await bot.send(PATIENT, '/status');

    const text = bot.textsTo(PATIENT).join('\n');
    expect(text, '/status never says how much is left').toMatch(/Doses left/i);
    expect(text).toMatch(/left today/i);
    expect(text).toMatch(/to go in all/i);
    // Both medicines accounted for, not just whichever is next.
    expect(text).toContain('Moxifloxacin');
    expect(text).toContain('Ceevit');
  });

  it('counts down as doses are taken', async () => {
    await enrol('Ayesha');
    await bot.sendFile(PATIENT, 'p.json', JSON.stringify(PRESCRIPTION));
    await bot.tap(PATIENT, /Apply|Confirm|Yes/i);
    await bot.send(PATIENT, '/awake');
    await bot.run(10 * MINUTE);

    const before = /(\d+) left today/.exec(bot.last(PATIENT) + (await statusText()))?.[1];
    await bot.tap(PATIENT, /Taken|✅|Moxi/);
    const after = /(\d+) left today/.exec(await statusText())?.[1];
    expect(Number(after), 'the count did not move after a dose').toBeLessThan(Number(before));
  });

  it('says "ongoing" rather than a number for a course with no end', async () => {
    await enrol('Ayesha');
    await bot.sendFile(PATIENT, 'p.json', JSON.stringify({
      version: 1, timezone: 'Asia/Dhaka',
      medicines: [{ id: 'drops', name: 'Lubricant', dose: '1 drop', schedule: { type: 'interval', every: '4h', anchor: 'wake' } }],
    }));
    await bot.tap(PATIENT, /Apply|Confirm|Yes/i);
    expect(await statusText()).toMatch(/ongoing/i);
  });
});

describe('the meals line', () => {
  const MEALY = {
    version: 1, timezone: 'Asia/Dhaka',
    day: { morning_poll_at: '06:30', presumed_wake_at: '09:00', evening_poll_at: '22:30', presumed_sleep_at: '23:00' },
    meals: [
      { id: 'breakfast', typical_local: '08:30' },
      { id: 'lunch', typical_local: '13:30' },
      { id: 'dinner', typical_local: '20:30' },
    ],
    medicines: [
      { id: 'omep', name: 'Cap. Maxpro', dose: '1 capsule', pattern: '1+0+1', relation: 'before', course: { days: 7 } },
    ],
  };

  async function setUp(): Promise<void> {
    await enrol('Ayesha');
    await bot.sendFile(PATIENT, 'p.json', JSON.stringify(MEALY));
    await bot.tap(PATIENT, /Apply|Confirm|Yes/i);
    await bot.send(PATIENT, '/awake');
  }

  it('lists meals in the order of the day, not alphabetically', async () => {
    // SQLite served them off the (patient, meal) index, so /status said
    // "breakfast · dinner · lunch" — which reads as a mistake, because it is one.
    await setUp();
    const text = await statusText();
    const order = ['breakfast', 'lunch', 'dinner'].map((m) => text.indexOf(m));
    expect(order[0]).toBeGreaterThan(-1);
    expect(order[1], 'lunch is not after breakfast').toBeGreaterThan(order[0]!);
    expect(order[2], 'dinner is not after lunch').toBeGreaterThan(order[1]!);
  });

  it('says when a meal that has not happened is expected', async () => {
    await setUp();
    const text = await statusText();
    // A bare "·" tells nobody anything, and the before-meal tablets hang off this.
    expect(text).toMatch(/lunch ~\d/);
  });

  it('says when a meal actually happened', async () => {
    await setUp();
    await bot.send(PATIENT, '/ate breakfast');
    const text = await statusText();
    expect(text).toMatch(/✅ breakfast \d/);
  });
});

async function statusText(): Promise<string> {
  const before = bot.sent.length;
  await bot.send(PATIENT, '/status');
  return bot.sent.slice(before).map((m) => m.text).join('\n');
}
