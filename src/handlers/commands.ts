/**
 * The command surface.
 *
 * This is what keeps the prescription out of the source code: importing a new one,
 * pausing a medicine, changing a dose and logging something after the fact are all things
 * a person does from their phone, not something that requires an edit and a redeploy.
 */

import type { Chat, Medicine, Patient } from '../core/domain.js';
import { describeCourse, describeSchedule, dosesPerDayInterval, hashString, parsePrescription } from '../core/prescription.js';
import { PRESCRIPTION_PROMPT_PARTS } from '../core/promptText.js';
import { describeJsonError, extractJson, looksLikeJsonFragment } from '../core/extractJson.js';
import type { NormalizedPrescription } from '../core/prescription.js';
import { renderConfirmation, renderEditMenu } from '../core/render.js';
import { resolveRetro } from '../core/retro.js';
import { parseDuration, parseTime, splitTrailingTime } from '../core/timeparse.js';
import { remainingFor, summarise } from '../core/remaining.js';
import { looksLikeRealName } from '../core/names.js';
import { wakeOffsets } from '../core/planMeals.js';
import { DAY_MS, HOUR, MINUTE, fmtDuration, isValidTimeZone, mealDayOf, parseWall, zoneFor } from '../core/tz.js';
import type { Zone } from '../core/tz.js';
import { Db } from '../io/db.js';
import { AdminDb } from '../io/adminDb.js';
import { Telegram, esc } from '../io/telegram.js';
import type { Env, TgIncomingMessage } from '../types.js';
import { broadcast, clearDoseNotes, clearPromptMessages, mealNews } from './dispatch.js';
import { encodeCallback } from '../core/callbackCodec.js';
import { courseComplete } from '../core/planSchedule.js';

export const COMMANDS = [
  { command: 'status', description: "What's pending and what's next" },
  { command: 'took', description: 'Log a dose — optionally at a past time, e.g. /took drops 5pm' },
  { command: 'awake', description: "Start the day (accepts a time, e.g. /awake 6:30am)" },
  { command: 'sleep', description: 'End the day' },
  { command: 'bedtime', description: "Set tonight's bedtime, e.g. /bedtime 12:30am" },
  { command: 'ate', description: 'Record a meal, e.g. /ate lunch 1pm' },
  { command: 'eating', description: "Say when you'll eat, e.g. /eating lunch in 1h" },
  { command: 'meds', description: 'List medicines and their schedules' },
  { command: 'skip', description: 'Skip the pending dose of a medicine' },
  { command: 'snooze', description: 'Push a reminder back, e.g. /snooze drops 15m' },
  { command: 'undo', description: 'Reverse the last thing you logged' },
  { command: 'import', description: 'Load a prescription (paste or attach the JSON)' },
  { command: 'prompt', description: 'Get the prompt for turning a prescription photo into JSON' },
  { command: 'edit', description: 'Change a medicine, e.g. /edit drops perday 3' },
  { command: 'extend', description: 'Add days to a course, e.g. /extend drops 3d' },
  { command: 'export', description: 'Get the current prescription back as JSON' },
  { command: 'log', description: 'Recent adherence' },
  { command: 'pause', description: 'Pause a medicine' },
  { command: 'resume', description: 'Resume a paused medicine' },
  { command: 'stop', description: 'Stop a medicine for good' },
  { command: 'tz', description: 'Set the timezone, e.g. /tz Asia/Dhaka' },
  { command: 'invite', description: 'Get a code so someone can back you up' },
  { command: 'patients', description: 'Who this chat is linked to' },
  { command: 'name', description: 'Change what I call you, e.g. /name Ayesha' },
  { command: 'settings', description: 'Your day, timezone and reminder settings' },
  { command: 'caregiver', description: 'Become someone\'s backup, with their code' },
  { command: 'leave', description: 'Stop being someone\'s backup' },
  { command: 'help', description: 'How all of this works' },
];

export interface CmdCtx {
  env: Env;
  db: Db;
  tg: Telegram;
  chatId: number;
  userName: string;
  /** False when Telegram gave us nothing usable and `userName` is only a stand-in. */
  nameKnown?: boolean;
  now: number;
}

const reply = async (ctx: CmdCtx, text: string, buttons?: Array<Array<{ text: string; callback_data: string }>>): Promise<void> => {
  await ctx.tg.sendMessage(ctx.chatId, text, buttons !== undefined ? { replyMarkup: { inline_keyboard: buttons } } : {});
};

/**
 * The chat's OWN record.
 *
 * There is one kind of account. Everybody who joins has their own prescription, and may
 * additionally back other people up -- that is a relationship, not a different sort of
 * user. Self-directed commands therefore always mean yourself: `/import` while backing
 * someone up must never quietly rewrite *their* prescription.
 */
async function activePatient(ctx: CmdCtx): Promise<{ patient: Patient; z: Zone; canAck: boolean } | null> {
  const links = await ctx.db.linksForChat(ctx.chatId);
  const self = links.find((l) => l.role === 'patient');
  if (self === undefined) return null;
  const patient = await ctx.db.getPatient(self.patientId);
  if (patient === null) return null;
  return { patient, z: zoneFor(patient.tz), canAck: self.canAck };
}

/** Resolve a patient this chat may look at: itself, or anyone it backs up. */
async function resolveViewable(
  ctx: CmdCtx,
  query: string,
): Promise<{ patient: Patient; z: Zone; isSelf: boolean } | null> {
  const links = await ctx.db.linksForChat(ctx.chatId);
  const wanted = query.trim().toLowerCase();
  for (const l of links) {
    const p = await ctx.db.getPatient(l.patientId);
    if (p === null) continue;
    if (wanted === '' ? l.role === 'patient' : p.displayName.toLowerCase().includes(wanted)) {
      return { patient: p, z: zoneFor(p.tz), isSelf: l.role === 'patient' };
    }
  }
  return null;
}

/**
 * Who is this command about?
 *
 * A caregiver typing `/took drops` means the person they look after -- they have no drops
 * of their own. Before this, the command resolved to the caregiver's own empty record:
 * `/took` said "you have no medicines loaded" and, worse, `/ate breakfast` silently wrote
 * a meal against the wrong person. Buttons always worked, because an escalated prompt
 * carries the dose id with it; typing did not, which is the half people fall back on when
 * the notification has scrolled away.
 *
 * Resolution, in order: an explicit `for <name>`; your own record if you have medicines;
 * the one person you look after; your own record; the only person there is. Anything
 * genuinely ambiguous asks rather than guessing, because guessing here writes a medical
 * record for the wrong human being.
 */
interface Acting {
  patient: Patient;
  z: Zone;
  isSelf: boolean;
  canAck: boolean;
  /** The arguments with any `for <name>` removed. */
  rest: string;
}

async function actingPatient(ctx: CmdCtx, args = ''): Promise<Acting | { ambiguous: string[] } | null> {
  const links = await ctx.db.linksForChat(ctx.chatId);
  if (links.length === 0) return null;

  const people: Array<{ patient: Patient; link: Chat; hasMeds: boolean }> = [];
  for (const link of links) {
    const patient = await ctx.db.getPatient(link.patientId);
    if (patient === null) continue;
    const meds = await ctx.db.medsFor(patient.id);
    people.push({ patient, link, hasMeds: meds.some((m) => m.status === 'active') });
  }
  if (people.length === 0) return null;

  const make = (chosen: { patient: Patient; link: Chat }, rest: string): Acting => ({
    patient: chosen.patient,
    z: zoneFor(chosen.patient.tz),
    isSelf: chosen.link.role === 'patient',
    canAck: chosen.link.canAck,
    rest: rest.trim(),
  });

  // "…for Ifti", anywhere in the arguments, names the person explicitly; "for me" is the
  // way back to your own record when the default has sensibly gone elsewhere.
  const named = /(^|\s)for\s+(\S+)\s*$/i.exec(args);
  if (named !== null) {
    const wanted = (named[2] ?? '').toLowerCase();
    const rest = args.slice(0, named.index);
    if (wanted === 'me' || wanted === 'myself') {
      const own = people.find((p) => p.link.role === 'patient');
      if (own !== undefined) return make(own, rest);
    }
    const match = people.find((p) => p.patient.displayName.toLowerCase().startsWith(wanted));
    if (match !== undefined) return make(match, rest);
    return { ambiguous: people.map((p) => p.patient.displayName) };
  }

  const self = people.find((p) => p.link.role === 'patient');
  if (self !== undefined && self.hasMeds) return make(self, args);

  const withMeds = people.filter((p) => p.hasMeds);
  if (withMeds.length === 1) return make(withMeds[0]!, args);
  if (withMeds.length > 1) return { ambiguous: withMeds.map((p) => p.patient.displayName) };

  if (self !== undefined) return make(self, args);
  if (people.length === 1) return make(people[0]!, args);
  return { ambiguous: people.map((p) => p.patient.displayName) };
}

/** Unwrap the above, answering the ambiguity or the missing setup itself. */
export async function actingFor(ctx: CmdCtx): Promise<Acting | null> {
  const found = await actingPatient(ctx, '');
  return found === null || 'ambiguous' in found ? null : found;
}

async function acting(ctx: CmdCtx, args = '', verb = 'that'): Promise<Acting | null> {
  const found = await actingPatient(ctx, args);
  if (found === null) {
    await needsSetup(ctx);
    return null;
  }
  if ('ambiguous' in found) {
    await reply(
      ctx,
      `Who is ${esc(verb)} for? You look after more than one person:\n` +
        found.ambiguous.map((n) => `• ${esc(n)}`).join('\n') +
        `\n\nAdd their name at the end, e.g. <code>for ${esc(found.ambiguous[0] ?? 'name')}</code>.`,
    );
    return null;
  }
  if (!found.isSelf && !found.canAck) {
    await reply(ctx, `You can see ${esc(found.patient.displayName)}'s reminders but not answer for them.`);
    return null;
  }
  return found;
}

/**
 * Tell everyone else what was just done on someone's behalf.
 *
 * A caregiver answering for a patient is the point of the arrangement, but the patient's
 * own chat going quiet about it is not: they would have no way to tell "somebody handled
 * it" from "nothing happened", which is the ambiguity this whole bot exists to remove.
 */
/**
 * `always` says it even when the patient recorded it themselves. Most confirmations are
 * only news in the other direction -- the caregiver answered, so tell the patient -- but
 * a meal and a medicine being stopped are news to the caregiver too, and that was the
 * half nobody was hearing.
 */
