/**
 * The Telegram webhook.
 *
 * Two things have to happen before anything else: prove the request really came from
 * Telegram, and make sure a redelivered update is not processed twice. Telegram retries
 * whenever it does not get a prompt 200 -- which includes any cold start that runs long --
 * and a repeated "taken" would double-count a course and end it early.
 */

import { Db } from '../io/db.js';
import { Telegram } from '../io/telegram.js';
import { handleCommand } from './commands.js';
import type { CmdCtx } from './commands.js';
import { handleCallback } from './callbacks.js';
import type { Env, TgUpdate } from '../types.js';

export async function handleWebhook(
  request: Request,
  env: Env,
  ctxWaitUntil: (p: Promise<unknown>) => void,
  now: number,
): Promise<Response> {
  const presented = request.headers.get('X-Telegram-Bot-Api-Secret-Token') ?? '';
  if (!timingSafeEqual(presented, env.WEBHOOK_SECRET)) {
    // Without this check anyone who discovers the Worker URL could mark doses as taken.
    return new Response('forbidden', { status: 403 });
  }

  let update: TgUpdate;
  try {
    update = (await request.json()) as TgUpdate;
  } catch {
    return new Response('ok');
  }

  const db = new Db(env.MEDBOT_DB);

  if (typeof update.update_id === 'number') {
    const fresh = await db.claimUpdate(update.update_id, now);
    if (!fresh) return new Response('ok'); // already handled; a retry, not a new event
  }

  // Answer Telegram immediately and do the work in the background: a slow reply is what
  // triggers the redelivery this handler has to guard against in the first place.
  ctxWaitUntil(process(env, db, update, now));
  return new Response('ok');
}

async function process(env: Env, db: Db, update: TgUpdate, now: number): Promise<void> {
  const tg = new Telegram(env.TELEGRAM_BOT_TOKEN, 20);
  try {
    if (update.callback_query !== undefined) {
      await handleCallback(env, db, tg, update.callback_query, now);
      return;
    }

    const msg = update.message;
    if (msg === undefined) return;
    if (msg.text === undefined && msg.caption === undefined && msg.document === undefined) return;

    // Any inbound message is proof the patient is up -- free wake detection that removes
    // most of the reason to ever ask.
    await db.touchActivity(msg.chat.id, now);

    const ctx: CmdCtx = {
      env,
      db,
      tg,
      chatId: msg.chat.id,
      userName: msg.from?.first_name ?? msg.chat.first_name ?? 'there',
      now,
    };
    await handleCommand(ctx, msg);
  } catch (e) {
    await db.audit(null, 'webhook_error', 'system', { error: e instanceof Error ? e.message : String(e) }, now);
    // Say so. A bug that eats the reply leaves someone staring at a message that went
    // nowhere, with no way to tell a broken bot from a slow one -- and the honest guess,
    // that it worked, is the dangerous one for a medication reminder.
    const chatId = update.message?.chat.id ?? update.callback_query?.message?.chat.id;
    if (chatId !== undefined) {
      await tg.sendMessage(
        chatId,
        "⚠️ Something went wrong at my end and I couldn't finish that. Nothing has changed.\n\n" +
          'Try again, or send /status to see where things stand.',
      ).catch(() => undefined);
    }
  }
}

/** Constant-time comparison, so the secret cannot be recovered by timing the responses. */
function timingSafeEqual(a: string, b: string): boolean {
  if (b === '') return false;
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}
