import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { Bot } from './harness/bot.js';
import { HOUR, MINUTE, zoneFor } from '../src/core/tz.js';

/**
 * The sleep-wake cycle, driven the way a person drives it.
 *
 * The configured times are a reference and nothing more. Bedtime is negotiated -- asked
 * about twice, movable as often as the patient likes -- and waking is never assumed at
 * all: the bot asks, and keeps asking, until somebody tells it.
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
  medicines: [
    { id: 'ceevit', name: 'Ceevit', dose: '1 tablet', schedule: { type: 'times_per_day', n: 4 }, course: { days: 7 } },
  ],
};

async function setUp(opts: { carer?: boolean } = {}): Promise<number> {
  const { AdminDb } = await import('../src/io/adminDb.js');
  const admin = new AdminDb(bot.d1 as never);
  const inv = await admin.createInvite('enrol', { createdBy: 'a', ttlMs: 86400_000 }, bot.now);
  await bot.send(PATIENT, `/start ${inv.code}`, { firstName: 'Ifti' });
  await bot.sendFile(PATIENT, 'p.json', JSON.stringify(PRESCRIPTION));
  await bot.tap(PATIENT, /Apply|Confirm|Yes/i);
  const id = Number(bot.d1.one('SELECT id FROM patients')?.['id']);
  if (opts.carer === true) {
    const care = await admin.createInvite('caregiver', { createdBy: 'a', ttlMs: 86400_000, patientId: id }, bot.now);
    await bot.send(CARER, `/caregiver ${care.code}`, { firstName: 'Ashrafur' });
  }
  await bot.send(PATIENT, '/awake');
  return id;
}

/** A tick that throws is recorded and swallowed, so every test here checks for one. */
function noErrors(): void {
  const errors = bot.d1.rows("SELECT * FROM audit_log WHERE kind IN ('tick_error','webhook_error')");
  expect(errors, `something threw: ${JSON.stringify(errors.slice(0, 1))}`).toHaveLength(0);
}

const patientRow = (): Record<string, unknown> => bot.d1.one('SELECT * FROM patients')!;
const expectedBed = (): number | null => {
  const v = patientRow()['expected_sleep_at'];
  return v === null || v === undefined ? null : Number(v);
};

