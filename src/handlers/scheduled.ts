/**
 * The minute tick.
 *
 * Deliberately written so that a dropped or delayed tick is harmless: it asks "what is
 * due at or before now", never "what is due this minute". Cloudflare does not retry a
 * failed cron invocation and free-tier crons can run late, so self-healing has to be a
 * property of the algorithm rather than of the platform.
 */

import { plan } from '../core/plan.js';
import { zoneFor } from '../core/tz.js';
import { Db } from '../io/db.js';
import { Telegram } from '../io/telegram.js';
import { dispatch, clearPromptMessages } from './dispatch.js';
import type { Env } from '../types.js';
import { COMMANDS } from './commands.js';

/** Subrequest budget. The platform allows 50; leave headroom for bookkeeping. */
const MAX_TELEGRAM_CALLS = 40;

export async function runTick(env: Env, now: number): Promise<{ patients: number; calls: number }> {
  const db = new Db(env.MEDBOT_DB);
  const tg = new Telegram(env.TELEGRAM_BOT_TOKEN, MAX_TELEGRAM_CALLS);

  await ensureWebhook(env, db, tg, now);

  const ids = await db.patientsNeedingAttention(now);
  let handled = 0;

  for (const pid of ids) {
    if (tg.exhausted) break;
    try {
      const patient = await db.getPatient(pid);
      if (patient === null) continue;

      const z = zoneFor(patient.tz);
      const today = z.localDay(now);
      const state = await db.loadState(pid, today);
      if (state === null) continue;

      const actions = plan(state, now, z);
      const idMaps = await db.applyActions(state, actions, now);

      // A prompt that was closed this tick still has messages sitting in people's chats.
      for (const a of actions) {
        if (a.t === 'closePrompt') {
          await clearPromptMessages({ db, tg, z, now }, idMaps.promptIds.get(a.promptId) ?? a.promptId);
        }
      }

      await dispatch({ db, tg, z, now }, state, actions, idMaps);
      handled++;
    } catch (e) {
      // One patient's failure must not stop the others, and it must be visible.
      await db.audit(pid, 'tick_error', 'system', { error: e instanceof Error ? e.message : String(e) }, now);
    }
  }

  await db.heartbeat(now, new Date(now).toISOString().slice(0, 10));

  // Housekeeping: keep the dedupe table from growing without bound. Cheap, and only once
  // an hour rather than every tick.
  if (new Date(now).getUTCMinutes() === 7) {
    await db.gcUpdates(now - 24 * 3600_000);
  }

  return { patients: handled, calls: tg.callsUsed };
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
  if (res.ok) await tg.setMyCommands(COMMANDS);
}
