import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { Bot } from './harness/bot.js';
import { zoneFor } from '../src/core/tz.js';

/**
 * Setting this up for the first time is the part that keeps going wrong.
 *
 * Not the scheduling maths -- that has a simulator. The bugs that reached real people
 * were all in the first twenty minutes: a prescription that would not import, a command
 * that existed but was not in the menu, a name nobody could change, a day that started at
 * five in the morning. So this drives the actual bot, from /start, the way a person does.
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

/** The join code an admin hands out, created the way the dashboard creates it. */
async function makeInvite(kind: 'enrol' | 'caregiver' = 'enrol', patientId?: number): Promise<string> {
  const { AdminDb } = await import('../src/io/adminDb.js');
  const admin = new AdminDb(bot.d1 as never);
  const invite = await admin.createInvite(kind, {
    createdBy: 'admin',
    ttlMs: 24 * 3600_000,
    ...(patientId === undefined ? {} : { patientId }),
  }, bot.now);
  return invite.code;
}

const PRESCRIPTION = {
  version: 1,
  patient: 'Ayesha',
  timezone: 'Asia/Dhaka',
  day: { morning_poll_at: '06:30', presumed_wake_at: '09:00', evening_poll_at: '22:30', presumed_sleep_at: '01:00' },
  meals: [
    { id: 'breakfast', typical_local: '08:30' },
    { id: 'lunch', typical_local: '13:30' },
    { id: 'dinner', typical_local: '20:30' },
  ],
  groups: [{ id: 'drops', spacing: '10m' }],
  medicines: [
    {
      id: 'moxi', name: 'Moxifloxacin 0.5%', dose: '1 drop, right eye',
      schedule: { type: 'interval', every: '2h', anchor: 'wake' },
      group: 'drops', group_seq: 1, course: { days: 7 },
    },
    {
      id: 'pred', name: 'Prednisolone & Co', dose: '1 drop',
      schedule: { type: 'times_per_day', n: 4 },
      group: 'drops', group_seq: 2, course: { days: 7 },
    },
    { id: 'ceevit', name: 'Tab. Ceevit 250', dose: '1 tablet', pattern: '1+1+1+1', course: { days: 7 } },
    { id: 'maxpro', name: 'Cap. Maxpro 20', dose: '1 capsule', pattern: '1+0+1', relation: 'before', course: { days: 14 } },
  ],
};

async function enrol(): Promise<void> {
  const code = await makeInvite();
  await bot.send(PATIENT, `/start ${code}`);
}

async function importPrescription(doc: unknown = PRESCRIPTION): Promise<void> {
  await bot.sendFile(PATIENT, 'prescription.json', JSON.stringify(doc));
  await bot.tap(PATIENT, /Apply|Confirm|Yes/i);
}

