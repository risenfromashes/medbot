import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { Bot } from './harness/bot.js';
import { zoneFor } from '../src/core/tz.js';

/**
 * The things people do that the happy path does not cover.
 *
 * Sending the wrong file. Typing a medicine's name from memory. Tapping a button twice.
 * Never getting round to setting the timezone. Each one of these is somebody's first
 * evening with the bot, and each one used to end in silence or a wall of red.
 */

const z = zoneFor('Asia/Dhaka');
const DAY0 = z.wallOnDayUtc('2026-09-14', '10:00');
const PATIENT = 5000;
const CARER = 6000;

const realFetch = globalThis.fetch;
let bot: Bot;

beforeEach(() => {
  bot = new Bot(DAY0);
  bot.install();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

async function makeInvite(kind: 'enrol' | 'caregiver' = 'enrol', patientId?: number): Promise<string> {
  const { AdminDb } = await import('../src/io/adminDb.js');
  const admin = new AdminDb(bot.d1 as never);
  const invite = await admin.createInvite(kind, {
    createdBy: 'admin', ttlMs: 24 * 3600_000,
    ...(patientId === undefined ? {} : { patientId }),
  }, bot.now);
  return invite.code;
}

async function enrol(chat = PATIENT): Promise<void> {
  await bot.send(chat, `/start ${await makeInvite()}`);
}

const SIMPLE = {
  version: 1,
  timezone: 'Asia/Dhaka',
  medicines: [
    { id: 'drops', name: 'Moxifloxacin eye drops', dose: '1 drop', schedule: { type: 'interval', every: '2h', anchor: 'wake' }, course: { days: 7 } },
  ],
};

async function importDoc(doc: unknown): Promise<void> {
  await bot.sendFile(PATIENT, 'prescription.json', JSON.stringify(doc));
  await bot.tap(PATIENT, /Apply|Confirm|Yes/i);
}

const noErrors = (): void => {
  const errors = bot.d1.rows("SELECT * FROM audit_log WHERE kind='webhook_error'");
  expect(errors, `threw: ${JSON.stringify(errors.slice(-1))}`).toHaveLength(0);
};

describe('things people actually send', () => {
  it('says what is wrong with a prescription it cannot use', async () => {
    await enrol();
    await bot.sendFile(PATIENT, 'p.json', JSON.stringify({
      version: 1, medicines: [{ id: 'x', name: 'Mystery', pattern: 'twice daily' }],
    }));
    expect(bot.last(PATIENT)).toMatch(/pattern/i);
    expect(bot.last(PATIENT), 'an error that names no fix is just a wall').toMatch(/1\+0\+1/);
    noErrors();
  });

  it('does not choke on a file that is not JSON at all', async () => {
    await enrol();
    bot.clear();
    await bot.sendFile(PATIENT, 'scan.pdf', '%PDF-1.4 binary rubbish here');
    expect(bot.sent.length, 'said nothing about a file it could not read').toBeGreaterThan(0);
    noErrors();
  });

  it('does not choke on a prescription with no medicines in it', async () => {
    await enrol();
    bot.clear();
    await bot.sendFile(PATIENT, 'p.json', JSON.stringify({ version: 1, medicines: [] }));
    expect(bot.sent.length).toBeGreaterThan(0);
    expect(bot.d1.rows('SELECT * FROM medications')).toHaveLength(0);
    noErrors();
  });

  it('answers ordinary chatter instead of ignoring it', async () => {
    await enrol();
    bot.clear();
    await bot.send(PATIENT, 'hello?');
    expect(bot.sent.length, 'a message into the void').toBeGreaterThan(0);
    noErrors();
  });

  it('takes a medicine name the way a person would type it', async () => {
    await enrol();
    await importDoc(SIMPLE);
    await bot.send(PATIENT, '/awake');
    await bot.run(10 * 60_000);
    bot.clear();
    await bot.send(PATIENT, '/took moxi');
    expect(bot.d1.rows("SELECT * FROM doses WHERE status='taken'").length, 'only exact names work').toBeGreaterThan(0);
  });

  it('says so, helpfully, when it does not recognise the medicine', async () => {
    await enrol();
    await importDoc(SIMPLE);
    bot.clear();
    await bot.send(PATIENT, '/took aspirin');
    expect(bot.last(PATIENT)).toMatch(/Moxifloxacin/);
    noErrors();
  });
});

describe('someone with nothing to take', () => {
  it('is never asked whether they are awake', async () => {
    // The caregiver half of a household often takes nothing at all. Polling them about a
    // day with no medicines in it is pure noise, and noise is what gets a bot muted.
    await enrol();
    bot.clear();
    await bot.run(26 * 3600_000, 10 * 60_000);
    const asked = bot.textsTo(PATIENT).filter((t) => /awake|bed/i.test(t));
    expect(asked, `asked ${asked.length} pointless questions`).toEqual([]);
  });

  it('starts asking once there is a prescription', async () => {
    await enrol();
    await importDoc(SIMPLE);
    await bot.send(PATIENT, '/sleep');
    await bot.tap(PATIENT, /turning in/i).catch(() => undefined);
    bot.clear();
    await bot.run(26 * 3600_000, 10 * 60_000);
    expect(bot.textsTo(PATIENT).join('\n')).toMatch(/wake up|awake|Moxifloxacin|morning/i);
  });
});

describe('the timezone nobody sets', () => {
  it('warns loudly when it still thinks you are in UTC', async () => {
    await enrol();
    bot.clear();
    await bot.sendFile(PATIENT, 'p.json', JSON.stringify({
      version: 1,
      medicines: [{ id: 'd', name: 'Drops', schedule: { type: 'interval', every: '2h' } }],
    }));
    await bot.tap(PATIENT, /Apply|Confirm|Yes/i);
    const all = bot.textsTo(PATIENT).join('\n');
    expect(all, 'imported with no timezone and said nothing').toMatch(/timezone|\/tz/i);
  });

  it('does not warn once the timezone is real', async () => {
    await enrol();
    await bot.send(PATIENT, '/tz Asia/Dhaka');
    bot.clear();
    await importDoc(SIMPLE);
    expect(bot.textsTo(PATIENT).join('\n')).not.toMatch(/still think you/i);
  });
});

describe('two people, one dose', () => {
  it('tells the caregiver when the patient goes quiet, and lets them answer', async () => {
    await enrol();
    await importDoc(SIMPLE);
    const patientId = Number(bot.d1.one('SELECT id FROM patients')?.['id']);
    await bot.send(CARER, `/caregiver ${await makeInvite('caregiver', patientId)}`);
    await bot.send(PATIENT, '/awake');
    bot.clear();

    await bot.run(20 * 60_000); // past the five-minute escalation
    expect(bot.textsTo(CARER).join('\n'), 'the backup never heard about it').toMatch(/Moxifloxacin/);

    await bot.tap(CARER, /Taken|✅/);
    expect(bot.d1.rows("SELECT * FROM doses WHERE status='taken'").length).toBeGreaterThan(0);
    expect(bot.textsTo(PATIENT).join('\n'), 'the patient was never told who answered').toMatch(/taken/i);
  });

  it('resolves a dose once, however many times it is tapped', async () => {
    await enrol();
    await importDoc(SIMPLE);
    await bot.send(PATIENT, '/awake');
    await bot.run(10 * 60_000);
    await bot.tap(PATIENT, /Taken|✅|Moxi/);
    const first = bot.d1.rows("SELECT * FROM doses WHERE status='taken'").length;
    await bot.tap(PATIENT, /Taken|✅|Moxi/).catch(() => undefined);
    expect(bot.d1.rows("SELECT * FROM doses WHERE status='taken'").length).toBe(first);
    expect(Number(bot.d1.one('SELECT doses_taken FROM medications')?.['doses_taken'])).toBe(1);
  });
});

describe('changing things without touching code', () => {
  it('changes how many times a day a medicine is taken', async () => {
    await enrol();
    await importDoc(SIMPLE);
    bot.clear();
    await bot.send(PATIENT, '/edit drops perday 3');
    expect(bot.sent.length).toBeGreaterThan(0);
    noErrors();
    const ms = Number(bot.d1.one('SELECT interval_ms FROM medications')?.['interval_ms']);
    expect(ms, 'three times a day is not still every two hours').not.toBe(2 * 3600_000);
  });

  it('survives importing a whole new prescription mid-course', async () => {
    await enrol();
    await importDoc(SIMPLE);
    await bot.send(PATIENT, '/awake');
    await bot.run(10 * 60_000);
    await bot.tap(PATIENT, /Taken|✅|Moxi/);

    await importDoc({
      version: 1, timezone: 'Asia/Dhaka',
      medicines: [
        { id: 'drops', name: 'Moxifloxacin eye drops', dose: '1 drop', schedule: { type: 'interval', every: '4h', anchor: 'wake' }, course: { days: 7 } },
        { id: 'new', name: 'Tab. Something', dose: '1 tablet', pattern: '1+0+1', course: { days: 5 } },
      ],
    });
    noErrors();
    expect(bot.d1.rows("SELECT * FROM medications WHERE status='active'")).toHaveLength(2);
    // Course progress survives a re-import, or every tweak restarts the week.
    expect(Number(bot.d1.one("SELECT doses_taken FROM medications WHERE med_key='drops'")?.['doses_taken'])).toBe(1);
  });

  it('stops a medicine that the new prescription drops, without deleting the record', async () => {
    await enrol();
    await importDoc(SIMPLE);
    await importDoc({ version: 1, timezone: 'Asia/Dhaka', medicines: [{ id: 'other', name: 'Something else', pattern: '1+0+1' }] });
    expect(Number(bot.d1.one("SELECT COUNT(*) c FROM medications WHERE status='discontinued'")?.['c'])).toBe(1);
  });
});

describe('messages that are too big for Telegram', () => {
  it('splits a long reply instead of dropping it', async () => {
    await enrol();
    const many = Array.from({ length: 40 }, (_, i) => ({
      id: `m${i}`, name: `A rather long medicine name number ${i} with detail`,
      dose: '1 tablet after food, with a glass of water',
      notes: 'Take at the same time each day and finish the course even if you feel better',
      pattern: '1+0+1', course: { days: 7 },
    }));
    await importDoc({ version: 1, timezone: 'Asia/Dhaka', medicines: many });
    bot.clear();
    await bot.send(PATIENT, '/meds');
    expect(bot.sent.length, 'a reply this long used to silently not arrive').toBeGreaterThan(1);
    for (const m of bot.sent) expect(m.text.length).toBeLessThanOrEqual(4096);
    noErrors();
  });
});
