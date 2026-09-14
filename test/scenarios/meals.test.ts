import { describe, expect, it } from 'vitest';
import { World, makeChat, makeMed, TZ } from '../simulate.js';
import { HOUR, MINUTE, zoneFor } from '../../src/core/tz.js';
import { planMeals, wakeOffsets } from '../../src/core/planMeals.js';
import type { MealDef } from '../../src/core/domain.js';

const z = zoneFor(TZ);
const at = (day: number, hhmm: string): number => z.wallOnDayUtc(z.addLocalDays('2026-09-14', day), hhmm);

const mealDefs: MealDef[] = [
  { patientId: 1, meal: 'breakfast', typicalLocal: '08:30', askAfterLocal: '09:30', presumeAtLocal: '11:30', afterWakeMs: 30 * MINUTE, minGapAfterPrevMs: 3 * HOUR, seq: 0 },
  { patientId: 1, meal: 'lunch', typicalLocal: '13:30', askAfterLocal: '14:30', presumeAtLocal: '16:30', afterWakeMs: 5 * HOUR, minGapAfterPrevMs: 3 * HOUR, seq: 1 },
];

function world(wakeAt: number): World {
  const w = new World({
    start: wakeAt - 5 * MINUTE,
    patient: {
      wakeState: 'awake', wakeConfidence: 'confirmed',
      wakeStateSince: wakeAt, lastWakeAt: wakeAt,
      presumedSleepAt: '23:59', eveningPollAt: '23:50',
    },
    meds: [
      makeMed({
        id: 1, medKey: 'stomach_capsule', name: 'Stomach protection capsule', kind: 'meal', intervalMs: null,
        minGapMs: 4 * HOUR,
        spec: { kind: 'meal', meal: { meal: 'breakfast', relation: 'before', offsetMs: 30 * MINUTE } },
      }),
      makeMed({
        id: 2, medKey: 'anti_inflammatory', name: 'Anti-inflammatory tablet', kind: 'meal', intervalMs: null,
        minGapMs: 4 * HOUR,
        spec: { kind: 'meal', meal: { meal: 'breakfast', relation: 'after', offsetMs: 0 } },
      }),
    ],
    mealDefs,
    chats: [makeChat({ chatId: 100 })],
  });
  w.respectSchedule = true;
  return w;
}

/** Agree to, or push back, a proposed meal time. */
function planMealAt(w: World, meal: string, at: number): void {
  planMeal(w, meal, at - w.now);
}

/** Answer a "when are you eating?" question. */
function planMeal(w: World, meal: string, inMs: number): void {
  const day = w.z.localDay(w.now);
  w.state.mealEvents = w.state.mealEvents.filter((e) => !(e.meal === meal && e.localDay === day));
  w.state.mealEvents.push({
    patientId: 1, meal, localDay: day, at: w.now + inMs,
    source: 'planned', plannedAt: w.now + inMs, askedAt: w.now,
  });
  for (const q of w.state.openPrompts) if (q.kind === 'meal' && q.body.meal === meal) q.state = 'resolved';
  w.state.openPrompts = w.state.openPrompts.filter((q) => q.state === 'open');
  w.state.patient.nextActionAt = w.now;
}

