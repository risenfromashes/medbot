import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { Bot } from './harness/bot.js';
import { zoneFor } from '../src/core/tz.js';

/**
 * Two things that went wrong in the same evening of real use.
 *
 * Breakfast, lunch and dinner disappeared from /status -- not because meals stopped being
 * tracked, but because the last meal-anchored medicine had been stopped and the block was
 * gated on one existing. And the caregiver was never told a meal had happened, because
 * the only announcement path bailed out when the patient recorded it themselves, which is
 * the usual case.
 */

const z = zoneFor('Asia/Dhaka');
const at = (hhmm: string, day = 0): number => z.wallOnDayUtc(z.addLocalDays('2026-09-14', day), hhmm);
const PATIENT = 5000;
const CARER = 6000;

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
  patient: 'Ifti',
  day: { morning_poll_at: '06:30', presumed_wake_at: '09:00', evening_poll_at: '22:30', presumed_sleep_at: '23:00' },
  meals: [
    { id: 'breakfast', typical_local: '08:30' },
    { id: 'lunch', typical_local: '13:30' },
    { id: 'dinner', typical_local: '20:30' },
  ],
  medicines: [
    { id: 'drops', name: 'Moxifloxacin', dose: '1 drop', schedule: { type: 'interval', every: '4h', anchor: 'wake' }, course: { days: 7 } },
    { id: 'flexi', name: 'Tab. Flexi 100', dose: '1 tablet', pattern: '1+0+1', course: { days: 3 } },
  ],
};

async function makeInvite(kind: 'enrol' | 'caregiver', patientId?: number): Promise<string> {
  const { AdminDb } = await import('../src/io/adminDb.js');
  const admin = new AdminDb(bot.d1 as never);
  const inv = await admin.createInvite(kind, {
    createdBy: 'a', ttlMs: 86400_000,
    ...(patientId === undefined ? {} : { patientId }),
  }, bot.now);
  return inv.code;
}

async function setUp(): Promise<void> {
  await bot.send(PATIENT, `/start ${await makeInvite('enrol')}`, { firstName: 'Ifti' });
  await bot.sendFile(PATIENT, 'p.json', JSON.stringify(PRESCRIPTION));
  await bot.tap(PATIENT, /Apply|Confirm|Yes/i);
  const patientId = Number(bot.d1.one('SELECT id FROM patients')?.['id']);
  await bot.send(CARER, `/caregiver ${await makeInvite('caregiver', patientId)}`, { firstName: 'Ashraf' });
  await bot.send(PATIENT, '/awake');
}

describe('the meals block in /status', () => {
  it('lists the meals even when nothing is anchored to one', async () => {
    await setUp();
    // The only meal-anchored medicine goes away -- which is what happened live.
    await bot.send(PATIENT, '/stop flexi');
    bot.clear();
    await bot.send(PATIENT, '/status');
    const text = bot.last(PATIENT);
    expect(text, 'the meals vanished with the last medicine that used them').toMatch(/Meals/);
    for (const meal of ['breakfast', 'lunch', 'dinner']) expect(text).toMatch(new RegExp(meal, 'i'));
  });

  it('still lists them once a meal has been recorded', async () => {
    await setUp();
    await bot.send(PATIENT, '/stop flexi');
    await bot.send(PATIENT, '/ate breakfast');
    bot.clear();
    await bot.send(PATIENT, '/status');
    expect(bot.last(PATIENT)).toMatch(/✅ breakfast/);
  });
});

describe('telling the household about a meal', () => {
  it('tells the caregiver when the patient records their own meal', async () => {
    await setUp();
    bot.clear();
    await bot.send(PATIENT, '/ate lunch');
    const heard = bot.textsTo(CARER).join('\n');
    expect(heard, 'the caregiver was never told lunch happened').toMatch(/lunch/i);
    expect(heard, 'phrased at the caregiver as if it were their own meal').not.toMatch(/your lunch/i);
  });

  it('tells the caregiver when the patient taps the meal button', async () => {
    await setUp();
    // Run until the bot actually asks about a meal, rather than hoping a fixed window
    // contains one.
    for (let i = 0; i < 6 * 60 && !bot.sent.some((m) => m.chatId === PATIENT && /Eating now/.test(JSON.stringify(m.buttons))); i++) {
      await bot.tick();
      bot.now += 10 * 60_000;
    }
    const before = bot.textsTo(CARER).length;
    await bot.tap(PATIENT, 'Eating now');
    const heard = bot.textsTo(CARER).slice(before).join('\n');
    expect(heard, 'the caregiver heard nothing when the meal button was tapped').toMatch(/breakfast|lunch|dinner/i);
    expect(heard).toMatch(/Ifti/);
  });

  it('does not tell the person who recorded it twice', async () => {
    await setUp();
    bot.clear();
    await bot.send(PATIENT, '/ate dinner');
    const mine = bot.textsTo(PATIENT).filter((t) => /dinner/i.test(t));
    expect(mine, 'the patient got the confirmation and the broadcast').toHaveLength(1);
  });
});

