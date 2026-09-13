#!/usr/bin/env node
/**
 * medbot deployment and administration.
 *
 *   node scripts/medbot.mjs setup             first-time deploy, end to end
 *   node scripts/medbot.mjs status            what is deployed and running
 *   node scripts/medbot.mjs reset-password    issue a new admin password
 *   node scripts/medbot.mjs calibrate         re-tune the password hashing cost
 *   node scripts/medbot.mjs rotate-secret     new webhook secret, re-register
 *   node scripts/medbot.mjs deploy            migrate and push code
 *
 * Everything here talks to Cloudflare through wrangler, so there is no second set of
 * credentials to manage. The admin password is generated locally, hashed locally, and
 * written straight into D1 -- it is never sent anywhere and never logged.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { webcrypto as crypto } from 'node:crypto';

const CREDENTIALS_FILE = 'medbot-credentials.json';
const ENV_FILE = '.env';
const DB_BINDING = 'MEDBOT_DB';
const DB_NAME = 'medbot';

// --- small helpers ---------------------------------------------------------

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

const say = (s = '') => console.log(s);
const step = (s) => say(`\n${c.bold(s)}`);
const ok = (s) => say(`  ${c.green('✓')} ${s}`);
const warn = (s) => say(`  ${c.yellow('!')} ${s}`);
const fail = (s) => say(`  ${c.red('✗')} ${s}`);

function wrangler(args, { quiet = true, input } = {}) {
  try {
    return execFileSync('npx', ['wrangler', ...args], {
      encoding: 'utf8',
      stdio: quiet ? ['pipe', 'pipe', 'pipe'] : 'inherit',
      input,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    });
  } catch (e) {
    const out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    const err = new Error(out.trim() || e.message);
    err.output = out;
    throw err;
  }
}

/** Run SQL against the remote D1 and return the rows. */
function sql(command, { remote = true } = {}) {
  const out = wrangler([
    'd1', 'execute', DB_BINDING, remote ? '--remote' : '--local',
    '--command', command, '--json',
  ]);
  const start = out.indexOf('[');
  if (start === -1) return [];
  try {
    return JSON.parse(out.slice(start))[0]?.results ?? [];
  } catch {
    return [];
  }
}

function readEnv() {
  if (!existsSync(ENV_FILE)) return {};
  const out = {};
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m !== null) out[m[1]] = m[2];
  }
  return out;
}

function writeEnv(patch) {
  const lines = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8').split('\n') : [];
  const kept = lines.filter((l) => {
    const m = /^([A-Z0-9_]+)=/.exec(l.trim());
    return m === null || !(m[1] in patch);
  }).filter((l) => l.trim() !== '');
  for (const [k, v] of Object.entries(patch)) kept.push(`${k}=${v}`);
  writeFileSync(ENV_FILE, `${kept.join('\n')}\n`, { mode: 0o600 });
  try { chmodSync(ENV_FILE, 0o600); } catch { /* best effort */ }
}

const rl = () => createInterface({ input: stdin, output: stdout });

async function ask(question, fallback = '') {
  const i = rl();
  const answer = (await i.question(`  ${question}${fallback === '' ? '' : ` ${c.dim(`[${fallback}]`)}`}: `)).trim();
  i.close();
  return answer === '' ? fallback : answer;
}

async function confirm(question, fallbackYes = false) {
  const answer = (await ask(`${question} ${fallbackYes ? '(Y/n)' : '(y/N)'}`)).toLowerCase();
  if (answer === '') return fallbackYes;
  return answer.startsWith('y');
}

// --- crypto (matching src/io/auth.ts exactly) -------------------------------

const b64 = (buf) => Buffer.from(new Uint8Array(buf)).toString('base64');

function generatePassword() {
  const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return `${out.slice(0, 5)}-${out.slice(5, 10)}-${out.slice(10, 15)}-${out.slice(15)}`;
}

function randomHex(bytes = 32) {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString('hex');
}

async function hashPassword(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256,
  );
  return b64(bits);
}

/**
 * Pick the largest iteration count whose cost fits the target budget.
 *
 * Measured here rather than guessed, because the honest answer depends on the machine.
 * `workerdFactor` accounts for the deployed runtime being slower than this laptop --
 * observed at roughly 1.6x, and rounded up, because being too slow means logins get
 * killed by the CPU limit while being too fast only costs a little security margin.
 */
async function calibrateIterations({ budgetMs = 4, workerdFactor = 2.0 } = {}) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  await hashPassword('warmup', salt, 5_000); // let the JIT settle

  const probe = 20_000;
  const runs = 5;
  const t0 = performance.now();
  for (let i = 0; i < runs; i++) await hashPassword('calibration', salt, probe);
  const msPerProbe = (performance.now() - t0) / runs;

  const msPerIteration = msPerProbe / probe;
  const affordable = Math.floor(budgetMs / (msPerIteration * workerdFactor));
  const rounded = Math.max(5_000, Math.min(500_000, Math.floor(affordable / 1000) * 1000));
  return {
    iterations: rounded,
    localMsAtProbe: msPerProbe,
    predictedWorkerMs: rounded * msPerIteration * workerdFactor,
  };
}

