import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { Bot } from './harness/bot.js';
import { MINUTE, zoneFor } from '../src/core/tz.js';

/**
 * What a caregiver can do by typing.
 *
 * Buttons always worked -- an escalated prompt carries the dose id with it. Typing did
 * not, and that is the half people fall back on once the notification has scrolled away.
 * `/took drops` from a caregiver resolved to their own empty record and answered "you
 * have no medicines loaded"; `/ate breakfast` was worse, and silently wrote a meal
 * against the wrong person.
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
  day: { morning_poll_at: '06:30', presumed_wake_at: '09:00', evening_poll_at: '22:30', presumed_sleep_at: '23:00' },
  meals: [{ id: 'breakfast', typical_local: '08:30' }, { id: 'lunch', typical_local: '13:30' }],
  medicines: [
    { id: 'drops', name: 'Moxifloxacin', dose: '1 drop', schedule: { type: 'interval', every: '3h', anchor: 'wake' }, course: { days: 7 } },
  ],
};

/** One patient with a prescription, one caregiver with nothing of their own. */
async function household(): Promise<number> {
  const { AdminDb } = await import('../src/io/adminDb.js');
  const admin = new AdminDb(bot.d1 as never);
  const enrol = await admin.createInvite('enrol', { createdBy: 'a', ttlMs: 86400_000 }, bot.now);
  await bot.send(PATIENT, `/start ${enrol.code}`, { firstName: 'Ifti' });
  await bot.sendFile(PATIENT, 'p.json', JSON.stringify(PRESCRIPTION));
  await bot.tap(PATIENT, /Apply|Confirm|Yes/i);

  const patientId = Number(bot.d1.one("SELECT id FROM patients WHERE display_name='Ifti'")?.['id']);
  const care = await admin.createInvite('caregiver', { createdBy: 'a', ttlMs: 86400_000, patientId }, bot.now);
  await bot.send(CARER, `/caregiver ${care.code}`, { firstName: 'Ashrafur' });
  await bot.send(PATIENT, '/awake');
  await bot.run(10 * MINUTE);
  return patientId;
}

const noErrors = (): void => {
  const errors = bot.d1.rows("SELECT * FROM audit_log WHERE kind='webhook_error'");
  expect(errors, `threw: ${JSON.stringify(errors.slice(-1))}`).toHaveLength(0);
};

describe('a caregiver typing on the patient’s behalf', () => {
  it('can log a dose', async () => {
    const patientId = await household();
    bot.clear();
    await bot.send(CARER, '/took drops');
    const taken = bot.d1.rows("SELECT * FROM doses WHERE status='taken'");
    expect(taken, 'the caregiver could not log a dose by typing').toHaveLength(1);
    expect(Number(taken[0]!['patient_id']), 'logged against the wrong person').toBe(patientId);
    expect(Number(taken[0]!['resolved_by_chat'])).toBe(CARER);
    noErrors();
  });

  it('can log a dose at a past time', async () => {
    await household();
    await bot.send(CARER, '/took drops 30m ago');
    const taken = bot.d1.rows("SELECT * FROM doses WHERE status='taken'");
    expect(taken).toHaveLength(1);
    expect(Number(taken[0]!['taken_at'])).toBeLessThan(bot.now - 20 * MINUTE);
  });

  it('records a meal against the patient, not themselves', async () => {
    const patientId = await household();
    await bot.send(CARER, '/ate breakfast');
    const meals = bot.d1.rows("SELECT * FROM meal_events WHERE source='confirmed'");
    expect(meals).toHaveLength(1);
    expect(Number(meals[0]!['patient_id']), 'wrote the meal against the caregiver').toBe(patientId);
  });

  it('can say when the patient is going to eat', async () => {
    const patientId = await household();
    await bot.send(CARER, '/eating lunch in 1h');
    const meals = bot.d1.rows("SELECT * FROM meal_events WHERE source='planned'");
    expect(meals.length).toBeGreaterThan(0);
    expect(Number(meals[0]!['patient_id'])).toBe(patientId);
  });

  it('can start and end the patient’s day', async () => {
    const patientId = await household();
    bot.now = at('22:30');
    await bot.send(CARER, '/sleep');
    expect(bot.d1.one(`SELECT wake_state FROM patients WHERE id=${patientId}`)?.['wake_state']).toBe('asleep');

    bot.now = at('08:00', 1);
    await bot.send(CARER, '/awake');
    expect(bot.d1.one(`SELECT wake_state FROM patients WHERE id=${patientId}`)?.['wake_state']).toBe('awake');
  });

  it('can skip and snooze', async () => {
    await household();
    await bot.send(CARER, '/snooze drops 20m');
    noErrors();
    await bot.send(CARER, '/skip drops');
    expect(bot.d1.rows("SELECT * FROM doses WHERE status='skipped'").length).toBeGreaterThan(0);
  });

  it('sees the patient’s medicines and log, not an empty list', async () => {
    await household();
    bot.clear();
    await bot.send(CARER, '/meds');
    expect(bot.last(CARER), '/meds showed the caregiver their own empty record').toContain('Moxifloxacin');
    await bot.send(CARER, '/took drops');
    bot.clear();
    await bot.send(CARER, '/log');
    expect(bot.last(CARER), '/log showed the caregiver their own empty record').toContain('Moxifloxacin');
  });

  it('tells the patient what was done for them', async () => {
    await household();
    bot.clear();
    await bot.send(CARER, '/ate breakfast', { firstName: 'Ashrafur' });
    expect(bot.textsTo(PATIENT).join('\n'), 'the patient was never told')
      .toMatch(/Ashrafur/);
  });

  it('says whose dose it just logged', async () => {
    await household();
    bot.clear();
    await bot.send(CARER, '/took drops');
    expect(bot.textsTo(CARER).join('\n')).toMatch(/Moxifloxacin/);
  });

  it('leaves the caregiver’s own record alone', async () => {
    await household();
    await bot.send(CARER, '/ate breakfast');
    await bot.send(CARER, '/took drops');
    const carerId = Number(bot.d1.one("SELECT id FROM patients WHERE display_name='Ashrafur'")?.['id']);
    expect(bot.d1.rows(`SELECT * FROM meal_events WHERE patient_id=${carerId}`)).toHaveLength(0);
    expect(bot.d1.rows(`SELECT * FROM doses WHERE patient_id=${carerId}`)).toHaveLength(0);
  });
});