describe('the evening is a negotiation', () => {
  it('asks an hour before the expected bedtime, and again half an hour before', async () => {
    await setUp();
    bot.clear();
    await bot.run(14 * HOUR, 5 * MINUTE); // 09:00 -> 23:00

    noErrors();
    const asks = bot.textsTo(PATIENT).filter((t) => /still turning in/i.test(t));
    expect(asks.length, 'never asked about bedtime').toBeGreaterThanOrEqual(2);
    expect(asks[0]).toContain('11:00pm');
  });

  it('names what is still to be taken before bed', async () => {
    await setUp();
    bot.now = at('21:55');
    await bot.run(15 * MINUTE, 5 * MINUTE);
    const ask = bot.textsTo(PATIENT).find((t) => /still turning in/i.test(t));
    expect(ask, 'no bedtime question at all').toBeDefined();
    expect(ask, 'asked about bed without saying what was still due').toMatch(/Before you turn in|Ceevit/);
  });

  it('moves bedtime when the patient says +1 hour, and asks again against the new time', async () => {
    await setUp();
    bot.now = at('21:55');
    await bot.run(15 * MINUTE, 5 * MINUTE);
    await bot.tap(PATIENT, /\+1 hour/);
    expect(expectedBed(), 'bedtime did not move').toBe(at('00:00', 1));

    bot.clear();
    await bot.run(90 * MINUTE, 5 * MINUTE); // through 23:00 and 23:30
    const asks = bot.textsTo(PATIENT).filter((t) => /still turning in/i.test(t));
    expect(asks.length, 'did not ask again against the new bedtime').toBeGreaterThan(0);
    expect(asks[0]).toContain('12:00am');
    // And it did not call it a night at the original hour.
    expect(patientRow()['wake_state']).toBe('awake');
  });

  it('can be postponed again and again', async () => {
    await setUp();
    bot.now = at('21:55');
    await bot.run(15 * MINUTE, 5 * MINUTE);
    await bot.tap(PATIENT, /\+1 hour/);
    await bot.run(70 * MINUTE, 5 * MINUTE);
    await bot.tap(PATIENT, /\+1 hour/);
    expect(expectedBed()).toBe(at('01:00', 1));
    expect(patientRow()['wake_state']).toBe('awake');
  });

  it('goes to sleep on the spot when asked to', async () => {
    await setUp();
    bot.now = at('21:55');
    await bot.run(15 * MINUTE, 5 * MINUTE);
    await bot.tap(PATIENT, /Going to sleep now/);
    expect(patientRow()['wake_state']).toBe('asleep');
  });

  it('takes the expected bedtime as the sleep time when nobody answers', async () => {
    await setUp();
    await bot.run(14 * HOUR + 10 * MINUTE, 5 * MINUTE); // past 23:00, answering nothing
    expect(patientRow()['wake_state']).toBe('asleep');
  });

  it('keeps chasing an outstanding dose through the grace hour', async () => {
    await setUp();
    // Answer everything until the evening, then leave the last dose of the day hanging.
    const { encodeCallback } = await import('../src/core/callbackCodec.js');
    while (bot.now < at('21:00')) {
      await bot.tick();
      for (const r of bot.d1.rows("SELECT id FROM doses WHERE status IN ('due','prompted')")) {
        await bot.sendCallback(PATIENT, encodeCallback({ a: 'take', doseId: Number(r['id']) }));
      }
      bot.now += 5 * MINUTE;
    }
    await bot.run(2 * HOUR, 5 * MINUTE); // to 23:00, answering nothing
    const outstanding = bot.d1.rows("SELECT * FROM doses WHERE status IN ('due','prompted')");
    if (outstanding.length === 0) return; // the day's count was met; nothing to chase

    await bot.send(PATIENT, '/sleep');
    await bot.tap(PATIENT, /Leave them for morning/i).catch(() => undefined);
    expect(patientRow()['wake_state']).toBe('asleep');

    bot.clear();
    await bot.run(40 * MINUTE, 5 * MINUTE);
    expect(
      bot.textsTo(PATIENT).some((t) => /Ceevit/.test(t)),
      'went silent on an unresolved medicine the moment bedtime arrived',
    ).toBe(true);
  });

  it('stops chasing once the grace hour is up', async () => {
    await setUp();
    await bot.run(14 * HOUR + 15 * MINUTE, 5 * MINUTE);
    expect(patientRow()['wake_state']).toBe('asleep');
    bot.now = at('00:30', 1);
    bot.clear();
    await bot.run(3 * HOUR, 10 * MINUTE);
    expect(bot.textsTo(PATIENT), 'still nagging in the small hours').toEqual([]);
  });

  it('brings forward a dose that would otherwise fall after bedtime', async () => {
    const id = await setUp();
    await bot.run(14 * HOUR, 5 * MINUTE);
    const late = bot.d1.rows(
      `SELECT effective_due_at FROM doses WHERE patient_id = ${id} AND effective_due_at > ${at('23:00')}`,
    );
    expect(late, 'a dose was scheduled past the expected bedtime').toHaveLength(0);
  });
});