describe('the first twenty minutes', () => {
  it('enrols someone with a join code', async () => {
    await enrol();
    expect(bot.last(PATIENT)).toMatch(/Hello/);
    expect(bot.d1.rows('SELECT * FROM patients')).toHaveLength(1);
    expect(bot.d1.rows("SELECT * FROM chats WHERE role='patient'")).toHaveLength(1);
  });

  it('refuses a made-up code without creating anything', async () => {
    await bot.send(PATIENT, '/start NOPE-NOPE');
    expect(bot.d1.rows('SELECT * FROM patients')).toHaveLength(0);
    expect(bot.last(PATIENT)).not.toMatch(/Hello/);
  });

  it('imports a prescription sent as a file, with no command', async () => {
    await enrol();
    await bot.sendFile(PATIENT, 'prescription.json', JSON.stringify(PRESCRIPTION));
    // The preview must name every medicine before anything is applied.
    expect(bot.last(PATIENT)).toContain('Moxifloxacin');
    expect(bot.last(PATIENT)).toContain('Ceevit');
    expect(bot.d1.rows('SELECT * FROM medications')).toHaveLength(0);

    await bot.tap(PATIENT, /Apply|Confirm|Yes/i);
    expect(bot.d1.rows('SELECT * FROM medications')).toHaveLength(4);
  });

  it('takes the timezone from the prescription', async () => {
    await enrol();
    await importPrescription();
    expect(bot.d1.one('SELECT tz FROM patients')?.['tz']).toBe('Asia/Dhaka');
  });

  it('escapes a medicine name that would otherwise break the message', async () => {
    // "Prednisolone & Co" is not exotic -- an ampersand in a name is enough for Telegram
    // to reject the entire message, which means the reminder never arrives at all.
    await enrol();
    await importPrescription();
    for (const m of bot.sent) {
      expect(m.text, `raw ampersand in: ${m.text.slice(0, 80)}`).not.toMatch(/&(?!amp;|lt;|gt;|quot;|#)/);
    }
  });

  it('lets someone change what the bot calls them', async () => {
    await enrol();
    bot.clear();
    await bot.send(PATIENT, '/name Ayesha');
    expect(bot.last(PATIENT)).toContain('Ayesha');
    expect(bot.d1.one('SELECT display_name FROM patients')?.['display_name']).toBe('Ayesha');
  });

  it('publishes its command menu on the way in', async () => {
    await enrol();
    await bot.tick();
    const menu = bot.calls.filter((c) => c.method === 'setMyCommands');
    expect(menu.length, 'never told Telegram what it can do').toBeGreaterThan(0);
    const names = (menu[0]!.body['commands'] as Array<{ command: string }>).map((c) => c.command);
    expect(names).toContain('prompt');
    expect(names).toContain('name');
  });

  it('answers every command it publishes without falling over', async () => {
    await enrol();
    await importPrescription();
    const { COMMANDS } = await import('../src/handlers/commands.js');
    for (const c of COMMANDS) {
      bot.clear();
      await bot.send(PATIENT, `/${c.command}`);
      const errors = bot.d1.rows("SELECT * FROM audit_log WHERE kind='webhook_error'");
      expect(errors, `/${c.command} threw: ${JSON.stringify(errors.slice(-1))}`).toHaveLength(0);
      expect(bot.sent.length, `/${c.command} said nothing at all`).toBeGreaterThan(0);
    }
  });

  it('answers every command before anything is set up', async () => {
    // Someone will always type /status first. None of it may throw, and none of it may
    // leave them staring at silence.
    const { COMMANDS } = await import('../src/handlers/commands.js');
    for (const c of COMMANDS) {
      bot.clear();
      await bot.send(PATIENT, `/${c.command}`);
      const errors = bot.d1.rows("SELECT * FROM audit_log WHERE kind='webhook_error'");
      expect(errors, `/${c.command} threw before setup`).toHaveLength(0);
      expect(bot.sent.length, `/${c.command} said nothing before setup`).toBeGreaterThan(0);
    }
  });

  it('says something useful when the JSON is broken', async () => {
    await enrol();
    await bot.sendFile(PATIENT, 'prescription.json', '{"version":1,"medicines":[{"id":"x"');
    expect(bot.last(PATIENT)).toMatch(/stops part-way|couldn't|could not|cut off|incomplete/i);
    expect(bot.d1.rows('SELECT * FROM medications')).toHaveLength(0);
  });

  it('stitches a prescription split across two pasted messages', async () => {
    await enrol();
    const json = JSON.stringify(PRESCRIPTION, null, 2);
    const cut = Math.floor(json.length / 2);
    await bot.send(PATIENT, json.slice(0, cut));
    expect(bot.last(PATIENT), 'did not notice the paste was cut short').toMatch(/rest|more|cut|second|continue|waiting/i);
    await bot.send(PATIENT, json.slice(cut));
    await bot.tap(PATIENT, /Apply|Confirm|Yes/i);
    expect(bot.d1.rows('SELECT * FROM medications')).toHaveLength(4);
  });

  it('never lets a command go unanswered, even when it fails', async () => {
    await enrol();
    bot.clear();
    await bot.send(PATIENT, '/took nothing-by-this-name');
    expect(bot.sent.length, 'silence is the one unacceptable answer').toBeGreaterThan(0);
  });

  it('takes a caregiver on, and lets them go again', async () => {
    await enrol();
    const patientId = Number(bot.d1.one('SELECT id FROM patients')?.['id']);
    const code = await makeInvite('caregiver', patientId);
    await bot.send(CARER, `/caregiver ${code}`);
    expect(bot.d1.rows("SELECT * FROM chats WHERE role='caregiver'")).toHaveLength(1);

    await bot.send(CARER, '/leave');
    await bot.tap(CARER, /Stop|Yes|Leave/i).catch(() => undefined);
    const still = bot.d1.rows("SELECT * FROM chats WHERE role='caregiver' AND active=1");
    expect(still, 'a caregiver who cannot leave will mute the bot instead').toHaveLength(0);
  });

  it('will not let anyone become their own backup', async () => {
    await enrol();
    const patientId = Number(bot.d1.one('SELECT id FROM patients')?.['id']);
    const code = await makeInvite('caregiver', patientId);
    bot.clear();
    await bot.send(PATIENT, `/caregiver ${code}`);
    expect(bot.d1.rows("SELECT * FROM chats WHERE role='caregiver'")).toHaveLength(0);
    // And the single-use code must survive being refused.
    expect(bot.d1.one('SELECT used_at FROM invites WHERE code = ?')?.['used_at'] ?? null).toBeNull();
  });
});

describe('a day, end to end', () => {
  it('starts the day when the patient says they are up, not before', async () => {
    await enrol();
    await importPrescription();
    await bot.send(PATIENT, '/sleep');
    bot.clear();

    await bot.run(3 * 3600_000); // through the small hours
    expect(bot.sent, 'woke the patient up').toHaveLength(0);

    await bot.send(PATIENT, '/awake');
    await bot.run(20 * 60_000);
    const texts = bot.textsTo(PATIENT).join('\n');
    expect(texts, 'nothing was offered after waking').toMatch(/Moxifloxacin/);
  });

  it('records a dose when the patient taps the button', async () => {
    await enrol();
    await importPrescription();
    await bot.send(PATIENT, '/awake');
    await bot.run(15 * 60_000);
    await bot.tap(PATIENT, /Moxi|Taken|✅/);
    const taken = bot.d1.rows("SELECT * FROM doses WHERE status='taken'");
    expect(taken.length).toBeGreaterThan(0);
  });

  it('lets a mistaken tap be undone', async () => {
    await enrol();
    await importPrescription();
    await bot.send(PATIENT, '/awake');
    await bot.run(15 * 60_000);
    await bot.tap(PATIENT, /Moxi|Taken|✅/);
    expect(bot.d1.rows("SELECT * FROM doses WHERE status='taken'").length).toBeGreaterThan(0);

    bot.clear();
    await bot.send(PATIENT, '/undo');
    expect(bot.d1.rows("SELECT * FROM doses WHERE status='taken'")).toHaveLength(0);
  });
});
