import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { Bot } from './harness/bot.js';
import { MINUTE, zoneFor } from '../src/core/tz.js';

/**
 * The morning nobody answers.
 *
 * Safety rule 1, from the day this was designed: "From presumed_wake_at the patient is
 * presumed awake and medicines fire normally. A user who never answers still gets every
 * reminder." Without it, someone who leaves their phone on charge gets zero reminders for
 * a whole day and the bot never notices -- which is the worst failure this system has.
 *
 * It happened. Asleep at 1am, configured to presume waking at 9am, and the first medicine
 * of the day went out at 11:55am -- retroactively, as three doses written straight into
 * the log as "missed" without one of them ever being sent.
 */

const z = zoneFor('Asia/Dhaka');
const at = (hhmm: string, day = 0): number => z.wallOnDayUtc(z.addLocalDays('2026-09-14', day), hhmm);
const P = 5000;

const realFetch = globalThis.fetch;
let bot: Bot;
beforeEach(() => { bot = new Bot(at('22:00')); bot.install(); });
afterEach(() => { globalThis.fetch = realFetch; });

const RX = {
  version: 1, timezone: 'Asia/Dhaka', patient: 'Ifti',
  day: { morning_poll_at: '06:30', presumed_wake_at: '09:00', evening_poll_at: '23:30', presumed_sleep_at: '01:00' },
  medicines: [
    { id: 'aqua', name: 'Aquafresh', dose: '1 drop', schedule: { type: 'interval', every: '2h', anchor: 'wake' }, min_gap: '90m' },
    { id: 'vigalon', name: 'Vigalon', dose: '1 drop', schedule: { type: 'interval', every: '4h40m', anchor: 'wake' }, min_gap: '4h', course: { days: 14 } },
  ],
};

async function setUp(): Promise<void> {
  const { AdminDb } = await import('../src/io/adminDb.js');
  const admin = new AdminDb(bot.d1 as never);
  const inv = await admin.createInvite('enrol', { createdBy: 'a', ttlMs: 86400_000 }, bot.now);
  await bot.send(P, `/start ${inv.code}`, { firstName: 'Ifti' });
  await bot.sendFile(P, 'p.json', JSON.stringify(RX));
  await bot.tap(P, /Apply|Confirm|Yes/i);
  await bot.send(P, '/awake');
}

/** Go to bed, then say nothing at all until `until`. */
async function silentNight(untilMs: number): Promise<void> {
  await bot.send(P, '/sleep');
  await bot.tap(P, /turning in/i).catch(() => undefined);
  while (bot.now < untilMs) {
    await bot.tick();
    bot.now += 5 * MINUTE;
  }
}