// --- credentials file ------------------------------------------------------

function writeCredentials(patch) {
  const existing = existsSync(CREDENTIALS_FILE)
    ? JSON.parse(readFileSync(CREDENTIALS_FILE, 'utf8'))
    : {};
  const merged = { ...existing, ...patch, updatedAt: new Date().toISOString() };
  writeFileSync(CREDENTIALS_FILE, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  try { chmodSync(CREDENTIALS_FILE, 0o600); } catch { /* best effort */ }
  return merged;
}

// --- state inspection ------------------------------------------------------

function workerUrl() {
  const env = readEnv();
  if (env.WORKER_URL) return env.WORKER_URL;
  try {
    const out = wrangler(['deployments', 'list']);
    const m = /https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i.exec(out);
    if (m) return m[0];
  } catch { /* fall through */ }
  return null;
}

function adminExists() {
  try {
    return sql('SELECT id FROM admin_users WHERE id = 1').length > 0;
  } catch {
    return false;
  }
}

function databaseId() {
  if (!existsSync('wrangler.jsonc')) return null;
  const m = /"database_id"\s*:\s*"([^"]+)"/.exec(readFileSync('wrangler.jsonc', 'utf8'));
  return m === null || m[1].startsWith('REPLACE') ? null : m[1];
}

function setDatabaseId(id) {
  const text = readFileSync('wrangler.jsonc', 'utf8');
  writeFileSync('wrangler.jsonc', text.replace(/"database_id"\s*:\s*"[^"]*"/, `"database_id": "${id}"`));
}

// --- commands --------------------------------------------------------------

async function cmdSetup() {
  say(c.bold('\nmedbot setup'));
  say(c.dim('Deploys the bot and dashboard to your Cloudflare account.\n'));

  // 1. Cloudflare account
  step('1. Cloudflare');
  let account;
  try {
    const who = wrangler(['whoami']);
    account = /associated with the email ([^.\s]+@[^.\s]+\.\S+?)\./.exec(who)?.[1] ?? 'your account';
    ok(`signed in as ${account}`);
  } catch {
    fail('not signed in to Cloudflare');
    say(`\n  Run ${c.cyan('npx wrangler login')} first, then run this again.\n`);
    process.exit(1);
  }

  // 2. Telegram token
  step('2. Telegram bot');
  const env = readEnv();
  let token = env.TELEGRAM_BOT_KEY ?? env.TELEGRAM_BOT_TOKEN ?? '';
  if (token !== '') {
    ok('token found in .env');
  } else {
    say(c.dim('  Message @BotFather on Telegram, send /newbot, and paste the token here.'));
    token = await ask('Bot token');
    if (!/^\d+:[\w-]+$/.test(token)) {
      fail('that does not look like a bot token');
      process.exit(1);
    }
  }

  const me = await fetch(`https://api.telegram.org/bot${token}/getMe`).then((r) => r.json());
  if (!me.ok) {
    fail(`Telegram rejected the token: ${me.description}`);
    process.exit(1);
  }
  ok(`bot verified: @${me.result.username}`);
  writeEnv({ TELEGRAM_BOT_KEY: token });

  // 3. Database
  step('3. Database');
  let dbId = databaseId();
  if (dbId !== null) {
    ok(`using existing database ${c.dim(dbId)}`);
  } else {
    const out = wrangler(['d1', 'create', DB_NAME]);
    dbId = /"database_id"\s*:\s*"([^"]+)"/.exec(out)?.[1] ?? null;
    if (dbId === null) {
      fail('could not create the database');
      say(out);
      process.exit(1);
    }
    setDatabaseId(dbId);
    ok(`created database ${c.dim(dbId)}`);
  }

  wrangler(['d1', 'migrations', 'apply', DB_BINDING, '--remote'], { quiet: true });
  ok('migrations applied');

  // 4. Secrets
  step('4. Secrets');
  let webhookSecret = env.WEBHOOK_SECRET ?? '';
  if (webhookSecret === '') {
    webhookSecret = randomHex(32);
    writeEnv({ WEBHOOK_SECRET: webhookSecret });
    ok('generated a webhook secret');
  } else {
    ok('webhook secret found in .env');
  }
  wrangler(['secret', 'put', 'TELEGRAM_BOT_TOKEN'], { input: token });
  wrangler(['secret', 'put', 'WEBHOOK_SECRET'], { input: webhookSecret });
  ok('secrets uploaded');

  // 5. Hash cost
  step('5. Password hashing');
  const cal = await calibrateIterations();
  await applyIterations(cal);

  // 6. Deploy
  step('6. Deploy');
  const deployOut = wrangler(['deploy']);
  const url = /https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i.exec(deployOut)?.[0] ?? null;
  if (url === null) {
    fail('deployed, but could not determine the URL');
  } else {
    ok(`deployed to ${c.cyan(url)}`);
    writeEnv({ WORKER_URL: url });
  }

  // 7. Webhook
  step('7. Telegram webhook');
  if (url !== null) {
    const res = await fetch(`${url}/setup?key=${encodeURIComponent(webhookSecret)}`);
    if (res.ok) ok('webhook registered and command menu published');
    else warn(`webhook registration returned ${res.status}`);
  }

  // 8. Admin account
  step('8. Admin account');
  await ensureAdmin({ interactive: true });

  // Done
  say(`\n${c.green(c.bold('Setup complete.'))}\n`);
  if (url !== null) {
    say(`  Dashboard  ${c.cyan(`${url}/app`)}`);
    say(`  Bot        ${c.cyan(`https://t.me/${me.result.username}`)}`);
  }
  say(`  Credentials written to ${c.bold(CREDENTIALS_FILE)} ${c.dim('(gitignored, chmod 600)')}`);
  say(`\n  Next: sign in, then use the join code on the overview page to add yourself in Telegram.\n`);
}

