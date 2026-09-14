/**
 * Turning state into the words the bot actually says.
 *
 * Pure, so message copy is unit-testable and the planner stays free of presentation.
 * The tone is deliberately warm and a little persistent -- this thing is going to be in
 * someone's pocket every two hours for a fortnight, and a curt robot gets muted.
 */

import type { Dose, Medicine, Prompt } from './domain.js';
import type { InlineButton } from '../io/telegram.js';
import { encodeCallback } from './callbackCodec.js';
import { esc } from './html.js';
import type { Zone } from './tz.js';
import { HOUR, MINUTE, fmtDuration, fmtTime12 } from './tz.js';

export interface Rendered {
  text: string;
  buttons: InlineButton[][];
}

/** Escalating nudge wording. Gentle first, plainer later; never scolding. */
function overdueLine(nudge: number, overdueMs: number, z: Zone, dueAt: number): string {
  if (nudge === 0) return '';
  if (nudge === 1) return `\n<i>Still waiting on this one — due at ${z.fmtTime12(dueAt)}.</i>`;
  return `\n⚠️ <i>${fmtDuration(overdueMs)} overdue</i> — due at ${z.fmtTime12(dueAt)}.`;
}

export function renderDosePrompt(
  prompt: Prompt,
  doses: Dose[],
  meds: Map<number, Medicine>,
  z: Zone,
  now: number,
  opts: { forCaregiver?: boolean; patientName?: string } = {},
): Rendered {
  const items = doses
    .map((d) => ({ dose: d, med: meds.get(d.medId) }))
    .filter((x): x is { dose: Dose; med: Medicine } => x.med !== undefined);

  if (items.length === 0) return { text: 'Nothing to take right now.', buttons: [] };

  const first = items[0]!;
  const dueAt = Math.min(...items.map((i) => i.dose.effectiveDueAt));
  const overdue = Math.max(0, now - dueAt);

  const who = opts.forCaregiver === true ? `${esc(opts.patientName ?? 'They')} ` : '';
  const lines: string[] = [];

  if (items.length === 1) {
    const { dose, med } = first;
    const step = med.steps[dose.step];
    const label = step !== undefined ? step.name : med.name;
    const doseText = step?.dose ?? med.doseText;

    if (med.steps.length > 1) {
      // A spacing group: say where we are in the sequence, because that is the whole
      // reason these arrive as separate messages ten minutes apart.
      lines.push(
        opts.forCaregiver === true
          ? `💧 ${who}hasn't confirmed <b>${esc(label)}</b> (drop ${dose.step + 1} of ${med.steps.length}).`
          : `💧 <b>${esc(label)}</b> — drop ${dose.step + 1} of ${med.steps.length}`,
      );
    } else {
      lines.push(
        opts.forCaregiver === true
          ? `💊 ${who}hasn't confirmed <b>${esc(label)}</b>.`
          : `💊 Time for <b>${esc(label)}</b>`,
      );
    }
    if (doseText !== null && doseText !== undefined) lines.push(esc(doseText));
    const note = step?.note ?? med.notes;
    if (note !== null && note !== undefined) lines.push(`<i>${esc(note)}</i>`);
  } else {
    lines.push(opts.forCaregiver === true ? `💊 ${who}hasn't confirmed these:` : '💊 Time for these:');
    for (const { dose, med } of items) {
      const step = med.steps[dose.step];
      const label = step !== undefined ? step.name : med.name;
      const doseText = step?.dose ?? med.doseText;
      lines.push(`• <b>${esc(label)}</b>${doseText != null ? ` — ${esc(doseText)}` : ''}`);
    }
  }

  // The reason is the point: "take this now, you're eating in half an hour" is an
  // instruction someone will actually follow.
  const bm = prompt.body.beforeMeal;
  if (bm !== undefined) {
    lines.push(
      `\n⏱ <i>You said ${esc(bm.meal)} in about ${fmtDuration(bm.inMs)} — this one goes before it.</i>`,
    );
  }

  lines.push(overdueLine(prompt.nudgeCount, overdue, z, dueAt));

  const buttons: InlineButton[][] = [];
  if (items.length === 1) {
    buttons.push([
      { text: '✅ Taken', callback_data: encodeCallback({ a: 'take', doseId: first.dose.id }) },
      { text: '⏰ 15 min', callback_data: encodeCallback({ a: 'snooze', doseId: first.dose.id, minutes: 15 }) },
    ]);
    buttons.push([
      { text: '🕐 Taken earlier…', callback_data: encodeCallback({ a: 'earlier', doseId: first.dose.id, minutesAgo: 30 }) },
      { text: '⏭ Skip', callback_data: encodeCallback({ a: 'skip', doseId: first.dose.id }) },
    ]);
  } else {
    buttons.push([{ text: '✅ All taken', callback_data: encodeCallback({ a: 'takeAll', promptId: prompt.id }) }]);
    for (const { dose, med } of items) {
      const step = med.steps[dose.step];
      buttons.push([
        { text: `✅ ${(step?.name ?? med.name).slice(0, 28)}`, callback_data: encodeCallback({ a: 'take', doseId: dose.id }) },
      ]);
    }
  }

  return { text: lines.filter((l) => l !== '').join('\n'), buttons };
}