describe('the bot asks when you will eat, rather than assuming', () => {
  it('asks ahead of the meal, with time to take what goes before it', () => {
    const w = world(at(0, '11:00'));
    w.run(3 * HOUR);

    const ask = w.sent.find((s) => s.kind === 'meal');
    expect(ask, 'never asked about breakfast').toBeDefined();

    const prompt = w.state.openPrompts.find((q) => q.kind === 'meal' && q.body.stage === 'plan')
      ?? w.allPrompts.find((q) => q.kind === 'meal' && q.body.stage === 'plan');
    expect(prompt?.body.proposedAt, 'the question proposed no time').toBeDefined();

    // Asked at least half an hour before the meal it is proposing, because the tablet
    // due half an hour before food needs that half hour to exist.
    expect(prompt!.body.proposedAt! - ask!.at).toBeGreaterThanOrEqual(30 * MINUTE);
    // And the proposal follows waking rather than a clock time someone else chose.
    expect(prompt!.body.proposedAt!).toBeGreaterThan(at(0, '11:00'));
    expect(prompt!.body.proposedAt!).toBeLessThanOrEqual(at(0, '12:30'));
  });

  it('proposes a time rather than asking an open question', () => {
    const w = world(at(0, '08:00'));
    w.run(2 * HOUR);
    const prompt = w.allPrompts.find((q) => q.kind === 'meal' && q.body.stage === 'plan');
    expect(prompt, 'no meal question was asked').toBeDefined();
    expect(prompt!.body.proposedAt, 'asked openly instead of proposing a time').toBeDefined();
  });

  it('asks the forward-looking question first, not "have you eaten"', () => {
    const w = world(at(0, '08:00'));
    w.run(90 * MINUTE);
    const prompt = w.allPrompts.find((q) => q.kind === 'meal');
    expect(prompt, 'no meal question was asked').toBeDefined();
    expect(prompt!.body.stage, 'asked whether they had eaten instead of when they would').toBe('plan');
  });

  it('keeps the proposed time when you agree with it', () => {
    const w = world(at(0, '08:00'));
    w.run(2 * HOUR);
    const prompt = w.allPrompts.find((q) => q.kind === 'meal' && q.body.stage === 'plan')!;
    const proposed = prompt.body.proposedAt!;

    // "Yes, around then" -- the assumption is kept exactly, not re-derived.
    planMealAt(w, 'breakfast', proposed);
    w.run(5 * MINUTE);

    const event = w.state.mealEvents.find((e) => e.meal === 'breakfast')!;
    expect(event.at).toBe(proposed);
    expect(event.source).toBe('planned');
  });

  it('pushes the meal back when you say later', () => {
    const w = world(at(0, '08:00'));
    w.run(2 * HOUR);
    const prompt = w.allPrompts.find((q) => q.kind === 'meal' && q.body.stage === 'plan')!;
    const proposed = prompt.body.proposedAt!;

    planMealAt(w, 'breakfast', proposed + HOUR);
    w.run(5 * MINUTE);

    expect(w.state.mealEvents.find((e) => e.meal === 'breakfast')!.at).toBe(proposed + HOUR);
    // And the before-meal tablet follows it.
    const dose = w.state.liveDoses.find((d) => d.medId === w.med('stomach_capsule').id);
    expect(dose!.effectiveDueAt).toBe(proposed + HOUR - 30 * MINUTE);
  });
});