describe('waking is never assumed', () => {
  async function asleepSince(hhmm: string): Promise<number> {
    const id = await setUp();
    bot.now = at(hhmm);
    // Clear the decks first: an outstanding dose is deliberately chased into the grace
    // hour, and these tests are about the night rather than that.
    const { encodeCallback } = await import('../src/core/callbackCodec.js');
    for (const r of bot.d1.rows("SELECT id FROM doses WHERE status IN ('due','prompted')")) {
      await bot.sendCallback(PATIENT, encodeCallback({ a: 'take', doseId: Number(r['id']) }));
    }
    await bot.send(PATIENT, '/sleep');
    await bot.tap(PATIENT, /turning in for the night/i).catch(() => undefined);
    await bot.tap(PATIENT, /Leave them|I took them/i).catch(() => undefined);
    expect(patientRow()['wake_state']).toBe('asleep');
    return id;
  }

  it('says nothing through the minimum sleep', async () => {
    await asleepSince('23:00');
    bot.clear();
    await bot.run(3 * HOUR, 10 * MINUTE);
    // The day's summary may still land; what must not is anything asking for something.
    const asking = bot.sent.filter((m) => m.chatId === PATIENT && m.buttons.length > 0);
    expect(asking.map((m) => m.text), 'asked the patient something inside the minimum night').toEqual([]);
  });

  it('asks whether they are up, and keeps asking', async () => {
    await asleepSince('23:00');
    bot.clear();
    await bot.run(10 * HOUR, 10 * MINUTE);
    const asks = bot.textsTo(PATIENT).filter((t) => /wake up|when you got up/i.test(t));
    expect(asks.length, 'asked once and gave up').toBeGreaterThan(1);
    expect(patientRow()['wake_state'], 'decided they were up without being told').toBe('asleep');
  });

  it('tells the caregiver when the question goes unanswered', async () => {
    await setUp({ carer: true });
    bot.now = at('23:00');
    await bot.send(PATIENT, '/sleep');
    bot.clear();
    await bot.run(10 * HOUR, 10 * MINUTE);
    expect(
      bot.textsTo(CARER).some((t) => /up|awake/i.test(t)),
      'nobody was told she had not surfaced',
    ).toBe(true);
  });

  it('starts the day from now when they say "just now"', async () => {
    await asleepSince('23:00');
    bot.now = at('08:00', 1);
    await bot.run(30 * MINUTE, 5 * MINUTE);
    await bot.tap(PATIENT, /just now/i);
    expect(patientRow()['wake_state']).toBe('awake');
    expect(Number(patientRow()['last_wake_at'])).toBeGreaterThanOrEqual(at('08:00', 1));
  });

  it('asks when, if they woke earlier, and starts the day from then', async () => {
    await asleepSince('23:00');
    bot.now = at('11:00', 1);
    await bot.run(30 * MINUTE, 5 * MINUTE);
    await bot.tap(PATIENT, /woke up earlier/i);
    expect(bot.last(PATIENT), 'did not ask when').toMatch(/when did you get up/i);

    await bot.tap(PATIENT, /3h ago|180/);
    expect(patientRow()['wake_state']).toBe('awake');
    const woke = Number(patientRow()['last_wake_at']);
    expect(woke).toBeLessThanOrEqual(at('08:45', 1));
    expect(woke).toBeGreaterThanOrEqual(at('08:15', 1));
  });

  it('offers back the doses that were due while nobody was logging', async () => {
    await asleepSince('23:00');
    bot.now = at('11:00', 1);
    await bot.run(30 * MINUTE, 5 * MINUTE);
    await bot.tap(PATIENT, /woke up earlier/i);
    const mark = bot.sent.length;
    await bot.tap(PATIENT, /3h ago|180/);

    const text = bot.sent.slice(mark).filter((m) => m.chatId === PATIENT).map((m) => m.text).join('\n');
    expect(text, 'said nothing about the three hours it missed').toMatch(/while you were up/i);
    expect(bot.d1.rows("SELECT * FROM doses WHERE status='missed'").length, 'reconstructed nothing')
      .toBeGreaterThan(0);

    // And "actually I took that" puts it right.
    await bot.tap(PATIENT, /Took Ceevit/i);
    expect(bot.d1.rows("SELECT * FROM doses WHERE status='taken'").length).toBeGreaterThan(0);
  });

  it('goes back to sleep for another hour when asked', async () => {
    await asleepSince('23:00');
    bot.now = at('08:00', 1);
    await bot.run(30 * MINUTE, 5 * MINUTE);
    await bot.tap(PATIENT, /\+1 hour/);
    expect(patientRow()['wake_state']).toBe('asleep');
    expect(Number(patientRow()['expected_wake_at'])).toBeGreaterThanOrEqual(at('09:00', 1));

    bot.clear();
    await bot.run(45 * MINUTE, 5 * MINUTE);
    expect(bot.textsTo(PATIENT), 'carried on asking after being told to wait').toEqual([]);
  });
});

/**
 * Two drops, ten minutes apart, both reminders sitting in the chat at once.
 *
 * Answering the first pushes the second back -- it always did, silently. Silently is the
 * problem: the second reminder sits there looking overdue, and the obvious thing to do
 * with an overdue reminder is tap it.
 */