describe('stopping a medicine leaves a trail', () => {
  it('writes an audit row and says how to undo it', async () => {
    await setUp();
    bot.clear();
    await bot.send(PATIENT, '/stop flexi');
    expect(bot.last(PATIENT)).toMatch(/\/resume flexi/);
    const rows = bot.d1.rows("SELECT * FROM audit_log WHERE kind='med_status_set'");
    expect(rows, 'a medicine stopped with nothing in the log').toHaveLength(1);
    expect(String(rows[0]!['detail_json'])).toMatch(/"to":"discontinued"/);
  });

  it('tells the caregiver that a medicine has been stopped', async () => {
    await setUp();
    bot.clear();
    await bot.send(PATIENT, '/stop flexi');
    expect(bot.textsTo(CARER).join('\n'), 'a medicine went silent and only one person knew')
      .toMatch(/Flexi/i);
  });

  it('says so rather than re-stopping an already stopped medicine', async () => {
    await setUp();
    await bot.send(PATIENT, '/stop flexi');
    bot.clear();
    await bot.send(PATIENT, '/stop flexi');
    expect(bot.last(PATIENT)).toMatch(/already stopped/i);
    expect(bot.d1.rows("SELECT * FROM audit_log WHERE kind='med_status_set'")).toHaveLength(1);
  });

  it('says on /status that a course was stopped part-way', async () => {
    await setUp();
    await bot.send(PATIENT, '/stop flexi');
    bot.clear();
    await bot.send(PATIENT, '/status');
    const text = bot.last(PATIENT);
    expect(text, 'a medicine went quiet mid-course and /status said nothing')
      .toMatch(/Stopped before the course finished/);
    expect(text).toMatch(/\/resume flexi/);
  });

  it('stops saying so once the medicine is back', async () => {
    await setUp();
    await bot.send(PATIENT, '/stop flexi');
    await bot.send(PATIENT, '/resume flexi');
    bot.clear();
    await bot.send(PATIENT, '/status');
    expect(bot.last(PATIENT)).not.toMatch(/Stopped before the course finished/);
  });

  it('brings it back with /resume', async () => {
    await setUp();
    await bot.send(PATIENT, '/stop flexi');
    await bot.send(PATIENT, '/resume flexi');
    expect(Number(bot.d1.one("SELECT COUNT(*) c FROM medications WHERE med_key='flexi' AND status='active'")?.['c'])).toBe(1);
  });
});

describe('/log', () => {
  it('lists the doses themselves, newest first', async () => {
    await setUp();
    await bot.run(30 * 60_000);
    await bot.tap(PATIENT, /Taken|✅ Mox/);
    bot.clear();
    await bot.send(PATIENT, '/log');
    const text = bot.last(PATIENT);
    expect(text, 'still a report card rather than a log').not.toMatch(/%/);
    expect(text).toMatch(/Today/);
    expect(text, 'no dose in the log at all').toMatch(/✅ .*Moxifloxacin/);
  });

  it('counts what happened without grading it', async () => {
    await setUp();
    await bot.run(30 * 60_000);
    await bot.tap(PATIENT, /Taken|✅ Mox/);
    bot.clear();
    await bot.send(PATIENT, '/log');
    expect(bot.last(PATIENT)).toMatch(/1 taken/);
  });

  it('says so plainly when nothing has been logged', async () => {
    await setUp();
    bot.clear();
    await bot.send(PATIENT, '/log');
    expect(bot.last(PATIENT)).toMatch(/Nothing logged/);
  });

  it('marks a skipped dose as skipped rather than dropping it', async () => {
    await setUp();
    await bot.run(30 * 60_000);
    await bot.tap(PATIENT, /Skip|⏭/);
    bot.clear();
    await bot.send(PATIENT, '/log');
    expect(bot.last(PATIENT)).toMatch(/⏭/);
  });
});

describe('meal questions do not depend on a medicine needing them', () => {
  it('still asks about meals once every meal-anchored medicine is stopped', async () => {
    await setUp();
    await bot.send(PATIENT, '/stop flexi');
    bot.clear();
    await bot.run(14 * 3600_000, 10 * 60_000);
    const asked = bot.textsTo(PATIENT).filter((t) => /breakfast|lunch|dinner/i.test(t));
    expect(asked.length, 'meal tracking stopped with the last medicine that used it')
      .toBeGreaterThan(0);
  });
});