describe('working backwards from when you say you will eat', () => {
  it('schedules the before-meal tablet half an hour before the stated time', () => {
    const w = world(at(0, '08:00'));
    w.run(45 * MINUTE);          // it asks about breakfast

    w.now = at(0, '08:45');
    planMeal(w, 'breakfast', 2 * HOUR);   // "in about two hours" -> 10:45
    w.run(5 * MINUTE);

    const dose = w.state.liveDoses.find((d) => d.medId === w.med('stomach_capsule').id);
    expect(dose, 'the before-meal tablet was never scheduled').toBeDefined();
    // Half an hour before 10:45.
    expect(dose!.effectiveDueAt).toBe(at(0, '10:15'));
  });

  it('moves the tablet when the meal plan changes', () => {
    const w = world(at(0, '08:00'));
    w.run(45 * MINUTE);

    w.now = at(0, '08:45');
    planMeal(w, 'breakfast', 3 * HOUR);   // 11:45
    w.run(5 * MINUTE);
    expect(w.state.liveDoses.find((d) => d.medId === w.med('stomach_capsule').id)!.effectiveDueAt).toBe(at(0, '11:15'));

    // "Actually, another half hour."
    w.now = at(0, '09:00');
    planMeal(w, 'breakfast', 4 * HOUR);   // 13:00
    w.run(5 * MINUTE);
    expect(w.state.liveDoses.find((d) => d.medId === w.med('stomach_capsule').id)!.effectiveDueAt).toBe(at(0, '12:30'));
  });

  it('tells you why the tablet is due now', () => {
    const w = world(at(0, '08:00'));
    w.run(45 * MINUTE);
    w.now = at(0, '08:45');
    planMeal(w, 'breakfast', 90 * MINUTE);   // 10:15, so the tablet is due 09:45
    w.run(90 * MINUTE);

    const prompt = w.state.openPrompts.find(
      (q) => q.kind === 'dose' && q.body.beforeMeal !== undefined,
    );
    expect(prompt, 'the before-meal dose never explained itself').toBeDefined();
    expect(prompt!.body.beforeMeal!.meal).toBe('breakfast');
    // Roughly half an hour before the meal, which is the whole point of saying it.
    expect(prompt!.body.beforeMeal!.inMs).toBeGreaterThan(20 * MINUTE);
    expect(prompt!.body.beforeMeal!.inMs).toBeLessThanOrEqual(40 * MINUTE);
  });

  it('holds the after-meal tablet until the meal is actually confirmed', () => {
    const w = world(at(0, '08:00'));
    w.run(45 * MINUTE);
    w.now = at(0, '08:45');
    planMeal(w, 'breakfast', HOUR);
    w.run(2 * HOUR);

    // Planned but never confirmed: the after-meal tablet must not have fired on a plan.
    const afterBeforeEating = w.takenTimes('anti_inflammatory').length;
    expect(afterBeforeEating).toBe(0);

    w.eat('breakfast');
    w.run(30 * MINUTE);
    const dose = w.state.liveDoses.find((d) => d.medId === w.med('anti_inflammatory').id);
    expect(dose, 'the after-meal tablet never appeared once she ate').toBeDefined();
  });
});

describe('when the plan does not survive contact with the day', () => {
  it('asks whether you are eating when the planned time arrives', () => {
    const w = world(at(0, '08:00'));
    w.run(45 * MINUTE);
    w.now = at(0, '08:45');
    planMeal(w, 'breakfast', HOUR);       // 09:45
    w.run(90 * MINUTE);

    const confirm = w.state.openPrompts.find((q) => q.kind === 'meal' && q.body.stage === 'confirm');
    expect(confirm, 'never checked whether the meal actually happened').toBeDefined();
  });

  it('assumes it happened rather than waiting for ever', () => {
    const w = world(at(0, '08:00'));
    w.run(45 * MINUTE);
    w.now = at(0, '08:45');
    planMeal(w, 'breakfast', 30 * MINUTE);   // 09:15
    w.run(4 * HOUR);                          // well past the two-hour grace

    const event = w.state.mealEvents.find((e) => e.meal === 'breakfast');
    expect(event, 'the meal record vanished').toBeDefined();
    expect(event!.source, 'still waiting on a meal from hours ago').toBe('presumed');
    // And the after-meal tablet is released rather than hanging for ever.
    const dose = w.state.liveDoses.find((d) => d.medId === w.med('anti_inflammatory').id);
    expect(dose, 'the after-meal tablet was stranded').toBeDefined();
  });

  it('a skipped meal resolves what depended on it instead of hanging', () => {
    const w = world(at(0, '08:00'));
    w.run(45 * MINUTE);
    const day = w.z.localDay(w.now);
    w.state.mealEvents.push({
      patientId: 1, meal: 'breakfast', localDay: day, at: w.now,
      source: 'skipped', plannedAt: null, askedAt: null,
    });
    w.state.patient.nextActionAt = w.now;
    const skippedAt = w.now;
    w.run(2 * HOUR);

    // Nothing further is asked about a meal that is not happening. Anything prompted
    // before she said so is fair -- the bot did not know yet.
    const flexiPrompts = w.sent.filter((s) =>
      s.at > skippedAt &&
      s.doseIds.some((id) => w.allDoses.find((d) => d.id === id)?.medId === w.med('anti_inflammatory').id));
    expect(flexiPrompts.length, 'kept asking about a meal she said she was skipping').toBe(0);
    // And the dose is resolved rather than left hanging all day.
    expect(w.state.liveDoses.filter((d) => d.medId === w.med('anti_inflammatory').id).length).toBe(0);
  });

  it('does not bunch the next meal question up against the last one', () => {
    const w = world(at(0, '08:00'));
    w.run(45 * MINUTE);
    w.now = at(0, '09:00');
    planMeal(w, 'breakfast', 15 * MINUTE);
    w.now = at(0, '09:15');
    w.eat('breakfast');
    w.run(3 * HOUR);

    const lunchAsk = w.sent.find((s) => {
      const q = w.state.openPrompts.find((x) => x.id === s.promptId);
      return s.kind === 'meal' && (q?.body.meal === 'lunch');
    });
    if (lunchAsk !== undefined) {
      // At least three hours after breakfast, not straight afterwards.
      expect(lunchAsk.at - at(0, '09:15')).toBeGreaterThanOrEqual(3 * HOUR);
    }
  });
});

