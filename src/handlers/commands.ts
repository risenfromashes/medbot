/**
 * The command surface.
 *
 * This is what keeps the prescription out of the source code: importing a new one,
 * pausing a medicine, changing a dose and logging something after the fact are all things
 * a person does from their phone, not something that requires an edit and a redeploy.
 */

import type { Medicine, Patient } from '../core/domain.js';
import { describeCourse, describeSchedule, hashString, parsePrescription } from '../core/prescription.js';
import type { NormalizedPrescription } from '../core/prescription.js';
import { renderConfirmation } from '../core/render.js';
import { resolveRetro } from '../core/retro.js';
import { parseDuration, parseTime, splitTrailingTime } from '../core/timeparse.js';
import { MINUTE, fmtDuration, isValidTimeZone, zoneFor } from '../core/tz.js';
import type { Zone } from '../core/tz.js';
import { Db } from '../io/db.js';
import { AdminDb } from '../io/adminDb.js';
import { Telegram, esc } from '../io/telegram.js';
import type { Env, TgIncomingMessage } from '../types.js';
import { broadcast, clearPromptMessages } from './dispatch.js';
import { encodeCallback } from '../core/callbackCodec.js';

export const COMMANDS = [
  { command: 'status', description: "What's pending and what's next" },
  { command: 'took', description: 'Log a dose — optionally at a past time, e.g. /took antibiotic drop 5pm' },
  { command: 'awake', description: "Start the day (accepts a time, e.g. /awake 6:30am)" },
  { command: 'sleep', description: 'End the day' },
  { command: 'ate', description: 'Record a meal, e.g. /ate lunch 1pm' },
  { command: 'meds', description: 'List medicines and their schedules' },
  { command: 'skip', description: 'Skip the pending dose of a medicine' },
  { command: 'snooze', description: 'Push a reminder back, e.g. /snooze antibiotic drop 15m' },
  { command: 'undo', description: 'Reverse the last thing you logged' },
  { command: 'import', description: 'Load a prescription (paste or attach the JSON)' },
  { command: 'export', description: 'Get the current prescription back as JSON' },
  { command: 'log', description: 'Recent adherence' },
  { command: 'pause', description: 'Pause a medicine' },
  { command: 'resume', description: 'Resume a paused medicine' },
  { command: 'stop', description: 'Stop a medicine for good' },
  { command: 'tz', description: 'Set the timezone, e.g. /tz Asia/Dhaka' },
  { command: 'invite', description: 'Get a code so someone can back you up' },
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
    case 'took': case 'take': case 'taken': return cmdTook(ctx, args);
    case 'skip': return cmdSkip(ctx, args);
    case 'snooze': return cmdSnooze(ctx, args);
    case 'undo': return cmdUndo(ctx);
    case 'status': return cmdStatus(ctx);
    case 'meds': case 'medicines': return cmdMeds(ctx);
    case 'import': return cmdImport(ctx, args, msg);
    case 'export': case 'prescription': return cmdExport(ctx);
    case 'log': case 'adherence': return cmdLog(ctx, args);
    case 'pause': return cmdMedStatus(ctx, args, 'paused');
    case 'resume': return cmdMedStatus(ctx, args, 'active');
    case 'stop': return cmdMedStatus(ctx, args, 'discontinued');
    case 'tz': case 'timezone': return cmdTz(ctx, args);
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
      await reply(ctx, "Nothing is pending right now. Name the medicine if you're logging something else: <code>/took antibiotic drop 5pm</code>");
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
      '• <code>/took antibiotic drop 5pm</code> — even if I already logged it as missed\n' +
      '• <code>/skip antibiotic drop</code> — if you decided not to take it\n' +
      '• <code>/awake 6:30am</code> — if I started the day at the wrong time',
  );
}

// --- information ---------------------------------------------------------

async function cmdStatus(ctx: CmdCtx): Promise<void> {
  const ap = await activePatient(ctx);
  if (ap === null) return needsSetup(ctx);
  const { patient, z } = ap;
  const meds = await ctx.db.medsFor(patient.id);

  const lines: string[] = [
    `<b>${esc(patient.displayName)}</b> — ${z.fmtTime12(ctx.now)} (${esc(patient.tz)})`,
    patient.wakeState === 'awake'
      ? `☀️ Awake since ${patient.lastWakeAt !== null ? z.fmtTime12(patient.lastWakeAt) : '?'}${patient.wakeConfidence !== 'confirmed' ? ` <i>(${patient.wakeConfidence})</i>` : ''}`
      : `🌙 Asleep${patient.lastSleepAt !== null ? ` since ${z.fmtTime12(patient.lastSleepAt)}` : ''}`,
    '',
  ];

  if (meds.length === 0) {
    lines.push('No medicines yet — send me a prescription with /import.');
    await reply(ctx, lines.join('\n'));
    return;
  }

  const pending: string[] = [];
  const upcoming: string[] = [];
  for (const med of meds) {
    const live = await ctx.db.liveDoseFor(med.id);
    if (live === null) continue;
    const label = med.steps.length > 1 ? `${med.steps[live.step]?.name ?? med.name} (${live.step + 1}/${med.steps.length})` : med.name;
    if (live.status === 'due' || live.status === 'prompted') {
      pending.push(`• <b>${esc(label)}</b> — due ${z.fmtTime12(live.effectiveDueAt)}, ${fmtDuration(ctx.now - live.effectiveDueAt)} ago`);
    } else if (live.status === 'deferred') {
      upcoming.push(`• ${esc(label)} — waiting until you're up`);
    } else {
      upcoming.push(`• ${esc(label)} — ${z.fmtTime12(live.effectiveDueAt)} (in ${fmtDuration(live.effectiveDueAt - ctx.now)})`);
    }
  }

  if (pending.length > 0) lines.push('<b>Waiting on you</b>', ...pending, '');
  if (upcoming.length > 0) lines.push('<b>Coming up</b>', ...upcoming);
  if (pending.length === 0 && upcoming.length === 0) lines.push('Nothing scheduled right now.');

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
  await reply(ctx, lines.join('\n\n'));
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
<code>/ate lunch</code> — meal-timed medicines need this.
<code>/status</code> — what's waiting and what's next.

<b>Logging a dose</b>
Tap ✅ on the reminder, or:
<code>/took antibiotic drop</code> — right now
<code>/took antibiotic drop 5pm</code> — earlier, and I'll fix the schedule
<code>/took antibiotic drop 20m ago</code>
<code>/skip antibiotic drop</code> · <code>/snooze antibiotic drop 15m</code>

If I already logged a dose as missed and you actually took it, just tell me the real time — I'll correct it and recalculate from there.

<b>Your prescription</b>
<code>/import</code> — send new JSON (I show a preview and wait for confirmation)
<code>/meds</code> · <code>/export</code> · <code>/pause</code> · <code>/resume</code> · <code>/stop</code>
<code>/tz Asia/Dhaka</code>

<b>Getting the JSON</b>
Photograph your prescription and ask any AI chatbot:
<i>"Convert this prescription photo to JSON using this schema: {version, timezone, meals[], groups[], medicines[{id, name, dose, schedule:{type: interval|fixed_times|meal, every, times, meals, relation, offset}, group, course:{days}}]}. Eye drops that must be spaced apart share a group."</i>
Paste the answer here. I check it carefully and show you what changes before anything happens.

<b>Sharing</b>
<code>/caregiver &lt;code&gt;</code> — become someone's backup. If they don't answer within a few minutes, I'll ask you instead.

⚠️ <i>I'm a reminder, not a doctor. Follow your prescription, and don't rely on me alone for anything critical.</i>`,
  );
}