/** The one-tap "I took it a while ago" menu. */
export function renderEarlierMenu(doseId: number, z: Zone, now: number): Rendered {
  const choices = [5, 15, 30, 60, 120];
  return {
    text:
      '🕐 <b>When did you take it?</b>\n' +
      `<i>Or just type</i> <code>/took &lt;medicine&gt; 5pm</code> <i>for an exact time.</i>`,
    buttons: [
      choices.slice(0, 3).map((m) => ({
        text: `${fmtDuration(m * MINUTE)} ago`,
        callback_data: encodeCallback({ a: 'earlier', doseId, minutesAgo: m }),
      })),
      choices.slice(3).map((m) => ({
        text: `${fmtDuration(m * MINUTE)} ago (${fmtTime12(now - m * MINUTE, z.tz)})`,
        callback_data: encodeCallback({ a: 'earlier', doseId, minutesAgo: m }),
      })),
      [{ text: '✅ Just now', callback_data: encodeCallback({ a: 'take', doseId }) }],
    ],
  };
}

/**
 * "Did you just wake up?"
 *
 * Never "good morning, here is your day" -- the bot does not know when they got up, and
 * starting the schedule from the wrong moment misplaces every dose in it. The one answer
 * that matters most is the second: people surface, potter about, and only reach for the
 * phone an hour later.
 */
export function renderWakePrompt(nudge: number, forCaregiver: boolean, patientName: string): Rendered {
  if (forCaregiver) {
    return {
      text: `☀️ ${esc(patientName)} hasn't said whether they're up — today's medicines are waiting on it.`,
      buttons: [],
    };
  }
  return {
    text:
      nudge === 0
        ? '☀️ <b>Did you just wake up?</b>\n\n<i>I\'ll start the day from whenever you actually got up, so the times come out right.</i>'
        : "☀️ Still there? Tell me when you got up and I'll pick the day up from then.",
    buttons: [
      [{ text: '☀️ Yes, just now', callback_data: encodeCallback({ a: 'wokeNow' }) }],
      [{ text: '🕐 I woke up earlier', callback_data: encodeCallback({ a: 'wokeEarlier' }) }],
      [
        { text: '😴 +30 min', callback_data: encodeCallback({ a: 'sleepOn', minutes: 30 }) },
        { text: '😴 +1 hour', callback_data: encodeCallback({ a: 'sleepOn', minutes: 60 }) },
      ],
      [{ text: '🌙 Going back to sleep', callback_data: encodeCallback({ a: 'sleepOn', minutes: 120 }) }],
    ],
  };
}

/** "Roughly when?" -- the follow-up to "I woke up earlier". */
export function renderWokeEarlierMenu(now: number, z: Zone): Rendered {
  const choices = [30, 60, 90, 120, 180, 240];
  const rows: InlineButton[][] = [];
  for (let i = 0; i < choices.length; i += 2) {
    rows.push(
      choices.slice(i, i + 2).map((m) => ({
        text: `${fmtDuration(m * MINUTE)} ago (${z.fmtTime12(now - m * MINUTE)})`,
        callback_data: encodeCallback({ a: 'wokeAgo', minutesAgo: m }),
      })),
    );
  }
  rows.push([{ text: '☀️ Actually, just now', callback_data: encodeCallback({ a: 'wokeNow' }) }]);
  return {
    text:
      '🕐 <b>Roughly when did you get up?</b>\n\n' +
      "<i>Or just tell me: <code>/awake 7:30am</code>. I'll work out what was due since then.</i>",
    buttons: rows,
  };
}

/**
 * "Still turning in at one?"
 *
 * Asked twice before the expected bedtime, because the answer decides what happens to
 * every dose that would otherwise fall the wrong side of it. The medicines worth taking
 * before bed are listed here rather than left to arrive separately: this is the moment
 * someone is thinking about going to sleep, and the last one at which "before bed" still
 * means anything.
 */
