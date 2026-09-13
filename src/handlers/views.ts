/**
 * Server-rendered HTML for the dashboard.
 *
 * No build step, no framework, no client bundle -- the Worker emits finished pages. That
 * keeps the whole dashboard inside the same 36KB deployment and the same 10ms CPU budget
 * as the scheduler, and it means there is nothing to rebuild when the schema changes.
 */

import type { Dose, Medicine, Patient } from '../core/domain.js';
import { describeCourse, describeSchedule } from '../core/prescription.js';
import { fmtDuration, zoneFor } from '../core/tz.js';
import type { Invite } from '../io/adminDb.js';

export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const STYLE = `
:root{
  --bg:#f7f7f5; --panel:#fff; --ink:#1b1b18; --muted:#6b6b63; --line:#e3e3dd;
  --accent:#7a5cff; --ok:#2e8b57; --warn:#c96a1b; --bad:#c0392b; --chip:#f0efeb;
}
@media (prefers-color-scheme:dark){:root{
  --bg:#141413; --panel:#1c1c1a; --ink:#eeeeea; --muted:#9a9a90; --line:#2e2e2a;
  --accent:#a48bff; --ok:#5cc98a; --warn:#e0954a; --bad:#e8685a; --chip:#26261f;
}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
  font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--accent)}
.wrap{max-width:1000px;margin:0 auto;padding:24px 16px 64px}
header.top{display:flex;flex-wrap:wrap;gap:12px;align-items:baseline;justify-content:space-between;
  padding-bottom:16px;margin-bottom:24px;border-bottom:1px solid var(--line)}
header.top h1{font-size:19px;margin:0;letter-spacing:-.01em}
header.top nav{display:flex;gap:16px;flex-wrap:wrap;font-size:14px}
header.top nav a{text-decoration:none;color:var(--muted)}
header.top nav a:hover,header.top nav a.on{color:var(--ink)}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:18px;margin-bottom:16px}
.card h2{font-size:13px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin:0 0 14px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px}
.person{display:block;text-decoration:none;color:inherit;background:var(--panel);
  border:1px solid var(--line);border-radius:12px;padding:16px}
.person:hover{border-color:var(--accent)}
.person .nm{font-weight:600;font-size:16px;margin-bottom:6px}
.muted{color:var(--muted)}
.small{font-size:13px}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.chip{display:inline-block;padding:2px 8px;border-radius:999px;background:var(--chip);
  font-size:12px;color:var(--muted);margin-right:6px}
.chip.ok{color:var(--ok)} .chip.warn{color:var(--warn)} .chip.bad{color:var(--bad)}
table{width:100%;border-collapse:collapse;font-size:14px}
th{text-align:left;font-weight:500;color:var(--muted);font-size:12px;text-transform:uppercase;
  letter-spacing:.06em;padding:0 10px 8px 0;border-bottom:1px solid var(--line)}
td{padding:9px 10px 9px 0;border-bottom:1px solid var(--line);vertical-align:top}
tr:last-child td{border-bottom:none}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
input,button,select{font:inherit}
input[type=text],input[type=password]{width:100%;padding:9px 11px;border:1px solid var(--line);
  border-radius:8px;background:var(--bg);color:var(--ink)}
input:focus{outline:2px solid var(--accent);outline-offset:1px}
button{padding:9px 15px;border-radius:8px;border:1px solid var(--line);background:var(--panel);
  color:var(--ink);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
button:hover{filter:brightness(1.06)}
label{display:block;font-size:13px;color:var(--muted);margin:12px 0 5px}
.code{font-family:ui-monospace,Menlo,monospace;font-size:26px;letter-spacing:.16em;
  background:var(--chip);padding:12px 16px;border-radius:10px;display:inline-block;user-select:all}
.note{border-left:3px solid var(--accent);padding:10px 14px;background:var(--chip);
  border-radius:0 8px 8px 0;margin:14px 0;font-size:14px}
.note.bad{border-color:var(--bad)} .note.ok{border-color:var(--ok)}
.bar{height:6px;border-radius:3px;background:var(--chip);overflow:hidden;min-width:90px}
.bar > i{display:block;height:100%;background:var(--ok)}
.login{max-width:380px;margin:12vh auto;padding:0 16px}
pre{overflow-x:auto;background:var(--chip);padding:14px;border-radius:8px;font-size:12.5px;margin:0}
svg{max-width:100%;height:auto}
@media(max-width:560px){.wrap{padding:16px 12px 48px}table{font-size:13px}}
`;

