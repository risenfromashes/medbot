/**
 * The minute tick.
 *
 * Deliberately written so that a dropped or delayed tick is harmless: it asks "what is
 * due at or before now", never "what is due this minute". Cloudflare does not retry a
 * failed cron invocation and free-tier crons can run late, so self-healing has to be a
 * property of the algorithm rather than of the platform.
 */

import { plan } from '../core/plan.js';
import { mealDayOf, zoneFor } from '../core/tz.js';
import { Db } from '../io/db.js';
import { Telegram } from '../io/telegram.js';
import { dispatch, clearPromptMessages, flushOutbox } from './dispatch.js';
import type { Env } from '../types.js';
import { COMMANDS } from './commands.js';
import { hashString } from '../core/prescription.js';

/** Subrequest budget. The platform allows 50; leave headroom for bookkeeping. */
const MAX_TELEGRAM_CALLS = 40;

export async function runTick(env: Env, now: number): Promise<{ patients: number; calls: number; flushed: number }> {
  const db = new Db(env.MEDBOT_DB);
  const tg = new Telegram(env.TELEGRAM_BOT_TOKEN, MAX_TELEGRAM_CALLS);

  await ensureWebhook(env, db, tg, now);
  await ensureCommandMenu(db, tg, now);

  // Anything queued by an earlier tick goes first: it is already late.
  const flushed = await flushOutbox({ db, tg, z: zoneFor('UTC'), now }, MAX_TELEGRAM_CALLS);

  const ids = await db.patientsNeedingAttention(now);
  let handled = 0;

  for (const pid of ids) {
    if (tg.exhausted) break;
    try {
      const patient = await db.getPatient(pid);
      if (patient === null) continue;

      const z = zoneFor(patient.tz);
      const today = z.localDay(now);
      // The waking day, for meals. It only differs from the calendar one for a patient
      // who is still up after midnight -- and for them, the difference is the whole point:
      // their breakfast, lunch and dinner are already behind them.
      const state = await db.loadState(pid, today, mealDayOf(z, patient, now));
      if (state === null) continue;

      const actions = plan(state, now, z);
      const idMaps = await db.applyActions(state, actions, now);

      // A prompt that was closed this tick still has messages sitting in people's chats.
      // `closeMealPrompt` closes by meal rather than by id and was not matched here, so
      // every answered meal question stayed in both chats with its buttons live.
      for (const a of actions) {
        if (a.t === 'closePrompt') {
          await clearPromptMessages({ db, tg, z, now }, idMaps.promptIds.get(a.promptId) ?? a.promptId);
        } else if (a.t === 'closeMealPrompt') {
          for (const q of state.openPrompts) {
            if (q.kind === 'meal' && q.body.meal === a.meal) {
              await clearPromptMessages({ db, tg, z, now }, q.id);
            }
          }
        }
      }

      await dispatch({ db, tg, z, now }, state, actions, idMaps);
      handled++;
    } catch (e) {
      // One patient's failure must not stop the others, and it must be visible.
      await db.audit(pid, 'tick_error', 'system', { error: e instanceof Error ? e.message : String(e) }, now);
    }
  }

  // Whatever the close paths missed. Every one of them can fail half way -- a delete that
  // ran out of subrequest budget, a tick that ended between the two writes -- and nothing
  // retried any of it, so six days of answered reminders were still sitting in the chats
  // with working buttons. A few per tick is enough to keep up and cheap enough to ignore.
  for (const stale of await db.stalePromptMessages(5)) {
    if (tg.exhausted) break;
    await tg.deleteMessage(stale.chatId, stale.messageId);
    await db.clearPromptMessage(stale.promptId, stale.chatId);
  }

  await db.heartbeat(now, new Date(now).toISOString().slice(0, 10));

  // Housekeeping: keep the dedupe and outbox tables from growing without bound. Cheap,
  // and only once an hour rather than every tick.
  if (new Date(now).getUTCMinutes() === 7) {
    await db.gcUpdates(now - 24 * 3600_000);
    await db.gcOutbox(now - 3 * 24 * 3600_000);
  }

  return { patients: handled, calls: tg.callsUsed, flushed };
}

/**
 * Keep the published command menu in step with the code.
 *
 * Telegram caches whatever `setMyCommands` last sent, and that used to happen only when
 * the webhook was registered. So a deploy that added a command left it invisible: it
 * worked if you typed it, but it was not in the menu and nobody knew it existed. Keyed on
 * a hash of the list, so this costs one cheap comparison an hour and one API call on the
 * deploy that actually changes something.
 */
async function ensureCommandMenu(db: Db, tg: Telegram, now: number): Promise<void> {
  const want = hashString(JSON.stringify(COMMANDS));
  const have = await db.kvGet('commands_hash');
  if (have === want) return;

  // Back off only after a failure. Throttling successes too would mean a second change
  // within the window is silently ignored -- the same invisible-command problem this
  // function exists to prevent.
  const lastFailed = Number((await db.kvGet('commands_failed_at')) ?? '0');
  if (now - lastFailed < 10 * 60_000) return;

  const res = await tg.setMyCommands(COMMANDS);
  if (res.ok) {
    await db.kvSet('commands_hash', want);
    await db.kvSet('commands_failed_at', '0');
    await db.audit(null, 'commands_published', 'system', { count: COMMANDS.length }, now);
  } else {
    await db.kvSet('commands_failed_at', String(now));
    await db.audit(null, 'commands_publish_failed', 'system', { error: res.error }, now);
  }
}

/**
 * Keep the webhook registered without anyone having to run curl.
 *
 * Telegram drops a webhook it cannot deliver to, and a fresh deployment has none at all,
 * so the tick re-asserts it periodically. Checking hourly rather than every minute keeps
 * it off the hot path.
 */
async function ensureWebhook(env: Env, db: Db, tg: Telegram, now: number): Promise<void> {
  const want = env.WEBHOOK_URL ?? (await db.kvGet('webhook_url'));
  if (want === null || want === undefined || want === '') return;

  const lastChecked = Number(await db.kvGet('webhook_checked_at') ?? '0');
  if (now - lastChecked < 3600_000) return;
  await db.kvSet('webhook_checked_at', String(now));

  const info = await tg.getWebhookInfo();
  if (info.ok && info.result?.url === want) return;

  const res = await tg.setWebhook(want, env.WEBHOOK_SECRET);
  await db.audit(null, 'webhook_registered', 'system', { url: want, ok: res.ok, error: res.error }, now);
}