describe('drops that have to be spaced', () => {
  const SPACED = {
    version: 1,
    timezone: 'Asia/Dhaka',
    day: { morning_poll_at: '06:30', presumed_wake_at: '09:00', evening_poll_at: '22:30', presumed_sleep_at: '23:00' },
    groups: [{ id: 'drops', spacing: '10m' }],
    medicines: [
      { id: 'moxi', name: 'Moxifloxacin', dose: '1 drop', schedule: { type: 'interval', every: '4h', anchor: 'wake' }, group: 'drops', group_seq: 1, course: { days: 7 } },
      { id: 'pred', name: 'Prednisolone', dose: '1 drop', schedule: { type: 'interval', every: '4h', anchor: 'wake' }, group: 'drops', group_seq: 2, course: { days: 7 } },
    ],
  };

  async function twoDrops(): Promise<void> {
    const { AdminDb } = await import('../src/io/adminDb.js');
    const admin = new AdminDb(bot.d1 as never);
    const inv = await admin.createInvite('enrol', { createdBy: 'a', ttlMs: 86400_000 }, bot.now);
    await bot.send(PATIENT, `/start ${inv.code}`, { firstName: 'Ifti' });
    await bot.sendFile(PATIENT, 'p.json', JSON.stringify(SPACED));
    await bot.tap(PATIENT, /Apply|Confirm|Yes/i);
    await bot.send(PATIENT, '/awake');
    await bot.run(25 * MINUTE, 5 * MINUTE);
  }

  it('says when the next one is due instead of pushing it back in silence', async () => {
    await twoDrops();
    const mark = bot.sent.length;
    await bot.tap(PATIENT, /Moxifloxacin|Taken|✅/);
    const after = bot.sent.slice(mark).map((m) => m.text).join('\n');
    expect(after, 'said nothing about the drop it just pushed back').toMatch(/Give it 10m/i);
    expect(after).toContain('Prednisolone');
  });

  it('offers a way to say both were already done', async () => {
    await twoDrops();
    const mark = bot.sent.length;
    await bot.tap(PATIENT, /Moxifloxacin|Taken|✅/);
    const btn = bot.sent.slice(mark).flatMap((m) => m.buttons.flat()).find((b) => /Already did/i.test(b.text));
    expect(btn, 'no way to say they had already done it').toBeDefined();

    await bot.sendCallback(PATIENT, btn!.callback_data);
    expect(bot.d1.rows("SELECT * FROM doses WHERE status='taken'")).toHaveLength(2);
  });

  it('says nothing of the sort for a dose logged retrospectively', async () => {
    // "/took moxi 5pm" says nothing about what happens in the next ten minutes.
    await twoDrops();
    const mark = bot.sent.length;
    await bot.send(PATIENT, '/took moxi 30m ago');
    expect(bot.sent.slice(mark).map((m) => m.text).join('\n')).not.toMatch(/Give it 10m/i);
  });

  it('says nothing about a drop whose next dose is hours away', async () => {
    // The one that reached a real chat: Vigalon had been taken already and its next dose
    // was at quarter past three in the morning. Listing it read as "you still owe me
    // this", and the button offered to mark a dose four hours out as already taken.
    await twoDrops();
    const { encodeCallback } = await import('../src/core/callbackCodec.js');
    const pred = bot.d1.one("SELECT d.id FROM doses d JOIN medications m ON m.id=d.med_id WHERE m.med_key='pred'")!;
    await bot.sendCallback(PATIENT, encodeCallback({ a: 'take', doseId: Number(pred['id']) }));
    // Prednisolone now has a fresh dose four hours out, well clear of the spacing gap.
    await bot.run(5 * MINUTE, 5 * MINUTE);

    const mark = bot.sent.length;
    await bot.tap(PATIENT, /Moxifloxacin|Taken|✅/);
    const after = bot.sent.slice(mark).map((m) => m.text).join('\n');
    expect(after, 'chased a drop that was not waiting on anything').not.toMatch(/Give it 10m/i);
    expect(
      bot.sent.slice(mark).flatMap((m) => m.buttons.flat()).some((b) => /Already did/i.test(b.text)),
      'offered to mark a dose hours away as already taken',
    ).toBe(false);
  });

  it('says nothing about a drop that has already been skipped', async () => {
    await twoDrops();
    const pred = bot.d1.one("SELECT d.id FROM doses d JOIN medications m ON m.id=d.med_id WHERE m.med_key='pred'")!;
    const { encodeCallback } = await import('../src/core/callbackCodec.js');
    await bot.sendCallback(PATIENT, encodeCallback({ a: 'skip', doseId: Number(pred['id']) }));

    const mark = bot.sent.length;
    await bot.tap(PATIENT, /Moxifloxacin|Taken|✅/);
    expect(bot.sent.slice(mark).map((m) => m.text).join('\n')).not.toMatch(/Prednisolone/);
  });
});

/**
 * What happens to a dose the schedule wants to put after bedtime.
 *
 * Vigalon is four times a day. Four had been taken, and the schedule computed a fifth for
 * quarter past three in the morning -- and showed it. "Every four hours and forty minutes"
 * is an arithmetic consequence of "four times a day", not an instruction to take one in
 * the middle of the night.
 */
