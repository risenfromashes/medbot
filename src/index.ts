/**
 * Worker entry point.
 *
 * This is the only module permitted to read the clock. `now` is captured once per
 * invocation and threaded through everything, which keeps the planner pure and testable,
 * and sidesteps the fact that the Workers runtime freezes Date.now() between I/O anyway.
 */

import { runTick } from './handlers/scheduled.js';
import { handleWebhook } from './handlers/webhook.js';
import { Db } from './io/db.js';
import { Telegram } from './io/telegram.js';
import { COMMANDS } from './handlers/commands.js';
import { fmtDuration } from './core/tz.js';
import type { Env } from './types.js';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const now = Date.now();
    const url = new URL(request.url);

    if (url.pathname === '/telegram' || url.pathname === '/webhook') {
      return handleWebhook(request, env, (p) => ctx.waitUntil(p), now);
    }

    // One-time setup: registers the webhook with Telegram and publishes the command menu,
    // so installing this needs no curl and no local tooling.
    if (url.pathname === '/setup') {
      if (url.searchParams.get('key') !== env.WEBHOOK_SECRET) {
        return new Response('forbidden', { status: 403 });
      }
      const db = new Db(env.MEDBOT_DB);
      const tg = new Telegram(env.TELEGRAM_BOT_TOKEN, 10);
      const hookUrl = `${url.origin}/telegram`;
      await db.kvSet('webhook_url', hookUrl);
      await db.kvSet('webhook_checked_at', String(now));
      const res = await tg.setWebhook(hookUrl, env.WEBHOOK_SECRET);
      if (!res.ok) {
        return Response.json({ ok: false, error: res.error }, { status: 500 });
      }
      await tg.setMyCommands(COMMANDS);
      return Response.json({ ok: true, webhook: hookUrl, message: 'Webhook registered. Say /start to your bot.' });
    }

    // A liveness page, because the cheapest way to notice the scheduler has died is to be
    // able to look.
    if (url.pathname === '/health') {
      const db = new Db(env.MEDBOT_DB);
      const hb = await db.getHeartbeat();
      const age = hb === null ? null : now - hb.lastTickAt;
      const healthy = age !== null && age < 5 * 60_000;
      return Response.json(
        {
          ok: healthy,
          lastTick: hb === null ? null : new Date(hb.lastTickAt).toISOString(),
          lastTickAge: age === null ? null : fmtDuration(age),
          ticksToday: hb?.ticksToday ?? 0,
        },
        { status: healthy ? 200 : 503 },
      );
    }

    // Local development only: lets a test drive the tick without waiting for cron.
    if (url.pathname === '/tick' && url.searchParams.get('key') === env.WEBHOOK_SECRET) {
      const result = await runTick(env, now);
      return Response.json(result);
    }

    return new Response('medbot is running. Set up with /setup?key=…', { status: 200 });
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runTick(env, Date.now()));
  },
};
