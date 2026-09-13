/**
 * Inline button presses.
 *
 * The important one is acknowledgment. Two people tapping "Taken" within the same second
 * produce two concurrent Worker invocations, and D1 offers no interactive transaction to
 * arbitrate between them -- so the decision is made by a guarded UPDATE, and whoever's
 * statement actually changed a row is the one that advances the schedule. The other is
 * told who beat them to it.
 */

import { decodeCallback } from '../core/callbackCodec.js';
import { renderConfirmation, renderEarlierMenu } from '../core/render.js';
import { HOUR, MINUTE, fmtDuration, zoneFor } from '../core/tz.js';
import { parseDuration } from '../core/timeparse.js';
import { dosesPerDayInterval } from '../core/prescription.js';
import { Db } from '../io/db.js';
import { Telegram, esc } from '../io/telegram.js';
import { broadcast, clearPromptMessages } from './dispatch.js';
import { applyImport, editMenuFor } from './commands.js';
import type { CmdCtx } from './commands.js';
import type { Env, TgCallbackQuery } from '../types.js';

export async function handleCallback(
  env: Env,
  db: Db,
  tg: Telegram,
  q: TgCallbackQuery,
  now: number,
): Promise<void> {
  const chatId = q.message?.chat.id ?? q.from.id;
  const userName = q.from.first_name ?? 'someone';
  const cb = decodeCallback(q.data ?? '');

  const ack = async (text?: string, alert = false): Promise<void> => {
    await tg.answerCallbackQuery(q.id, text, alert);
  };

  if (cb.a === 'noop') {
    await ack();
    return;
  }

  const links = await db.linksForChat(chatId);
  if (links.length === 0) {
    await ack('This chat is not set up — send /start.', true);
    return;
  }

  const ctx: CmdCtx = { env, db, tg, chatId, userName, now };

  // --- prescription confirmation ------------------------------------------
  if (cb.a === 'confirmImport' || cb.a === 'cancelImport') {
    if (cb.a === 'cancelImport') {
      await ack('Cancelled — nothing changed.');
      if (q.message !== undefined) {
        await tg.editMessageText(chatId, q.message.message_id, '✖️ <i>Import cancelled — nothing changed.</i>');
      }
      return;
    }
    await ack('Applying…');
    const summary = await applyImport(ctx, cb.versionId);
    if (q.message !== undefined) await tg.editMessageText(chatId, q.message.message_id, summary);
    else await tg.sendMessage(chatId, summary);
    return;
  }

  // --- ending a caregiver arrangement ---------------------------------------
  if (cb.a === 'unlink') {
    // Either side may end it: the caregiver stepping back, or the patient removing them.
    const isTheCaregiver = cb.chatId === chatId;
    const isThePatient = links.some((l) => l.patientId === cb.patientId && l.role === 'patient');
    if (!isTheCaregiver && !isThePatient) {
      await ack('That is not yours to change.', true);
      return;
    }

    const patient = await db.getPatient(cb.patientId);
    const carers = await db.caregiversFor(cb.patientId);
    const leaving = carers.find((c) => c.chatId === cb.chatId);

    const removed = await db.unlinkChat(cb.chatId, cb.patientId, now);
    if (!removed) {
      await ack('That link is already gone.');
      return;
    }
    await ack('Removed.');

    const who = leaving?.displayName ?? 'Your backup';
    const name = patient?.displayName ?? 'them';

    if (isTheCaregiver) {
      await tg.sendMessage(chatId, `👋 You've stopped backing up <b>${esc(name)}</b>.`);
    } else {
      await tg.sendMessage(chatId, `✖️ <b>${esc(who)}</b> is no longer your backup.`);
    }

    // Whoever did not press the button still needs to know the arrangement has ended --
    // on one side someone believes they are being watched, on the other someone believes
    // they are watching.
    if (!isTheCaregiver) {
      await tg.sendMessage(
        cb.chatId,
        `👋 <b>${esc(name)}</b> has removed you as their backup. You won't get their reminders any more.`,
      );
    } else {
      for (const chat of await db.chatsFor(cb.patientId)) {
        if (chat.role !== 'patient') continue;
        await tg.sendMessage(
          chat.chatId,
          `🛟 <b>${esc(who)}</b> has stopped being your backup.\n\n` +
            'Nobody else will be told if you miss something. Send /invite to set up someone new.',
        );
      }
    }
    return;
  }

  // --- the tap-through editor ----------------------------------------------
  if (cb.a === 'editMenu' || cb.a === 'editSet') {
    const med = await db.getMed(cb.medId);
    if (med === null) {
      await ack('That medicine is gone.');
      return;
    }
    // A caregiver for one patient must not be able to edit another's medicine.
    const link = links.find((l) => l.patientId === med.patientId && l.canAck);
    if (link === undefined) {
      await ack('You cannot change this one.', true);
      return;
    }

    if (cb.a === 'editSet') {
      const applied = await applyEdit(db, med.id, cb.field, cb.value, chatId, now);
      if (applied === null) {
        await ack('That change did not work.');
        return;
      }
      await db.wakeNow(med.patientId, now);
      await ack(`✓ ${applied}`);
      if (q.message !== undefined) {
        const refreshed = await editMenuFor(ctx, med.id);
        const note = `\n\n✅ <i>${esc(applied)}</i>`;
        if (refreshed !== null) {
          await tg.editMessageText(chatId, q.message.message_id, refreshed.text + note, {
            replyMarkup: { inline_keyboard: refreshed.buttons },
          });
        }
      }
      return;
    }

    const menu = await editMenuFor(ctx, med.id);
    await ack();
    if (menu !== null) {
      await tg.sendMessage(chatId, menu.text, { replyMarkup: { inline_keyboard: menu.buttons } });
    }
    return;
  }

  // --- day state -----------------------------------------------------------
  if (cb.a === 'wake' || cb.a === 'sleep') {
    const link = links.find((l) => l.role === 'patient') ?? links[0]!;
    const patient = await db.getPatient(link.patientId);
    if (patient === null) {
      await ack();
      return;
    }
    const z = zoneFor(patient.tz);
    await db.setWake(patient.id, cb.a === 'wake' ? 'awake' : 'asleep', now, z.localDay(now), 'button', chatId);
    for (const prompt of await db.openPromptsFor(patient.id)) {
      if (prompt.kind === cb.a) {
        await db.closePrompt(prompt.id, 'resolved', now);
        await clearPromptMessages({ db, tg, z, now }, prompt.id);
      }
    }
    await ack(cb.a === 'wake' ? 'Good morning!' : 'Sleep well.');
    await tg.sendMessage(
      chatId,
      cb.a === 'wake'
        ? "☀️ Good morning. Starting today's schedule."
        : "🌙 Goodnight — I'll keep quiet until morning.",
    );
    return;
  }

  // --- meals ---------------------------------------------------------------
  if (cb.a === 'mealAt' || cb.a === 'planMeal') {
    const link = links.find((l) => l.role === 'patient') ?? links[0]!;
    const patient = await db.getPatient(link.patientId);
    if (patient === null) {
      await ack();
      return;
    }
    const z = zoneFor(patient.tz);
    // Either "yes, around then" / "push it back" against a proposed time, or a plain
    // "in about an hour".
    const plannedAt = cb.a === 'mealAt' ? cb.at : now + cb.inMinutes * MINUTE;
    await db.recordMeal(patient.id, cb.meal, z.localDay(now), plannedAt, 'planned', plannedAt);
    await db.wakeNow(patient.id, now);
    for (const prompt of await db.openPromptsFor(patient.id)) {
      if (prompt.kind === 'meal' && prompt.body.meal === cb.meal) {
        await db.closePrompt(prompt.id, 'resolved', now);
        await clearPromptMessages({ db, tg, z, now }, prompt.id);
      }
    }
    await ack(`Noted — ${cb.meal} around ${z.fmtTime12(plannedAt)}.`);
    await tg.sendMessage(
      chatId,
      `🍽 <b>${esc(cb.meal)}</b> at about ${z.fmtTime12(plannedAt)}.\n` +
        `<i>I'll remind you about anything that needs taking before it.</i>`,
    );
    return;
  }

  if (cb.a === 'ate' || cb.a === 'skipMeal') {
    const link = links.find((l) => l.role === 'patient') ?? links[0]!;
    const patient = await db.getPatient(link.patientId);
    if (patient === null) {
      await ack();
      return;
    }
    const z = zoneFor(patient.tz);
    await db.recordMeal(patient.id, cb.meal, z.localDay(now), now, cb.a === 'ate' ? 'confirmed' : 'skipped');
    await db.wakeNow(patient.id, now);
    for (const prompt of await db.openPromptsFor(patient.id)) {
      if (prompt.kind === 'meal' && prompt.body.meal === cb.meal) {
        await db.closePrompt(prompt.id, 'resolved', now);
        await clearPromptMessages({ db, tg, z, now }, prompt.id);
      }
    }
    await ack(cb.a === 'ate' ? 'Noted.' : 'Skipping it.');
    return;
  }

  // --- the "taken earlier" menu -------------------------------------------
  if (cb.a === 'earlier' && q.message !== undefined) {
    const dose = await db.getDose(cb.doseId);
    if (dose === null) {
      await ack('That reminder has moved on.');
      return;
    }
    const patient = await db.getPatient(dose.patientId);
    const z = zoneFor(patient?.tz ?? 'UTC');
    // The first tap opens the menu; the choices inside it carry a real offset.
    if (cb.minutesAgo === 30 && q.data?.endsWith('.u') !== true) {
      const menu = renderEarlierMenu(cb.doseId, z, now);
      await ack();
      await tg.editMessageText(chatId, q.message.message_id, menu.text, {
        replyMarkup: { inline_keyboard: menu.buttons },
      });
      return;
    }
  }

  // --- dose resolution (the contended path) --------------------------------
  if (cb.a === 'take' || cb.a === 'skip' || cb.a === 'snooze' || cb.a === 'earlier') {
    const dose = await db.getDose(cb.doseId);
    if (dose === null) {
      await ack('That reminder has moved on.');
      return;
    }
    const link = links.find((l) => l.patientId === dose.patientId);
    if (link === undefined || !link.canAck) {
      // A caregiver linked to two people must not be able to resolve across them.
      await ack('You cannot answer for this one.', true);
      return;
    }

    const patient = await db.getPatient(dose.patientId);
    if (patient === null) {
      await ack();
      return;
    }
    const z = zoneFor(patient.tz);
    const med = await db.getMed(dose.medId);
    const label = med === null ? 'that' : med.steps.length > 1 ? (med.steps[dose.step]?.name ?? med.name) : med.name;
    const dctx = { db, tg, z, now };

    if (cb.a === 'snooze') {
      const moved = await db.snoozeDose(dose.id, now + cb.minutes * MINUTE, now);
      if (!moved) {
        await ack('Already answered.');
        return;
      }
      if (dose.promptId !== null) {
        await db.closePrompt(dose.promptId, 'cancelled', now);
        await clearPromptMessages(dctx, dose.promptId);
      }
      await db.wakeNow(patient.id, now + cb.minutes * MINUTE);
      await ack(`I'll ask again in ${fmtDuration(cb.minutes * MINUTE)}.`);
      return;
    }

    const takenAt = cb.a === 'earlier' ? now - cb.minutesAgo * MINUTE : now;
    const status = cb.a === 'skip' ? 'skipped' : 'taken';
    const res = await db.tryResolveDose(dose.id, chatId, status, status === 'taken' ? takenAt : null, now, 'button');

    if (!res.won) {
      // Someone else got there first. Say so plainly rather than pretending it worked.
      const byChat = res.alreadyBy;
      await ack(byChat !== null && byChat !== chatId ? 'Already recorded by the other chat.' : 'Already recorded.');
      if (q.message !== undefined) await tg.deleteMessage(chatId, q.message.message_id);
      return;
    }

    if (dose.promptId !== null) {
      await db.closePrompt(dose.promptId, 'resolved', now);
      await clearPromptMessages(dctx, dose.promptId);
    }

    await ack(status === 'taken' ? '✅ Recorded' : '⏭ Skipped');

    const chats = await db.chatsFor(patient.id);
    const line =
      status === 'skipped'
        ? `⏭ <b>${esc(label)}</b> — skipped${chats.length > 1 ? ` by ${esc(userName)}` : ''}`
        : renderConfirmation(label, takenAt, z, chats.length > 1 ? userName : null, cb.a === 'earlier');
    await broadcast(dctx, chats, line);
    return;
  }

  // --- "all taken" on a merged checklist -----------------------------------
  if (cb.a === 'takeAll') {
    const prompt = await db.getPrompt(cb.promptId);
    if (prompt === null || prompt.state !== 'open') {
      await ack('Already answered.');
      return;
    }
    const patient = await db.getPatient(prompt.patientId);
    if (patient === null) {
      await ack();
      return;
    }
    const link = links.find((l) => l.patientId === prompt.patientId);
    if (link === undefined || !link.canAck) {
      await ack('You cannot answer for this one.', true);
      return;
    }
    const z = zoneFor(patient.tz);
    const labels: string[] = [];
    for (const doseId of prompt.body.doseIds) {
      const res = await db.tryResolveDose(doseId, chatId, 'taken', now, now, 'button');
      if (res.won && res.med !== null) labels.push(res.med.name);
    }
    await db.closePrompt(prompt.id, 'resolved', now);
    await clearPromptMessages({ db, tg, z, now }, prompt.id);
    await ack('✅ All recorded');
    if (labels.length > 0) {
      const chats = await db.chatsFor(patient.id);
      await broadcast(
        { db, tg, z, now },
        chats,
        renderConfirmation(labels.join(', '), now, z, chats.length > 1 ? userName : null, false),
      );
    }
  }
}

