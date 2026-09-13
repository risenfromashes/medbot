import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { Bot } from './harness/bot.js';
import { handleDashboard } from '../src/handlers/dashboard.js';
import { AdminDb } from '../src/io/adminDb.js';
import { zoneFor } from '../src/core/tz.js';

/**
 * The dashboard, opened.
 *
 * It had never been. Every page is server-rendered HTML built by hand, which means a
 * missing field or an undefined in a template is a 500 that nobody discovers until they
 * click the link -- and the one person who will click it is the one who set the thing up.
 */

const z = zoneFor('Asia/Dhaka');
const DAY0 = z.wallOnDayUtc('2026-09-14', '10:00');
const PATIENT = 5000;
const CARER = 6000;

const realFetch = globalThis.fetch;
let bot: Bot;
let cookie = '';

beforeEach(() => {
  bot = new Bot(DAY0);
  bot.install();
  cookie = '';
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

async function get(path: string): Promise<Response> {
  const req = new Request(`https://medbot.test${path}`, { headers: cookie === '' ? {} : { cookie } });
  return handleDashboard(req, bot.env, bot.now, path);
}

/** The CSRF token the forms carry; posting without it is meant to fail. */
async function csrf(page = '/app/invites'): Promise<string> {
  const body = await (await get(page)).text();
  return /name="csrf" value="([^"]+)"/.exec(body)?.[1] ?? '';
}

async function post(path: string, form: Record<string, string>): Promise<Response> {
  const req = new Request(`https://medbot.test${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(cookie === '' ? {} : { cookie }),
    },
    body: new URLSearchParams(form).toString(),
  });
  return handleDashboard(req, bot.env, bot.now, path);
}

/** Create the admin, sign in, and set up a household worth looking at. */
async function household(): Promise<void> {
  const adb = new AdminDb(bot.d1 as never);
  const password = await adb.createAdmin('admin', 'Admin', bot.now);

  const enrol = await adb.createInvite('enrol', { createdBy: 'admin', ttlMs: 86400_000 }, bot.now);
  await bot.send(PATIENT, `/start ${enrol.code}`);
  await bot.sendFile(PATIENT, 'p.json', JSON.stringify({
    version: 1, timezone: 'Asia/Dhaka',
    medicines: [
      { id: 'drops', name: 'Moxifloxacin & Co', dose: '1 drop', schedule: { type: 'interval', every: '2h', anchor: 'wake' }, course: { days: 7 } },
      { id: 'tab', name: 'Tab. Ceevit 250', dose: '1 tablet', pattern: '1+1+1+1', course: { days: 7 } },
    ],
  }));
  await bot.tap(PATIENT, /Apply|Confirm|Yes/i);

  const patientId = Number(bot.d1.one('SELECT id FROM patients')?.['id']);
  const care = await adb.createInvite('caregiver', { createdBy: 'admin', ttlMs: 86400_000, patientId }, bot.now);
  await bot.send(CARER, `/caregiver ${care.code}`);

  await bot.send(PATIENT, '/awake');
  await bot.run(15 * 60_000);

  const res = await post('/app/login', { username: 'admin', password });
  expect([302, 303], "could not sign in with the generated password").toContain(res.status);
  cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  expect(cookie).not.toBe('');
}

describe('the dashboard', () => {
  it('shows a login page before anyone has signed in', async () => {
    const adb = new AdminDb(bot.d1 as never);
    await adb.createAdmin('admin', 'Admin', bot.now);
    const res = await get('/app/login');
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/password/i);
  });

  it('sends you to the login page instead of showing anything', async () => {
    const adb = new AdminDb(bot.d1 as never);
    await adb.createAdmin('admin', 'Admin', bot.now);
    const res = await get('/app');
    expect([302, 303]).toContain(res.status);
    expect(res.headers.get('location')).toBe('/app/login');
  });

  it('refuses a wrong password', async () => {
    const adb = new AdminDb(bot.d1 as never);
    await adb.createAdmin('admin', 'Admin', bot.now);
    const res = await post('/app/login', { username: 'admin', password: 'not-it' });
    expect(res.status).toBe(401);
  });

  it('renders every page once there is something to show', async () => {
    await household();
    const patientId = Number(bot.d1.one('SELECT id FROM patients')?.['id']);
    for (const path of ['/app', `/app/p/${patientId}`, '/app/graph', '/app/invites', '/app/account']) {
      const res = await get(path);
      expect(res.status, `${path} returned ${res.status}`).toBe(200);
      const body = await res.text();
      expect(body.length, `${path} rendered nothing`).toBeGreaterThan(200);
      expect(body, `${path} leaked an undefined`).not.toMatch(/undefined|\[object Object\]|NaN/);
    }
  });

  it('shows the household, their medicines and who backs up whom', async () => {
    await household();
    const patientId = Number(bot.d1.one('SELECT id FROM patients')?.['id']);
    const home = await (await get('/app')).text();
    expect(home, 'the overview does not link to anyone').toContain(`/app/p/${patientId}`);
    const detail = await (await get(`/app/p/${patientId}`)).text();
    expect(detail).toContain('Moxifloxacin');
    expect(detail, 'no schedule on the patient page').toMatch(/every 2h|waking/i);
    const graph = await (await get('/app/graph')).text();
    expect(graph, 'the caregiver graph shows nobody').toMatch(/Tester|caregiver|backs/i);
  });

  it('escapes a medicine name with an ampersand in it', async () => {
    await household();
    const patientId = Number(bot.d1.one('SELECT id FROM patients')?.['id']);
    const detail = await (await get(`/app/p/${patientId}`)).text();
    expect(detail).toContain('Moxifloxacin &amp; Co');
  });

  it('makes an invite you can actually redeem', async () => {
    await household();
    expect((await post('/app/invites/new', { kind: 'enrol' })).status, 'took a form with no CSRF token').toBe(403);
    const res = await post('/app/invites/new', { kind: 'enrol', csrf: await csrf() });
    expect([200, 302, 303]).toContain(res.status);
    const page = await (await get('/app/invites')).text();
    const code = /<b>([23456789BCDFGHJKMNPQRSTVWXYZ]{8})<\/b>/.exec(page)?.[1];
    expect(code, 'the invites page shows no code to copy').toBeDefined();

    await bot.send(7000, `/start ${code}`);
    expect(bot.last(7000)).toMatch(/Hello/);
  });

  it('never shows a medical detail to someone without a session', async () => {
    await household();
    cookie = '';
    for (const path of ['/app', '/app/graph', '/app/invites']) {
      const res = await get(path);
      expect([302, 303], `${path} was readable without signing in`).toContain(res.status);
    }
  });

  it('will not change the password without the current one', async () => {
    await household();
    const res = await post('/app/account/password', {
      csrf: await csrf('/app/account'),
      current: 'definitely-not-it', next: 'a-new-passphrase-here', confirm: 'a-new-passphrase-here',
    });
    expect(res.headers.get('location'), 'changed the password without checking the old one')
      .toMatch(/error=/);
  });
});