export function renderBedtimePrompt(
  proposedAt: number,
  beforeBed: Array<{ label: string }>,
  forCaregiver: boolean,
  patientName: string,
  z: Zone,
): Rendered {
  const when = z.fmtTime12(proposedAt);
  const list = beforeBed.length === 0
    ? ''
    : `\n\n<b>Before you turn in</b>\n${beforeBed.map((b) => `• ${esc(b.label)}`).join('\n')}`;

  if (forCaregiver) {
    return {
      text: `🌙 ${esc(patientName)} is expected to turn in around ${when}.${list}`,
      buttons: [],
    };
  }
  return {
    text: `🌙 <b>Still turning in around ${when}?</b>${list}`,
    buttons: [
      [{ text: '🌙 Going to sleep now', callback_data: encodeCallback({ a: 'bedNow' }) }],
      [
        { text: '−30 min', callback_data: encodeCallback({ a: 'bedAt', shiftMinutes: -30 }) },
        { text: '✅ On time', callback_data: encodeCallback({ a: 'bedAt', shiftMinutes: 0 }) },
      ],
      [
        { text: '+30 min', callback_data: encodeCallback({ a: 'bedAt', shiftMinutes: 30 }) },
        { text: '+1 hour', callback_data: encodeCallback({ a: 'bedAt', shiftMinutes: 60 }) },
      ],
    ],
  };
}

export function renderSleepPrompt(forCaregiver: boolean, patientName: string): Rendered {
  return {
    text: forCaregiver
      ? `🌙 ${esc(patientName)} hasn't turned in yet.`
      : "🌙 Heading to bed? Let me know and I'll stop bothering you until morning.",
    buttons: [[{ text: '🌙 Going to sleep', callback_data: encodeCallback({ a: 'sleep' }) }]],
  };
}

/**
 * Asking about a meal, in two stages.
 *
 * The first is forward-looking -- "when are you eating?" -- because that is the only way
 * a "half an hour before food" tablet can ever be scheduled. By the time someone confirms
 * they have eaten, that window has gone.
 */
export function renderMealPrompt(
  meal: string,
  forCaregiver: boolean,
  patientName: string,
  stage: 'plan' | 'confirm' = 'plan',
  proposedAt?: number,
  z?: Zone,
): Rendered {
  const nice = meal.charAt(0).toUpperCase() + meal.slice(1);
  const when = proposedAt !== undefined && z !== undefined ? z.fmtTime12(proposedAt) : null;

  if (stage === 'confirm') {
    return {
      text: forCaregiver
        ? `🍽 ${esc(patientName)} said they'd have ${esc(meal)} around now.`
        : `🍽 Having ${esc(meal)} now?`,
      buttons: [
        [
          { text: '✅ Eating now', callback_data: encodeCallback({ a: 'ate', meal }) },
          { text: '🕐 +30 min', callback_data: encodeCallback({ a: 'planMeal', meal, inMinutes: 30 }) },
          { text: '🕐 +1 hour', callback_data: encodeCallback({ a: 'planMeal', meal, inMinutes: 60 }) },
        ],
        [{ text: '⏭ Skipping it', callback_data: encodeCallback({ a: 'skipMeal', meal }) }],
      ],
    };
  }

  // Proposing a time rather than asking openly: one tap to agree, one to push it back.
  // Asked early enough that whatever goes before the meal still has time to be taken.
  if (when !== null && proposedAt !== undefined) {
    const delay = (mins: number, label: string): InlineButton => ({
      text: label,
      callback_data: encodeCallback({ a: 'mealAt', meal, at: proposedAt + mins * MINUTE }),
    });
    return {
      text: forCaregiver
        ? `🍽 ${esc(patientName)} hasn't confirmed ${esc(meal)} around ${when}.`
        : `🍽 Having <b>${esc(nice.toLowerCase())}</b> around ${when}?\n` +
          `<i>Just so I can time the tablets that go before and after it.</i>`,
      buttons: [
        [
          { text: `✅ Yes, ${when}`, callback_data: encodeCallback({ a: 'mealAt', meal, at: proposedAt }) },
          { text: '🍽 Eating now', callback_data: encodeCallback({ a: 'ate', meal }) },
        ],
        [delay(30, '🕐 Later, +30 min'), delay(60, '🕐 +1 hour'), delay(120, '🕐 +2 hours')],
        [{ text: '⏭ Skipping it', callback_data: encodeCallback({ a: 'skipMeal', meal }) }],
      ],
    };
  }

  // No proposal to offer, so fall back to asking outright.
  return {
    text: forCaregiver
      ? `🍽 ${esc(patientName)} hasn't said when they're having ${esc(meal)}.`
      : `🍽 When are you having ${esc(nice.toLowerCase())}?`,
    buttons: [
      [
        { text: 'In ~30 min', callback_data: encodeCallback({ a: 'planMeal', meal, inMinutes: 30 }) },
        { text: 'In ~1 hour', callback_data: encodeCallback({ a: 'planMeal', meal, inMinutes: 60 }) },
        { text: 'In ~2 hours', callback_data: encodeCallback({ a: 'planMeal', meal, inMinutes: 120 }) },
      ],
      [
        { text: '🍽 Eating now', callback_data: encodeCallback({ a: 'ate', meal }) },
        { text: '⏭ Skipping it', callback_data: encodeCallback({ a: 'skipMeal', meal }) },
      ],
    ],
  };
}