const medPrompts = (): string[] =>
  bot.textsTo(P).filter((t) => /Aquafresh|Vigalon/.test(t) && /Time for|hasn't confirmed/.test(t));

describe('a patient who never confirms waking', () => {
  it('is reminded from the configured wake time anyway', async () => {
    await setUp();
    await silentNight(at('11:00', 1));
    expect(medPrompts().length, 'a whole morning of medicines, never once sent').toBeGreaterThan(0);
  });

  it('starts at the configured time, not hours later', async () => {
    await setUp();
    await silentNight(at('10:00', 1));
    const first = bot.sent.find((m) => /Aquafresh|Vigalon/.test(m.text) && /Time for|hasn't confirmed/.test(m.text));
    expect(first, 'nothing at all by ten in the morning').toBeDefined();
    expect(first!.at, 'waited well past the hour it was told to start').toBeLessThanOrEqual(at('10:00', 1));
    expect(first!.at, 'started dosing before the configured wake time').toBeGreaterThanOrEqual(at('09:00', 1));
  });

  it('says it is assuming, rather than pretending to know', async () => {
    await setUp();
    await silentNight(at('10:30', 1));
    const all = bot.textsTo(P).join('\n');
    expect(all, 'dosed on an assumption without admitting it was one').toMatch(/assum|if you're not up|not up yet/i);
  });

  it('keeps asking whether they are up', async () => {
    await setUp();
    await silentNight(at('11:00', 1));
    expect(bot.textsTo(P).filter((t) => /wake up|awake|Still there/i.test(t)).length,
      'stopped asking once it started assuming').toBeGreaterThan(1);
  });

  it('re-anchors on the real time once they say when they got up', async () => {
    await setUp();
    await silentNight(at('10:00', 1));
    await bot.send(P, '/awake 7:30am');
    const woke = Number(bot.d1.one('SELECT last_wake_at FROM patients')?.['last_wake_at']);
    expect(woke, 'the stated wake time was ignored').toBe(at('07:30', 1));
  });

  it('does not write the morning off as missed without ever asking', async () => {
    await setUp();
    await silentNight(at('11:00', 1));
    const unasked = bot.d1.rows(
      "SELECT * FROM doses WHERE status='missed' AND first_prompt_at IS NULL",
    );
    expect(unasked, 'doses logged as missed that were never sent to anyone').toEqual([]);
  });

  it('still respects the minimum sleep', async () => {
    // Bed at 4am with a four-hour minimum: nothing before 8am, whatever the clock says.
    bot = new Bot(at('03:50'));
    bot.install();
    await setUp();
    await silentNight(at('07:30'));
    expect(medPrompts(), 'woke someone inside their minimum sleep').toEqual([]);
  });
});

/**
 * Writing off a morning after the fact.
 *
 * "I woke up earlier" reconstructs the doses that should have happened and logs them
 * missed. That is defensible — but it was doing it without keeping any of the books every
 * other resolution path keeps, so the day's totals disagreed with the log, the evening
 * digest reported nothing at all, and correcting one of them printed "-1 missed".
 */
describe('reconstructing a morning nobody logged', () => {
  async function wakeLateAndReconstruct(): Promise<void> {
    await setUp();
    await bot.send(P, '/sleep');
    await bot.tap(P, /turning in/i).catch(() => undefined);
    bot.now = at('11:00', 1);
    await bot.run(30 * MINUTE, 5 * MINUTE);
    await bot.tap(P, /woke up earlier/i);
    await bot.tap(P, /3h ago|180/);
  }

  it('counts the write-offs in the day it is writing off', async () => {
    await wakeLateAndReconstruct();
    const missed = bot.d1.rows("SELECT * FROM doses WHERE status='missed' AND resolution_src='reconstructed'");
    expect(missed.length, 'reconstructed nothing').toBeGreaterThan(0);
    const counted = bot.d1.rows('SELECT SUM(missed) m FROM day_counters');
    expect(Number(counted[0]?.['m'] ?? 0), 'the day totals never heard about them')
      .toBeGreaterThanOrEqual(missed.length);
  });

  it('leaves each write-off in the record', async () => {
    await wakeLateAndReconstruct();
    const missed = bot.d1.rows("SELECT * FROM doses WHERE status='missed' AND resolution_src='reconstructed'");
    const logged = bot.d1.rows("SELECT * FROM audit_log WHERE kind='dose_missed' AND actor='reconstructed'");
    expect(logged.length, 'doses written off with nothing in the medical record').toBe(missed.length);
  });

  it('never drives the day counters negative when one is corrected', async () => {
    await wakeLateAndReconstruct();
    await bot.tap(P, /Took /i).catch(() => undefined);
    const rows = bot.d1.rows('SELECT taken, missed FROM day_counters');
    for (const r of rows) {
      expect(Number(r['missed']), 'a negative number of missed doses').toBeGreaterThanOrEqual(0);
      expect(Number(r['taken']), 'a negative number of taken doses').toBeGreaterThanOrEqual(0);
    }
  });

  it('offers every reconstructed dose back, not just the last one', async () => {
    await wakeLateAndReconstruct();
    const offer = [...bot.sent].reverse().find((m) => /while you were up/i.test(m.text));
    expect(offer, 'said nothing about the hours it wrote off').toBeDefined();
    const perMed = bot.d1.rows(
      "SELECT med_id, COUNT(*) c FROM doses WHERE resolution_src='reconstructed' GROUP BY med_id",
    );
    const most = Math.max(...perMed.map((r) => Number(r['c'])), 0);
    expect(offer!.buttons.flat().length, 'only one dose per medicine could be corrected')
      .toBeGreaterThanOrEqual(Math.min(most, 2));
  });

  it('does not rewind the schedule behind a dose taken later', async () => {
    await wakeLateAndReconstruct();
    const rows = bot.d1.rows('SELECT last_taken_at, last_cycle_start_at FROM medications WHERE last_taken_at IS NOT NULL');
    for (const r of rows) {
      expect(Number(r['last_cycle_start_at']), 'the grid was rewound onto a slot that never happened')
        .toBeGreaterThanOrEqual(Number(r['last_taken_at']) - 1);
    }
  });
});