/** Apply one tapped change. Returns a human description, or null if it was rejected. */
async function applyEdit(
  db: Db,
  medId: number,
  field: string,
  value: string,
  chatId: number,
  now: number,
): Promise<string | null> {
  const med = await db.getMed(medId);
  if (med === null) return null;

  switch (field) {
    case 'perday': {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > 12) return null;
      const patient = await db.getPatient(med.patientId);
      if (patient === null) return null;
      const ms = dosesPerDayInterval(patient.morningPollAt, patient.eveningPollAt, n);
      await db.updateMed(
        medId,
        {
          intervalMs: ms,
          minGapMs: Math.min(med.minGapMs, Math.floor(ms * 0.75)),
          spec: { kind: 'interval', intervalMs: ms, anchor: 'wake' },
        },
        { rescheduleNow: true },
        now,
      );
      await db.audit(med.patientId, 'med_edited', String(chatId), { medId, field, value }, now);
      return `now ${n} time${n === 1 ? '' : 's'} a day`;
    }
    case 'every': {
      const ms = parseDuration(value);
      if (ms === null || ms < 5 * MINUTE) return null;
      await db.updateMed(
        medId,
        { intervalMs: ms, minGapMs: Math.min(med.minGapMs, Math.floor(ms * 0.75)), spec: { ...med.spec, kind: 'interval', intervalMs: ms } },
        { rescheduleNow: true },
        now,
      );
      await db.audit(med.patientId, 'med_edited', String(chatId), { medId, field, value }, now);
      return `now every ${fmtDuration(ms)}`;
    }
    case 'spacing': {
      const ms = parseDuration(value);
      if (ms === null || med.steps.length < 2) return null;
      await db.updateMed(medId, { stepSpacingMs: ms }, { rescheduleNow: true }, now);
      await db.audit(med.patientId, 'med_edited', String(chatId), { medId, field, value }, now);
      return `now ${fmtDuration(ms)} apart`;
    }
    case 'status': {
      const next = value === 'paused' ? 'paused' : 'discontinued';
      await db.setMedStatus(medId, next, now);
      await db.audit(med.patientId, 'med_edited', String(chatId), { medId, field, value }, now);
      return next === 'paused' ? 'paused' : 'stopped';
    }
    case 'extend': {
      const ms = parseDuration(value);
      if (ms === null) return null;
      const days = Math.max(1, Math.round(ms / (24 * HOUR)));
      const total = (med.courseDays ?? 0) + days;
      await db.updateMed(medId, { courseKind: 'days', courseDays: total }, { rescheduleNow: false }, now);
      if (med.status === 'completed') await db.setMedStatus(medId, 'active', now);
      await db.audit(med.patientId, 'course_extended', String(chatId), { medId, extraDays: days }, now);
      return `course extended to ${total} days`;
    }
    default:
      return null;
  }
}