describe('doses that fall past bedtime', () => {
  const FOUR_A_DAY = {
    version: 1,
    timezone: 'Asia/Dhaka',
    day: { morning_poll_at: '06:30', presumed_wake_at: '09:00', evening_poll_at: '22:30', presumed_sleep_at: '23:00' },
    medicines: [
      { id: 'vigalon', name: 'Vigalon', dose: '1 drop', schedule: { type: 'times_per_day', n: 4 }, course: { days: 14 } },
      { id: 'aqua', name: 'Aquafresh', dose: '1 drop', schedule: { type: 'interval', every: '2h', anchor: 'wake' } },
    ],
  };

  /** A full day, answering everything, up to `until`. */
  async function dayUntil(until: string): Promise<void> {
    const { AdminDb } = await import('../src/io/adminDb.js');
    const admin = new AdminDb(bot.d1 as never);
    const inv = await admin.createInvite('enrol', { createdBy: 'a', ttlMs: 86400_000 }, bot.now);
    await bot.send(PATIENT, `/start ${inv.code}`, { firstName: 'Ifti' });
    await bot.sendFile(PATIENT, 'p.json', JSON.stringify(FOUR_A_DAY));
    await bot.tap(PATIENT, /Apply|Confirm|Yes/i);
    await bot.send(PATIENT, '/awake');
    const { encodeCallback } = await import('../src/core/callbackCodec.js');
    while (bot.now < at(until)) {
      await bot.tick();
      for (const r of bot.d1.rows("SELECT id FROM doses WHERE status IN ('due','prompted')")) {
        await bot.sendCallback(PATIENT, encodeCallback({ a: 'take', doseId: Number(r['id']) }));
      }
      bot.now += 5 * MINUTE;
    }
  }

  const nextFor = (key: string): number | null => {
    const r = bot.d1.one(
      `SELECT d.effective_due_at FROM doses d JOIN medications m ON m.id = d.med_id
        WHERE m.med_key = '${key}' AND d.status IN ('scheduled','deferred','due','prompted')`,
    );
    return r === null ? null : Number(r['effective_due_at']);
  };

  it('does not put a fifth dose of a four-a-day medicine in the small hours', async () => {
    await dayUntil('22:45');
    const next = nextFor('vigalon');
    if (next !== null) {
      // A fourth dose right at bedtime is legitimate; one at half past two is not.
      const smallHours = next > at('00:30', 1) && next < at('06:00', 1);
      expect(smallHours, `next Vigalon at ${z.fmtTime12(next)} — the middle of the night`).toBe(false);
    }
    const taken = Number(bot.d1.one("SELECT doses_taken FROM medications WHERE med_key='vigalon'")?.['doses_taken']);
    expect(taken, 'took more than the prescribed four in a day').toBeLessThanOrEqual(4);
  });

  it('keeps the day’s count, bringing the last one forward if it would fall late', async () => {
    await dayUntil('18:00');
    const taken = Number(bot.d1.one("SELECT doses_taken FROM medications WHERE med_key='vigalon'")?.['doses_taken']);
    expect(taken).toBeLessThan(4);
    await dayUntil('22:50');
    // All four fitted into the day rather than one being pushed past bedtime.
    const after = Number(bot.d1.one("SELECT doses_taken FROM medications WHERE med_key='vigalon'")?.['doses_taken']);
    expect(after, 'the day ended short of the prescribed count').toBe(4);
  });

  it('leaves an open-ended interval medicine to tomorrow rather than 1am', async () => {
    await dayUntil('22:45');
    const next = nextFor('aqua');
    expect(next, 'the two-hourly drop went quiet').not.toBeNull();
    // Within the grace hour is tonight's dose running late, and fine. Anything beyond it
    // belongs to tomorrow -- what must never happen is a time in between.
    const insideGrace = next! <= at('00:00', 1);
    const tomorrow = next! >= at('06:00', 1);
    expect(insideGrace || tomorrow, `next Aquafresh at ${z.fmtTime12(next!)} — the small hours`).toBe(true);
  });

  it('brings a dose back when the patient pushes bedtime later', async () => {
    await dayUntil('21:55');
    await bot.run(10 * MINUTE, 5 * MINUTE);
    const before = nextFor('vigalon');
    await bot.tap(PATIENT, /\+1 hour/).catch(() => undefined);
    await bot.run(10 * MINUTE, 5 * MINUTE);
    const after = nextFor('vigalon');
    if (before !== null && after !== null) {
      expect(after, 'the schedule ignored the later bedtime').not.toBeLessThan(before - MINUTE);
    }
  });
});