export function page(title: string, body: string, opts: { nav?: string; user?: string } = {}): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)} · medbot</title><style>${STYLE}</style></head><body>
${opts.nav === undefined ? '' : opts.nav}
<div class="wrap">${body}</div></body></html>`;
}

export function nav(active: string, displayName: string): string {
  const item = (href: string, key: string, label: string): string =>
    `<a href="${href}"${active === key ? ' class="on"' : ''}>${label}</a>`;
  return `<div class="wrap" style="padding-bottom:0"><header class="top">
    <h1>💊 medbot <span class="muted small" style="font-weight:400">· ${esc(displayName)}</span></h1>
    <nav>
      ${item('/app', 'home', 'Overview')}
      ${item('/app/graph', 'graph', 'Relationships')}
      ${item('/app/invites', 'invites', 'Invites')}
      ${item('/app/account', 'account', 'Account')}
      <a href="/app/logout" onclick="event.preventDefault();document.getElementById('lo').submit()">Sign out</a>
      <form id="lo" method="post" action="/app/logout" hidden></form>
    </nav></header></div>`;
}

export function loginPage(error: string | null, notice: string | null): string {
  return page('Sign in', `<div class="login">
    <h1 style="font-size:22px;margin:0 0 4px">💊 medbot</h1>
    <p class="muted small" style="margin:0 0 22px">Family medication dashboard</p>
    ${error === null ? '' : `<div class="note bad">${esc(error)}</div>`}
    ${notice === null ? '' : `<div class="note">${esc(notice)}</div>`}
    <form method="post" action="/app/login">
      <label for="u">Username</label>
      <input id="u" name="username" type="text" autocomplete="username" autofocus required>
      <label for="p">Password</label>
      <input id="p" name="password" type="password" autocomplete="current-password" required>
      <div style="margin-top:18px"><button class="primary" type="submit" style="width:100%">Sign in</button></div>
    </form>
    <p class="muted small" style="margin-top:22px">Accounts can't be created here. Family members join
    through the Telegram bot with an invite code.</p>
  </div>`);
}

// --- overview --------------------------------------------------------------

function wakeChip(p: Patient, now: number): string {
  const z = zoneFor(p.tz);
  if (p.wakeState === 'awake') {
    const since = p.lastWakeAt === null ? '' : ` since ${z.fmtTime12(p.lastWakeAt)}`;
    const conf = p.wakeConfidence === 'confirmed' ? '' : ` (${p.wakeConfidence})`;
    return `<span class="chip ok">☀️ Awake${esc(since)}${esc(conf)}</span>`;
  }
  const since = p.lastSleepAt === null ? '' : ` since ${z.fmtTime12(p.lastSleepAt)}`;
  void now;
  return `<span class="chip">🌙 Asleep${esc(since)}</span>`;
}

export function overviewPage(data: {
  displayName: string;
  patients: Array<Patient & { chatCount: number; medCount: number; pending: number }>;
  chatCount: number;
  heartbeat: { lastTickAt: number; ticksToday: number } | null;
  now: number;
  bootstrapInvite: Invite | null;
}): string {
  const { now } = data;
  const hb = data.heartbeat;
  const age = hb === null ? null : now - hb.lastTickAt;
  const healthy = age !== null && age < 5 * 60_000;

  const bootstrap = data.bootstrapInvite === null ? '' : `
    <div class="card">
      <h2>Get started</h2>
      <p style="margin-top:0">Nobody has joined yet. Open Telegram, find the bot, and send:</p>
      <p class="mono" style="font-size:15px">/start ${esc(data.bootstrapInvite.code)}</p>
      <div class="code">${esc(data.bootstrapInvite.code)}</div>
      <p class="muted small">Single use, expires ${esc(fmtDuration(data.bootstrapInvite.expiresAt - now))} from now.
      This panel disappears once someone has joined.</p>
    </div>`;

  const cards = data.patients.length === 0
    ? '<p class="muted">No one has enrolled yet.</p>'
    : `<div class="grid">${data.patients.map((p) => {
        const z = zoneFor(p.tz);
        return `<a class="person" href="/app/p/${p.id}">
          <div class="nm">${esc(p.displayName)}</div>
          <div style="margin-bottom:8px">${wakeChip(p, now)}</div>
          <div class="small muted">
            ${p.medCount} active medicine${p.medCount === 1 ? '' : 's'} ·
            ${p.chatCount} chat${p.chatCount === 1 ? '' : 's'}<br>
            ${esc(z.fmtTime12(now))} local (${esc(p.tz)})
          </div>
          ${p.pending > 0 ? `<div style="margin-top:9px"><span class="chip warn">${p.pending} waiting</span></div>` : ''}
        </a>`;
      }).join('')}</div>`;

  return page('Overview', `
    ${bootstrap}
    <div class="card">
      <h2>Family</h2>
      ${cards}
    </div>
    <div class="card">
      <h2>Scheduler</h2>
      <div class="row">
        <span class="chip ${healthy ? 'ok' : 'bad'}">${healthy ? '✓ Running' : '⚠ Stalled'}</span>
        <span class="small muted">${
          age === null ? 'has never run' : `last tick ${esc(fmtDuration(age))} ago · ${hb!.ticksToday} today`
        }</span>
      </div>
      ${healthy ? '' : '<div class="note bad">The minute tick is not firing. Reminders are not being sent.</div>'}
    </div>`, { nav: nav('home', data.displayName) });
}

// --- patient detail --------------------------------------------------------

function statusChip(d: Dose, now: number, tz: string): string {
  const z = zoneFor(tz);
  switch (d.status) {
    case 'due': case 'prompted':
      return `<span class="chip warn">waiting · due ${esc(z.fmtTime12(d.effectiveDueAt))} (${esc(fmtDuration(now - d.effectiveDueAt))} ago)</span>`;
    case 'deferred':
      return '<span class="chip">held until they wake</span>';
    default:
      return `<span class="chip">next ${esc(z.fmtTime12(d.effectiveDueAt))} · in ${esc(fmtDuration(d.effectiveDueAt - now))}</span>`;
  }
}

export function patientPage(data: {
  displayName: string;
  patient: Patient;
  meds: Medicine[];
  liveDoses: Dose[];
  chats: Array<{ chatId: number; role: string; tier: number; escalateAfterMs: number }>;
  adherence: Array<{ medId: number; status: string; n: number }>;
  recent: Dose[];
  prescriptionJson: string | null;
  now: number;
}): string {
  const { patient: p, now } = data;
  const z = zoneFor(p.tz);
  const liveByMed = new Map(data.liveDoses.map((d) => [d.medId, d]));
  const medById = new Map(data.meds.map((m) => [m.id, m]));

  const adh = new Map<number, { taken: number; missed: number; skipped: number }>();
  for (const a of data.adherence) {
    const e = adh.get(a.medId) ?? { taken: 0, missed: 0, skipped: 0 };
    if (a.status === 'taken') e.taken = a.n;
    if (a.status === 'missed') e.missed = a.n;
    if (a.status === 'skipped') e.skipped = a.n;
    adh.set(a.medId, e);
  }

  const medRows = data.meds.map((m) => {
    const live = liveByMed.get(m.id);
    const e = adh.get(m.id) ?? { taken: 0, missed: 0, skipped: 0 };
    const total = e.taken + e.missed + e.skipped;
    const pct = total === 0 ? null : Math.round((e.taken / total) * 100);
    const icon = m.status === 'active' ? '💊' : m.status === 'paused' ? '⏸' : m.status === 'completed' ? '🎉' : '⏹';
    const steps = m.steps.length > 1
      ? `<div class="small muted" style="margin-top:4px">${m.steps.map((s, i) => `${i + 1}. ${esc(s.name)}`).join(' · ')} — ${esc(fmtDuration(m.stepSpacingMs))} apart</div>`
      : '';
    const progress = m.courseKind === 'days' && m.startedAt !== null
      ? `day ${z.diffLocalDays(z.localDay(m.startedAt), z.localDay(now)) + 1} of ${m.courseDays}`
      : m.courseKind === 'doses' ? `${m.dosesTaken}/${m.courseDoses} doses` : '';
    return `<tr>
      <td><div>${icon} <b>${esc(m.name)}</b></div>
        <div class="small muted">${esc(describeSchedule(m))} · ${esc(describeCourse(m))}${progress === '' ? '' : ` · ${esc(progress)}`}</div>
        ${steps}</td>
      <td>${m.status === 'active' && live !== undefined ? statusChip(live, now, p.tz) : `<span class="chip">${esc(m.status)}</span>`}</td>
      <td>${pct === null ? '<span class="muted small">—</span>' : `
        <div class="row"><div class="bar" style="flex:1"><i style="width:${pct}%"></i></div>
        <span class="small muted">${pct}%</span></div>
        <div class="small muted">${e.taken} taken${e.missed > 0 ? `, ${e.missed} missed` : ''}${e.skipped > 0 ? `, ${e.skipped} skipped` : ''}</div>`}</td>
    </tr>`;
  }).join('');

  const recentRows = data.recent.slice(0, 25).map((d) => {
    const m = medById.get(d.medId);
    const label = m === undefined ? '?' : m.steps.length > 1 ? (m.steps[d.step]?.name ?? m.name) : m.name;
    const when = d.takenAt ?? d.resolvedAt ?? d.plannedDueAt;
    const cls = d.status === 'taken' ? 'ok' : d.status === 'missed' ? 'bad' : '';
    return `<tr><td class="small">${esc(d.localDay)} ${esc(z.fmtTime12(when))}</td>
      <td class="small">${esc(label)}</td>
      <td><span class="chip ${cls}">${esc(d.status)}</span>${d.resolutionSrc === 'correction' ? '<span class="chip">corrected</span>' : ''}</td></tr>`;
  }).join('');

  const chatRows = data.chats.map((c) => `<tr>
      <td class="mono small">${c.chatId}</td>
      <td>${esc(c.role)}</td>
      <td class="small muted">${c.tier === 0 ? 'gets everything immediately' : `after ${esc(fmtDuration(c.escalateAfterMs))} of silence`}</td>
    </tr>`).join('');

  return page(p.displayName, `
    <p class="small"><a href="/app">← Overview</a></p>
    <div class="card">
      <h2>${esc(p.displayName)}</h2>
      <div class="row" style="margin-bottom:10px">${wakeChip(p, now)}
        <span class="chip">${esc(z.fmtTime12(now))} local</span>
        <span class="chip">${esc(p.tz)}</span></div>
      <div class="small muted">Day runs ${esc(p.morningPollAt)}–${esc(p.eveningPollAt)} ·
        presumed awake by ${esc(p.presumedWakeAt)} · presumed asleep by ${esc(p.presumedSleepAt)}</div>
    </div>

    <div class="card"><h2>Medicines</h2>
      ${data.meds.length === 0 ? '<p class="muted">No prescription imported yet.</p>' :
        `<table><thead><tr><th>Medicine</th><th>Status</th><th>Last 14 days</th></tr></thead><tbody>${medRows}</tbody></table>`}
    </div>

    <div class="card"><h2>Linked chats</h2>
      ${data.chats.length === 0 ? '<p class="muted">No chats linked.</p>' :
        `<table><thead><tr><th>Chat</th><th>Role</th><th>Escalation</th></tr></thead><tbody>${chatRows}</tbody></table>`}
    </div>

    <div class="card"><h2>Recent doses</h2>
      ${data.recent.length === 0 ? '<p class="muted">Nothing logged yet.</p>' :
        `<table><thead><tr><th>When</th><th>Medicine</th><th></th></tr></thead><tbody>${recentRows}</tbody></table>`}
    </div>

    ${data.prescriptionJson === null ? '' : `<div class="card"><h2>Active prescription</h2>
      <pre>${esc(pretty(data.prescriptionJson))}</pre></div>`}
  `, { nav: nav('home', data.displayName) });
}

function pretty(json: string): string {
  try { return JSON.stringify(JSON.parse(json), null, 2); } catch { return json; }
}

// --- invites ---------------------------------------------------------------

export function invitesPage(data: {
  displayName: string;
  live: Invite[];
  recent: Invite[];
  patients: Array<{ id: number; name: string }>;
  justCreated: Invite | null;
  now: number;
  csrf: string;
}): string {
  const { now } = data;
  const created = data.justCreated === null ? '' : `
    <div class="card">
      <h2>New invite</h2>
      <div class="code">${esc(data.justCreated.code)}</div>
      <p style="margin-bottom:4px">Send this to them, along with the bot's link. They reply:</p>
      <p class="mono">${data.justCreated.kind === 'enrol'
        ? `/start ${esc(data.justCreated.code)}`
        : `/caregiver ${esc(data.justCreated.code)}`}</p>
      <p class="muted small">Single use · expires in ${esc(fmtDuration(data.justCreated.expiresAt - now))}</p>
    </div>`;

  const liveRows = data.live.map((i) => `<tr>
      <td class="mono"><b>${esc(i.code)}</b></td>
      <td>${i.kind === 'enrol' ? 'New member' : `Caregiver${i.label === null ? '' : ` for ${esc(i.label)}`}`}</td>
      <td class="small muted">expires in ${esc(fmtDuration(i.expiresAt - now))}</td>
      <td><form method="post" action="/app/invites/revoke" style="margin:0">
        <input type="hidden" name="csrf" value="${esc(data.csrf)}">
        <input type="hidden" name="code" value="${esc(i.code)}">
        <button class="small">Revoke</button></form></td>
    </tr>`).join('');

  const usedRows = data.recent.filter((i) => i.usedAt !== null).slice(0, 10).map((i) => `<tr>
      <td class="mono small">${esc(i.code)}</td>
      <td class="small">${i.kind === 'enrol' ? 'New member' : 'Caregiver'}</td>
      <td class="small muted">used ${esc(fmtDuration(now - i.usedAt!))} ago</td>
    </tr>`).join('');

  const patientOptions = data.patients.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');

  return page('Invites', `
    ${created}
    <div class="card">
      <h2>Invite someone new</h2>
      <p class="small muted" style="margin-top:0">They'll be able to join the bot and import their own
      prescription. Codes are single use and expire.</p>
      <form method="post" action="/app/invites/new">
        <input type="hidden" name="csrf" value="${esc(data.csrf)}">
        <input type="hidden" name="kind" value="enrol">
        <button class="primary" type="submit">Create join code</button>
      </form>
    </div>

    ${data.patients.length === 0 ? '' : `<div class="card">
      <h2>Invite a caregiver</h2>
      <p class="small muted" style="margin-top:0">They'll receive anything this person hasn't answered
      in time, and can answer on their behalf.</p>
      <form method="post" action="/app/invites/new">
        <input type="hidden" name="csrf" value="${esc(data.csrf)}">
        <input type="hidden" name="kind" value="caregiver">
        <label for="pt">Backup for</label>
        <select id="pt" name="patient_id" style="padding:9px 11px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--ink)">${patientOptions}</select>
        <label for="dl">Escalate after</label>
        <select id="dl" name="delay" style="padding:9px 11px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--ink)">
          <option value="5m" selected>5 minutes of silence</option>
          <option value="10m">10 minutes</option>
          <option value="15m">15 minutes</option>
          <option value="30m">30 minutes</option>
        </select>
        <div style="margin-top:16px"><button class="primary" type="submit">Create caregiver code</button></div>
      </form>
    </div>`}

    <div class="card"><h2>Outstanding</h2>
      ${data.live.length === 0 ? '<p class="muted">None.</p>' :
        `<table><thead><tr><th>Code</th><th>For</th><th>Expiry</th><th></th></tr></thead><tbody>${liveRows}</tbody></table>`}
    </div>

    ${usedRows === '' ? '' : `<div class="card"><h2>Redeemed</h2>
      <table><tbody>${usedRows}</tbody></table></div>`}
  `, { nav: nav('invites', data.displayName) });
}

// --- account ---------------------------------------------------------------

export function accountPage(data: {
  displayName: string;
  username: string;
  mustChange: boolean;
  error: string | null;
  notice: string | null;
  sessions: Array<{ createdAt: number; lastSeenAt: number; userAgent: string | null }>;
  now: number;
  csrf: string;
}): string {
  const sessionRows = data.sessions.map((s) => `<tr>
    <td class="small">${esc(fmtDuration(data.now - s.lastSeenAt))} ago</td>
    <td class="small muted">${esc((s.userAgent ?? 'unknown').slice(0, 70))}</td></tr>`).join('');

  return page('Account', `
    ${data.mustChange ? '<div class="note bad">You are still using the generated password. Please set your own.</div>' : ''}
    ${data.error === null ? '' : `<div class="note bad">${esc(data.error)}</div>`}
    ${data.notice === null ? '' : `<div class="note ok">${esc(data.notice)}</div>`}

    <div class="card"><h2>Profile</h2>
      <form method="post" action="/app/account/profile">
        <input type="hidden" name="csrf" value="${esc(data.csrf)}">
        <label for="dn">Display name</label>
        <input id="dn" name="display_name" type="text" value="${esc(data.displayName)}" required>
        <label for="un">Username</label>
        <input id="un" name="username" type="text" value="${esc(data.username)}" autocomplete="username" required>
        <div style="margin-top:16px"><button class="primary" type="submit">Save</button></div>
      </form>
    </div>

    <div class="card"><h2>Password</h2>
      <form method="post" action="/app/account/password">
        <input type="hidden" name="csrf" value="${esc(data.csrf)}">
        <label for="cp">Current password</label>
        <input id="cp" name="current" type="password" autocomplete="current-password" required>
        <label for="np">New password</label>
        <input id="np" name="next" type="password" autocomplete="new-password" required minlength="12">
        <label for="np2">Repeat new password</label>
        <input id="np2" name="confirm" type="password" autocomplete="new-password" required minlength="12">
        <p class="muted small" style="margin:10px 0 0">At least 12 characters. Changing this signs out every
        other device.</p>
        <div style="margin-top:16px"><button class="primary" type="submit">Change password</button></div>
      </form>
    </div>

    <div class="card"><h2>Signed in on</h2>
      ${data.sessions.length === 0 ? '<p class="muted">No active sessions.</p>' :
        `<table><tbody>${sessionRows}</tbody></table>
        <form method="post" action="/app/account/sessions" style="margin-top:14px">
          <input type="hidden" name="csrf" value="${esc(data.csrf)}">
          <button>Sign out everywhere else</button></form>`}
    </div>
  `, { nav: nav('account', data.displayName) });
}

// --- relationship graph ----------------------------------------------------

/**
 * A bipartite drawing: patients along the bottom, Telegram chats along the top, an edge
 * for every link. Laid out server-side as plain SVG -- with a handful of family members
 * there is nothing a physics simulation would add, and this needs no client code at all.
 */
export function graphPage(data: {
  displayName: string;
  patients: Array<{ id: number; name: string }>;
  links: Array<{ chatId: number; patientId: number; role: string; tier: number; escalateAfterMs: number }>;
}): string {
  const chats = [...new Set(data.links.map((l) => l.chatId))];
  const W = 900;
  const rowY = { chat: 90, patient: 300 };
  const H = 400;

  if (data.patients.length === 0) {
    return page('Relationships', `<div class="card"><h2>Relationships</h2>
      <p class="muted">Nobody has joined yet. Create an invite to get started.</p></div>`,
      { nav: nav('graph', data.displayName) });
  }

  const xs = (i: number, n: number): number => (W / (n + 1)) * (i + 1);
  const chatX = new Map(chats.map((c, i) => [c, xs(i, chats.length)]));
  const patX = new Map(data.patients.map((p, i) => [p.id, xs(i, data.patients.length)]));
  const nameOf = new Map(data.patients.map((p) => [p.id, p.name]));

  // A chat that is its own patient's chat is drawn solid; a caregiver link dashed.
  const edges = data.links.map((l) => {
    const x1 = chatX.get(l.chatId) ?? 0;
    const x2 = patX.get(l.patientId) ?? 0;
    const mid = (rowY.chat + rowY.patient) / 2;
    const care = l.role === 'caregiver';
    const label = care ? `after ${fmtDuration(l.escalateAfterMs)}` : 'immediate';
    return `<g>
      <path d="M ${x1} ${rowY.chat + 26} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${rowY.patient - 30}"
        fill="none" stroke="${care ? 'var(--accent)' : 'var(--ok)'}" stroke-width="2"
        ${care ? 'stroke-dasharray="6 5"' : ''} opacity=".75"/>
      <text x="${(x1 + x2) / 2}" y="${mid + 4}" text-anchor="middle" font-size="11"
        fill="var(--muted)">${esc(label)}</text>
    </g>`;
  }).join('');

  const chatNodes = chats.map((c) => {
    const x = chatX.get(c) ?? 0;
    const roles = data.links.filter((l) => l.chatId === c);
    const isPatient = roles.some((r) => r.role === 'patient');
    const owns = roles.filter((r) => r.role === 'patient').map((r) => nameOf.get(r.patientId) ?? '?');
    const label = isPatient ? (owns[0] ?? `chat ${c}`) : `caregiver`;
    return `<g>
      <circle cx="${x}" cy="${rowY.chat}" r="26" fill="var(--panel)" stroke="var(--line)" stroke-width="2"/>
      <text x="${x}" y="${rowY.chat + 5}" text-anchor="middle" font-size="18">${isPatient ? '👤' : '🛟'}</text>
      <text x="${x}" y="${rowY.chat - 38}" text-anchor="middle" font-size="13" font-weight="600"
        fill="var(--ink)">${esc(label)}</text>
      <text x="${x}" y="${rowY.chat - 23}" text-anchor="middle" font-size="10.5"
        fill="var(--muted)">chat ${c}</text>
    </g>`;
  }).join('');

  const patientNodes = data.patients.map((p) => {
    const x = patX.get(p.id) ?? 0;
    return `<g>
      <rect x="${x - 62}" y="${rowY.patient - 30}" width="124" height="56" rx="12"
        fill="var(--panel)" stroke="var(--line)" stroke-width="2"/>
      <text x="${x}" y="${rowY.patient - 8}" text-anchor="middle" font-size="13" font-weight="600"
        fill="var(--ink)">${esc(p.name)}</text>
      <text x="${x}" y="${rowY.patient + 12}" text-anchor="middle" font-size="11"
        fill="var(--muted)">patient</text>
    </g>`;
  }).join('');

  return page('Relationships', `
    <div class="card">
      <h2>Who looks after whom</h2>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Caregiver relationship graph">
        <text x="16" y="24" font-size="11" fill="var(--muted)" text-transform="uppercase">Telegram chats</text>
        <text x="16" y="${rowY.patient + 60}" font-size="11" fill="var(--muted)">Patients</text>
        ${edges}${chatNodes}${patientNodes}
      </svg>
      <div class="row small muted" style="margin-top:12px">
        <span><span style="display:inline-block;width:22px;height:0;border-top:2px solid var(--ok);vertical-align:middle"></span> own chat — reminded immediately</span>
        <span><span style="display:inline-block;width:22px;height:0;border-top:2px dashed var(--accent);vertical-align:middle"></span> caregiver — reminded only after silence</span>
      </div>
    </div>`, { nav: nav('graph', data.displayName) });
}

export function setupPage(password: string, username: string, origin: string): string {
  return page('Setup complete', `<div class="login" style="max-width:520px">
    <h1 style="font-size:22px">✅ medbot is set up</h1>
    <div class="note bad"><b>This password is shown once.</b> Save it now — it cannot be recovered,
    only reset by re-running setup.</div>
    <p class="muted small" style="margin-bottom:4px">Username</p>
    <div class="code" style="font-size:18px">${esc(username)}</div>
    <p class="muted small" style="margin:16px 0 4px">Password</p>
    <div class="code" style="font-size:18px">${esc(password)}</div>
    <p style="margin-top:24px"><a href="${esc(origin)}/app">Sign in →</a></p>
  </div>`);
}
