/**
 * The admin dashboard.
 *
 * One account, read-only over everyone's medical data, and no way to create an account
 * from the web -- the only route in is an invite code redeemed through the bot. Every
 * write here is confined to the admin's own profile or to minting invites; nothing in
 * this file can alter a schedule, which keeps the scheduler's safety rules to a single
 * code path.
 */

import { AdminDb } from '../io/adminDb.js';
import { Db } from '../io/db.js';
import {
  SESSION_COOKIE, checkPasswordStrength, clearedCookie, constantTimeEqual, cookieFrom,
  sessionCookie, sha256Hex,
} from '../io/auth.js';
import type { AdminUser } from '../io/adminDb.js';
import { parseDuration } from '../core/timeparse.js';
import { HOUR, MINUTE, zoneFor } from '../core/tz.js';
import {
  accountPage, graphPage, invitesPage, loginPage, overviewPage, patientPage, setupPage,
} from './views.js';
import type { Env } from '../types.js';

/** Failed logins from one address in 15 minutes before it is refused. */
const LOCKOUT_PER_IP = 8;
/** Loose global backstop for a distributed attempt. Deliberately far above the per-IP
 *  limit so one attacker cannot lock the admin out of their own dashboard. */
const LOCKOUT_GLOBAL = 60;
const INVITE_TTL_MS = 24 * HOUR;

interface Session {
  user: AdminUser;
  token: string;
  csrf: string;
}

const html = (body: string, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // The dashboard renders health data; keep it out of caches and out of frames.
      'cache-control': 'no-store, private',
      'referrer-policy': 'same-origin',
      'x-frame-options': 'DENY',
      'x-content-type-options': 'nosniff',
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      ...headers,
    },
  });

const redirect = (to: string, headers: Record<string, string> = {}): Response =>
  new Response(null, { status: 303, headers: { location: to, 'cache-control': 'no-store', ...headers } });

/**
 * The CSRF token is derived from the session token, so it needs no storage and is
 * meaningless without the cookie. SameSite=Lax already blocks the common cases; this
 * covers the rest.
 */
async function csrfFor(token: string): Promise<string> {
  return (await sha256Hex(`csrf:${token}`)).slice(0, 32);
}

async function currentSession(request: Request, adb: AdminDb, now: number): Promise<Session | null> {
  const token = cookieFrom(request.headers.get('cookie'), SESSION_COOKIE);
  if (token === null) return null;
  const user = await adb.validateSession(token, now);
  if (user === null) return null;
  return { user, token, csrf: await csrfFor(token) };
}

async function readForm(request: Request): Promise<URLSearchParams> {
  const text = await request.text();
  return new URLSearchParams(text);
}

function checkCsrf(form: URLSearchParams, session: Session): boolean {
  return constantTimeEqual(form.get('csrf') ?? '', session.csrf);
}

