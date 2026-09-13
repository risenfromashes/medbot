/**
 * The command surface.
 *
 * This is what keeps the prescription out of the source code: importing a new one,
 * pausing a medicine, changing a dose and logging something after the fact are all things
 * a person does from their phone, not something that requires an edit and a redeploy.
 */

import type { Medicine, Patient } from '../core/domain.js';
import { describeCourse, describeSchedule, hashString, parsePrescription } from '../core/prescription.js';
import { PRESCRIPTION_PROMPT_PARTS } from '../core/promptText.js';
import type { NormalizedPrescription } from '../core/prescription.js';
import { renderConfirmation, renderEditMenu } from '../core/render.js';
import { resolveRetro } from '../core/retro.js';
import { parseDuration, parseTime, splitTrailingTime } from '../core/timeparse.js';
import { HOUR, MINUTE, fmtDuration, isValidTimeZone, parseWall, zoneFor } from '../core/tz.js';
import type { Zone } from '../core/tz.js';
import { Db } from '../io/db.js';
import { AdminDb } from '../io/adminDb.js';
import { Telegram, esc } from '../io/telegram.js';
import type { Env, TgIncomingMessage } from '../types.js';
import { broadcast, clearPromptMessages } from './dispatch.js';
import { encodeCallback } from '../core/callbackCodec.js';

export const COMMANDS = [
  { command: 'status', description: "What's pending and what's next" },
  { command: 'took', description: 'Log a dose — optionally at a past time, e.g. /took drop_a 5pm' },
  { command: 'awake', description: "Start the day (accepts a time, e.g. /awake 6:30am)" },
  { command: 'sleep', description: 'End the day' },
  { command: 'ate', description: 'Record a meal, e.g. /ate lunch 1pm' },
  { command: 'eating', description: "Say when you'll eat, e.g. /eating lunch in 1h" },
  { command: 'meds', description: 'List medicines and their schedules' },
  { command: 'skip', description: 'Skip the pending dose of a medicine' },
  { command: 'snooze', description: 'Push a reminder back, e.g. /snooze drop_a 15m' },
  { command: 'undo', description: 'Reverse the last thing you logged' },
  { command: 'import', description: 'Load a prescription (paste or attach the JSON)' },
  { command: 'prompt', description: 'Get the prompt for turning a prescription photo into JSON' },
  { command: 'edit', description: 'Change a medicine, e.g. /edit drop_a every 3h' },
  { command: 'extend', description: 'Add days to a course, e.g. /extend drop_a 3d' },
  { command: 'export', description: 'Get the current prescription back as JSON' },
  { command: 'log', description: 'Recent adherence' },
  { command: 'pause', description: 'Pause a medicine' },
  { command: 'resume', description: 'Resume a paused medicine' },
  { command: 'stop', description: 'Stop a medicine for good' },
  { command: 'tz', description: 'Set the timezone, e.g. /tz Asia/Dhaka' },
  { command: 'invite', description: 'Get a code so someone can back you up' },
  { command: 'patients', description: 'Who this chat is linked to' },
  { command: 'settings', description: 'Your day, timezone and reminder settings' },
  { command: 'caregiver', description: 'Link this chat as a backup for someone' },
  { command: 'help', description: 'How all of this works' },
];

export interface CmdCtx {
  env: Env;
  db: Db;
  tg: Telegram;
  chatId: number;
  userName: string;
  now: number;
}

const reply = async (ctx: CmdCtx, text: string, buttons?: Array<Array<{ text: string; callback_data: string }>>): Promise<void> => {
  await ctx.tg.sendMessage(ctx.chatId, text, buttons !== undefined ? { replyMarkup: { inline_keyboard: buttons } } : {});
};

/** Which patient is this chat acting for? */
async function activePatient(ctx: CmdCtx): Promise<{ patient: Patient; z: Zone; canAck: boolean } | null> {
  const links = await ctx.db.linksForChat(ctx.chatId);
  if (links.length === 0) return null;
  // Prefer the chat's own patient over anyone they merely watch.
  const self = links.find((l) => l.role === 'patient') ?? links[0]!;
  const patient = await ctx.db.getPatient(self.patientId);
  if (patient === null) return null;
  return { patient, z: zoneFor(patient.tz), canAck: self.canAck };
}

/** Match a user-typed medicine name against the patient's list, loosely but safely. */
function matchMed(meds: Medicine[], query: string): Medicine[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [];
  const exact = meds.filter((m) => m.medKey.toLowerCase() === q || m.name.toLowerCase() === q);
  if (exact.length > 0) return exact;
  const prefix = meds.filter((m) => m.medKey.toLowerCase().startsWith(q) || m.name.toLowerCase().startsWith(q));
  if (prefix.length > 0) return prefix;
  const contains = meds.filter(
    (m) => m.name.toLowerCase().includes(q) || m.steps.some((s) => s.name.toLowerCase().includes(q)),
  );
  return contains;
}

export async function handleCommand(ctx: CmdCtx, msg: TgIncomingMessage): Promise<void> {
  const text = (msg.text ?? msg.caption ?? '').trim();
  const m = /^\/([a-z_]+)(?:@\S+)?\s*([\s\S]*)$/i.exec(text);
  const cmd = m === null ? '' : m[1]!.toLowerCase();
  const args = m === null ? '' : m[2]!.trim();

  // A document attachment is almost always a prescription, whatever the caption says.
  if (msg.document !== undefined && (cmd === 'import' || cmd === '')) {
    await cmdImport(ctx, args, msg);
    return;
  }

  switch (cmd) {
    case 'start': return cmdStart(ctx, args);
    case 'help': return cmdHelp(ctx);
    case 'awake': case 'wokeup': case 'up': return cmdWake(ctx, 'wake', args);
    case 'sleep': case 'bed': case 'goodnight': return cmdWake(ctx, 'sleep', args);
    case 'ate': case 'eaten': return cmdAte(ctx, args);
    case 'eating': case 'plan': return cmdEating(ctx, args);
    case 'took': case 'take': case 'taken': return cmdTook(ctx, args);
    case 'skip': return cmdSkip(ctx, args);
    case 'snooze': return cmdSnooze(ctx, args);
    case 'undo': return cmdUndo(ctx);
    case 'status': return cmdStatus(ctx);
    case 'meds': case 'medicines': return cmdMeds(ctx);
    case 'import': return cmdImport(ctx, args, msg);
    case 'prompt': case 'template': case 'json': return cmdPrompt(ctx);
    case 'edit': case 'set': return cmdEdit(ctx, args);
    case 'extend': return cmdExtend(ctx, args);
    case 'add': case 'new': return cmdAdd(ctx, args);
    case 'export': case 'prescription': return cmdExport(ctx);
    case 'log': case 'adherence': return cmdLog(ctx, args);
    case 'pause': return cmdMedStatus(ctx, args, 'paused');
    case 'resume': return cmdMedStatus(ctx, args, 'active');
    case 'stop': return cmdMedStatus(ctx, args, 'discontinued');
    case 'tz': case 'timezone': return cmdTz(ctx, args);
    case 'patients': return cmdPatients(ctx);
    case 'settings': return cmdSettings(ctx, args);
    case 'invite': return cmdInvite(ctx);
    case 'caregiver': case 'watch': return cmdCaregiver(ctx, args);
    case 'health': return cmdHealth(ctx);
    default:
      if (cmd === '') return freeText(ctx, text);
      await reply(ctx, `I don't know <code>/${esc(cmd)}</code>. Try /help.`);
  }
}