/** The short line every linked chat gets once someone answers. */
export function renderConfirmation(
  medLabel: string,
  takenAt: number,
  z: Zone,
  byName: string | null,
  corrected: boolean,
): string {
  const when = z.fmtTime12(takenAt);
  const by = byName !== null ? `, confirmed by ${esc(byName)}` : '';
  return corrected
    ? `✅ <b>${esc(medLabel)}</b> — recorded as taken at ${when}${by}. Schedule updated.`
    : `✅ <b>${esc(medLabel)}</b> — taken ${when}${by}`;
}

/** A collapsed one-liner replacing a superseded nudge, so the chat stays readable. */
export function renderCollapsed(medLabel: string, z: Zone, dueAt: number): string {
  return `<i>💊 ${esc(medLabel)} — reminder from ${z.fmtTime12(dueAt)}</i>`;
}

/**
 * The tap-through editor.
 *
 * `/edit <med> every 3h` is precise but assumes you remember the syntax. For the handful of
 * changes people actually make mid-course, offering the plausible values as buttons means
 * nobody has to memorise anything -- which is the whole point of keeping the prescription
 * out of the source code.
 */
export function renderEditMenu(med: Medicine, z: Zone): Rendered {
  const rows: InlineButton[][] = [];
  const set = (field: string, value: string, label: string): InlineButton => ({
    text: label,
    callback_data: encodeCallback({ a: 'editSet', medId: med.id, field, value }),
  });

  const lines = [
    `✏️ <b>${esc(med.name)}</b>`,
    med.doseText === null ? '' : esc(med.doseText),
  ];

  if (med.kind === 'interval' || med.kind === 'fixed_times') {
    if (med.kind === 'interval') {
      const total = Math.round((med.intervalMs ?? 0) / MINUTE);
      const h = Math.floor(total / 60);
      const m = total % 60;
      lines.push('', `Currently every ${h === 0 ? `${m}m` : m === 0 ? `${h}h` : `${h}h ${m}m`}${med.spec.anchor === 'wake' ? ' from waking' : ''}.`);
    } else {
      lines.push('', `Currently at ${(med.spec.times ?? []).join(', ')}.`);
    }

    // How many a day is the change people actually make mid-course -- a doctor says
    // "drop it to three times a day", not "make it every four hours and forty minutes".
    lines.push('<i>How many times a day?</i>');
    rows.push([2, 3, 4].map((n) => set('perday', String(n), `${n}× a day`)));
    rows.push([5, 6, 8].map((n) => set('perday', String(n), `${n}× a day`)));

    if (med.kind === 'interval') {
      const hours = (med.intervalMs ?? 0) / HOUR;
      lines.push('<i>Or set the gap directly:</i>');
      const choices = [2, 3, 4, 6].filter((x) => x !== hours);
      rows.push(choices.map((x) => set('every', `${x}h`, `every ${x}h`)));
    }
  }

  if (med.steps.length > 1) {
    const cur = Math.round(med.stepSpacingMs / MINUTE);
    lines.push(`${med.steps.length} drops, ${cur} minutes apart.`);
    rows.push([5, 10, 15, 20].filter((m) => m !== cur).map((m) => set('spacing', `${m}m`, `${m}m apart`)));
  }

  rows.push([
    { text: '⏸ Pause', callback_data: encodeCallback({ a: 'editSet', medId: med.id, field: 'status', value: 'paused' }) },
    { text: '⏹ Stop', callback_data: encodeCallback({ a: 'editSet', medId: med.id, field: 'status', value: 'stopped' }) },
    { text: '⏳ +3 days', callback_data: encodeCallback({ a: 'editSet', medId: med.id, field: 'extend', value: '3d' }) },
  ]);

  lines.push('', '<i>For anything else: <code>/edit ' + esc(med.medKey) + ' dose 2 drops</code></i>');
  void z;
  return { text: lines.filter((l) => l !== '').join('\n'), buttons: rows };
}