describe('the proposal is always actionable', () => {
  it('never proposes a time that has already gone', () => {
    // Woken hours ago with nothing said: the assumed breakfast time is long past, but
    // proposing it would leave no room for the tablet due before it.
    const w = world(at(0, '06:00'));
    w.now = at(0, '11:00');
    w.state.patient.nextActionAt = w.now;
    w.run(10 * MINUTE);

    const prompt = w.allPrompts.find((q) => q.kind === 'meal' && q.body.stage === 'plan');
    expect(prompt, 'never asked').toBeDefined();
    expect(prompt!.body.proposedAt!, 'proposed a time in the past').toBeGreaterThan(at(0, '11:00'));
    // And with enough lead for the half-hour-before tablet.
    expect(prompt!.body.proposedAt! - prompt!.createdAt).toBeGreaterThanOrEqual(30 * MINUTE);
  });

  it('still presumes the meal happened if nothing is ever answered', () => {
    const w = world(at(0, '08:00'));
    w.run(6 * HOUR);
    const event = w.state.mealEvents.find((e) => e.meal === 'breakfast');
    expect(event, 'a meal nobody answered about vanished entirely').toBeDefined();
    expect(event!.source).toBe('presumed');
    // And the after-meal tablet was not stranded waiting for an answer.
    expect(w.state.liveDoses.filter((d) => d.medId === w.med('anti_inflammatory').id).length).toBe(1);
  });
});

/**
 * Meals hang off waking, keeping the spacing the prescription describes.
 *
 * The day starts when the patient gets up -- that is the premise the whole bot is built
 * on, and meals are no exception. What comes from the prescription is the *rhythm*:
 * "08:30, 13:30, 20:30" says five hours from breakfast to lunch and seven from lunch to
 * dinner. A hardcoded 5.25h step ignored that and put dinner where nobody eats it.
 */