describe('the morning reference', () => {
  it('is where asking starts, and setting it moves what belongs to tomorrow', async () => {
    const { AdminDb } = await import('../src/io/adminDb.js');
    const admin = new AdminDb(bot.d1 as never);
    const inv = await admin.createInvite('enrol', { createdBy: 'a', ttlMs: 86400_000 }, bot.now);
    await bot.send(PATIENT, `/start ${inv.code}`, { firstName: 'Ifti' });
    await bot.sendFile(PATIENT, 'p.json', JSON.stringify({
      version: 1, timezone: 'Asia/Dhaka',
      day: { morning_poll_at: '06:30', presumed_wake_at: '08:00', evening_poll_at: '22:30', presumed_sleep_at: '23:00' },
      medicines: [{ id: 'aqua', name: 'Aquafresh', schedule: { type: 'interval', every: '2h', anchor: 'wake' } }],
    }));
    await bot.tap(PATIENT, /Apply|Confirm|Yes/i);
    await bot.send(PATIENT, '/awake');

    // "wake" is an alias for the morning reference now, not a setting of its own.
    await bot.send(PATIENT, '/settings wake 09:00');
    expect(bot.d1.one('SELECT morning_poll_at FROM patients')?.['morning_poll_at'],
      'setting the morning did nothing at all').toBe('09:00');

    const { encodeCallback } = await import('../src/core/callbackCodec.js');
    while (bot.now < at('22:45')) {
      await bot.tick();
      for (const r of bot.d1.rows("SELECT id FROM doses WHERE status IN ('due','prompted')")) {
        await bot.sendCallback(PATIENT, encodeCallback({ a: 'take', doseId: Number(r['id']) }));
      }
      bot.now += 5 * MINUTE;
    }
    const next = bot.d1.one("SELECT effective_due_at FROM doses WHERE status IN ('scheduled','deferred','due','prompted')");
    if (next !== null) {
      const t = Number(next['effective_due_at']);
      const insideGrace = t <= at('00:00', 1);
      expect(insideGrace || t >= at('09:00', 1), `next dose at ${z.fmtTime12(t)}, before the morning they set`).toBe(true);
    }
  });

  it('never brings a dose forward into the small hours', async () => {
    // The min-gap can refuse an earlier time. When it does, the dose is tomorrow's --
    // "brought forward" to ten past four in the morning is not brought forward.
    const { AdminDb } = await import('../src/io/adminDb.js');
    const admin = new AdminDb(bot.d1 as never);
    const inv = await admin.createInvite('enrol', { createdBy: 'a', ttlMs: 86400_000 }, bot.now);
    await bot.send(PATIENT, `/start ${inv.code}`, { firstName: 'Ifti' });
    await bot.sendFile(PATIENT, 'p.json', JSON.stringify({
      version: 1, timezone: 'Asia/Dhaka',
      day: { morning_poll_at: '06:30', presumed_wake_at: '09:00', evening_poll_at: '22:30', presumed_sleep_at: '23:00' },
      medicines: [{ id: 'ceevit', name: 'Ceevit', schedule: { type: 'times_per_day', n: 4 }, min_gap: '4h30m', course: { days: 7 } }],
    }));
    await bot.tap(PATIENT, /Apply|Confirm|Yes/i);
    await bot.send(PATIENT, '/awake');

    const { encodeCallback } = await import('../src/core/callbackCodec.js');
    while (bot.now < at('23:30')) {
      await bot.tick();
      for (const r of bot.d1.rows("SELECT id FROM doses WHERE status IN ('due','prompted')")) {
        await bot.sendCallback(PATIENT, encodeCallback({ a: 'take', doseId: Number(r['id']) }));
      }
      bot.now += 5 * MINUTE;
    }
    const next = bot.d1.one("SELECT effective_due_at FROM doses WHERE status IN ('scheduled','deferred','due','prompted')");
    expect(next).not.toBeNull();
    const t = Number(next!['effective_due_at']);
    const smallHours = t > at('00:00', 1) && t < at('06:00', 1);
    expect(smallHours, `dose sits at ${z.fmtTime12(t)} — the middle of the night`).toBe(false);
  });
});