describe('a caregiver with nothing of their own acts entirely for the patient', () => {
  it('changes settings and the timezone on the patient', async () => {
    const patientId = await household();
    await bot.send(CARER, '/settings morning 06:00');
    expect(bot.d1.one(`SELECT morning_poll_at FROM patients WHERE id=${patientId}`)?.['morning_poll_at']).toBe('06:00');
    await bot.send(CARER, '/tz Asia/Kolkata');
    expect(bot.d1.one(`SELECT tz FROM patients WHERE id=${patientId}`)?.['tz']).toBe('Asia/Kolkata');
  });

  it('edits, pauses and extends the patient’s medicines', async () => {
    const patientId = await household();
    await bot.send(CARER, '/extend drops 3d');
    expect(Number(bot.d1.one(`SELECT course_days FROM medications WHERE patient_id=${patientId}`)?.['course_days'])).toBe(10);
    await bot.send(CARER, '/pause drops');
    expect(bot.d1.one(`SELECT status FROM medications WHERE patient_id=${patientId}`)?.['status']).toBe('paused');
    noErrors();
  });

  it('imports a prescription for them, and says whose it is', async () => {
    const patientId = await household();
    bot.clear();
    await bot.sendFile(CARER, 'p.json', JSON.stringify({
      version: 1, timezone: 'Asia/Dhaka',
      medicines: [{ id: 'new', name: 'Tab. Something New', pattern: '1+0+1', course: { days: 5 } }],
    }));
    expect(bot.last(CARER), 'gave no hint whose prescription this would become').toMatch(/for <b>Ifti/);
    await bot.tap(CARER, /Apply|Confirm|Yes/i);
    expect(bot.d1.rows(`SELECT * FROM medications WHERE patient_id=${patientId} AND med_key='new'`)).toHaveLength(1);
    const carerId = Number(bot.d1.one("SELECT id FROM patients WHERE display_name='Ashrafur'")?.['id']);
    expect(bot.d1.rows(`SELECT * FROM medications WHERE patient_id=${carerId}`)).toHaveLength(0);
  });

  it('still renames itself, not the patient', async () => {
    const patientId = await household();
    await bot.send(CARER, '/name Ash');
    expect(bot.d1.one(`SELECT display_name FROM patients WHERE id=${patientId}`)?.['display_name']).toBe('Ifti');
    expect(bot.d1.one("SELECT id FROM patients WHERE display_name='Ash'"), 'renamed the wrong person').not.toBeNull();
  });

  it('exports the patient’s prescription, not an empty one', async () => {
    await household();
    bot.clear();
    await bot.send(CARER, '/export');
    expect(bot.last(CARER)).toContain('Moxifloxacin');
  });
});

describe('someone who is both a patient and a caregiver', () => {
  /** Two people, each on their own prescription, each backing up the other. */
  async function both(): Promise<{ a: number; b: number }> {
    const { AdminDb } = await import('../src/io/adminDb.js');
    const admin = new AdminDb(bot.d1 as never);
    for (const [chat, name] of [[PATIENT, 'Ifti'], [CARER, 'Ashrafur']] as const) {
      const inv = await admin.createInvite('enrol', { createdBy: 'a', ttlMs: 86400_000 }, bot.now);
      await bot.send(chat, `/start ${inv.code}`, { firstName: name });
      await bot.sendFile(chat, 'p.json', JSON.stringify(PRESCRIPTION));
      await bot.tap(chat, /Apply|Confirm|Yes/i);
    }
    const a = Number(bot.d1.one("SELECT id FROM patients WHERE display_name='Ifti'")?.['id']);
    const b = Number(bot.d1.one("SELECT id FROM patients WHERE display_name='Ashrafur'")?.['id']);
    const care = await admin.createInvite('caregiver', { createdBy: 'a', ttlMs: 86400_000, patientId: a }, bot.now);
    await bot.send(CARER, `/caregiver ${care.code}`);
    await bot.send(PATIENT, '/awake');
    await bot.send(CARER, '/awake');
    await bot.run(10 * MINUTE);
    return { a, b };
  }

  it('defaults to their own medicines', async () => {
    const { b } = await both();
    await bot.send(CARER, '/took drops');
    const taken = bot.d1.rows("SELECT * FROM doses WHERE status='taken'");
    expect(taken).toHaveLength(1);
    expect(Number(taken[0]!['patient_id']), 'answered for someone else by default').toBe(b);
  });

  it('acts for the other person when asked by name', async () => {
    const { a } = await both();
    await bot.send(CARER, '/took drops for Ifti');
    const taken = bot.d1.rows("SELECT * FROM doses WHERE status='taken'");
    expect(taken).toHaveLength(1);
    expect(Number(taken[0]!['patient_id'])).toBe(a);
  });

  it('asks rather than guessing when the name means nobody', async () => {
    await both();
    bot.clear();
    await bot.send(CARER, '/took drops for Nobody');
    expect(bot.last(CARER)).toMatch(/more than one|who is/i);
    expect(bot.d1.rows("SELECT * FROM doses WHERE status='taken'"), 'guessed anyway').toHaveLength(0);
  });
});