describe('meals follow waking, spaced as the prescription describes', () => {
  const zz = zoneFor(TZ);
  const wall = (hhmm: string): number => zz.wallOnDayUtc('2026-09-14', hhmm);

  function mealsAt(wakeAt: string, opts: { breakfastAt?: string } = {}): Map<string, number> {
    const w = new World({
      start: wall(wakeAt),
      patient: {
        morningPollAt: '06:30', presumedWakeAt: '09:00',
        eveningPollAt: '22:30', presumedSleepAt: '23:30',
        wakeState: 'awake', wakeConfidence: 'confirmed',
        wakeStateSince: wall(wakeAt), lastWakeAt: wall(wakeAt),
      },
      mealDefs: [
        { patientId: 1, meal: 'breakfast', typicalLocal: '08:30', askAfterLocal: '09:30', presumeAtLocal: null, afterWakeMs: null, minGapAfterPrevMs: 3 * HOUR, seq: 0 },
        { patientId: 1, meal: 'lunch', typicalLocal: '13:30', askAfterLocal: '14:30', presumeAtLocal: null, afterWakeMs: null, minGapAfterPrevMs: 3 * HOUR, seq: 1 },
        { patientId: 1, meal: 'dinner', typicalLocal: '20:30', askAfterLocal: '21:30', presumeAtLocal: null, afterWakeMs: null, minGapAfterPrevMs: 3 * HOUR, seq: 2 },
      ],
      meds: [],
      chats: [makeChat({ chatId: 100 })],
    });
    if (opts.breakfastAt !== undefined) w.eat('breakfast', wall(opts.breakfastAt));
    const facts = planMeals(
      w.state, w.now, zz, zz.localDay(w.now), true, () => undefined, () => false, wall(wakeAt),
    );
    const out = new Map<string, number>();
    for (const [meal, v] of facts.meals) out.set(meal, v.at - wall(wakeAt));
    return out;
  }

  it('takes the gaps between meals from the prescription', () => {
    // 08:30 -> 13:30 -> 20:30 is five hours and then seven, whatever time you got up.
    const offsets = wakeOffsets([
      { patientId: 1, meal: 'breakfast', typicalLocal: '08:30', askAfterLocal: '09:30', presumeAtLocal: null, afterWakeMs: null, minGapAfterPrevMs: 3 * HOUR, seq: 0 },
      { patientId: 1, meal: 'lunch', typicalLocal: '13:30', askAfterLocal: '14:30', presumeAtLocal: null, afterWakeMs: null, minGapAfterPrevMs: 3 * HOUR, seq: 1 },
      { patientId: 1, meal: 'dinner', typicalLocal: '20:30', askAfterLocal: '21:30', presumeAtLocal: null, afterWakeMs: null, minGapAfterPrevMs: 3 * HOUR, seq: 2 },
    ]);
    expect(offsets).toEqual([45 * MINUTE, 45 * MINUTE + 5 * HOUR, 45 * MINUTE + 12 * HOUR]);
  });

  it('moves the whole day when the patient gets up late', () => {
    const early = mealsAt('06:30');
    const late = mealsAt('11:00');
    // Identical offsets from waking: the day shifts, its shape does not.
    expect([...late.entries()].sort()).toEqual([...early.entries()].sort());
    expect(early.get('breakfast')).toBe(45 * MINUTE);
    expect(early.get('lunch')).toBe(45 * MINUTE + 5 * HOUR);
    expect(early.get('dinner')).toBe(45 * MINUTE + 12 * HOUR);
  });

  it('does not bunch lunch against a genuinely late breakfast', () => {
    // Up at 8:35 and breakfast not until 11:27: lunch waits three hours, not five.
    const m = mealsAt('08:35', { breakfastAt: '11:27' });
    expect(m.get('lunch')).toBe(wall('14:27') - wall('08:35'));
    expect(m.get('dinner')).toBe(45 * MINUTE + 12 * HOUR);
  });

  it('falls back to a sensible ladder when the prescription gave no times', () => {
    const offsets = wakeOffsets([
      { patientId: 1, meal: 'breakfast', typicalLocal: '', askAfterLocal: '', presumeAtLocal: null, afterWakeMs: null, minGapAfterPrevMs: 3 * HOUR, seq: 0 },
      { patientId: 1, meal: 'lunch', typicalLocal: '', askAfterLocal: '', presumeAtLocal: null, afterWakeMs: null, minGapAfterPrevMs: 3 * HOUR, seq: 1 },
    ]);
    expect(offsets[0]).toBe(45 * MINUTE);
    expect(offsets[1]).toBeGreaterThan(4 * HOUR);
  });
});