async function tellTheOthers(ctx: CmdCtx, ap: Acting, text: string, always = false): Promise<void> {
  if (ap.isSelf && !always) return;
  const chats = await ctx.db.chatsFor(ap.patient.id);
  await broadcast({ db: ctx.db, tg: ctx.tg, z: ap.z, now: ctx.now }, chats, text, ctx.chatId);
}

/** "— for Ifti", appended when the acting chat is not the patient's own. */
function onBehalf(ap: Acting): string {
  return ap.isSelf ? '' : ` — for <b>${esc(ap.patient.displayName)}</b>`;
}

/**
 * Take a trailing duration off the arguments, leaving the medicine name.
 *
 * Mutates nothing: it returns the duration and the caller keeps the shortened name, so
 * `/resume vigalon 7d` finds "vigalon" and seven days, while `/resume vigalon` -- and a
 * medicine whose name genuinely ends in a number -- are left alone.
 */
function peelDuration(args: string): number | null {
  const m = /\s+(\d+\s*(?:d(?:ays?)?|w(?:eeks?)?))\s*$/i.exec(args);
  if (m === null) return null;
  const weeks = /w/i.test(m[1]!);
  const n = Number(/\d+/.exec(m[1]!)?.[0] ?? '0');
  return n <= 0 ? null : n * (weeks ? 7 : 1) * 24 * HOUR;
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

  // A document is almost always a prescription, whatever the caption says -- and
  // attaching one is the path most likely to work, so it should never need a command
  // in front of it.
  if (msg.document !== undefined) {
    await cmdImport(ctx, args, msg);
    return;
  }

  switch (cmd) {
    case 'start': return cmdStart(ctx, args);
    case 'help': return cmdHelp(ctx);
    case 'awake': case 'wokeup': case 'up': return cmdWake(ctx, 'wake', args);
    case 'sleep': case 'bed': case 'goodnight': return cmdWake(ctx, 'sleep', args);
    case 'bedtime': case 'tonight': return cmdBedtime(ctx, args);
    case 'ate': case 'eaten': return cmdAte(ctx, args);
    case 'eating': case 'plan': return cmdEating(ctx, args);
    case 'took': case 'take': case 'taken': return cmdTook(ctx, args);
    case 'skip': return cmdSkip(ctx, args);
    case 'snooze': return cmdSnooze(ctx, args);
    case 'undo': return cmdUndo(ctx);
    case 'status': return cmdStatus(ctx, args);
    case 'meds': case 'medicines': return cmdMeds(ctx, args);
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
    // Buried inside /settings, nobody found it: one household went a fortnight with the
    // bot calling someone "Member", which is what Telegram hands over when a chat has no
    // first name on it.
    case 'name': case 'callme': case 'rename': return cmdSettings(ctx, `name ${args}`);
    case 'invite': return cmdInvite(ctx);
    case 'caregiver': case 'watch': return cmdCaregiver(ctx, args);
    case 'leave': case 'unwatch': return cmdLeave(ctx, args);
    case 'health': return cmdHealth(ctx);
    default:
      if (cmd === '') return freeText(ctx, text);
      await reply(ctx, `I don't know <code>/${esc(cmd)}</code>. Try /help.`);
  }
}

/** Bare words that ought to just work, because people type them. */
/**
 * Ask what to call someone, and take the next thing they say as the answer.
 *
 * Telegram gives a first name most of the time, and when it does this never runs. When it
 * does not, the alternative was calling a patient "Member" in every reminder for ever,
 * because the way to fix it was buried inside /settings and nobody knew to look.
 */
async function askForName(ctx: CmdCtx, patientId: number): Promise<void> {
  await ctx.db.kvSet(`askname:${ctx.chatId}`, JSON.stringify({ patientId, at: ctx.now }));
  await reply(
    ctx,
    "One thing first — <b>what should I call you?</b>\n\n" +
      'Telegram has not told me your name, and I would rather not guess. ' +
      'Just send it, or <code>/name Ayesha</code> any time.',
  );
}

/** The pending "what should I call you?", if the answer is still expected. */
async function awaitingName(ctx: CmdCtx): Promise<number | null> {
  const raw = await ctx.db.kvGet(`askname:${ctx.chatId}`);
  if (raw === null || raw === '') return null;
  try {
    const held = JSON.parse(raw) as { patientId: number; at: number };
    // An hour. Past that, an ordinary message is an ordinary message again.
    if (ctx.now - held.at > HOUR) {
      await ctx.db.kvSet(`askname:${ctx.chatId}`, '');
      return null;
    }
    return held.patientId;
  } catch {
    return null;
  }
}

