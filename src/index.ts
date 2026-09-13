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
import { bootstrapAdmin, handleDashboard } from './handlers/dashboard.js';
import { fmtDuration } from './core/tz.js';
import type { Env } from './types.js';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const now = Date.now();
    const url = new URL(request.url);

    if (url.pathname === '/telegram' || url.pathname === '/webhook') {
      return handleWebhook(request, env, (p) => ctx.waitUntil(p), now);
    }

    // The admin dashboard. Everything under /app authenticates itself; see dashboard.ts.
    if (url.pathname === '/app' || url.pathname.startsWith('/app/')) {
      return handleDashboard(request, env, now, url.pathname);
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

      // The admin account is created first and independently: if Telegram is unreachable
      // or the token is wrong, you still want a dashboard to log into and diagnose from.
      const bootstrap = await bootstrapAdmin(env, now, url.origin);

      await db.kvSet('webhook_url', hookUrl);
      await db.kvSet('webhook_checked_at', String(now));
      const res = await tg.setWebhook(hookUrl, env.WEBHOOK_SECRET);
      if (res.ok) await tg.setMyCommands(COMMANDS);
      else await db.audit(null, 'webhook_registration_failed', 'setup', { error: res.error }, now);

      if (bootstrap !== null) return bootstrap;

      return Response.json({
        ok: res.ok,
        webhook: hookUrl,
        webhookError: res.ok ? undefined : res.error,
        dashboard: `${url.origin}/app`,
        message: res.ok
          ? 'Webhook re-registered. The admin account already exists.'
          : 'Admin account exists, but the webhook could not be registered — check TELEGRAM_BOT_TOKEN.',
      });
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

    // Nothing else is public. Send anyone who lands here to the dashboard.
    return Response.redirect(`${url.origin}/app`, 302);
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runTick(env, Date.now()));
  },
};