export async function handleDashboard(
  request: Request,
  env: Env,
  now: number,
  path: string,
): Promise<Response> {
  const adb = new AdminDb(env.MEDBOT_DB);
  const db = new Db(env.MEDBOT_DB);
  const url = new URL(request.url);

  if (!(await adb.adminExists())) {
    return html(
      loginPage(null, 'This deployment has not been set up yet. Run /setup?key=<WEBHOOK_SECRET> first.'),
      503,
    );
  }

  // --- unauthenticated routes ---------------------------------------------

  if (path === '/app/login' && request.method === 'POST') {
    const form = await readForm(request);
    const ip = request.headers.get('cf-connecting-ip');

    // With the hash work factor capped by the CPU budget, throttling is what actually
    // stops an online guessing attack.
    const failures = await adb.recentFailures(now, ip);
    if (failures.fromIp >= LOCKOUT_PER_IP || failures.total >= LOCKOUT_GLOBAL) {
      await adb.recordLoginAttempt(false, ip, now);
      return html(loginPage('Too many failed attempts. Wait 15 minutes and try again.', null), 429);
    }

    const ok = await adb.verifyPassword(form.get('username') ?? '', form.get('password') ?? '');
    await adb.recordLoginAttempt(ok, ip, now);
    if (!ok) return html(loginPage('Wrong username or password.', null), 401);

    const token = await adb.createSession(now, request.headers.get('user-agent'));
    await env.MEDBOT_DB.prepare('UPDATE admin_users SET last_login_at = ?1 WHERE id = 1').bind(now).run();
    const user = await adb.getAdmin();
    return redirect(user?.mustChange === true ? '/app/account' : '/app', {
      'set-cookie': sessionCookie(token, 14 * 24 * HOUR),
    });
  }

  const session = await currentSession(request, adb, now);

  if (session === null) {
    if (path === '/app/logout') return redirect('/app/login');
    if (path === '/app/login') return html(loginPage(null, url.searchParams.get('notice')));
    return redirect('/app/login');
  }

  // --- authenticated -------------------------------------------------------

  if (path === '/app/logout' && request.method === 'POST') {
    await adb.destroySession(session.token);
    return redirect('/app/login', { 'set-cookie': clearedCookie() });
  }

  if (path === '/app/login') return redirect('/app');

  if (path === '/app' || path === '/app/') {
    const ov = await adb.overview(now);
    const patients = [];
    for (const p of ov.patients) {
      const meds = await db.medsFor(p.id);
      let pending = 0;
      for (const m of meds) {
        const live = await db.liveDoseFor(m.id);
        if (live !== null && (live.status === 'due' || live.status === 'prompted')) pending++;
      }
      patients.push({ ...p, pending });
    }

    // The bootstrap code is only surfaced while nobody has joined; once the bot is in
    // use there is no reason for a join code to be sitting on a page.
    let bootstrapInvite = null;
    if (ov.chatCount === 0) {
      const live = (await adb.liveInvites(now)).filter((i) => i.kind === 'enrol');
      bootstrapInvite = live[0] ?? (await adb.createInvite('enrol', { createdBy: 'dashboard:bootstrap', ttlMs: INVITE_TTL_MS }, now));
    }

    return html(overviewPage({
      displayName: session.user.displayName, patients, chatCount: ov.chatCount,
      heartbeat: ov.heartbeat, now, bootstrapInvite,
    }));
  }

  const patientMatch = /^\/app\/p\/(\d+)$/.exec(path);
  if (patientMatch !== null) {
    const id = Number(patientMatch[1]);
    const patient = await db.getPatient(id);
    if (patient === null) return redirect('/app');
    const z = zoneFor(patient.tz);
    const today = z.localDay(now);
    const detail = await adb.patientDetail(id, today, z.addLocalDays(today, -13));
    if (detail === null) return redirect('/app');
    return html(patientPage({ displayName: session.user.displayName, ...detail, now }));
  }

  if (path === '/app/graph') {
    const rel = await adb.relationships();
    return html(graphPage({ displayName: session.user.displayName, ...rel }));
  }

  if (path === '/app/invites') {
    const [live, recent, rel] = await Promise.all([
      adb.liveInvites(now), adb.recentInvites(20), adb.relationships(),
    ]);
    return html(invitesPage({
      displayName: session.user.displayName, live, recent, patients: rel.patients,
      justCreated: null, now, csrf: session.csrf,
    }));
  }

  if (path === '/app/invites/new' && request.method === 'POST') {
    const form = await readForm(request);
    if (!checkCsrf(form, session)) return html(loginPage('Session expired. Sign in again.', null), 403);

    const kind = form.get('kind') === 'caregiver' ? 'caregiver' : 'enrol';
    let created;
    if (kind === 'caregiver') {
      const patientId = Number(form.get('patient_id'));
      const patient = await db.getPatient(patientId);
      if (patient === null) return redirect('/app/invites');
      const delay = parseDuration(form.get('delay') ?? '5m') ?? 5 * MINUTE;
      created = await adb.createInvite('caregiver', {
        patientId, label: patient.displayName, escalateAfterMs: delay,
        createdBy: 'dashboard', ttlMs: INVITE_TTL_MS,
      }, now);
    } else {
      created = await adb.createInvite('enrol', { createdBy: 'dashboard', ttlMs: INVITE_TTL_MS }, now);
    }

    const [live, recent, rel] = await Promise.all([
      adb.liveInvites(now), adb.recentInvites(20), adb.relationships(),
    ]);
    return html(invitesPage({
      displayName: session.user.displayName, live, recent, patients: rel.patients,
      justCreated: created, now, csrf: session.csrf,
    }));
  }

  if (path === '/app/invites/revoke' && request.method === 'POST') {
    const form = await readForm(request);
    if (!checkCsrf(form, session)) return redirect('/app/invites');
    await adb.revokeInvite(form.get('code') ?? '', now);
    return redirect('/app/invites');
  }

  if (path === '/app/account') {
    const sessions = await adb.activeSessions(now);
    return html(accountPage({
      displayName: session.user.displayName, username: session.user.username,
      mustChange: session.user.mustChange,
      error: url.searchParams.get('error'), notice: url.searchParams.get('notice'),
      sessions, now, csrf: session.csrf,
    }));
  }

  if (path === '/app/account/profile' && request.method === 'POST') {
    const form = await readForm(request);
    if (!checkCsrf(form, session)) return redirect('/app/account?error=Session+expired');
    const name = (form.get('display_name') ?? '').trim().slice(0, 60);
    const username = (form.get('username') ?? '').trim().slice(0, 60);
    if (name === '' || username === '') return redirect('/app/account?error=Name+cannot+be+empty');
    await adb.setDisplayName(name);
    await adb.setUsername(username);
    return redirect('/app/account?notice=Profile+updated');
  }

  if (path === '/app/account/password' && request.method === 'POST') {
    const form = await readForm(request);
    if (!checkCsrf(form, session)) return redirect('/app/account?error=Session+expired');

    const current = form.get('current') ?? '';
    const next = form.get('next') ?? '';
    const confirm = form.get('confirm') ?? '';

    if (!(await adb.verifyPassword(session.user.username, current))) {
      await adb.recordLoginAttempt(false, request.headers.get('cf-connecting-ip'), now);
      return redirect('/app/account?error=Current+password+is+wrong');
    }
    if (next !== confirm) return redirect('/app/account?error=The+new+passwords+do+not+match');
    const strength = checkPasswordStrength(next);
    if (!strength.ok) return redirect(`/app/account?error=${encodeURIComponent(strength.problem ?? 'Too weak')}`);

    // Keep this session alive; sign every other device out.
    await adb.setPassword(next, now, await adb.sessionHash(session.token));
    return redirect('/app/account?notice=Password+changed.+Other+devices+signed+out.');
  }

  if (path === '/app/account/sessions' && request.method === 'POST') {
    const form = await readForm(request);
    if (!checkCsrf(form, session)) return redirect('/app/account');
    await adb.destroyAllSessions();
    const token = await adb.createSession(now, request.headers.get('user-agent'));
    return redirect('/app/account?notice=Signed+out+everywhere+else', {
      'set-cookie': sessionCookie(token, 14 * 24 * HOUR),
    });
  }

  return redirect('/app');
}

/** Called from /setup: creates the admin account once and shows the password. */
export async function bootstrapAdmin(env: Env, now: number, origin: string): Promise<Response | null> {
  const adb = new AdminDb(env.MEDBOT_DB);
  if (await adb.adminExists()) return null;
  const password = await adb.createAdmin('admin', 'Admin', now);
  return html(setupPage(password, 'admin', origin));
}

export { AdminDb };