/** Bare words that ought to just work, because people type them. */
async function freeText(ctx: CmdCtx, text: string): Promise<void> {
  const t = text.toLowerCase().trim();
  if (/^(taken|done|took it|yes|✅)$/.test(t)) return cmdTook(ctx, '');
  if (/^(awake|i'm up|im up|good morning|morning)$/.test(t)) return cmdWake(ctx, 'wake', '');
  if (/^(sleeping|going to bed|good ?night|bed)$/.test(t)) return cmdWake(ctx, 'sleep', '');
  // A pasted prescription needs no ceremony.
  if (t.startsWith('{') && t.includes('medicines')) return cmdImport(ctx, text, { message_id: 0, chat: { id: ctx.chatId, type: 'private' }, date: 0 });
  await reply(ctx, 'Not sure what you meant — /help lists everything I understand.');
}

// --- linking -------------------------------------------------------------

async function cmdStart(ctx: CmdCtx, args: string): Promise<void> {
  const existing = await ctx.db.linksForChat(ctx.chatId);
  if (existing.length > 0) {
    await reply(ctx, "You're already set up here. /status shows what's pending, /help lists everything.");
    return;
  }

  const code = args.trim().split(/\s+/)[0] ?? '';
  if (code === '') {
    await reply(
      ctx,
      "🔒 <b>This bot is private.</b>\n\nYou need an invite code from whoever runs it:\n" +
        '<code>/start ABCD1234</code>',
    );
    return;
  }

  // Single use and expiring, rather than one fixed password that would let anyone in
  // forever once it leaked.
  const adb = new AdminDb(ctx.env.MEDBOT_DB);
  const result = await adb.redeemInvite(code, ctx.chatId, ctx.now);
  if (!result.ok) {
    const why =
      result.reason === 'used' ? 'That code has already been used.'
      : result.reason === 'expired' ? 'That code has expired.'
      : 'That code is not valid.';
    await reply(ctx, `🔒 ${why}\n\nAsk for a fresh one — each code works once.`);
    return;
  }

  const invite = result.invite!;

  if (invite.kind === 'caregiver' && invite.patientId !== null) {
    const patient = await ctx.db.getPatient(invite.patientId);
    const delay = invite.escalateAfterMs ?? 5 * MINUTE;
    await ctx.db.linkChat(ctx.chatId, invite.patientId, 'caregiver', 1, delay, ctx.now);
    await reply(
      ctx,
      `✅ You're now the backup for <b>${esc(patient?.displayName ?? 'them')}</b>.\n\n` +
        `If they don't answer a reminder within ${fmtDuration(delay)} — medicines, meals, waking up, ` +
        "going to bed — I'll ask you instead, and you can answer on their behalf. Otherwise I'll leave you alone.",
    );
    return;
  }

  const patientId = await ctx.db.createPatient(ctx.userName, 'UTC', ctx.now);
  await ctx.db.linkChat(ctx.chatId, patientId, 'patient', 0, 5 * MINUTE, ctx.now);
  await reply(
    ctx,
    `👋 Hello ${esc(ctx.userName)}.\n\n` +
      "I'll remind you to take your medicines, and keep asking until you tell me you have.\n\n" +
      '<b>Two things to do next</b>\n' +
      '1. <code>/tz Asia/Dhaka</code> — so I know what time it is for you.\n' +
      '2. <code>/import</code> — send me your prescription as JSON.\n\n' +
      "Don't have the JSON? Photograph your prescription, give it to any AI chatbot with the " +
      'template from /help, and paste back what it gives you. I check it carefully before anything takes effect.',
  );
}

async function cmdInvite(ctx: CmdCtx): Promise<void> {
  const ap = await activePatient(ctx);
  if (ap === null) return needsSetup(ctx);

  const adb = new AdminDb(ctx.env.MEDBOT_DB);
  const invite = await adb.createInvite(
    'caregiver',
    {
      patientId: ap.patient.id,
      label: ap.patient.displayName,
      escalateAfterMs: 5 * MINUTE,
      createdBy: String(ctx.chatId),
      ttlMs: 24 * 60 * MINUTE,
    },
    ctx.now,
  );

  await reply(
    ctx,
    `<b>Backup code: <code>${invite.code}</code></b>\n\n` +
      'Send that to whoever should look after you. They open this bot and send:\n' +
      `<code>/start ${invite.code}</code>\n\n` +
      "They'll then get any reminder you haven't answered within five minutes — medicines, meals, " +
      'waking up, going to bed — and they can answer on your behalf.\n\n' +
      '<i>Single use, expires in 24 hours.</i>',
  );
}

async function cmdCaregiver(ctx: CmdCtx, args: string): Promise<void> {
  const code = args.trim().split(/\s+/)[0] ?? '';

  if (code === '') {
    const links = await ctx.db.linksForChat(ctx.chatId);
    const lines = await Promise.all(
      links.map(async (l) => {
        const p = await ctx.db.getPatient(l.patientId);
        return `• <b>${esc(p?.displayName ?? '?')}</b> — ${l.role}${l.escalationTier > 0 ? `, after ${fmtDuration(l.escalateAfterMs)} of silence` : ', immediately'}`;
      }),
    );
    await reply(
      ctx,
      (lines.length > 0 ? `You are linked to:\n${lines.join('\n')}\n\n` : 'This chat is not linked to anyone yet.\n\n') +
        "To become someone's backup, ask them to run <code>/invite</code>, then send me the code:\n" +
        '<code>/caregiver ABCD1234</code>',
    );
    return;
  }

  const adb = new AdminDb(ctx.env.MEDBOT_DB);
  const result = await adb.redeemInvite(code, ctx.chatId, ctx.now);
  if (!result.ok) {
    const why =
      result.reason === 'used' ? 'That code has already been used.'
      : result.reason === 'expired' ? 'That code has expired.'
      : 'That code is not valid.';
    await reply(ctx, `${why} Ask them to run /invite again — each code works once.`);
    return;
  }

  const invite = result.invite!;
  if (invite.kind !== 'caregiver' || invite.patientId === null) {
    await reply(ctx, 'That code is for joining as a new member. Send <code>/start ' + esc(code) + '</code> instead.');
    return;
  }

  const delay = invite.escalateAfterMs ?? 5 * MINUTE;
  const patient = await ctx.db.getPatient(invite.patientId);
  await ctx.db.linkChat(ctx.chatId, invite.patientId, 'caregiver', 1, delay, ctx.now);
  await reply(
    ctx,
    `✅ You're now the backup for <b>${esc(patient?.displayName ?? 'them')}</b>.\n\n` +
      `If they don't answer within ${fmtDuration(delay)} — medicines, meals, waking up, going to bed — ` +
      "I'll ask you instead, and you can answer on their behalf. Otherwise I'll leave you alone.",
  );
}

// --- day state -----------------------------------------------------------

async function cmdWake(ctx: CmdCtx, kind: 'wake' | 'sleep', args: string): Promise<void> {
  const ap = await activePatient(ctx);
  if (ap === null) return needsSetup(ctx);
  const { patient, z } = ap;

  let at = ctx.now;
  let suffix = '';
  if (args.trim() !== '') {
    const parsed = parseTime(args, ctx.now, z);
    if (parsed === null) {
      await reply(ctx, `I couldn't read "${esc(args)}" as a time. Try <code>/${kind === 'wake' ? 'awake' : 'sleep'} 6:30am</code> or <code>20m ago</code>.`);
      return;
    }
    if (parsed.at > ctx.now + MINUTE) {
      await reply(ctx, "That's in the future — I can only record something that has already happened.");
      return;
    }
    at = parsed.at;
    suffix = ` (recorded as ${z.fmtTime12(at)})`;
  }

  await ctx.db.setWake(patient.id, kind === 'wake' ? 'awake' : 'asleep', at, z.localDay(at), 'command', ctx.chatId);
  for (const q of await ctx.db.openPromptsFor(patient.id)) {
    if (q.kind === kind) {
      await ctx.db.closePrompt(q.id, 'resolved', ctx.now);
      await clearPromptMessages({ db: ctx.db, tg: ctx.tg, z, now: ctx.now }, q.id);
    }
  }

  await reply(
    ctx,
    kind === 'wake'
      ? `☀️ Good morning${suffix}. Starting today's schedule — I'll let you know when something is due.`
      : `🌙 Sleep well${suffix}. I'll keep quiet until morning.`,
  );
}

/**
 * "I'm eating in an hour." The forward-looking half of meal handling, and the only way a
 * before-meal tablet can be timed at all.
 */
async function cmdEating(ctx: CmdCtx, args: string): Promise<void> {
  const ap = await activePatient(ctx);
  if (ap === null) return needsSetup(ctx);
  const { patient, z } = ap;

  const parts = args.trim().split(/\s+/).filter((x) => x !== '');
  const meal = (parts[0] ?? '').toLowerCase();
  if (meal === '') {
    await reply(
      ctx,
      "When are you eating? e.g. <code>/eating lunch in 1h</code> or <code>/eating dinner at 8pm</code>\n\n" +
        "<i>Knowing in advance is what lets me remind you about anything that goes before the meal.</i>",
    );
    return;
  }

  const rest = parts.slice(1).join(' ').replace(/^(in|at)\s+/i, '').trim();
  let plannedAt: number | null = null;
  if (rest === '') {
    plannedAt = ctx.now + 30 * MINUTE;
  } else {
    const dur = parseDuration(rest);
    if (dur !== null) plannedAt = ctx.now + dur;
    else {
      const t = parseTime(rest, ctx.now, z);
      if (t !== null) {
        // A clock time given now almost always means the next one, not the last.
        plannedAt = t.at <= ctx.now ? t.at + 24 * HOUR : t.at;
        if (plannedAt - ctx.now > 14 * HOUR) plannedAt = t.at;
      }
    }
  }

  if (plannedAt === null) {
    await reply(ctx, `I couldn't read "${esc(rest)}". Try <code>in 45m</code> or <code>at 1pm</code>.`);
    return;
  }
  if (plannedAt < ctx.now - MINUTE) {
    await reply(ctx, `That's in the past — use <code>/ate ${esc(meal)} ${esc(rest)}</code> if you've already eaten.`);
    return;
  }

  await ctx.db.recordMeal(patient.id, meal, z.localDay(ctx.now), plannedAt, 'planned', plannedAt);
  await ctx.db.wakeNow(patient.id, ctx.now);
  for (const q of await ctx.db.openPromptsFor(patient.id)) {
    if (q.kind === 'meal' && q.body.meal === meal) {
      await ctx.db.closePrompt(q.id, 'resolved', ctx.now);
      await clearPromptMessages({ db: ctx.db, tg: ctx.tg, z, now: ctx.now }, q.id);
    }
  }
  await reply(
    ctx,
    `🍽 <b>${esc(meal)}</b> at about ${z.fmtTime12(plannedAt)}.\n` +
      `<i>I'll remind you about anything that needs taking before it.</i>`,
  );
}

async function cmdAte(ctx: CmdCtx, args: string): Promise<void> {
  const ap = await activePatient(ctx);
  if (ap === null) return needsSetup(ctx);
  const { patient, z } = ap;

  const { head, time } = splitTrailingTime(args, ctx.now, z);
  const meal = head.trim().toLowerCase();
  if (meal === '') {
    await reply(ctx, 'Which meal? e.g. <code>/ate lunch</code> or <code>/ate breakfast 8:30am</code>');
    return;
  }
  const at = time?.at ?? ctx.now;
  await ctx.db.recordMeal(patient.id, meal, z.localDay(at), at, 'confirmed');
  await ctx.db.wakeNow(patient.id, ctx.now);
  for (const q of await ctx.db.openPromptsFor(patient.id)) {
    if (q.kind === 'meal' && q.body.meal === meal) {
      await ctx.db.closePrompt(q.id, 'resolved', ctx.now);
      await clearPromptMessages({ db: ctx.db, tg: ctx.tg, z, now: ctx.now }, q.id);
    }
  }
  await reply(ctx, `🍽 Noted — ${esc(meal)} at ${z.fmtTime12(at)}.`);
}

// --- doses ---------------------------------------------------------------

async function cmdTook(ctx: CmdCtx, args: string): Promise<void> {
  const ap = await activePatient(ctx);
  if (ap === null) return needsSetup(ctx);
  const { patient, z } = ap;

  const meds = await ctx.db.medsFor(patient.id);
  const { head, time } = splitTrailingTime(args, ctx.now, z);

  let target: Medicine | null = null;
  if (head.trim() === '') {
    // No medicine named: use whatever is pending, if that is unambiguous.
    const pending: Medicine[] = [];
    for (const med of meds) {
      const live = await ctx.db.liveDoseFor(med.id);
      if (live !== null && (live.status === 'due' || live.status === 'prompted')) pending.push(med);
    }
    if (pending.length === 0) {
      await reply(ctx, "Nothing is pending right now. Name the medicine if you're logging something else: <code>/took drop_a 5pm</code>");
      return;
    }
    if (pending.length > 1) {
      await reply(
        ctx,
        'Which one?\n' + pending.map((p) => `• <code>/took ${esc(p.medKey)}</code> — ${esc(p.name)}`).join('\n'),
      );
      return;
    }
    target = pending[0]!;
  } else {
    const matches = matchMed(meds, head);
    if (matches.length === 0) {
      await reply(ctx, `No medicine matching "${esc(head)}". /meds lists them.`);
      return;
    }
    if (matches.length > 1) {
      await reply(ctx, 'Which one?\n' + matches.map((p) => `• <code>/took ${esc(p.medKey)}</code> — ${esc(p.name)}`).join('\n'));
      return;
    }
    target = matches[0]!;
  }

  const statedAt = time?.at ?? ctx.now;
  if (statedAt > ctx.now + MINUTE) {
    await reply(ctx, "That's in the future. Tell me once you've actually taken it.");
    return;
  }

  const live = await ctx.db.liveDoseFor(target.id);
  const recent = await ctx.db.recentDoses(target.id, 12);
  const outcome = resolveRetro({ med: target, live, recent, statedAt, now: ctx.now });

  if (outcome.kind === 'reject') {
    await reply(
      ctx,
      outcome.reason === 'needs_confirm'
        ? "That's more than a day ago. If you really mean it, say the date too: <code>/took " + esc(target.medKey) + ' yesterday 5pm</code>'
        : esc(outcome.reason),
    );
    return;
  }

  const warn =
    outcome.warning === 'min_gap'
      ? `\n\n⚠️ That's less than ${fmtDuration(target.minGapMs)} after the previous dose. I've recorded it, but please double-check you haven't doubled up.`
      : '';

  const label = target.steps.length > 1 ? `${target.steps[live?.step ?? 0]?.name ?? target.name}` : target.name;
  const chats = await ctx.db.chatsFor(patient.id);
  const dctx = { db: ctx.db, tg: ctx.tg, z, now: ctx.now };

  if (outcome.kind === 'resolve_live') {
    const res = await ctx.db.tryResolveDose(outcome.doseId, ctx.chatId, 'taken', outcome.takenAt, ctx.now, 'command');
    if (!res.won) {
      await reply(ctx, 'That one was already recorded — nothing more to do.');
      return;
    }
    if (live?.promptId != null) {
      await ctx.db.closePrompt(live.promptId, 'resolved', ctx.now);
      await clearPromptMessages(dctx, live.promptId);
    }
    const line = renderConfirmation(label, outcome.takenAt, z, ctx.userName, outcome.takenAt < ctx.now - 2 * MINUTE);
    await reply(ctx, line + warn);
    await broadcast(dctx, chats, line, ctx.chatId);
    return;
  }

  if (outcome.kind === 'correct_past') {
    // The interesting case: a dose already written off as missed. Flipping it also
    // invalidates everything the scheduler built on the wrong assumption.
    const corrected = await ctx.db.correctDose(outcome.doseId, ctx.chatId, outcome.takenAt, ctx.now);
    if (corrected === null) {
      await reply(ctx, "I couldn't find that dose to correct.");
      return;
    }
    if (live?.promptId != null) {
      await ctx.db.closePrompt(live.promptId, 'resolved', ctx.now);
      await clearPromptMessages(dctx, live.promptId);
    }
    const line =
      `✅ <b>${esc(label)}</b> — corrected: recorded as taken at ${z.fmtTime12(outcome.takenAt)}` +
      ` (it was logged as missed). The next dose has been recalculated from there.`;
    await reply(ctx, line + warn);
    await broadcast(dctx, chats, line, ctx.chatId);
    return;
  }

  await ctx.db.audit(patient.id, 'dose_recorded_adhoc', String(ctx.chatId), { medId: target.id, takenAt: outcome.takenAt }, ctx.now);
  await reply(ctx, `✅ Noted — ${esc(label)} at ${z.fmtTime12(outcome.takenAt)}.${warn}`);
}

async function cmdSkip(ctx: CmdCtx, args: string): Promise<void> {
  const ap = await activePatient(ctx);
  if (ap === null) return needsSetup(ctx);
  const meds = await ctx.db.medsFor(ap.patient.id);
  const matches = matchMed(meds, args);
  if (matches.length !== 1) {
    await reply(ctx, matches.length === 0 ? `No medicine matching "${esc(args)}".` : 'Which one? /meds lists them.');
    return;
  }
  const med = matches[0]!;
  const live = await ctx.db.liveDoseFor(med.id);
  if (live === null) {
    await reply(ctx, `Nothing pending for ${esc(med.name)}.`);
    return;
  }
  await ctx.db.tryResolveDose(live.id, ctx.chatId, 'skipped', null, ctx.now, 'command');
  if (live.promptId !== null) {
    await ctx.db.closePrompt(live.promptId, 'resolved', ctx.now);
    await clearPromptMessages({ db: ctx.db, tg: ctx.tg, z: ap.z, now: ctx.now }, live.promptId);
  }
  await reply(ctx, `⏭ Skipped ${esc(med.name)}. I'll remind you at the next one.`);
}

async function cmdSnooze(ctx: CmdCtx, args: string): Promise<void> {
  const ap = await activePatient(ctx);
  if (ap === null) return needsSetup(ctx);
  const parts = args.split(/\s+/).filter((p) => p !== '');
  const durText = parts.length > 1 ? parts[parts.length - 1]! : '';
  const dur = durText !== '' ? parseDuration(durText) : null;
  const nameText = dur !== null ? parts.slice(0, -1).join(' ') : args;

  const meds = await ctx.db.medsFor(ap.patient.id);
  const matches = matchMed(meds, nameText);
  if (matches.length !== 1) {
    await reply(ctx, matches.length === 0 ? `No medicine matching "${esc(nameText)}".` : 'Which one? /meds lists them.');
    return;
  }
  const med = matches[0]!;
  const live = await ctx.db.liveDoseFor(med.id);
  if (live === null) {
    await reply(ctx, `Nothing pending for ${esc(med.name)}.`);
    return;
  }
  const delay = dur ?? 15 * MINUTE;
  await ctx.db.snoozeDose(live.id, ctx.now + delay, ctx.now);
  if (live.promptId !== null) {
    await ctx.db.closePrompt(live.promptId, 'cancelled', ctx.now);
    await clearPromptMessages({ db: ctx.db, tg: ctx.tg, z: ap.z, now: ctx.now }, live.promptId);
  }
  await ctx.db.wakeNow(ap.patient.id, ctx.now + delay);
  await reply(ctx, `⏰ Fine — I'll ask again in ${fmtDuration(delay)}.`);
}

async function cmdUndo(ctx: CmdCtx): Promise<void> {
  await reply(
    ctx,
    'To correct something, just state the truth and I\'ll fix the schedule:\n' +
      '• <code>/took drop_a 5pm</code> — even if I already logged it as missed\n' +
      '• <code>/skip drop_a</code> — if you decided not to take it\n' +
      '• <code>/awake 6:30am</code> — if I started the day at the wrong time',
  );
}

// --- information ---------------------------------------------------------

async function cmdStatus(ctx: CmdCtx): Promise<void> {
  const ap = await activePatient(ctx);
  if (ap === null) return needsSetup(ctx);
  const { patient, z } = ap;
  const meds = await ctx.db.medsFor(patient.id);
  const today = z.localDay(ctx.now);

  const lines: string[] = [
    `<b>${esc(patient.displayName)}</b> · ${z.fmtTime12(ctx.now)}`,
    patient.wakeState === 'awake'
      ? `☀️ Awake${patient.lastWakeAt !== null ? ` since ${z.fmtTime12(patient.lastWakeAt)}` : ''}` +
        (patient.wakeConfidence === 'confirmed' ? '' : ` <i>(${patient.wakeConfidence})</i>`)
      : `🌙 Asleep${patient.lastSleepAt !== null ? ` since ${z.fmtTime12(patient.lastSleepAt)}` : ''}`,
  ];

  if (meds.length === 0) {
    lines.push('', 'No medicines yet — send /import, or /prompt to get the format.');
    await reply(ctx, lines.join('\n'));
    return;
  }

  const pending: string[] = [];
  const upcoming: Array<{ at: number; text: string }> = [];

  for (const med of meds) {
    const live = await ctx.db.liveDoseFor(med.id);
    if (live === null) continue;
    const step = med.steps[live.step];
    const label = med.steps.length > 1
      ? `${step?.name ?? med.name} (${live.step + 1}/${med.steps.length})`
      : med.name;
    const dose = step?.dose ?? med.doseText;
    const withDose = dose === null || dose === undefined ? '' : ` — ${esc(dose)}`;

    if (live.status === 'due' || live.status === 'prompted') {
      pending.push(`• <b>${esc(label)}</b>${withDose}\n  <i>due ${z.fmtTime12(live.effectiveDueAt)}, ${fmtDuration(ctx.now - live.effectiveDueAt)} ago</i>`);
    } else if (live.status === 'deferred') {
      upcoming.push({ at: Number.MAX_SAFE_INTEGER, text: `• ${esc(label)} — <i>waiting until you're up</i>` });
    } else {
      upcoming.push({
        at: live.effectiveDueAt,
        text: `• ${esc(label)} — ${z.fmtTime12(live.effectiveDueAt)} <i>(in ${fmtDuration(live.effectiveDueAt - ctx.now)})</i>`,
      });
    }
  }

  if (pending.length > 0) lines.push('', '<b>Waiting on you</b>', ...pending);
  if (upcoming.length > 0) {
    upcoming.sort((a, b) => a.at - b.at);
    lines.push('', '<b>Coming up</b>', ...upcoming.slice(0, 6).map((u) => u.text));
  }
  if (pending.length === 0 && upcoming.length === 0) lines.push('', 'Nothing scheduled right now.');

  // Today so far, from the same counters the digest uses.
  const rows = await ctx.db.adherence(patient.id, today);
  let taken = 0;
  let missed = 0;
  for (const r of rows) {
    if (r.status === 'taken') taken += r.n;
    if (r.status === 'missed') missed += r.n;
  }
  if (taken > 0 || missed > 0) {
    lines.push('', `<b>Today</b> — ${taken} taken${missed > 0 ? `, ${missed} missed` : ''}`);
  }

  // Meals matter only if something actually depends on them.
  const mealDeps = meds.filter((m) => m.kind === 'meal');
  if (mealDeps.length > 0) {
    const defs = await ctx.db.mealDefsFor(patient.id);
    const events = await ctx.db.mealEventsFor(patient.id, today);
    const mealLine = defs
      .map((d) => {
        const e = events.find((x) => x.meal === d.meal);
        const mark = e === undefined ? '·' : e.source === 'skipped' ? '⏭' : '✅';
        return `${mark} ${d.meal}`;
      })
      .join('  ');
    if (mealLine !== '') lines.push('', `<b>Meals</b>  ${mealLine}`);
  }

  await reply(ctx, lines.join('\n'));
}

async function cmdMeds(ctx: CmdCtx): Promise<void> {
  const ap = await activePatient(ctx);
  if (ap === null) return needsSetup(ctx);
  const meds = await ctx.db.medsFor(ap.patient.id, true);
  if (meds.length === 0) {
    await reply(ctx, 'No medicines yet. Send me a prescription with /import.');
    return;
  }
  const lines = meds.map((m) => {
    const icon = m.status === 'active' ? '💊' : m.status === 'paused' ? '⏸' : m.status === 'completed' ? '🎉' : '⏹';
    const steps = m.steps.length > 1 ? `\n   <i>${m.steps.map((s, i) => `${i + 1}. ${esc(s.name)}`).join(' · ')} — ${fmtDuration(m.stepSpacingMs)} apart</i>` : '';
    const progress =
      m.courseKind === 'days' && m.startedAt !== null
        ? ` · day ${ap.z.diffLocalDays(ap.z.localDay(m.startedAt), ap.z.localDay(ctx.now)) + 1} of ${m.courseDays}`
        : m.courseKind === 'doses'
          ? ` · ${m.dosesTaken}/${m.courseDoses} doses`
          : '';
    return `${icon} <b>${esc(m.name)}</b> <code>${esc(m.medKey)}</code>\n   ${esc(describeSchedule(m))}, ${esc(describeCourse(m))}${progress}${steps}`;
  });
  const buttons = meds
    .filter((m) => m.status === 'active' || m.status === 'paused')
    .slice(0, 8)
    .map((m) => [{ text: `✏️ ${m.name.slice(0, 30)}`, callback_data: encodeCallback({ a: 'editMenu', medId: m.id }) }]);
  await reply(ctx, lines.join('\n\n'), buttons.length > 0 ? buttons : undefined);
}

async function cmdLog(ctx: CmdCtx, args: string): Promise<void> {
  const ap = await activePatient(ctx);
  if (ap === null) return needsSetup(ctx);
  const days = Math.min(30, Math.max(1, Number(args.trim()) || 7));
  const since = ap.z.addLocalDays(ap.z.localDay(ctx.now), -(days - 1));
  const rows = await ctx.db.adherence(ap.patient.id, since);
  const meds = await ctx.db.medsFor(ap.patient.id, true);
  const byMed = new Map<number, { taken: number; missed: number; skipped: number }>();
  for (const r of rows) {
    const e = byMed.get(r.medId) ?? { taken: 0, missed: 0, skipped: 0 };
    if (r.status === 'taken') e.taken = r.n;
    if (r.status === 'missed') e.missed = r.n;
    if (r.status === 'skipped') e.skipped = r.n;
    byMed.set(r.medId, e);
  }
  const lines = meds
    .filter((m) => byMed.has(m.id))
    .map((m) => {
      const e = byMed.get(m.id)!;
      const total = e.taken + e.missed + e.skipped;
      const pct = total === 0 ? 0 : Math.round((e.taken / total) * 100);
      return `• <b>${esc(m.name)}</b> — ${e.taken}/${total} taken (${pct}%)${e.missed > 0 ? `, ${e.missed} missed` : ''}${e.skipped > 0 ? `, ${e.skipped} skipped` : ''}`;
    });
  await reply(ctx, lines.length > 0 ? `<b>Last ${days} days</b>\n${lines.join('\n')}` : 'Nothing logged yet.');
}

async function cmdHealth(ctx: CmdCtx): Promise<void> {
  const hb = await ctx.db.getHeartbeat();
  if (hb === null) {
    await reply(ctx, "⚠️ The scheduler hasn't run yet.");
    return;
  }
  const age = ctx.now - hb.lastTickAt;
  await reply(
    ctx,
    `${age < 5 * MINUTE ? '✅' : '⚠️'} Last tick ${fmtDuration(age)} ago · ${hb.ticksToday} ticks today.`,
  );
}

// --- medicine management --------------------------------------------------

async function cmdMedStatus(ctx: CmdCtx, args: string, status: Medicine['status']): Promise<void> {
  const ap = await activePatient(ctx);
  if (ap === null) return needsSetup(ctx);
  const meds = await ctx.db.medsFor(ap.patient.id, true);
  const matches = matchMed(meds, args);
  if (matches.length !== 1) {
    await reply(ctx, matches.length === 0 ? `No medicine matching "${esc(args)}". /meds lists them.` : 'Which one? /meds lists them.');
    return;
  }
  const med = matches[0]!;
  await ctx.db.setMedStatus(med.id, status, ctx.now);
  await ctx.db.wakeNow(ap.patient.id, ctx.now);
  const word = status === 'paused' ? 'Paused' : status === 'active' ? 'Resumed' : 'Stopped';
  await reply(ctx, `${word} <b>${esc(med.name)}</b>.`);
}

async function cmdTz(ctx: CmdCtx, args: string): Promise<void> {
  const ap = await activePatient(ctx);
  if (ap === null) return needsSetup(ctx);
  const tz = args.trim();
  if (tz === '') {
    await reply(ctx, `Currently <code>${esc(ap.patient.tz)}</code> — it's ${ap.z.fmtTime12(ctx.now)} there.\nChange it with <code>/tz Asia/Dhaka</code>.`);
    return;
  }
  if (!isValidTimeZone(tz)) {
    await reply(ctx, `<code>${esc(tz)}</code> isn't a timezone I recognise. Use an IANA name like <code>Asia/Dhaka</code> or <code>Europe/London</code>.`);
    return;
  }
  await ctx.env.MEDBOT_DB.prepare('UPDATE patients SET tz = ?2, next_action_at = ?3 WHERE id = ?1')
    .bind(ap.patient.id, tz, ctx.now)
    .run();
  const z = zoneFor(tz);
  await reply(ctx, `🕐 Timezone set to <code>${esc(tz)}</code> — it's ${z.fmtTime12(ctx.now)} there now.`);
}

// --- prescriptions --------------------------------------------------------

async function cmdImport(ctx: CmdCtx, args: string, msg: TgIncomingMessage): Promise<void> {
  const ap = await activePatient(ctx);
  if (ap === null) return needsSetup(ctx);

  let raw = args.trim();

  if (msg.document !== undefined) {
    const size = msg.document.file_size ?? 0;
    if (size > 256_000) {
      await reply(ctx, 'That file is too large to be a prescription. Send the JSON as text instead.');
      return;
    }
    const file = await ctx.tg.getFile(msg.document.file_id);
    if (file.ok && file.result !== undefined) {
      const content = await ctx.tg.downloadFile(file.result.file_path);
      if (content !== null) raw = content;
    }
  }

  // Chatbots love to wrap JSON in a fence.
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  if (fence !== null) raw = fence[1]!.trim();

  if (raw === '') {
    await reply(
      ctx,
      '<b>Send me your prescription</b>\n\n' +
        'Paste the JSON, or attach it as a <code>.json</code> file.\n\n' +
        "If you don't have it yet: photograph your prescription, open any AI chatbot, and ask it to " +
        'convert the photo using the format in /help. Paste the result back here.\n\n' +
        "I'll show you exactly what would change and wait for you to confirm.",
    );
    return;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (e) {
    await reply(
      ctx,
      `❌ That isn't valid JSON.\n<code>${esc(e instanceof Error ? e.message : String(e))}</code>\n\n` +
        'If you copied it from a chatbot, make sure you got the whole thing including the outer <code>{</code> and <code>}</code>.',
    );
    return;
  }

  const result = parsePrescription(parsedJson, { now: ctx.now });
  if (!result.ok) {
    await reply(
      ctx,
      `❌ <b>I couldn't use that prescription</b>\n\n${result.errors.map((e) => `• ${esc(e)}`).join('\n')}\n\n` +
        'Fix those and send it again — nothing has changed yet.',
    );
    return;
  }

  const presc = result.value!;
  const diff = await buildDiff(ctx, ap.patient.id, presc);
  const versionId = await ctx.db.stageePrescription(
    ap.patient.id, raw, hashString(raw), diff, ctx.chatId, ctx.now,
  );

  const warnings = result.warnings.length > 0 ? `\n\n<b>Worth checking</b>\n${result.warnings.map((w) => `• ${esc(w)}`).join('\n')}` : '';
  await reply(
    ctx,
    `<b>Here's what would change</b>\n\n${diff}${warnings}\n\n<i>Nothing has been applied yet.</i>`,
    [[
      { text: '✅ Apply', callback_data: encodeCallback({ a: 'confirmImport', versionId }) },
      { text: '✖️ Cancel', callback_data: encodeCallback({ a: 'cancelImport', versionId }) },
    ]],
  );
}

/** Plain English, because the person reading it is holding a prescription, not a diff tool. */
async function buildDiff(ctx: CmdCtx, patientId: number, presc: NormalizedPrescription): Promise<string> {
  const existing = await ctx.db.medsFor(patientId, true);
  const byKey = new Map(existing.map((m) => [m.medKey, m]));
  const lines: string[] = [];

  for (const m of presc.meds) {
    const prev = byKey.get(m.medKey);
    const desc = `${esc(describeSchedule(m))}, ${esc(describeCourse(m))}`;
    const steps = m.steps.length > 1 ? ` <i>(${m.steps.length} drops, ${fmtDuration(m.stepSpacingMs)} apart)</i>` : '';
    if (prev === undefined) {
      lines.push(`➕ <b>${esc(m.name)}</b> — ${desc}${steps}`);
    } else if (prev.specHash !== m.specHash) {
      lines.push(`✏️ <b>${esc(m.name)}</b> — now ${desc}${steps}\n   <i>was ${esc(describeSchedule(prev))}</i>`);
    }
  }

  const incoming = new Set(presc.meds.map((m) => m.medKey));
  for (const prev of existing) {
    if (prev.status === 'active' && !incoming.has(prev.medKey)) {
      lines.push(`➖ <b>${esc(prev.name)}</b> — stopped`);
    }
  }

  if (presc.tz !== null) lines.push(`🕐 Timezone: <code>${esc(presc.tz)}</code>`);
  return lines.length > 0 ? lines.join('\n') : '<i>Nothing would change.</i>';
}

export async function applyImport(ctx: CmdCtx, versionId: number): Promise<string> {
  const version = await ctx.db.getPrescriptionVersion(versionId);
  if (version === null) return 'That import has expired. Send the prescription again.';
  if (version.state !== 'pending_confirm') return 'That import was already dealt with.';

  const result = parsePrescription(JSON.parse(version.raw), { now: ctx.now });
  if (!result.ok) return 'That prescription no longer parses. Send it again.';

  const summary = await ctx.db.activatePrescription(versionId, version.patientId, result.value!, ctx.now);
  await ctx.db.wakeNow(version.patientId, ctx.now);

  const parts: string[] = [];
  if (summary.added.length > 0) parts.push(`added ${summary.added.map(esc).join(', ')}`);
  if (summary.changed.length > 0) parts.push(`updated ${summary.changed.map(esc).join(', ')}`);
  if (summary.stopped.length > 0) parts.push(`stopped ${summary.stopped.map(esc).join(', ')}`);

  return (
    `✅ <b>Prescription applied</b>${parts.length > 0 ? ` — ${parts.join('; ')}.` : '.'}\n\n` +
    "I'll start reminding you from the next dose. /meds shows everything, /status shows what's next."
  );
}

async function cmdExport(ctx: CmdCtx): Promise<void> {
  const ap = await activePatient(ctx);
  if (ap === null) return needsSetup(ctx);
  const raw = await ctx.db.latestPrescription(ap.patient.id);
  if (raw === null) {
    await reply(ctx, 'No prescription has been imported yet.');
    return;
  }
  const pretty = JSON.stringify(JSON.parse(raw), null, 2);
  const body = pretty.length > 3500 ? `${pretty.slice(0, 3500)}\n… (truncated)` : pretty;
  await reply(ctx, `<pre><code>${esc(body)}</code></pre>`);
}

/** Hand over the prescription-conversion prompt, in chunks Telegram will accept. */
async function cmdPrompt(ctx: CmdCtx): Promise<void> {
  for (const part of PRESCRIPTION_PROMPT_PARTS) {
    await reply(ctx, part);
  }
}

/**
 * Change one medicine without touching the code or re-importing the whole prescription.
 *
 * A deliberately small grammar -- `/edit <medicine> <field> <value>` -- because the
 * alternative is either a menu tree nobody can navigate on a phone or natural language,
 * which would mean guessing, and guessing about a dose schedule is not acceptable.
 */
async function cmdEdit(ctx: CmdCtx, args: string): Promise<void> {
  const ap = await activePatient(ctx);
  if (ap === null) return needsSetup(ctx);

  const usage =
    '<b>Changing a medicine</b>\n' +
    '<code>/edit drop_a every 3h</code> — dosing interval\n' +
    '<code>/edit drop_a times 08:00,20:00</code> — fixed clock times\n' +
    '<code>/edit drop_a dose 2 drops</code> — what to take\n' +
    '<code>/edit drop_a name Antibiotic drop</code>\n' +
    '<code>/edit drop_a mingap 90m</code> — minimum safe gap\n' +
    '<code>/edit drop_a spacing 15m</code> — gap between drops in a group\n' +
    '<code>/edit drop_a maxperday 4</code>\n' +
    '<code>/edit drop_a critical on</code> — may wake you at night\n' +
    '<code>/edit drop_a note Shake well</code>\n\n' +
    'To change more than one thing, /import the whole prescription again.';

  const meds = await ctx.db.medsFor(ap.patient.id, true);
  const parts = args.trim().split(/\s+/).filter((x) => x !== '');
  if (parts.length < 2) {
    await reply(ctx, usage);
    return;
  }

  // The medicine name may itself be several words, so find the longest prefix that
  // resolves to exactly one medicine and treat the rest as field + value.
  let med = null;
  let rest: string[] = [];
  for (let take = Math.min(4, parts.length - 2); take >= 1; take--) {
    const candidates = matchMed(meds, parts.slice(0, take).join(' '));
    if (candidates.length === 1) {
      med = candidates[0]!;
      rest = parts.slice(take);
      break;
    }
  }
  if (med === null) {
    await reply(ctx, `No medicine matching "${esc(parts[0] ?? '')}". /meds lists them.`);
    return;
  }

  const field = (rest[0] ?? '').toLowerCase();
  const value = rest.slice(1).join(' ').trim();
  if (value === '') {
    await reply(ctx, usage);
    return;
  }

  let summary: string;
  let reschedule = true;

  switch (field) {
    case 'every':
    case 'interval': {
      const ms = parseDuration(value);
      if (ms === null || ms < 5 * MINUTE) {
        await reply(ctx, `I couldn't read "${esc(value)}" as an interval. Try <code>3h</code> or <code>90m</code>.`);
        return;
      }
      // Keep the safety floor sensible relative to the new interval unless it was set
      // explicitly tighter -- a looser interval with an old, tiny min gap is a trap.
      const minGap = Math.min(med.minGapMs, Math.floor(ms * 0.75));
      await ctx.db.updateMed(med.id, {
        intervalMs: ms, minGapMs: minGap,
        spec: { ...med.spec, kind: 'interval', intervalMs: ms },
      }, { rescheduleNow: true }, ctx.now);
      summary = `now every ${fmtDuration(ms)}`;
      break;
    }

    case 'times': {
      const times: string[] = [];
      for (const t of value.split(/[, ]+/).filter((x) => x !== '')) {
        try {
          const { h, mi } = parseWall(t);
          times.push(`${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`);
        } catch {
          await reply(ctx, `"${esc(t)}" is not a time like <code>08:00</code>.`);
          return;
        }
      }
      if (times.length === 0) {
        await reply(ctx, 'Give me at least one time, e.g. <code>/edit drop_a times 08:00,20:00</code>');
        return;
      }
      times.sort();
      await ctx.db.updateMed(med.id, {
        intervalMs: null as unknown as number,
        spec: { kind: 'fixed_times', times },
      }, { rescheduleNow: true }, ctx.now);
      summary = `now at ${times.join(', ')}`;
      break;
    }

    case 'dose':
      await ctx.db.updateMed(med.id, { doseText: value }, { rescheduleNow: false }, ctx.now);
      summary = `dose is now "${value}"`;
      reschedule = false;
      break;

    case 'name':
      await ctx.db.updateMed(med.id, { name: value }, { rescheduleNow: false }, ctx.now);
      summary = `renamed to "${value}"`;
      reschedule = false;
      break;

    case 'note':
    case 'notes':
      await ctx.db.updateMed(med.id, { notes: value }, { rescheduleNow: false }, ctx.now);
      summary = `note set`;
      reschedule = false;
      break;

    case 'mingap':
    case 'min_gap': {
      const ms = parseDuration(value);
      if (ms === null) {
        await reply(ctx, `I couldn't read "${esc(value)}" as a duration.`);
        return;
      }
      await ctx.db.updateMed(med.id, { minGapMs: ms }, { rescheduleNow: true }, ctx.now);
      summary = `minimum gap is now ${fmtDuration(ms)}`;
      break;
    }

    case 'spacing': {
      const ms = parseDuration(value);
      if (ms === null) {
        await reply(ctx, `I couldn't read "${esc(value)}" as a duration.`);
        return;
      }
      if (med.steps.length < 2) {
        await reply(ctx, `${esc(med.name)} is a single medicine, not a spaced group — spacing does not apply.`);
        return;
      }
      await ctx.db.updateMed(med.id, { stepSpacingMs: ms }, { rescheduleNow: true }, ctx.now);
      summary = `now ${fmtDuration(ms)} between each one`;
      break;
    }

    case 'maxperday':
    case 'max_per_day': {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > 24) {
        await reply(ctx, 'Give a whole number between 1 and 24.');
        return;
      }
      await ctx.db.updateMed(med.id, { maxPerDay: n }, { rescheduleNow: true }, ctx.now);
      summary = `at most ${n} a day`;
      break;
    }

    case 'critical': {
      const on = /^(on|yes|true|1)$/i.test(value);
      // A critical medicine must be allowed to pierce sleep, or the flag means nothing.
      await ctx.db.updateMed(med.id, { critical: on, awakeOnly: !on }, { rescheduleNow: true }, ctx.now);
      summary = on ? 'will now be reminded even at night' : 'will only be reminded while awake';
      break;
    }

    case 'drift': {
      if (!['absorb', 'strict_actual', 'strict_grid'].includes(value)) {
        await reply(ctx, 'Use <code>absorb</code>, <code>strict_actual</code> or <code>strict_grid</code>.');
        return;
      }
      await ctx.db.updateMed(med.id, { driftPolicy: value as 'absorb' }, { rescheduleNow: true }, ctx.now);
      summary = `drift policy is now ${value}`;
      break;
    }

    default:
      await reply(ctx, usage);
      return;
  }

  await ctx.db.audit(ap.patient.id, 'med_edited', String(ctx.chatId), { medId: med.id, field, value }, ctx.now);
  await ctx.db.wakeNow(ap.patient.id, ctx.now);
  await reply(
    ctx,
    `✏️ <b>${esc(med.name)}</b> — ${esc(summary)}.` +
      (reschedule ? '\n<i>The next dose has been recalculated.</i>' : ''),
  );
}

async function cmdExtend(ctx: CmdCtx, args: string): Promise<void> {
  const ap = await activePatient(ctx);
  if (ap === null) return needsSetup(ctx);

  const parts = args.trim().split(/\s+/).filter((x) => x !== '');
  if (parts.length < 2) {
    await reply(ctx, 'How much longer? e.g. <code>/extend drop_a 3d</code>');
    return;
  }
  const meds = await ctx.db.medsFor(ap.patient.id, true);
  const matches = matchMed(meds, parts.slice(0, -1).join(' '));
  if (matches.length !== 1) {
    await reply(ctx, matches.length === 0 ? `No medicine matching "${esc(parts[0] ?? '')}".` : 'Which one? /meds lists them.');
    return;
  }
  const med = matches[0]!;
  const extra = parseDuration(parts[parts.length - 1]!);
  if (extra === null) {
    await reply(ctx, `I couldn't read "${esc(parts[parts.length - 1] ?? '')}" — try <code>3d</code> or <code>48h</code>.`);
    return;
  }
  const extraDays = Math.max(1, Math.round(extra / (24 * HOUR)));

  if (med.courseKind !== 'days') {
    // Turning an open-ended medicine into a fixed course from today is a different
    // decision, so say so rather than quietly inventing a start date.
    await ctx.db.updateMed(med.id, { courseKind: 'days', courseDays: extraDays }, { rescheduleNow: false }, ctx.now);
    await reply(ctx, `⏳ <b>${esc(med.name)}</b> — now set to run ${extraDays} more day${extraDays === 1 ? '' : 's'} from when it started.`);
  } else {
    const total = (med.courseDays ?? 0) + extraDays;
    await ctx.db.updateMed(med.id, { courseDays: total }, { rescheduleNow: false }, ctx.now);
    await reply(ctx, `⏳ <b>${esc(med.name)}</b> — course extended to ${total} days (was ${med.courseDays}).`);
  }

  if (med.status === 'completed') {
    await ctx.db.setMedStatus(med.id, 'active', ctx.now);
    await reply(ctx, 'It had already finished, so I have restarted it.');
  }
  await ctx.db.audit(ap.patient.id, 'course_extended', String(ctx.chatId), { medId: med.id, extraDays }, ctx.now);
  await ctx.db.wakeNow(ap.patient.id, ctx.now);
}

/**
 * Add one medicine without replacing the whole prescription. Accepts the same object
 * shape as an entry in the `medicines` array, so whatever produced the original JSON can
 * produce this too.
 */
async function cmdAdd(ctx: CmdCtx, args: string): Promise<void> {
  const ap = await activePatient(ctx);
  if (ap === null) return needsSetup(ctx);

  let raw = args.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  if (fence !== null) raw = fence[1]!.trim();

  if (raw === '') {
    await reply(
      ctx,
      '<b>Adding one medicine</b>\n\n' +
        'Send it as JSON, the same shape as one entry in a prescription:\n' +
        '<code>/add {"id":"painkiller","name":"Painkiller","dose":"1 tablet",' +
        '"schedule":{"type":"as_needed"},"min_gap":"6h","max_per_day":4}</code>\n\n' +
        'Use /prompt to get the full format, or /import to replace everything at once.',
    );
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    await reply(ctx, `❌ That isn't valid JSON.\n<code>${esc(e instanceof Error ? e.message : String(e))}</code>`);
    return;
  }

  // Validate it exactly as an import would, by wrapping it in a one-medicine document.
  const wrapped = { version: 1, medicines: Array.isArray(parsed) ? parsed : [parsed] };
  const result = parsePrescription(wrapped, { now: ctx.now });
  if (!result.ok) {
    await reply(ctx, `❌ <b>I couldn't use that</b>\n\n${result.errors.map((e) => `• ${esc(e)}`).join('\n')}`);
    return;
  }

  const existing = await ctx.db.medsFor(ap.patient.id, true);
  const clash = result.value!.meds.find((m) => existing.some((e) => e.medKey === m.medKey));
  if (clash !== undefined) {
    await reply(
      ctx,
      `There is already a medicine with the id <code>${esc(clash.medKey)}</code>. ` +
        'Give it a different <code>id</code>, or use /edit to change the existing one.',
    );
    return;
  }

  await ctx.db.addMedicines(ap.patient.id, result.value!.meds, ctx.now);
  await ctx.db.wakeNow(ap.patient.id, ctx.now);
  const added = result.value!.meds
    .map((m) => `• <b>${esc(m.name)}</b> — ${esc(describeSchedule(m))}, ${esc(describeCourse(m))}`)
    .join('\n');
  const warnings = result.warnings.length > 0
    ? `\n\n<b>Worth checking</b>\n${result.warnings.map((w) => `• ${esc(w)}`).join('\n')}`
    : '';
  await reply(ctx, `➕ <b>Added</b>\n${added}${warnings}`);
}

/** Who this chat can see and answer for. */
async function cmdPatients(ctx: CmdCtx): Promise<void> {
  const links = await ctx.db.linksForChat(ctx.chatId);
  if (links.length === 0) return needsSetup(ctx);

  const lines: string[] = ['<b>This chat is linked to</b>'];
  for (const l of links) {
    const p = await ctx.db.getPatient(l.patientId);
    if (p === null) continue;
    const z = zoneFor(p.tz);
    const meds = await ctx.db.medsFor(l.patientId);
    lines.push(
      `\n• <b>${esc(p.displayName)}</b> — ${l.role === 'patient' ? 'you' : 'you are their backup'}\n` +
        `  ${p.wakeState === 'awake' ? '☀️ awake' : '🌙 asleep'} · ${z.fmtTime12(ctx.now)} ${esc(p.tz)}\n` +
        `  ${meds.length} active medicine${meds.length === 1 ? '' : 's'}` +
        (l.escalationTier > 0 ? ` · told after ${fmtDuration(l.escalateAfterMs)} of silence` : ''),
    );
  }
  lines.push('\n<i>Use /invite to let someone back you up.</i>');
  await reply(ctx, lines.join('\n'));
}

/**
 * The times that shape the day. These are the knobs worth changing without a re-import --
 * everything else lives in the prescription.
 */
async function cmdSettings(ctx: CmdCtx, args: string): Promise<void> {
  const ap = await activePatient(ctx);
  if (ap === null) return needsSetup(ctx);
  const { patient, z } = ap;

  const parts = args.trim().split(/\s+/).filter((x) => x !== '');
  const FIELDS: Record<string, { column: string; label: string }> = {
    morning: { column: 'morning_poll_at', label: 'start asking if you are awake' },
    wake: { column: 'presumed_wake_at', label: 'assume you are awake by' },
    evening: { column: 'evening_poll_at', label: 'start asking if you are in bed' },
    sleep: { column: 'presumed_sleep_at', label: 'assume you are asleep by' },
    digest: { column: 'digest_at', label: 'send the daily summary' },
  };

  if (parts.length >= 2) {
    const key = parts[0]!.toLowerCase();
    const entry = FIELDS[key];
    if (entry === undefined) {
      await reply(ctx, `I don't know the setting "${esc(key)}". Send /settings to see them.`);
      return;
    }
    let wall: string;
    try {
      const { h, mi } = parseWall(parts[1]!);
      wall = `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
    } catch {
      await reply(ctx, `"${esc(parts[1] ?? '')}" is not a time like <code>07:30</code>.`);
      return;
    }
    await ctx.env.MEDBOT_DB
      .prepare(`UPDATE patients SET ${entry.column} = ?2, next_action_at = ?3 WHERE id = ?1`)
      .bind(patient.id, wall, ctx.now)
      .run();
    await ctx.db.audit(patient.id, 'setting_changed', String(ctx.chatId), { key, value: wall }, ctx.now);
    await reply(ctx, `⚙️ I'll ${esc(entry.label)} at <b>${esc(wall)}</b> from now on.`);
    return;
  }

  await reply(
    ctx,
    `<b>⚙️ Settings</b> · ${esc(patient.displayName)}\n\n` +
      `Timezone       <code>${esc(patient.tz)}</code> — it's ${z.fmtTime12(ctx.now)} there\n` +
      `Morning ask    <code>${esc(patient.morningPollAt)}</code>\n` +
      `Assume awake   <code>${esc(patient.presumedWakeAt)}</code>\n` +
      `Evening ask    <code>${esc(patient.eveningPollAt)}</code>\n` +
      `Assume asleep  <code>${esc(patient.presumedSleepAt)}</code>\n` +
      `Daily summary  <code>${esc(patient.digestAt)}</code>\n\n` +
      `<b>To change one</b>\n` +
      `<code>/settings morning 06:30</code>\n` +
      `<code>/settings wake 09:00</code>\n` +
      `<code>/settings evening 22:30</code>\n` +
      `<code>/settings sleep 01:00</code>\n` +
      `<code>/settings digest 21:30</code>\n` +
      `<code>/tz Asia/Dhaka</code>\n\n` +
      `<i>"Assume awake" is the safety net: past that time I start reminding you even if ` +
      `you haven't said you're up, because going quiet is worse than being wrong.</i>`,
  );
}

/** Shared by the /meds buttons and the callback handler. */
export async function editMenuFor(ctx: CmdCtx, medId: number): Promise<{ text: string; buttons: Array<Array<{ text: string; callback_data: string }>> } | null> {
  const med = await ctx.db.getMed(medId);
  if (med === null) return null;
  const patient = await ctx.db.getPatient(med.patientId);
  if (patient === null) return null;
  const r = renderEditMenu(med, zoneFor(patient.tz));
  return { text: r.text, buttons: r.buttons };
}

// --- help ----------------------------------------------------------------

async function needsSetup(ctx: CmdCtx): Promise<void> {
  await reply(ctx, 'This chat is not set up yet — send /start first.');
}

async function cmdHelp(ctx: CmdCtx): Promise<void> {
  await reply(
    ctx,
    `<b>medbot</b> — I remind you to take your medicines, and I don't give up.

<b>Every day</b>
<code>/awake</code> · <code>/sleep</code> — start and end your day. I'll ask if you forget.
<code>/eating lunch in 1h</code> — so I can time the before-meal tablets.
<code>/ate lunch</code> — once you've actually eaten.
<code>/status</code> — what's waiting and what's next.

<b>Logging a dose</b>
Tap ✅ on the reminder, or:
<code>/took drop_a</code> — right now
<code>/took drop_a 5pm</code> — earlier, and I'll fix the schedule
<code>/took drop_a 20m ago</code>
<code>/skip drop_a</code> · <code>/snooze drop_a 15m</code>

If I already logged a dose as missed and you actually took it, just tell me the real time — I'll correct it and recalculate from there.

<b>Your prescription</b>
<code>/prompt</code> — get the prompt for turning a photo into JSON
<code>/import</code> — send new JSON (I preview it and wait for confirmation)
<code>/add {...}</code> — add one medicine
<code>/edit drop_a every 3h</code> — change one thing
<code>/extend drop_a 3d</code> — lengthen a course
<code>/meds</code> · <code>/export</code> · <code>/pause</code> · <code>/resume</code> · <code>/stop</code>
<code>/log 7</code> — adherence · <code>/tz Asia/Dhaka</code>

<b>Sharing</b>
<code>/invite</code> — get a code so someone can back you up. If you don't answer within a few minutes, I'll ask them instead, and they can answer for you.

Every evening I send a short summary of the day. If that stops arriving, something is wrong — <code>/health</code> tells you whether the scheduler is still running.

⚠️ <i>I'm a reminder, not a doctor. Follow your prescription, and don't rely on me alone for anything critical.</i>`,
  );
}