async function freeText(ctx: CmdCtx, text: string): Promise<void> {
  // A paste that arrived in pieces continues here. Telegram splits long messages, so the
  // second half turns up as ordinary text with no command in front of it.
  const held = await pendingImport(ctx);
  if (held !== null && looksLikeJsonFragment(text)) {
    const ap = await activePatient(ctx);
    if (ap !== null) {
      await ingestPrescription(ctx, ap.patient.id, held + text, { fromFile: false, continuing: true });
      return;
    }
  }

  // "What should I call you?" was asked; this is the answer.
  const pendingName = await awaitingName(ctx);
  if (pendingName !== null && !text.trim().startsWith('/') && looksLikeRealName(text)) {
    await ctx.db.kvSet(`askname:${ctx.chatId}`, '');
    return cmdSettings(ctx, `name ${text.trim()}`);
  }

  const t = text.toLowerCase().trim();
  if (/^(taken|done|took it|yes|✅)$/.test(t)) return cmdTook(ctx, '');
  if (/^(awake|i'm up|im up|good morning|morning)$/.test(t)) return cmdWake(ctx, 'wake', '');
  if (/^(sleeping|going to bed|good ?night|bed)$/.test(t)) return cmdWake(ctx, 'sleep', '');

  // A pasted prescription needs no ceremony, complete or not.
  if (extractJson(text).kind !== 'none') {
    return cmdImport(ctx, text, { message_id: 0, chat: { id: ctx.chatId, type: 'private' }, date: 0 });
  }

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
  const result = await adb.redeemInvite(code, ctx.chatId, ctx.now, 'enrol');
  if (!result.ok) {
    if (result.reason === 'wrong_kind') {
      // Not consumed, so the code still works -- on the right command.
      await reply(
        ctx,
        "That's a <b>caregiver</b> code, for looking after someone who already uses this bot.\n\n" +
          `Send <code>/caregiver ${esc(code.toUpperCase())}</code> instead.\n\n` +
          '<i>If you meant to join as a new member, ask for a joining code instead.</i>',
      );
      return;
    }
    const why =
      result.reason === 'used' ? 'That code has already been used.'
      : result.reason === 'expired' ? 'That code has expired.'
      : 'That code is not valid.';
    await reply(ctx, `🔒 ${why}\n\nAsk for a fresh one — each code works once.`);
    return;
  }

  const patientId = await ctx.db.createPatient(ctx.userName, 'UTC', ctx.now);
  await ctx.db.linkChat(ctx.chatId, patientId, 'patient', 0, 5 * MINUTE, ctx.now, ctx.userName);
  await reply(
    ctx,
    `👋 Hello ${esc(ctx.userName)}.\n\n` +
      "I'll remind you to take your medicines, and keep asking until you tell me you have.\n\n" +
      '<b>Two things to do next</b>\n' +
      '1. <code>/tz Asia/Dhaka</code> — so I know what time it is for you.\n' +
      '2. <code>/import</code> — send me your prescription as JSON.\n\n' +
      "Don't have the JSON? Send <code>/prompt</code> and I'll give you the text to paste into any " +
      'AI chatbot along with a photo of your prescription. I check the result carefully before ' +
      'anything takes effect.\n\n' +
      `<i>If I've got your name wrong, <code>/name Ayesha</code> fixes it. And if someone ` +
      `should be told when you miss a dose, <code>/invite</code> gives them a code.</i>`,
  );
  if (ctx.nameKnown === false) await askForName(ctx, patientId);
}

/**
 * Step back from looking after someone.
 *
 * Worth having for its own sake -- people's circumstances change -- but also because a
 * caregiver who cannot leave will mute the bot instead, and a muted caregiver is a safety
 * net that looks present and is not.
 */
async function cmdLeave(ctx: CmdCtx, args: string): Promise<void> {
  const links = (await ctx.db.linksForChat(ctx.chatId)).filter((l) => l.role === 'caregiver');
  if (links.length === 0) {
    await reply(ctx, "You're not backing anyone up at the moment.");
    return;
  }

  const named: Array<{ patientId: number; name: string }> = [];
  for (const l of links) {
    const p = await ctx.db.getPatient(l.patientId);
    named.push({ patientId: l.patientId, name: p?.displayName ?? `#${l.patientId}` });
  }

  const query = args.trim().toLowerCase();
  const matches = query === '' ? named : named.filter((n) => n.name.toLowerCase().includes(query));

  if (matches.length === 0) {
    await reply(ctx, `You're not backing up anyone called "${esc(args.trim())}".`);
    return;
  }

  // More than one and no way to tell which: ask rather than guess. Quietly removing the
  // wrong person's safety net would be a bad way to be helpful.
  if (matches.length > 1) {
    await reply(ctx, 'Which one?\n' + matches.map((m) => `• <code>/leave ${esc(m.name)}</code>`).join('\n'));
    return;
  }

  const target = matches[0]!;
  const removed = await ctx.db.unlinkChat(ctx.chatId, target.patientId, ctx.now);
  if (!removed) {
    await reply(ctx, 'That link is already gone.');
    return;
  }

  await reply(
    ctx,
    `👋 You've stopped backing up <b>${esc(target.name)}</b>.\n\n` +
      "You won't get their reminders any more. They can send you a new code with /invite if that changes.",
  );

  // They must know their safety net has gone. Silence would leave them believing someone
  // is watching who is not.
  for (const chat of await ctx.db.chatsFor(target.patientId)) {
    if (chat.role !== 'patient') continue;
    await ctx.tg.sendMessage(
      chat.chatId,
      `🛟 <b>${esc(ctx.userName)}</b> has stopped being your backup.\n\n` +
        'Nobody else will be told if you miss something. Send /invite to set up someone new.',
    );
  }
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

  // Look before claiming. Every reason to refuse -- wrong kind, your own code -- has to be
  // found first, or a single-use code is burned on a command that then rejects it.
  const peeked = await adb.peekInvite(code);
  const existing = await ctx.db.linksForChat(ctx.chatId);

  if (peeked !== null && peeked.kind !== 'caregiver') {
    await reply(
      ctx,
      "That's a <b>joining</b> code, for someone new to this bot.\n\n" +
        `Send <code>/start ${esc(code.toUpperCase())}</code> instead.`,
    );
    return;
  }

  if (
    peeked !== null && peeked.patientId !== null &&
    existing.some((l) => l.patientId === peeked.patientId && l.role === 'patient')
  ) {
    // Backing up yourself is not a safety net; it is the same person twice.
    await reply(
      ctx,
      "That's your own code — you can't be your own backup.\n\n" +
        'Give it to someone else, and they send <code>/caregiver ' + esc(code.toUpperCase()) + '</code>.',
    );
    return;
  }

  const result = await adb.redeemInvite(code, ctx.chatId, ctx.now, 'caregiver');
  if (!result.ok) {
    const why =
      result.reason === 'wrong_kind' ? 'That code is not a caregiver code.'
      : result.reason === 'used' ? 'That code has already been used.'
      : result.reason === 'expired' ? 'That code has expired.'
      : 'That code is not valid.';
    await reply(ctx, `${why} Ask them to run /invite again — each code works once.`);
    return;
  }

  const invite = result.invite!;
  if (invite.patientId === null) {
    await reply(ctx, 'That code is missing the person it belongs to. Ask them to run /invite again.');
    return;
  }

  const delay = invite.escalateAfterMs ?? 5 * MINUTE;
  const patient = await ctx.db.getPatient(invite.patientId);

  // Backing someone up does not make you a different sort of user. If this chat has no
  // record of its own yet, it gets one now -- so they can import their own prescription
  // without having to be invited a second time.
  let own = existing.find((l) => l.role === 'patient');
  if (own === undefined) {
    const ownId = await ctx.db.createPatient(ctx.userName, patient?.tz ?? 'UTC', ctx.now);
    await ctx.db.linkChat(ctx.chatId, ownId, 'patient', 0, 5 * MINUTE, ctx.now, ctx.userName);
    if (ctx.nameKnown === false) await askForName(ctx, ownId);
    own = (await ctx.db.linksForChat(ctx.chatId)).find((l) => l.role === 'patient');
  }

  await ctx.db.linkChat(ctx.chatId, invite.patientId, 'caregiver', 1, delay, ctx.now, ctx.userName);
  await reply(
    ctx,
    `✅ You're now the backup for <b>${esc(patient?.displayName ?? 'them')}</b>.\n\n` +
      `If they don't answer within ${fmtDuration(delay)} — medicines, meals, waking up, going to bed — ` +
      "I'll ask you instead, and you can answer on their behalf. Otherwise I'll leave you alone.\n\n" +
      "You also have your own account here, so if you're ever prescribed something yourself, " +
      '<code>/import</code> it and I\'ll remind you too.\n\n' +
      '<i>Step back at any time with /leave.</i>',
  );
  // Tell them their safety net is in place, from the chat that will be doing the asking.
  for (const chat of await ctx.db.chatsFor(invite.patientId)) {
    if (chat.role !== 'patient') continue;
    await ctx.tg.sendMessage(
      chat.chatId,
      `🛟 <b>${esc(ctx.userName)}</b> is now your backup. If you don't answer something within ` +
        `${fmtDuration(delay)}, I'll ask them instead.`,
    );
  }
}

// --- day state -----------------------------------------------------------

/**
 * "Tonight I'm turning in at half twelve."
 *
 * Tonight only. `/settings sleep` changes the routine -- the hour the bot starts from
 * every evening -- and most of the time what someone means is just this once: a late
 * film, an early start tomorrow. Conflating the two means every exception quietly
 * rewrites the rule.
 *
 * Everything recalculates from the new time: the two questions before it, what gets
 * brought forward to fit before it, and what is left to tomorrow.
 */
async function cmdBedtime(ctx: CmdCtx, args: string): Promise<void> {
  const ap = await acting(ctx, args, 'bedtime');
  if (ap === null) return;
  const { patient, z } = ap;
  const rest = ap.rest.trim();

  if (rest === '') {
    const current = patient.expectedSleepAt ?? z.nextWallAtOrAfter(patient.presumedSleepAt, ctx.now);
    await reply(
      ctx,
      `🌙 Tonight I'm expecting you to turn in around <b>${z.fmtTime12(current)}</b>.\n\n` +
        `Change it for tonight with <code>/bedtime 12:30am</code>, or for good with ` +
        `<code>/settings sleep 00:30</code>.`,
    );
    return;
  }

  // A bedtime is the next occurrence of that wall time -- "half twelve" said at eleven
  // at night means tonight, not thirteen hours ago.
  let at: number;
  try {
    const { h, mi } = parseWall(rest);
    at = z.nextWallAtOrAfter(`${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`, ctx.now);
  } catch {
    const parsed = parseTime(rest, ctx.now, z);
    if (parsed === null) {
      await reply(ctx, `I couldn't read "${esc(rest)}" as a time. Try <code>/bedtime 12:30am</code>.`);
      return;
    }
    at = parsed.at <= ctx.now ? parsed.at + DAY_MS : parsed.at;
  }

  if (at > ctx.now + 20 * HOUR) {
    await reply(ctx, "That's more than a day away — did you mean tonight?");
    return;
  }

  await ctx.db.setExpectedSleep(patient.id, at, ctx.now);
  for (const q of await ctx.db.openPromptsFor(patient.id)) {
    if (q.kind !== 'sleep') continue;
    await ctx.db.closePrompt(q.id, 'resolved', ctx.now);
    await clearPromptMessages({ db: ctx.db, tg: ctx.tg, z, now: ctx.now }, q.id);
  }

  await reply(
    ctx,
    `🌙 Bedtime tonight: <b>${z.fmtTime12(at)}</b>${onBehalf(ap)}.\n\n` +
      `I'll fit what I can before it and check in beforehand. ` +
      `<i>Your usual ${esc(patient.presumedSleepAt)} is unchanged — <code>/settings sleep</code> for that.</i>`,
  );
  await tellTheOthers(ctx, ap, `🌙 ${esc(ctx.userName)} set tonight's bedtime to ${z.fmtTime12(at)}.`);
}

/**
 * The shortest stretch of being up that counts as a day.
 *
 * /sleep ends the day; a doze on the sofa does not. Without a floor, "up" and "in bed"
 * ping-pong: the day restarts, medicines re-anchor on a wake that was really a nap, and
 * the schedule walks. Naps need no command at all -- the bot simply carries on.
 */
const MIN_AWAKE = 4 * HOUR;

async function cmdWake(ctx: CmdCtx, kind: 'wake' | 'sleep', args: string, force = false): Promise<void> {
  const ap = await acting(ctx, args, kind === 'wake' ? 'the morning' : 'bedtime');
  if (ap === null) return;
  const { patient, z } = ap;
  args = ap.rest;

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

  if (kind === 'sleep' && !force) {
    if (patient.wakeState === 'asleep') {
      await reply(ctx, "🌙 You're already down for the night as far as I'm concerned — sleep well.");
      return;
    }
    const upFor = at - patient.wakeStateSince;
    if (upFor < MIN_AWAKE) {
      await reply(
        ctx,
        `You've only been up ${esc(fmtDuration(Math.max(upFor, 0)))}, so I'll leave the day running.\n\n` +
          `Nap as much as you like — you don't need to tell me, and I'll keep the reminders coming. ` +
          `<b>/sleep</b> is for the end of the day, when you're turning in for the night.`,
        [[{ text: "🌙 No, I'm turning in for the night", callback_data: encodeCallback({ a: 'sleepAnyway' }) }]],
      );
      return;
    }
  }

  await ctx.db.setWake(patient.id, kind === 'wake' ? 'awake' : 'asleep', at, z.localDay(at), 'command', ctx.chatId);
  for (const q of await ctx.db.openPromptsFor(patient.id)) {
    if (q.kind === kind) {
      await ctx.db.closePrompt(q.id, 'resolved', ctx.now);
      await clearPromptMessages({ db: ctx.db, tg: ctx.tg, z, now: ctx.now }, q.id);
    }
  }

  if (kind === 'wake') {
    await reply(
      ctx,
      ap.isSelf
        ? `☀️ Good morning${suffix}. Starting today's schedule — I'll let you know when something is due.`
        : `☀️ Noted${suffix} — <b>${esc(patient.displayName)}</b> is up. Starting their day.`,
    );
    await tellTheOthers(ctx, ap, `☀️ ${esc(ctx.userName)} says you're up${suffix}. Starting today's schedule.`);
    return;
  }

  await sayGoodnight(ctx, ap, suffix);
  await tellTheOthers(ctx, ap, `🌙 ${esc(ctx.userName)} says you've turned in${suffix}. I'll keep quiet until morning.`);
}

/**
 * Going to bed, with whatever is still outstanding named rather than left to rot.
 *
 * Sleep does not clear the day by itself: an unanswered dose stays unanswered, parks
 * overnight and comes back in the morning. But saying nothing about it is how a person
 * ends up with three days of "missed" in their log that they actually took. So they get
 * told, and given the three honest answers.
 */
export function bedtimeButtons(): Array<Array<{ text: string; callback_data: string }>> {
  return [
    [{ text: '✅ I took them', callback_data: encodeCallback({ a: 'bedtime', choice: 'took' }) }],
    [{ text: "⏭ I'm skipping them", callback_data: encodeCallback({ a: 'bedtime', choice: 'skip' }) }],
    [{ text: '🌙 Leave them for morning', callback_data: encodeCallback({ a: 'bedtime', choice: 'leave' }) }],
  ];
}

export async function goodnightMessage(ctx: CmdCtx, patientId: number, suffix = ''): Promise<string> {
  const patient = await ctx.db.getPatient(patientId);
  const z = zoneFor(patient?.tz ?? 'UTC');
  const outstanding = await ctx.db.outstandingDoses(patientId);
  if (outstanding.length === 0) {
    return `🌙 Sleep well${suffix}. Everything's done for today — I'll keep quiet until morning.`;
  }
  const names = outstanding.map((d) => `• ${esc(d.label)} — <i>due ${z.fmtTime12(d.dose.effectiveDueAt)}</i>`);
  return (
    `🌙 Sleep well${suffix}. I'll keep quiet until morning.\n\n` +
    `<b>Still outstanding today</b>\n${names.join('\n')}\n\n` +
    `What should I do with ${outstanding.length === 1 ? 'it' : 'them'}?`
  );
}

/** The "yes, I really am going to bed" button, bypassing the too-soon guard. */
export async function forceSleep(ctx: CmdCtx): Promise<void> {
  await cmdWake(ctx, 'sleep', '', true);
}

async function sayGoodnight(
  ctx: CmdCtx,
  ap: { patient: Patient; z: Zone },
  suffix = '',
): Promise<void> {
  const outstanding = await ctx.db.outstandingDoses(ap.patient.id);
  const text = await goodnightMessage(ctx, ap.patient.id, suffix);
  await reply(ctx, text, outstanding.length === 0 ? undefined : bedtimeButtons());
}

/** The answer to that question. Exported because the button lands in the callback handler. */
export async function resolveBedtime(ctx: CmdCtx, choice: 'took' | 'skip' | 'leave'): Promise<string> {
  const found = await actingPatient(ctx, '');
  if (found === null || 'ambiguous' in found) return 'I need to know who you are first — send /start.';
  const ap = found;
  const { patient, z } = ap;

  if (choice === 'leave') {
    return (
      "🌙 Left as they are. They'll be waiting when you get up, re-timed to whenever that " +
      'actually is — nothing is logged as missed in the meantime.'
    );
  }

  const outstanding = await ctx.db.outstandingDoses(patient.id);
  if (outstanding.length === 0) return 'Nothing outstanding — all dealt with.';

  const status = choice === 'took' ? 'taken' : 'skipped';
  const done: string[] = [];
  for (const item of outstanding) {
    const res = await ctx.db.tryResolveDose(item.dose.id, ctx.chatId, status, ctx.now, ctx.now, 'bedtime');
    if (res.won) done.push(item.label);
    if (item.dose.promptId !== null) {
      await ctx.db.closePrompt(item.dose.promptId, 'resolved', ctx.now);
      await clearPromptMessages({ db: ctx.db, tg: ctx.tg, z, now: ctx.now }, item.dose.promptId);
    }
  }
  if (done.length === 0) return 'Those were already dealt with — nothing more to do.';

  return choice === 'took'
    ? `✅ Logged as taken: ${done.map(esc).join(', ')}.\n\n` +
        `If any of those were earlier than now, <code>/took ${esc(done[0] ?? 'name')} 9pm</code> corrects the time. ` +
        `<code>/undo</code> puts it all back.`
    : `⏭ Logged as skipped: ${done.map(esc).join(', ')}.\n\n` +
        `⚠️ <b>These count as doses you did not take</b> — they'll show in /log, and tomorrow starts ` +
        `fresh from whenever you get up rather than carrying on from today. ` +
        `<code>/undo</code> puts it back if that wasn't what you meant.`;
}

/**
 * "I'm eating in an hour." The forward-looking half of meal handling, and the only way a
 * before-meal tablet can be timed at all.
 */
async function cmdEating(ctx: CmdCtx, args: string): Promise<void> {
  const ap = await acting(ctx, args, 'the meal');
  if (ap === null) return;
  const { patient, z } = ap;
  args = ap.rest;

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

  await ctx.db.recordMeal(patient.id, meal, mealDayOf(z, patient, plannedAt), plannedAt, 'planned', plannedAt, ctx.chatId, ctx.now);
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
  await tellTheOthers(ctx, ap, mealNews(patient.displayName, meal, 'planned', plannedAt, z, ctx.userName), true);
}

async function cmdAte(ctx: CmdCtx, args: string): Promise<void> {
  const ap = await acting(ctx, args, 'the meal');
  if (ap === null) return;
  const { patient, z } = ap;
  args = ap.rest;

  const { head, time } = splitTrailingTime(args, ctx.now, z);
  const meal = head.trim().toLowerCase();
  if (meal === '') {
    await reply(ctx, 'Which meal? e.g. <code>/ate lunch</code> or <code>/ate breakfast 8:30am</code>');
    return;
  }
  const at = time?.at ?? ctx.now;
  await ctx.db.recordMeal(patient.id, meal, mealDayOf(z, patient, at), at, 'confirmed', null, ctx.chatId, ctx.now);
  await ctx.db.wakeNow(patient.id, ctx.now);
  for (const q of await ctx.db.openPromptsFor(patient.id)) {
    if (q.kind === 'meal' && q.body.meal === meal) {
      await ctx.db.closePrompt(q.id, 'resolved', ctx.now);
      await clearPromptMessages({ db: ctx.db, tg: ctx.tg, z, now: ctx.now }, q.id);
    }
  }
  await reply(ctx, `🍽 Noted — ${esc(meal)} at ${z.fmtTime12(at)}${onBehalf(ap)}.`);
  await tellTheOthers(ctx, ap, mealNews(patient.displayName, meal, 'confirmed', at, z, ctx.userName), true);
}

// --- doses ---------------------------------------------------------------

async function cmdTook(ctx: CmdCtx, args: string): Promise<void> {
  const ap = await acting(ctx, args, 'the dose');
  if (ap === null) return;
  const { patient, z } = ap;
  args = ap.rest;

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
      await reply(ctx, "Nothing is pending right now. Name the medicine if you're logging something else: <code>/took drops 5pm</code>");
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
      await reply(ctx, `No medicine matching "${esc(head)}".\n\n${await medicineList(ctx, patient.id)}`);
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
    if (live !== null) await clearDoseNotes(dctx, live.id);
    const line = renderConfirmation(label, outcome.takenAt, z, ctx.userName, outcome.takenAt < ctx.now - 2 * MINUTE);
    await reply(ctx, line + warn);
    await broadcast(dctx, chats, line, ctx.chatId);
    await noteSpacedNeighbours(ctx, patient.id, target, outcome.takenAt);
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
  const ap = await acting(ctx, args, 'the dose');
  if (ap === null) return;
  args = ap.rest;
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
  const ap = await acting(ctx, args, 'the reminder');
  if (ap === null) return;
  args = ap.rest;
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
  const links = await ctx.db.linksForChat(ctx.chatId);
  if (links.length === 0) return needsSetup(ctx);

  const done = await ctx.db.undoLast(links.map((l) => l.patientId), ctx.now);
  if (done === null) {
    await reply(
      ctx,
      "Nothing to undo — I haven't recorded a decision in the last day.\n\n" +
        'To correct something older, just state the truth and I\'ll fix the schedule:\n' +
        '• <code>/took drops 5pm</code> — even if I already logged it as missed\n' +
        '• <code>/skip drops</code> — if you decided not to take it\n' +
        '• <code>/awake 6:30am</code> — if I started the day at the wrong time',
    );
    return;
  }

  const patient = links[0] === undefined ? null : await ctx.db.getPatient(links[0].patientId);
  const z = zoneFor(patient?.tz ?? 'UTC');
  await reply(
    ctx,
    `↩️ Undone — <b>${esc(done.medName)}</b> ${esc(done.status === 'undone' ? 'is back as it was' : `is no longer recorded as ${done.status}`)} ` +
      `(logged ${z.fmtTime12(done.at)}).\n\n` +
      "I've put the schedule back to where it was. Send /undo again to step back further.",
  );
}

// --- information ---------------------------------------------------------

/**
 * Status for everyone this chat is responsible for.
 *
 * A caregiver's whole job is knowing whether someone else is all right, and making them
 * type a name to find out -- or worse, guess at the spelling -- is the wrong way round.
 * A bare /status covers themselves and everyone they back up, in that order.
 */
async function cmdStatus(ctx: CmdCtx, args = ''): Promise<void> {
  if (args.trim() === '') {
    const links = await ctx.db.linksForChat(ctx.chatId);
    if (links.length === 0) return needsSetup(ctx);
    const ordered = [...links].sort((a, b) => (a.role === 'patient' ? -1 : 0) - (b.role === 'patient' ? -1 : 0));
    for (const link of ordered) {
      const p = await ctx.db.getPatient(link.patientId);
      if (p === null) continue;
      await statusFor(ctx, { patient: p, z: zoneFor(p.tz), isSelf: link.role === 'patient' });
    }
    return;
  }

  const view = await resolveViewable(ctx, args);
  if (view === null) {
    await reply(ctx, `You're not linked to anyone called "${esc(args.trim())}". /patients lists who you are.`);
    return;
  }
  await statusFor(ctx, view);
}

async function statusFor(ctx: CmdCtx, view: { patient: Patient; z: Zone; isSelf: boolean }): Promise<void> {
  const { patient, z } = view;
  const meds = await ctx.db.medsFor(patient.id);
  const today = z.localDay(ctx.now);
  // Meals are read by the waking day, exactly as the planner and every write path do.
  // Leaving this one on the calendar day meant a dinner confirmed after midnight
  // disappeared from the very command that had just been asked about it.
  const mealDay = mealDayOf(z, patient, ctx.now);

  const lines: string[] = [
    `<b>${esc(patient.displayName)}</b>${view.isSelf ? '' : ' <i>(you back them up)</i>'} · ${z.fmtTime12(ctx.now)}`,
    patient.wakeState === 'awake'
      ? `☀️ Awake${patient.lastWakeAt !== null ? ` since ${z.fmtTime12(patient.lastWakeAt)}` : ''}` +
        (patient.wakeConfidence === 'confirmed' ? '' : ` <i>(${patient.wakeConfidence})</i>`)
      : `🌙 Asleep${patient.lastSleepAt !== null ? ` since ${z.fmtTime12(patient.lastSleepAt)}` : ''}`,
  ];

  if (meds.length === 0) {
    lines.push('', view.isSelf
      ? 'No medicines yet — send /import, or /prompt to get the format.'
      : 'They have no medicines loaded yet.');
    await reply(ctx, lines.join('\n'));
    return;
  }

  const pending: string[] = [];
  const upcoming: Array<{ at: number; text: string }> = [];
  const liveByMed = new Map<number, number | null>();

  for (const med of meds) {
    const live = await ctx.db.liveDoseFor(med.id);
    if (live === null) {
      // Between a dose being answered and the planner building its successor, a medicine
      // has nothing live. Dropping it from the list here made it look as though it had
      // finished for the day while the count below still said otherwise.
      liveByMed.set(med.id, null);
      if (med.status === 'active' && med.kind !== 'as_needed') {
        upcoming.push({ at: Number.MAX_SAFE_INTEGER - 1, text: `• ${esc(med.name)} — <i>working out the next one</i>` });
      }
      continue;
    }
    liveByMed.set(med.id, live.effectiveDueAt);
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
    } else if (live.effectiveDueAt <= ctx.now) {
      // Scheduled, its time gone, and still not due: it is waiting on a meal. Saying
      // "in 45m" about a time forty-five minutes ago is worse than saying nothing.
      upcoming.push({
        at: live.effectiveDueAt,
        text: `• ${esc(label)} — <i>waiting until you've eaten</i>`,
      });
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
  const doneByMed = new Map<number, number>();
  for (const r of rows) {
    if (r.status === 'taken') taken += r.n;
    if (r.status === 'missed') missed += r.n;
    // Taken, missed and skipped are all behind you; only what is left counts as left.
    doneByMed.set(r.medId, (doneByMed.get(r.medId) ?? 0) + r.n);
  }

  // How much of the course is still ahead. The question anyone three days into a week of
  // eye drops actually has, and the one /status could not answer.
  // The day ends when the patient is expected to be asleep. Anything the schedule puts
  // past that belongs to tomorrow, and saying otherwise contradicts the list above.
  const endsAt = z.nextWallAtOrAfter(patient.presumedSleepAt, ctx.now);
  const mealEvents = await ctx.db.mealEventsFor(patient.id, mealDay);
  const mealsLeft = (await ctx.db.mealDefsFor(patient.id)).filter((d) => {
    const e = mealEvents.find((x) => x.meal === d.meal);
    return e === undefined || e.source === 'planned';
  }).length;

  let leftToday = 0;
  let leftCourse = 0;
  let openEnded = false;
  const perMed: string[] = [];
  for (const med of meds) {
    if (med.status !== 'active') continue;
    const r = remainingFor(med, patient, doneByMed.get(med.id) ?? 0, ctx.now, z, today, {
      nextDueAt: liveByMed.get(med.id) ?? null,
      endsAt,
      mealsLeft,
    });
    if (r.perDay === 0) continue;
    leftToday += r.today;
    if (r.course === null) openEnded = true;
    else leftCourse += r.course;
    perMed.push(
      `• ${esc(med.name)} — ${r.today} today` +
        (r.course === null ? ', ongoing' : `, ${r.course} left`),
    );
  }
  const summary = summarise(leftToday, leftCourse, openEnded);
  if (summary !== '') {
    lines.push('', `<b>Doses left</b> — ${summary}`, ...perMed);
  }

  if (taken > 0 || missed > 0) {
    lines.push('', `<b>Today so far</b> — ${taken} taken${missed > 0 ? `, ${missed} missed` : ''}`);
  }

  // A medicine stopped before its course ran out is the one thing /status must not be
  // silent about. Two of Ifti's were stopped mid-course by a mistyped command and nothing
  // anywhere said so -- they simply never came up again, which is the exact failure this
  // whole bot exists to prevent. An indefinite medicine is left out: stopping one is how
  // it ends, so it is not news.
  const stoppedEarly = (await ctx.db.medsFor(patient.id, true)).filter((m) => {
    if (m.status !== 'discontinued' && m.status !== 'paused') return false;
    switch (m.courseKind) {
      case 'days':
        // A course that never got its first dose has `startedAt` null; stopping it is
        // still stopping it part-way.
        return m.courseDays !== null
          && (m.startedAt === null || z.diffLocalDays(z.localDay(m.startedAt), today) < m.courseDays);
      case 'doses':
        return m.courseDoses !== null && m.dosesTaken < m.courseDoses;
      case 'until':
        return m.courseUntil !== null && m.courseUntil > ctx.now;
      case 'indefinite':
        return false;
    }
  });
  if (stoppedEarly.length > 0) {
    lines.push(
      '',
      '<b>Stopped before the course finished</b>',
      ...stoppedEarly.map(
        (m) => `• ${esc(m.name)} — ${m.status === 'paused' ? 'paused' : 'stopped'} · ` +
          `<code>/resume ${esc(m.medKey)}</code>`,
      ),
    );
  }

  // Meals are part of the day whether or not a tablet hangs off one: the bot asks about
  // them, anchors the schedule on them, and the household reads them to see how the day
  // is going. Gating this on an active meal-anchored medicine meant that the moment the
  // last such medicine stopped, breakfast/lunch/dinner vanished from /status with no
  // explanation -- which is exactly how they disappeared in real use.
  {
    const defs = [...(await ctx.db.mealDefsFor(patient.id))].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    // Filed under this day *and* actually belonging to it -- the same rule the planner
    // reads by. A dinner confirmed after midnight once landed on the following day, and
    // /status opened the afternoon with "✅ dinner 10:22pm", eight hours early.
    const events = (await ctx.db.mealEventsFor(patient.id, mealDay))
      .filter((e) => mealDayOf(z, patient, e.at) === mealDay);
    const offsets = wakeOffsets(defs);
    const anchor = patient.lastWakeAt ?? patient.wakeStateSince;

    const mealLine = defs
      .map((d, i) => {
        const e = events.find((x) => x.meal === d.meal);
        if (e !== undefined && e.source === 'skipped') return `⏭ ${d.meal}`;
        if (e !== undefined && (e.source === 'confirmed' || e.source === 'presumed')) {
          return `✅ ${d.meal} ${z.fmtTime12(e.at)}`;
        }
        // Still ahead: say when, because the before-meal tablets hang off it and "·"
        // tells nobody anything.
        const at = e?.at ?? anchor + (offsets[i] ?? 0);
        return `· ${d.meal} ~${z.fmtTime12(at)}`;
      })
      .join('\n');
    if (mealLine !== '') lines.push('', `<b>Meals</b>\n${mealLine}`);
  }

  await reply(ctx, lines.join('\n'));
}

async function cmdMeds(ctx: CmdCtx, args = ''): Promise<void> {
  const view = args.trim() === '' ? await actingPatient(ctx, '') : await resolveViewable(ctx, args);
  if (view === null) return needsSetup(ctx);
  if ('ambiguous' in view) {
    await reply(ctx, `Whose medicines? ${view.ambiguous.map(esc).join(', ')} — name one, e.g. <code>/meds ${esc(view.ambiguous[0] ?? '')}</code>.`);
    return;
  }
  const ap = { patient: view.patient, z: view.z };
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
  const ap = await acting(ctx, args, 'the log');
  if (ap === null) return;
  args = ap.rest;
  const days = Math.min(30, Math.max(1, Number(args.trim()) || 7));
  const since = ap.z.addLocalDays(ap.z.localDay(ctx.now), -(days - 1));
  const meds = await ctx.db.medsFor(ap.patient.id, true);
  const byId = new Map(meds.map((m) => [m.id, m]));
  const history = await ctx.db.doseHistory(ap.patient.id, since);

  // What the log is for: the doses themselves, newest first. It used to answer with a
  // percentage per medicine, which is a report card -- nobody opens the log to be graded,
  // they open it to settle "did that one get taken, and when".
  const lines: string[] = [];
  let day = '';
  let taken = 0;
  let missed = 0;
  let skipped = 0;
  for (const h of history) {
    const med = byId.get(h.medId);
    if (med === undefined) continue;
    if (h.status === 'taken') taken++;
    else if (h.status === 'missed') missed++;
    else skipped++;

    const d = ap.z.localDay(h.at);
    if (d !== day) {
      day = d;
      const back = ap.z.diffLocalDays(d, ap.z.localDay(ctx.now));
      lines.push('', `<b>${back === 0 ? 'Today' : back === 1 ? 'Yesterday' : esc(d)}</b>`);
    }
    const step = med.steps[h.step];
    const label = med.steps.length > 1 && step !== undefined ? `${step.name} (${h.step + 1}/${med.steps.length})` : med.name;
    const icon = h.status === 'taken' ? '✅' : h.status === 'skipped' ? '⏭' : '❌';
    const tail = h.status === 'taken'
      ? (h.src === 'auto' ? ' <i>(auto)</i>' : '')
      : ` — <i>${h.status}</i>`;
    lines.push(`${icon} ${ap.z.fmtTime12(h.at)} ${esc(label)}${tail}`);
  }

  if (lines.length === 0) {
    await reply(ctx, `Nothing logged in the last ${days} day${days === 1 ? '' : 's'}.`);
    return;
  }
  const tally = [`${taken} taken`, missed > 0 ? `${missed} missed` : '', skipped > 0 ? `${skipped} skipped` : '']
    .filter((x) => x !== '')
    .join(' · ');
  await reply(ctx, `<b>Last ${days} days</b> — ${tally}${lines.join('\n')}`);
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
  const ap = await acting(ctx, args, 'the medicine');
  if (ap === null) return;
  args = ap.rest;
  // Off the front of the matching, or `/resume vigalon 7d` looks for a medicine called
  // "vigalon 7d".
  const statedMs = status === 'active' ? peelDuration(args) : null;
  if (statedMs !== null) args = args.replace(/\s+\S+\s*$/, '').trim();
  const meds = await ctx.db.medsFor(ap.patient.id, true);
  const matches = matchMed(meds, args);
  if (matches.length !== 1) {
    await reply(
      ctx,
      matches.length === 0
        ? `No medicine matching "${esc(args)}".\n\n${await medicineList(ctx, ap.patient.id)}`
        : `Which one?\n\n${await medicineList(ctx, ap.patient.id)}`,
    );
    return;
  }
  const med = matches[0]!;
  const word = status === 'paused' ? 'Paused' : status === 'active' ? 'Resumed' : 'Stopped';

  // Resuming a course that has already run its length.
  //
  // `/resume vigalon` set the medicine active, the planner saw that seven days had passed
  // since it first started, and completed it again on the very next tick. The bot said
  // "Resumed" and nothing happened. A course is a length, not a fixed pair of dates: if it
  // is being resumed after it ran out, it runs again from today.
  //
  // `/resume vigalon 7d` says the length outright, which is what a new prescription
  // usually means.
  let restarted: string | null = null;
  if (status === 'active') {
    const days = statedMs === null ? null : Math.max(1, Math.round(statedMs / (24 * HOUR)));
    const elapsed = courseComplete(med, ctx.now, ap.z, ap.z.localDay(ctx.now));
    if (days !== null) {
      await ctx.db.updateMed(
        med.id, { courseKind: 'days', courseDays: days, startedAt: ctx.now }, { rescheduleNow: false }, ctx.now,
      );
      restarted = `${days} day${days === 1 ? '' : 's'} from today`;
    } else if (elapsed && med.courseKind === 'days' && med.courseDays !== null) {
      await ctx.db.updateMed(med.id, { startedAt: ctx.now }, { rescheduleNow: false }, ctx.now);
      restarted = `a fresh ${med.courseDays} day${med.courseDays === 1 ? '' : 's'} from today`;
    }
  }

  if (med.status === status && restarted === null) {
    await reply(ctx, `<b>${esc(med.name)}</b> is already ${word.toLowerCase()}.`);
    return;
  }
  await ctx.db.setMedStatus(med.id, status, ctx.now);
  // This is the one edit that makes the bot go silent about a medicine for good, and it
  // was the one edit that wrote nothing to the log: two of Ifti's medicines stopped
  // mid-course with no record of who did it or when. Everything else here audits.
  await ctx.db.audit(
    ap.patient.id, 'med_status_set', String(ctx.chatId),
    { medId: med.id, medKey: med.medKey, from: med.status, to: status }, ctx.now,
  );
  await ctx.db.wakeNow(ap.patient.id, ctx.now);
  const undo = status === 'active' ? '' : `\n<i>Undo with</i> <code>/resume ${esc(med.medKey)}</code>`;
  const course = restarted === null
    ? ''
    : `\n<i>Its course had already run, so this is ${restarted}.</i>` +
      `\n<i>Different length?</i> <code>/resume ${esc(med.medKey)} 10d</code>`;
  await reply(ctx, `${word} <b>${esc(med.name)}</b>${onBehalf(ap)}.${course}${undo}`);
  // A medicine falling silent is the failure this whole bot exists to prevent, so the
  // other chats hear about it even when the patient did it to themselves.
  await tellTheOthers(
    ctx, ap,
    `⏹ <b>${esc(ap.patient.displayName)}</b> — ${esc(med.name)} ${word.toLowerCase()} by ${esc(ctx.userName)}.`,
    true,
  );
}

async function cmdTz(ctx: CmdCtx, args: string): Promise<void> {
  const ap = await acting(ctx, args, 'the timezone');
  if (ap === null) return;
  args = ap.rest;
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
  const ap = await acting(ctx, args, 'the prescription');
  if (ap === null) return;
  args = ap.rest;

  let raw = args.trim();

  if (msg.document !== undefined) {
    const size = msg.document.file_size ?? 0;
    if (size > 512_000) {
      await reply(ctx, "That file is far too large to be a prescription — is it the right one?");
      return;
    }
    const file = await ctx.tg.getFile(msg.document.file_id);
    if (!file.ok || file.result === undefined) {
      await reply(ctx, "I couldn't fetch that file from Telegram. Try sending it again.");
      return;
    }
    const content = await ctx.tg.downloadFile(file.result.file_path);
    if (content === null) {
      await reply(ctx, "I couldn't read that file. Try sending it again, or paste the JSON instead.");
      return;
    }
    raw = content;
    // A fresh file supersedes any half-finished paste.
    await ctx.db.kvSet(`import:${ctx.chatId}`, '');
  }

  if (raw === '') {
    await reply(ctx, importInstructions());
    return;
  }

  await ingestPrescription(ctx, ap.patient.id, raw, { fromFile: msg.document !== undefined });
}

function importInstructions(): string {
  return (
    '<b>Send me your prescription</b>\n\n' +
    '📎 <b>Best way: attach it as a file.</b> Save the JSON as <code>prescription.json</code> ' +
    'and send it as a document. Pasting long text into Telegram often splits it across two ' +
    'messages, which is where most import problems come from.\n\n' +
    "Pasting still works — if it arrives in pieces I'll stitch them together.\n\n" +
    "Don't have the JSON yet? Send <code>/prompt</code>."
  );
}

/**
 * Take whatever arrived and try to make a prescription of it.
 *
 * Pasted text reaches this in pieces more often than not, because Telegram clients split a
 * long paste into separate messages. A half-object is held for a few minutes and joined to
 * whatever comes next, rather than being reported as a syntax error the sender cannot
 * interpret.
 */
async function ingestPrescription(
  ctx: CmdCtx,
  patientId: number,
  raw: string,
  opts: { fromFile: boolean; continuing?: boolean },
): Promise<void> {
  const extracted = extractJson(raw);

  if (extracted.kind === 'none') {
    await reply(
      ctx,
      opts.continuing === true
        ? "That doesn't look like part of a prescription. Send /import to start again."
        : "I couldn't find any JSON in that.\n\n" + importInstructions(),
    );
    return;
  }

  if (extracted.kind === 'partial') {
    if (opts.fromFile) {
      // A file cannot have been split, so this really is incomplete.
      await reply(
        ctx,
        `⚠️ That file stops part-way through — ${extracted.missing} closing bracket` +
          `${extracted.missing === 1 ? '' : 's'} short. Check it saved completely and send it again.`,
      );
      return;
    }
    await ctx.db.kvSet(`import:${ctx.chatId}`, JSON.stringify({ text: extracted.text, at: ctx.now }));
    await reply(
      ctx,
      `📥 Got the first part — send the rest and I'll join them up.\n\n` +
        `<i>Telegram splits long pastes. If it keeps going wrong, save the JSON as a file and ` +
        `attach it instead.</i>`,
    );
    return;
  }

  await ctx.db.kvSet(`import:${ctx.chatId}`, '');

  let parsed: unknown;
  try {
    parsed = JSON.parse(extracted.text);
  } catch (e) {
    await reply(
      ctx,
      `❌ <b>That isn't valid JSON</b>\n\n<code>${esc(describeJsonError(extracted.text, e))}</code>\n\n` +
        'If you pasted it, try attaching it as a <code>.json</code> file instead — that avoids ' +
        'the message being split or reformatted.',
    );
    return;
  }

  const result = parsePrescription(parsed, { now: ctx.now });
  if (!result.ok) {
    await reply(
      ctx,
      `❌ <b>I couldn't use that prescription</b>\n\n${result.errors.map((e) => `• ${esc(e)}`).join('\n')}\n\n` +
        'Fix those and send it again — nothing has changed yet.',
    );
    return;
  }

  const presc = result.value!;
  const diff = await buildDiff(ctx, patientId, presc);
  const versionId = await ctx.db.stageePrescription(
    patientId, extracted.text, hashString(extracted.text), diff, ctx.chatId, ctx.now,
  );

  const warnings = result.warnings.length > 0
    ? `\n\n<b>Worth checking</b>\n${result.warnings.map((w) => `• ${esc(w)}`).join('\n')}`
    : '';
  // Whose prescription this is, whenever it is not the reader's own. A caregiver
  // importing for the person they look after is exactly what should happen; being unsure
  // which of the two it landed on is not.
  const owner = await ctx.db.getPatient(patientId);
  const ownLink = (await ctx.db.linksForChat(ctx.chatId)).find((l) => l.role === 'patient');
  const forWhom = owner !== null && ownLink?.patientId !== patientId
    ? ` — for <b>${esc(owner.displayName)}</b>`
    : '';

  await reply(
    ctx,
    `<b>Here's what would change</b>${forWhom}\n\n${diff}${warnings}` +
      `${presc.tz === null ? await timezoneWarning(ctx, patientId) : ''}\n\n<i>Nothing has been applied yet.</i>`,
    [[
      { text: '✅ Apply', callback_data: encodeCallback({ a: 'confirmImport', versionId }) },
      { text: '✖️ Cancel', callback_data: encodeCallback({ a: 'cancelImport', versionId }) },
    ]],
  );
}

/**
 * The medicines this patient is on, as a list you can copy a name out of.
 *
 * "No medicine matching X. /meds lists them." makes someone type a second command to
 * find out what they were supposed to have typed the first time. Just show them.
 */
async function medicineList(ctx: CmdCtx, patientId: number): Promise<string> {
  const meds = (await ctx.db.medsFor(patientId)).filter((m) => m.status === 'active');
  if (meds.length === 0) return 'You have no medicines loaded — send /import, or /prompt for the format.';
  return `<b>You're on:</b>\n${meds.map((m) => `• ${esc(m.name)} — <code>/took ${esc(m.medKey)}</code>`).join('\n')}`;
}

/**
 * "You got up at seven and it's eleven — here's what was due in between."
 *
 * The point of asking when someone actually woke rather than assuming it. A retrospective
 * wake time means hours of doses that were either taken and never logged, or genuinely
 * missed, and a bot that silently starts from now writes all of them off. They are
 * reconstructed as missed -- the honest default -- and each comes back with a button to
 * say otherwise, which is the whole reason for asking the question.
 */
export async function offerMissedSince(ctx: CmdCtx, patientId: number, wokeAt: number): Promise<void> {
  const gap = ctx.now - wokeAt;
  if (gap < 30 * MINUTE) return;

  const patient = await ctx.db.getPatient(patientId);
  if (patient === null) return;
  const z = zoneFor(patient.tz);
  const meds = await ctx.db.medsFor(patientId);

  const lines: string[] = [];
  const buttons: Array<Array<{ text: string; callback_data: string }>> = [];

  for (const med of meds) {
    if (med.status !== 'active' || med.kind !== 'interval') continue;
    const interval = med.intervalMs ?? 0;
    if (interval <= 0 || med.spec.anchor !== 'wake') continue;

    // Where the schedule would have put each dose, from the stated wake time forward.
    // A dose parked overnight is about to be revived at "now", so the gap stops short of
    // it; anything already logged in the window is left alone, since they may have
    // answered some of it at the time.
    const live = await ctx.db.liveDoseFor(med.id);
    const stopAt = live === null ? ctx.now : Math.min(ctx.now, live.effectiveDueAt);
    const times: number[] = [];
    for (let at = wokeAt + med.onsetOffsetMs; at < stopAt && times.length < 8; at += interval) {
      if (med.lastTakenAt !== null && Math.abs(at - med.lastTakenAt) < med.minGapMs) continue;
      times.push(at);
    }
    if (times.length === 0) continue;

    const made = await ctx.db.reconstructMissed(med, patientId, times, (at) => z.localDay(at), ctx.now);
    lines.push(
      `• <b>${esc(med.name)}</b> — ${made.map((m) => z.fmtTime12(m.at)).join(', ')}`,
    );
    // A button per dose, not one per medicine. With one, every reconstructed dose but the
    // last was unreachable: the only way to correct them was to know the /took syntax.
    for (const m of made.slice(-4)) {
      buttons.push([
        {
          text: `✅ Took ${med.name.slice(0, 16)} ${z.fmtTime12(m.at)}`,
          callback_data: encodeCallback({ a: 'tookPast', doseId: m.id }),
        },
      ]);
    }
  }

  if (lines.length === 0) return;
  await reply(
    ctx,
    `🕐 <b>While you were up but not telling me</b>\n\n${lines.join('\n')}\n\n` +
      `I've logged those as missed for now — anything still due I'll ask about separately. ` +
      `Tap below for anything you actually took, ` +
      `or <code>/took ${esc(meds[0]?.medKey ?? 'name')} 8am</code> to be exact.`,
    buttons,
  );
}

/**
 * "Right — the next drop in ten minutes."
 *
 * Two drops ten minutes apart usually arrive as two reminders sitting in the chat at
 * once, and answering the first silently pushes the second back. Silently is the problem:
 * the second reminder just sits there looking overdue, and the obvious thing to do with
 * an overdue reminder is tap it, which is how you end up with two drops in one eye.
 *
 * So say it. And offer the one honest alternative -- they may genuinely have done both --
 * rather than making them wait ten minutes to tell the truth.
 *
 * Only for a dose taken *just now*: a retrospective "/took drops 5pm" says nothing about
 * what is happening in the next ten minutes. And only for group members still outstanding,
 * never one already skipped or answered.
 */
export async function noteSpacedNeighbours(
  ctx: CmdCtx,
  patientId: number,
  med: Medicine,
  takenAt: number,
): Promise<void> {
  if (med.spacingGroup === null || med.spacingMs <= 0) return;
  if (Math.abs(takenAt - ctx.now) > 2 * MINUTE) return; // not "just now"

  const patient = await ctx.db.getPatient(patientId);
  if (patient === null) return;
  const z = zoneFor(patient.tz);

  // Only the drops queued alongside this one. A group member whose next dose is at
  // quarter past three is not waiting on anything -- naming it read as "you still owe me
  // this", and its button offered to mark a dose hours away as already taken.
  const queued: Array<{ label: string; dueAt: number; doseId: number }> = [];
  for (const other of await ctx.db.medsFor(patientId)) {
    if (other.id === med.id || other.status !== 'active') continue;
    if (other.spacingGroup !== med.spacingGroup) continue;
    const live = await ctx.db.liveDoseFor(other.id);
    if (live === null || live.takenAt !== null) continue;
    if (live.status !== 'due' && live.status !== 'prompted') continue;
    queued.push({
      label: other.steps.length > 1 ? (other.steps[live.step]?.name ?? other.name) : other.name,
      dueAt: live.effectiveDueAt,
      doseId: live.id,
    });
  }
  if (queued.length === 0) return;

  // And only the ones this actually moves, worked out the way the planner will: each takes
  // the later of its own time and the running floor. A drop already sitting far enough
  // ahead is left alone and not mentioned, because nothing has changed for it.
  const spacing = Math.max(med.spacingMs, 0);
  queued.sort((a, b) => a.dueAt - b.dueAt);
  let floor = takenAt + spacing;
  const waiting: Array<{ label: string; at: number; doseId: number }> = [];
  for (const q of queued) {
    const moved = Math.max(q.dueAt, floor);
    if (moved > q.dueAt + MINUTE) waiting.push({ label: q.label, at: moved, doseId: q.doseId });
    floor = moved + spacing;
  }
  if (waiting.length === 0) return;

  const lines = waiting.map((w) => `• <b>${esc(w.label)}</b> — ${z.fmtTime12(w.at)}`);
  const sent = await ctx.tg.sendMessage(
    ctx.chatId,
    `⏳ <b>Give it ${esc(fmtDuration(spacing))}.</b>\n\n${lines.join('\n')}\n\n` +
      `<i>I'll remind you. Tap below only if you have already done ${waiting.length === 1 ? 'it' : 'them'}.</i>`,
    {
      replyMarkup: {
        inline_keyboard: waiting.slice(0, 3).map((w) => [
          { text: `✅ Already did ${w.label.slice(0, 20)}`, callback_data: encodeCallback({ a: 'take', doseId: w.doseId }) },
        ]),
      },
    },
  );
  // Remembered against every dose it offers, so whichever of them is answered first takes
  // the note down with it rather than leaving a live button on finished business.
  const messageId = sent.result?.message_id;
  if (messageId !== undefined) {
    for (const w of waiting) await ctx.db.noteMessage(w.doseId, ctx.chatId, messageId, ctx.now);
  }
}

/** A paste that arrived in pieces, if one is still in progress. */
async function pendingImport(ctx: CmdCtx): Promise<string | null> {
  const raw = await ctx.db.kvGet(`import:${ctx.chatId}`);
  if (raw === null || raw === '') return null;
  try {
    const held = JSON.parse(raw) as { text: string; at: number };
    // Ten minutes, after which an abandoned half-paste stops hijacking ordinary messages.
    if (ctx.now - held.at > 10 * 60_000) {
      await ctx.db.kvSet(`import:${ctx.chatId}`, '');
      return null;
    }
    return held.text;
  } catch {
    return null;
  }
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
    "I'll start reminding you from the next dose. /meds shows everything, /status shows what's next." +
    (await timezoneWarning(ctx, version.patientId))
  );
}

/**
 * Nothing else in the bot is wrong by six hours, silently.
 *
 * A patient who never sent /tz, with a prescription whose chatbot did not fill in a
 * timezone, gets a schedule built on UTC: their morning poll fires in the middle of the
 * night and their eye drops are due while they are asleep. Every time is plausible and
 * every time is wrong, which is the hardest kind of wrong to notice.
 */
async function timezoneWarning(ctx: CmdCtx, patientId: number): Promise<string> {
  const patient = await ctx.db.getPatient(patientId);
  if (patient === null || patient.tz !== 'UTC') return '';
  const z = zoneFor('UTC');
  return (
    `\n\n⚠️ <b>I still think you're on UTC</b> — it's ${z.fmtTime12(ctx.now)} as far as I know. ` +
    `Send <code>/tz Asia/Dhaka</code> (or wherever you are) or every reminder will be hours out.`
  );
}

async function cmdExport(ctx: CmdCtx): Promise<void> {
  const ap = await acting(ctx, '', 'the prescription');
  if (ap === null) return;
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
  const ap = await acting(ctx, args, 'the change');
  if (ap === null) return;
  args = ap.rest;

  const usage =
    '<b>Changing a medicine</b>\n' +
    '<code>/edit drops every 3h</code> — dosing interval\n' +
    '<code>/edit drops times 08:00,20:00</code> — fixed clock times\n' +
    '<code>/edit drops dose 2 drops</code> — what to take\n' +
    '<code>/edit drops name Antibiotic drop</code>\n' +
    '<code>/edit drops mingap 90m</code> — minimum safe gap\n' +
    '<code>/edit drops spacing 15m</code> — gap between drops in a group\n' +
    '<code>/edit drops maxperday 4</code>\n' +
    '<code>/edit drops critical on</code> — may wake you at night\n' +
    '<code>/edit drops note Shake well</code>\n\n' +
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
    case 'perday':
    case 'daily':
    case 'timesperday':
    case 'times_per_day': {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > 12) {
        await reply(ctx, 'How many doses a day? Give a whole number between 1 and 12.');
        return;
      }
      // Spread across the patient's own waking window, so three a day means three across
      // the day they actually have -- the same arithmetic an import would do.
      const ms = dosesPerDayInterval(ap.patient.morningPollAt, ap.patient.eveningPollAt, n);
      await ctx.db.updateMed(med.id, {
        intervalMs: ms,
        minGapMs: Math.min(med.minGapMs, Math.floor(ms * 0.75)),
        spec: { kind: 'interval', intervalMs: ms, anchor: 'wake' },
      }, { rescheduleNow: true }, ctx.now);
      summary = `now ${n} time${n === 1 ? '' : 's'} a day (about every ${fmtDuration(ms)} while awake)`;
      break;
    }

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
        await reply(ctx, 'Give me at least one time, e.g. <code>/edit drops times 08:00,20:00</code>');
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
  const ap = await acting(ctx, args, 'the course');
  if (ap === null) return;
  args = ap.rest;

  const parts = args.trim().split(/\s+/).filter((x) => x !== '');
  if (parts.length < 2) {
    await reply(ctx, 'How much longer? e.g. <code>/extend drops 3d</code>');
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
  const ap = await acting(ctx, args, 'the medicine');
  if (ap === null) return;
  args = ap.rest;

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

/** Who this chat can see and answer for, and who is watching over this patient. */
async function cmdPatients(ctx: CmdCtx): Promise<void> {
  const links = await ctx.db.linksForChat(ctx.chatId);
  if (links.length === 0) return needsSetup(ctx);

  const lines: string[] = [];
  const buttons: Array<Array<{ text: string; callback_data: string }>> = [];

  const own = links.filter((l) => l.role === 'patient');
  const watching = links.filter((l) => l.role === 'caregiver');

  for (const l of own) {
    const p = await ctx.db.getPatient(l.patientId);
    if (p === null) continue;
    const z = zoneFor(p.tz);
    const meds = await ctx.db.medsFor(l.patientId);
    lines.push(
      `<b>${esc(p.displayName)}</b> — you\n` +
        `  ${p.wakeState === 'awake' ? '☀️ awake' : '🌙 asleep'} · ${z.fmtTime12(ctx.now)} ${esc(p.tz)}\n` +
        `  ${meds.length} active medicine${meds.length === 1 ? '' : 's'}`,
    );

    // Who is backing this person up, and a button to end each arrangement.
    const carers = await ctx.db.caregiversFor(l.patientId);
    if (carers.length === 0) {
      lines.push('  <i>Nobody is backing you up. /invite sets that up.</i>');
    } else {
      lines.push('  <b>Backed up by</b>');
      for (const c of carers) {
        lines.push(`  • ${esc(c.displayName ?? `chat ${c.chatId}`)} — told after ${fmtDuration(c.escalateAfterMs)}`);
        buttons.push([{
          text: `✖️ Remove ${(c.displayName ?? 'backup').slice(0, 24)}`,
          callback_data: encodeCallback({ a: 'unlink', chatId: c.chatId, patientId: l.patientId }),
        }]);
      }
    }
    lines.push('');
  }

  for (const l of watching) {
    const p = await ctx.db.getPatient(l.patientId);
    if (p === null) continue;
    lines.push(
      `<b>${esc(p.displayName)}</b> — you are their backup\n` +
        `  told after ${fmtDuration(l.escalateAfterMs)} of silence`,
    );
    buttons.push([{
      text: `👋 Stop backing up ${p.displayName.slice(0, 20)}`,
      callback_data: encodeCallback({ a: 'unlink', chatId: ctx.chatId, patientId: l.patientId }),
    }]);
    lines.push('');
  }

  lines.push('<i>/invite gives someone a code to back you up. /leave steps back from someone.</i>');
  await reply(ctx, lines.join('\n'), buttons.length > 0 ? buttons : undefined);
}

/**
 * The times that shape the day. These are the knobs worth changing without a re-import --
 * everything else lives in the prescription.
 */
async function cmdSettings(ctx: CmdCtx, args: string): Promise<void> {
  const ap = await acting(ctx, args, 'the settings');
  if (ap === null) return;
  args = ap.rest;
  const { patient, z } = ap;

  const parts = args.trim().split(/\s+/).filter((x) => x !== '');
  const FIELDS: Record<string, { column: string; label: string }> = {
    // "wake" is an alias, not a second setting. It used to mean "assume they are awake by
    // this time", and nothing assumes that any more -- so someone setting it got a
    // confirmation and no change whatsoever. It means the same thing people meant by it.
    morning: { column: 'morning_poll_at', label: 'start asking if you are up, from' },
    wake: { column: 'morning_poll_at', label: 'start asking if you are up, from' },
    evening: { column: 'evening_poll_at', label: 'start asking if you are in bed' },
    sleep: { column: 'presumed_sleep_at', label: 'take as your usual bedtime' },
    digest: { column: 'digest_at', label: 'send the daily summary' },
  };

  if (parts.length >= 1 && ['name', 'callme'].includes(parts[0]!.toLowerCase())) {
    // "What should I call you?" is about the person typing. Everything else in /settings
    // belongs to whoever's day it is; this one does not, unless they say "for <name>".
    const target = ap.isSelf ? ap : ((await actingPatient(ctx, 'for me')) as Acting | null);
    const who = target !== null && 'patient' in target ? target : ap;
    const newName = parts.slice(1).join(' ').trim().slice(0, 60);
    if (newName === '') {
      await reply(ctx, `What should I call you? Send <code>/name Ayesha</code>.`);
      return;
    }
    await ctx.env.MEDBOT_DB
      .prepare('UPDATE patients SET display_name = ?2 WHERE id = ?1')
      .bind(who.patient.id, newName)
      .run();
    await ctx.env.MEDBOT_DB
      .prepare("UPDATE chats SET display_name = ?2 WHERE chat_id = ?1 AND role = 'patient'")
      .bind(ctx.chatId, newName)
      .run();
    await reply(ctx, `⚙️ I'll call you <b>${esc(newName)}</b> from now on.`);
    return;
  }

  const DURATIONS: Record<string, { column: string; label: string; lo: number; hi: number }> = {
    bedask1: { column: 'bed_lead_first_ms', label: 'first ask before bedtime', lo: 5 * MINUTE, hi: 6 * HOUR },
    bedask2: { column: 'bed_lead_second_ms', label: 'second ask before bedtime', lo: 5 * MINUTE, hi: 6 * HOUR },
    bedgrace: { column: 'post_bed_grace_ms', label: 'keep chasing after bedtime for', lo: 0, hi: 4 * HOUR },
    wakecheck: { column: 'wake_check_every_ms', label: 'ask if you are up every', lo: 15 * MINUTE, hi: 6 * HOUR },
  };
  if (parts.length >= 2 && DURATIONS[parts[0]!.toLowerCase()] !== undefined) {
    const entry = DURATIONS[parts[0]!.toLowerCase()]!;
    const ms = parseDuration(parts.slice(1).join(' '));
    if (ms === null || ms < entry.lo || ms > entry.hi) {
      await reply(
        ctx,
        `Give me a length between ${esc(fmtDuration(entry.lo))} and ${esc(fmtDuration(entry.hi))}, ` +
          `e.g. <code>/settings ${esc(parts[0] ?? '')} 45m</code>.`,
      );
      return;
    }
    await ctx.env.MEDBOT_DB
      .prepare(`UPDATE patients SET ${entry.column} = ?2, next_action_at = ?3 WHERE id = ?1`)
      .bind(patient.id, ms, ctx.now)
      .run();
    await ctx.db.audit(patient.id, 'setting_changed', String(ctx.chatId), { key: entry.column, value: ms }, ctx.now);
    await reply(ctx, `⚙️ I'll ${esc(entry.label)} <b>${esc(fmtDuration(ms))}</b>.`);
    return;
  }

  if (parts.length >= 2 && ['mealgap', 'meal_gap', 'betweenmeals'].includes(parts[0]!.toLowerCase())) {
    // The other reason a meal shows later than its stated time: it is never proposed
    // within this of the one before. Three hours suits most people and not everybody.
    const ms = parseDuration(parts.slice(1).join(' '));
    if (ms === null || ms < 30 * MINUTE || ms > 8 * HOUR) {
      await reply(ctx, 'Give me a gap between 30 minutes and 8 hours, e.g. <code>/settings mealgap 2h</code>.');
      return;
    }
    await ctx.env.MEDBOT_DB
      .prepare('UPDATE meal_defs SET min_gap_after_prev_ms = ?2 WHERE patient_id = ?1')
      .bind(patient.id, ms)
      .run();
    await ctx.env.MEDBOT_DB
      .prepare('UPDATE patients SET next_action_at = ?2 WHERE id = ?1')
      .bind(patient.id, ctx.now)
      .run();
    await ctx.db.audit(patient.id, 'setting_changed', String(ctx.chatId), { key: 'meal_gap', value: ms }, ctx.now);
    await reply(
      ctx,
      `⚙️ I'll leave at least <b>${esc(fmtDuration(ms))}</b> between meals when I'm guessing at times. ` +
        `A late breakfast still pushes lunch back, just by less.`,
    );
    return;
  }

  if (parts.length >= 2 && ['minsleep', 'min_sleep', 'nightlength'].includes(parts[0]!.toLowerCase())) {
    const ms = parseDuration(parts.slice(1).join(' '));
    if (ms === null || ms < 15 * 60_000 || ms > 12 * 60 * 60_000) {
      await reply(ctx, 'Give me a length between 15 minutes and 12 hours, e.g. <code>/settings minsleep 4h</code>.');
      return;
    }
    await ctx.env.MEDBOT_DB
      .prepare('UPDATE patients SET min_sleep_ms = ?2, next_action_at = ?3 WHERE id = ?1')
      .bind(patient.id, ms, ctx.now)
      .run();
    await ctx.db.audit(patient.id, 'setting_changed', String(ctx.chatId), { key: 'min_sleep', value: ms }, ctx.now);
    await reply(
      ctx,
      `⚙️ Once you're in bed I'll leave you alone for at least <b>${esc(fmtDuration(ms))}</b>, ` +
        `whatever the clock says. Send /awake any time to start the day early.`,
    );
    return;
  }

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
      `Name           <code>${esc(patient.displayName)}</code>\n` +
      `Timezone       <code>${esc(patient.tz)}</code> — it's ${z.fmtTime12(ctx.now)} there\n` +
      `Start asking   <code>${esc(patient.morningPollAt)}</code> <i>— never assumed</i>\n` +
      `Usual bedtime  <code>${esc(patient.presumedSleepAt)}</code>` +
        `${patient.expectedSleepAt === null ? '' : ` — tonight <b>${z.fmtTime12(patient.expectedSleepAt)}</b>`}\n` +
      `Ask before bed <code>${esc(fmtDuration(patient.bedLeadFirstMs))}</code> then ` +
        `<code>${esc(fmtDuration(patient.bedLeadSecondMs))}</code> ahead\n` +
      `Chase after it <code>${esc(fmtDuration(patient.postBedGraceMs))}</code>\n` +
      `Shortest night <code>${esc(fmtDuration(patient.minSleepMs))}</code>\n` +
      `Ask if awake   every <code>${esc(fmtDuration(patient.wakeCheckEveryMs))}</code>\n` +
      `Daily summary  <code>${esc(patient.digestAt)}</code>\n\n` +
      `<b>To change one</b>\n` +
      `<code>/name Ayesha</code>\n` +
      `<code>/settings morning 09:00</code>\n` +
      `<code>/settings sleep 01:00</code>\n` +
      `<code>/settings bedask1 1h</code> · <code>/settings bedask2 30m</code>\n` +
      `<code>/settings bedgrace 1h</code> · <code>/settings wakecheck 1h</code>\n` +
      `<code>/settings minsleep 4h</code>\n` +
      `<code>/settings mealgap 3h</code>\n` +
      `<code>/settings digest 21:30</code>\n` +
      `<code>/tz Asia/Dhaka</code>\n\n` +
      `<i>The morning time is only where I start asking — I never decide you are up ` +
      `without being told. Bedtime is a starting point too: I check before it, and you ` +
      `can push it back as often as you like.</i>`,
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
<code>/bedtime 12:30am</code> — just for tonight; your usual time stays put.
<code>/eating lunch in 1h</code> — so I can time the before-meal tablets.
<code>/ate lunch</code> — once you've actually eaten.
<code>/status</code> — what's waiting and what's next.

<b>Logging a dose</b>
Tap ✅ on the reminder, or:
<code>/took drops</code> — right now
<code>/took drops 5pm</code> — earlier, and I'll fix the schedule
<code>/took drops 20m ago</code>
<code>/skip drops</code> · <code>/snooze drops 15m</code>

If I already logged a dose as missed and you actually took it, just tell me the real time — I'll correct it and recalculate from there.

<b>Your prescription</b>
<code>/prompt</code> — get the prompt for turning a photo into JSON
<code>/import</code> — send new JSON (I preview it and wait for confirmation)
<code>/add {...}</code> — add one medicine
<code>/edit drops every 3h</code> — change one thing
<code>/extend drops 3d</code> — lengthen a course
<code>/meds</code> · <code>/export</code> · <code>/pause</code> · <code>/resume</code> · <code>/stop</code>
<code>/log 7</code> — adherence · <code>/tz Asia/Dhaka</code>

<b>Sharing</b>
There is one kind of account. You have your own prescription, and you can also back other people up — that's a relationship, not a different sort of login.

<code>/invite</code> — get a code so someone can back you up. If you don't answer within a few minutes, I'll ask them instead, and they can answer for you.
<code>/caregiver &lt;code&gt;</code> — back someone else up, using their code.
<code>/patients</code> — who you're linked to, with buttons to end any of it.
<code>/leave</code> — stop backing someone up.

<b>Answering for someone</b>
If you back someone up and have no prescription of your own, every command is about them: <code>/took drops</code>, <code>/ate lunch</code>, <code>/sleep</code>, <code>/meds</code> — all theirs, and they're told what you did. If you're on medicines too, commands are about you unless you say whose: <code>/took drops for Ifti</code>, or <code>for me</code> to be sure.

<code>/status</code> on its own covers you and everyone you look after.

Every evening I send a short summary of the day. If that stops arriving, something is wrong — <code>/health</code> tells you whether the scheduler is still running.

⚠️ <i>I'm a reminder, not a doctor. Follow your prescription, and don't rely on me alone for anything critical.</i>`,
  );
}