async function applyIterations(cal) {
  sql(`INSERT INTO kv (k, v) VALUES ('pbkdf2_iterations', '${cal.iterations}')
       ON CONFLICT (k) DO UPDATE SET v = '${cal.iterations}'`);
  ok(`calibrated to ${cal.iterations.toLocaleString()} PBKDF2 iterations`);
  say(c.dim(`    ~${cal.predictedWorkerMs.toFixed(1)}ms predicted on the Worker, against a 10ms budget`));
  writeCredentials({ pbkdf2Iterations: cal.iterations });
}

/** Creates the admin only if there isn't one. An existing password is never overwritten. */
async function ensureAdmin({ interactive = false, force = false } = {}) {
  const exists = adminExists();

  if (exists && !force) {
    ok('admin account already exists — password left untouched');
    say(c.dim('    Use `reset-password` if you have lost it.'));
    return null;
  }

  const username = interactive && !exists ? await ask('Admin username', 'admin') : 'admin';
  const displayName = interactive && !exists ? await ask('Your name', 'Admin') : 'Admin';

  const iterRow = sql("SELECT v FROM kv WHERE k = 'pbkdf2_iterations'");
  const iterations = iterRow.length > 0 ? Number(iterRow[0].v) : 12_000;

  const password = generatePassword();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await hashPassword(password, salt, iterations);
  const now = Date.now();

  const esc = (s) => String(s).replace(/'/g, "''");
  if (exists) {
    sql(`UPDATE admin_users SET password_hash='${esc(hash)}', password_salt='${esc(b64(salt))}',
         iterations=${iterations}, must_change=1, password_changed_at=${now} WHERE id=1`);
    sql('DELETE FROM sessions');
    ok('password reset — all sessions signed out');
  } else {
    sql(`INSERT INTO admin_users (id, username, display_name, password_hash, password_salt,
           iterations, must_change, created_at)
         VALUES (1, '${esc(username)}', '${esc(displayName)}', '${esc(hash)}', '${esc(b64(salt))}',
           ${iterations}, 1, ${now})`);
    ok(`admin account created`);
  }

  const url = workerUrl();
  writeCredentials({
    dashboard: url === null ? undefined : `${url}/app`,
    username: exists ? undefined : username,
    initialPassword: password,
    passwordIssuedAt: new Date(now).toISOString(),
    note: 'This is the INITIAL password. Once you change it in the dashboard, this value is stale and the setup script will not regenerate it.',
  });

  say('');
  say(`  ${c.bold('Username')}  ${exists ? sql('SELECT username FROM admin_users WHERE id=1')[0]?.username ?? 'admin' : username}`);
  say(`  ${c.bold('Password')}  ${c.green(password)}`);
  say(c.dim(`  Saved to ${CREDENTIALS_FILE}. Change it after signing in.`));
  return password;
}

async function cmdResetPassword() {
  if (!adminExists()) {
    warn('no admin account yet — run `setup` first');
    return;
  }
  say(c.bold('\nReset the admin password'));
  say(c.dim('  This signs out every device and issues a new generated password.\n'));
  if (!(await confirm('Continue?'))) {
    say('  Cancelled.\n');
    return;
  }
  await ensureAdmin({ force: true });
  say('');
}

async function cmdCalibrate() {
  say(c.bold('\nCalibrating password hashing cost'));
  const budget = Number(await ask('Target CPU budget in ms (the free plan allows 10)', '4'));
  const cal = await calibrateIterations({ budgetMs: Number.isFinite(budget) ? budget : 4 });
  say('');
  say(`  local cost at 20,000 iterations: ${cal.localMsAtProbe.toFixed(2)} ms`);
  await applyIterations(cal);
  say(c.dim('\n  Existing passwords keep their own stored count and still work.'));
  say(c.dim('  The new value applies the next time a password is set.\n'));
}

async function cmdRotateSecret() {
  const url = workerUrl();
  if (url === null) {
    fail('could not determine the Worker URL — is it deployed?');
    return;
  }
  say(c.bold('\nRotating the webhook secret\n'));
  const secret = randomHex(32);
  wrangler(['secret', 'put', 'WEBHOOK_SECRET'], { input: secret });
  writeEnv({ WEBHOOK_SECRET: secret });
  ok('new secret uploaded');
  // Give the new version a moment to become live before re-registering.
  await new Promise((r) => setTimeout(r, 3000));
  const res = await fetch(`${url}/setup?key=${encodeURIComponent(secret)}`);
  if (res.ok) ok('webhook re-registered with the new secret');
  else warn(`re-registration returned ${res.status}; run it again in a moment`);
  say('');
}

async function cmdDeploy() {
  step('Migrating');
  wrangler(['d1', 'migrations', 'apply', DB_BINDING, '--remote']);
  ok('migrations applied');
  step('Deploying');
  const out = wrangler(['deploy']);
  const url = /https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i.exec(out)?.[0];
  ok(`deployed${url ? ` to ${c.cyan(url)}` : ''}`);
  say('');
}

async function cmdStatus() {
  say(c.bold('\nmedbot status\n'));

  const url = workerUrl();
  say(`  Worker       ${url ?? c.dim('unknown')}`);
  say(`  Database     ${databaseId() ?? c.dim('not configured')}`);

  try {
    const admin = sql('SELECT username, display_name, must_change, last_login_at FROM admin_users WHERE id=1');
    if (admin.length === 0) say(`  Admin        ${c.yellow('not created')}`);
    else {
      const a = admin[0];
      say(`  Admin        ${a.username} (${a.display_name})${a.must_change ? c.yellow(' — still on the generated password') : ''}`);
    }
    const iter = sql("SELECT v FROM kv WHERE k='pbkdf2_iterations'");
    say(`  Hash cost    ${iter.length > 0 ? `${Number(iter[0].v).toLocaleString()} iterations` : c.dim('default')}`);

    const counts = sql(`SELECT
      (SELECT COUNT(*) FROM patients) AS patients,
      (SELECT COUNT(*) FROM chats WHERE active=1) AS chats,
      (SELECT COUNT(*) FROM medications WHERE status='active') AS meds,
      (SELECT COUNT(*) FROM invites WHERE used_at IS NULL AND expires_at > ${Date.now()}) AS invites`)[0] ?? {};
    say(`  Family       ${counts.patients ?? 0} patient(s), ${counts.chats ?? 0} chat(s), ${counts.meds ?? 0} active medicine(s)`);
    say(`  Invites      ${counts.invites ?? 0} outstanding`);
  } catch (e) {
    warn(`could not read the database: ${e.message.split('\n')[0]}`);
  }

  if (url !== null) {
    try {
      const health = await fetch(`${url}/health`).then((r) => r.json());
      say(`  Scheduler    ${health.ok ? c.green('running') : c.red('STALLED')} — last tick ${health.lastTickAge ?? 'never'}, ${health.ticksToday} today`);
    } catch {
      warn('health check failed');
    }
  }
  say('');
}

// --- entry point -----------------------------------------------------------

const COMMANDS = {
  setup: cmdSetup,
  status: cmdStatus,
  'reset-password': cmdResetPassword,
  calibrate: cmdCalibrate,
  'rotate-secret': cmdRotateSecret,
  deploy: cmdDeploy,
};

const command = process.argv[2] ?? 'setup';
const handler = COMMANDS[command];

if (handler === undefined) {
  say(`\n${c.bold('medbot')}\n`);
  say('  node scripts/medbot.mjs <command>\n');
  say(`  ${c.bold('setup')}            first-time deploy, end to end`);
  say(`  ${c.bold('status')}           what is deployed and running`);
  say(`  ${c.bold('reset-password')}   issue a new admin password`);
  say(`  ${c.bold('calibrate')}        re-tune the password hashing cost`);
  say(`  ${c.bold('rotate-secret')}    new webhook secret, re-register`);
  say(`  ${c.bold('deploy')}           migrate and push code\n`);
  process.exit(command === 'help' || command === '--help' ? 0 : 1);
}

handler().catch((e) => {
  say(`\n${c.red('Failed:')} ${e.message}\n`);
  process.exit(1);
});
