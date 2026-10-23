#!/usr/bin/env node
// End-to-end test of the gateway against two stand-in panels. Uses a throwaway
// data directory, so your real users and panels are untouched.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakePanel } from './fake-panel.mjs';

const GW = 8190;
const BASE = `http://localhost:${GW}`;
const TOKEN_A = 'REAL-TOKEN-PANEL-A-secret';
const TOKEN_B = 'REAL-TOKEN-PANEL-B-secret';
const PANEL_PASSWORD = 'panel-account-password-A';

let pass = 0;
let fail = 0;
const t = (name, ok, extra = '') => {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
};
const section = (name) => console.log(`\n── ${name}`);

// Minimal cookie jar: fetch does not keep cookies between calls.
function client() {
  const jar = new Map();
  return async function call(path, options = {}) {
    const headers = { ...(options.headers ?? {}) };
    if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (options.json) {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(options.json);
    }
    const res = await fetch(`${BASE}${path}`, { ...options, headers, redirect: 'manual' });
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const eq = pair.indexOf('=');
      jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    return res;
  };
}

const dataDir = mkdtempSync(join(tmpdir(), 'npf-gw-test-'));
let gateway;
let panelA;
let panelB;

async function boot() {
  panelA = await startFakePanel({ port: 8191, accessKey: 'KEYA', rek: 'rek-for-panel-a', username: 'ops-a@x.com', password: PANEL_PASSWORD, token: TOKEN_A });
  panelB = await startFakePanel({ port: 8192, accessKey: 'KEYB', rek: 'rek-for-panel-b', username: 'ops-b@x.com', password: 'panel-account-password-B', token: TOKEN_B });

  gateway = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env,
      GW_DATA_DIR: dataDir,
      PORT: String(GW),
      SESSION_SECRET: 'test-secret-'.padEnd(64, 'x'),
      ADMIN_EMAIL: 'admin@test.local',
      NPF_EMAIL: '',
      NPF_PASSWORD: '',
      TRUST_PROXY: '0',
      BULK_MAX_PER_WINDOW: '5',
      BULK_WINDOW_MINUTES: '60',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  gateway.stdout.on('data', (d) => { output += d; });
  gateway.stderr.on('data', (d) => { output += d; });

  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`${BASE}/gw/health`);
      if (res.ok) break;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }

  const adminPassword = output.match(/password:\s+(\S+)/)?.[1];
  if (!adminPassword) throw new Error(`gateway did not print a bootstrap admin password:\n${output}`);
  return adminPassword;
}

function shutdown() {
  gateway?.kill();
  panelA?.server.close();
  panelB?.server.close();
  rmSync(dataDir, { recursive: true, force: true });
}

try {
  const adminPassword = await boot();

  /* ── first run ──────────────────────────────────────────────────── */
  section('first run');
  t('bootstrap created an admin and printed its password', Boolean(adminPassword));

  const admin = client();
  const badLogin = await admin('/gw/auth/login', { method: 'POST', json: { email: 'admin@test.local', password: 'wrong' } });
  t('wrong password is rejected', badLogin.status === 401);

  const login = await admin('/gw/auth/login', { method: 'POST', json: { email: 'admin@test.local', password: adminPassword } });
  t('admin can sign in', login.status === 200);
  t('session cookie is HttpOnly', (login.headers.getSetCookie?.() ?? []).some((c) => /gw_session/.test(c) && /HttpOnly/i.test(c)));

  /* ── panels ─────────────────────────────────────────────────────── */
  section('panels');
  const addA = await admin('/gw/admin/panels', { method: 'POST', json: { label: 'NPF', url: panelA.origin, username: 'ops-a@x.com', password: PANEL_PASSWORD } });
  const { panel: A } = await addA.json();
  t('admin can add a panel', addA.status === 200 && A.slug === 'npf');

  const addB = await admin('/gw/admin/panels', { method: 'POST', json: { label: 'NPF5', url: panelB.origin, username: 'ops-b@x.com', password: 'panel-account-password-B' } });
  const { panel: B } = await addB.json();
  t('admin can add a second panel', addB.status === 200 && B.slug === 'npf5');

  const onDisk = readFileSync(join(dataDir, 'panels.json'), 'utf8');
  t('panel password is NOT stored in clear', !onDisk.includes(PANEL_PASSWORD));
  t('panel password is sealed', onDisk.includes('passwordSealed'));

  const testOk = await (await admin(`/gw/admin/panels/${A.id}/test`, { method: 'POST' })).json();
  t('connection test reports success', testOk.ok === true);

  await admin(`/gw/admin/panels/${B.id}`, { method: 'PATCH', json: { password: 'wrong-now' } });
  const testBad = await (await admin(`/gw/admin/panels/${B.id}/test`, { method: 'POST' })).json();
  t('connection test reports a bad password', testBad.ok === false && /incorrect/i.test(testBad.message));
  await admin(`/gw/admin/panels/${B.id}`, { method: 'PATCH', json: { password: 'panel-account-password-B' } });

  /* ── users ──────────────────────────────────────────────────────── */
  section('users');
  const madeViewer = await (await admin('/gw/admin/users', {
    method: 'POST',
    json: { email: 'viewer@test.local', name: 'Viewer', role: 'user', canExport: false, panels: [A.id] },
  })).json();
  t('admin can add a user and is shown the password once', Boolean(madeViewer.password));

  const madeExporter = await (await admin('/gw/admin/users', {
    method: 'POST',
    json: { email: 'exporter@test.local', name: 'Exporter', role: 'user', canExport: true, panels: '*' },
  })).json();
  t('admin can grant export rights', madeExporter.user.canExport === true);

  const dupe = await admin('/gw/admin/users', { method: 'POST', json: { email: 'viewer@test.local', password: 'whatever12' } });
  t('duplicate email is refused', dupe.status === 400);

  /* ── access control ─────────────────────────────────────────────── */
  section('access control');
  const viewer = client();
  await viewer('/gw/auth/login', { method: 'POST', json: { email: 'viewer@test.local', password: madeViewer.password } });

  t('non-admin cannot reach the admin API', (await viewer('/gw/admin/users')).status === 403);

  const me = await (await viewer('/gw/auth/me')).json();
  t('picker shows only assigned panels', me.panels.length === 1 && me.panels[0].slug === 'npf');

  t('unassigned panel is refused', (await viewer(`/p/npf5/`)).status === 403);

  const anon = client();
  const anonRes = await anon('/p/npf/');
  t('signed-out visitor is sent to the login page', anonRes.status === 302 && anonRes.headers.get('location').startsWith('/login'));

  /* ── the panel itself ───────────────────────────────────────────── */
  section('serving the panel');
  const shellRes = await viewer('/p/npf/');
  const shell = await shellRes.text();
  t('panel shell is served', shellRes.status === 200);
  t('base href is rewritten to the panel prefix', shell.includes('<base href="/p/npf/">'));
  t('session is seeded so no vendor login is needed', shell.includes("localStorage.setItem('userEmail',\"viewer@test.local\")"));
  t('a placeholder access_token cookie is set at the panel path', (shellRes.headers.getSetCookie?.() ?? []).some((c) => /access_token/.test(c) && c.includes('Path=/p/npf/')));

  const bundle = await (await viewer('/p/npf/main.abc123.js')).text();
  t('bundle API base points back at the gateway', bundle.includes('apiBaseUrl:"/p/npf/npf-api/"'));
  t('bundle no longer references the upstream API', !bundle.includes(`${panelA.origin}/`));
  t('cookie path is scoped to this panel', bundle.includes('cookiePath:"/p/npf/"'));

  /* ── token shielding ────────────────────────────────────────────── */
  section('credential shielding');
  const menuRes = await viewer('/p/npf/npf-api/publishers/v1/menuList');
  const menu = await menuRes.json();
  t('data request succeeds', menuRes.status === 200 && menu.status === 1);
  t('real upstream token never appears in a response', !JSON.stringify(menu).includes(TOKEN_A));
  t('upstream received the injected real token', panelA.seen.some((s) => s.path === '/publishers/v1/menuList' && s.token === TOKEN_A));

  const allCookies = shellRes.headers.getSetCookie?.() ?? [];
  t('no cookie carries the upstream token', !allCookies.some((c) => c.includes(TOKEN_A)));

  /* ── exports ────────────────────────────────────────────────────── */
  section('exports');
  const blocked = await viewer('/p/npf/npf-api/publishers/v1/downloadLeadDetailsViewList');
  t('export blocked for a user without the permission', blocked.status === 403);
  t('blocked export never reached the panel', !panelA.seen.some((s) => s.path.includes('download')));

  const exporter = client();
  await exporter('/gw/auth/login', { method: 'POST', json: { email: 'exporter@test.local', password: madeExporter.password } });
  const allowed = await exporter('/p/npf/npf-api/publishers/v1/downloadLeadDetailsViewList');
  t('export allowed for a user with the permission', allowed.status === 200);
  t('CSV streams through intact', (await allowed.text()).includes('Lead One'));
  t('download filename preserved', (allowed.headers.get('content-disposition') ?? '').includes('leads.csv'));

  /* ── account endpoints ──────────────────────────────────────────── */
  section('shared-account protection');
  for (const path of ['users/v1/editProfile', 'users/v1/resetPassword', 'users/v1/forgot']) {
    const res = await exporter(`/p/npf/npf-api/${path}`, { method: 'POST', json: {} });
    t(`${path} blocked even for an exporter`, res.status === 403);
  }
  const logout = await exporter('/p/npf/npf-api/users/v1/logout');
  t('panel logout handled locally', logout.status === 200);
  t('panel logout never reached upstream', !panelA.seen.some((s) => s.path === '/users/v1/logout'));

  /* ── panel isolation ────────────────────────────────────────────── */
  section('panel isolation');
  const bMenu = await (await exporter('/p/npf5/npf-api/publishers/v1/menuList')).json();
  t('second panel serves its own data', bMenu.data?.panel === 8192);
  t('panel B received panel B token', panelB.seen.some((s) => s.token === TOKEN_B));
  t('panel B never saw panel A token', !panelB.seen.some((s) => s.token === TOKEN_A));

  /* ── revocation ─────────────────────────────────────────────────── */
  section('revocation');
  const viewerId = (await (await admin('/gw/admin/users')).json()).users.find((u) => u.email === 'viewer@test.local').id;
  await admin(`/gw/admin/users/${viewerId}`, { method: 'PATCH', json: { active: false } });
  const afterDisable = await viewer('/p/npf/npf-api/publishers/v1/menuList');
  t('disabling a user kills their live session at once', afterDisable.status === 401);

  await admin(`/gw/admin/users/${viewerId}`, { method: 'PATCH', json: { active: true, panels: [] } });
  const viewer2 = client();
  const reset = await (await admin(`/gw/admin/users/${viewerId}`, { method: 'PATCH', json: { resetPassword: true } })).json();
  await viewer2('/gw/auth/login', { method: 'POST', json: { email: 'viewer@test.local', password: reset.password } });
  t('revoking panel access takes effect without a re-login', (await viewer2('/p/npf/')).status === 403);

  /* ── audit ──────────────────────────────────────────────────────── */
  section('audit');
  const { entries } = await (await admin('/gw/admin/audit')).json();
  t('blocked export was recorded', entries.some((e) => e.event === 'blocked' && e.reason === 'export-blocked'));
  t('requests are attributed to a person', entries.some((e) => e.event === 'request' && e.user === 'viewer@test.local'));
  t('panel is recorded alongside the request', entries.some((e) => e.panel === 'npf'));

  /* ── pages and assets ───────────────────────────────────────────── */
  section('pages');
  for (const [path, expect] of [['/login', 200], ['/gw-assets/app.css', 200], ['/gw-assets/ui.js', 200]]) {
    t(`${path} serves`, (await anon(path)).status === expect);
  }
  t('/ sends a stranger to the login page', (await anon('/')).headers.get('location') === '/login');
  t('/admin refuses a non-admin', (await viewer2('/admin')).status === 403);
  t('/admin serves an admin', (await admin('/admin')).status === 200);
  t('/account serves any signed-in user', (await viewer2('/account')).status === 200);

  /* ── own password ───────────────────────────────────────────────── */
  section('changing your own password');
  const pw = client();
  const pwUser = await (await admin('/gw/admin/users', {
    method: 'POST', json: { email: 'self@test.local', name: 'Self', role: 'user', panels: [] },
  })).json();
  await pw('/gw/auth/login', { method: 'POST', json: { email: 'self@test.local', password: pwUser.password } });

  const wrongCurrent = await pw('/gw/auth/password', { method: 'POST', json: { currentPassword: 'nope', newPassword: 'brand-new-password' } });
  t('wrong current password is refused', wrongCurrent.status === 400);

  const tooShort = await pw('/gw/auth/password', { method: 'POST', json: { currentPassword: pwUser.password, newPassword: 'short' } });
  t('too-short new password is refused', tooShort.status === 400);

  const reuse = await pw('/gw/auth/password', { method: 'POST', json: { currentPassword: pwUser.password, newPassword: pwUser.password } });
  t('reusing the same password is refused', reuse.status === 400);

  const changed = await pw('/gw/auth/password', { method: 'POST', json: { currentPassword: pwUser.password, newPassword: 'a-properly-long-new-one' } });
  t('a valid change succeeds', changed.status === 200);
  t('the session that made the change still works', (await pw('/gw/auth/me')).status === 200);

  const oldPw = client();
  const oldTry = await oldPw('/gw/auth/login', { method: 'POST', json: { email: 'self@test.local', password: pwUser.password } });
  t('the old password no longer works', oldTry.status === 401);

  /* ── last sign-in ───────────────────────────────────────────────── */
  section('sign-in tracking');
  const tracked = (await (await admin('/gw/admin/users')).json()).users.find((u) => u.email === 'self@test.local');
  t('last sign-in is recorded', Boolean(tracked.lastLoginAt));
  t('sign-in IP is recorded', Boolean(tracked.lastLoginIp));

  /* ── live sessions ──────────────────────────────────────────────── */
  section('live sessions');
  const { sessions: live } = await (await admin('/gw/admin/sessions')).json();
  t('admin can see who is signed in', live.length >= 2);
  t('the admin\'s own session is marked', live.some((s) => s.current));
  t('sessions carry an IP and device', live.every((s) => 'ip' in s && 'userAgent' in s));

  const victim = live.find((s) => s.email === 'self@test.local');
  await admin(`/gw/admin/sessions/${victim.id}`, { method: 'DELETE' });
  t('admin can sign someone out remotely', (await pw('/gw/auth/me')).status === 401);

  /* ── overview ───────────────────────────────────────────────────── */
  section('overview');
  const overview = await (await admin('/gw/admin/overview')).json();
  t('counts users', overview.users.total >= 3);
  t('counts panels', overview.panels.total === 2);
  t('reports the storage backend', overview.storage.backend === 'file');
  t('counts today\'s blocked requests', overview.today.blocked >= 1);

  /* ── audit export ───────────────────────────────────────────────── */
  section('audit export');
  const csvRes = await admin('/gw/admin/audit.csv');
  const csv = await csvRes.text();
  t('CSV downloads', csvRes.status === 200 && (csvRes.headers.get('content-disposition') ?? '').includes('.csv'));
  t('CSV has a header row', csv.split('\n')[0].startsWith('at,event,user'));
  t('CSV contains real entries', csv.split('\n').length > 3);

  /* ── guard rails ────────────────────────────────────────────────── */
  section('guard rails');
  const adminId = (await (await admin('/gw/admin/users')).json()).users.find((u) => u.email === 'admin@test.local').id;
  t('an admin cannot delete themselves', (await admin(`/gw/admin/users/${adminId}`, { method: 'DELETE' })).status === 400);
  t('an admin cannot demote themselves', (await admin(`/gw/admin/users/${adminId}`, { method: 'PATCH', json: { role: 'user' } })).status === 400);
  t('the last admin cannot be disabled', (await admin(`/gw/admin/users/${adminId}`, { method: 'PATCH', json: { active: false } })).status === 400);

  const reserved = await admin('/gw/admin/panels', { method: 'POST', json: { label: 'admin', url: 'https://x.test', username: 'a@b.c', password: 'x' } });
  t('a panel cannot take a reserved name', reserved.status === 400);

  const weak = await admin('/gw/admin/users', { method: 'POST', json: { email: 'weak@test.local', password: 'short' } });
  t('a short password is refused', weak.status === 400);

  const badEmail = await admin('/gw/admin/users', { method: 'POST', json: { email: 'not-an-email' } });
  t('an invalid email is refused', badEmail.status === 400);

  // The first-run fallback address must satisfy the same validation, or a
  // deploy with no ADMIN_EMAIL set cannot create an administrator at all.
  const fallback = await admin('/gw/admin/users', { method: 'POST', json: { email: 'admin@example.com', password: 'a-long-enough-pass' } });
  t('the built-in fallback admin address is accepted', fallback.status === 200);

  /* ── login throttling ───────────────────────────────────────────── */
  section('login throttling');
  const attacker = client();
  let throttled = false;
  for (let i = 0; i < 12; i += 1) {
    const res = await attacker('/gw/auth/login', { method: 'POST', json: { email: 'target@test.local', password: `guess-${i}` } });
    if (res.status === 429) { throttled = true; break; }
  }
  t('repeated failures against one account are throttled', throttled);


  /* ── watermarking ───────────────────────────────────────────────── */
  section('watermarking');
  // A fresh user: viewer2 had its panel access revoked by the test above, so
  // it would be served a 403 page rather than the panel shell.
  const watched = client();
  const watchedUser = await (await admin('/gw/admin/users', {
    method: 'POST', json: { email: 'watched@test.local', name: 'Watched', role: 'user', canExport: false, panels: '*' },
  })).json();
  await watched('/gw/auth/login', { method: 'POST', json: { email: 'watched@test.local', password: watchedUser.password } });

  const userShell = await (await watched('/p/npf/')).text();
  t('watermark layer is injected', userShell.includes('kagw-wm'));
  t('watermark carries the brand', userShell.includes('KollegeApply'));
  t('watermark carries the viewer identity', userShell.includes('watched@test.local'));
  t('watermark names the panel', /var PANEL = "NPF"/.test(userShell));
  t('watermark is re-asserted, not set once', userShell.includes('MutationObserver'));
  t('watermark survives printing', userShell.includes('@media print'));
  t('watermark opacity is applied from config', /var O = 0\.\d+;/.test(userShell));
  // The identity line is deliberately stronger than the brand: it is the part
  // that has to stay readable once a screenshot has been compressed.
  const wmO = Number(userShell.match(/var O = ([\d.]+);/)[1]);
  t('opacity is in the legible-but-unobtrusive range', wmO >= 0.08 && wmO <= 0.3, `is ${wmO}`);

  /* ── copy friction ──────────────────────────────────────────────── */
  section('copy friction');
  t('friction is on for a plain user', /var FRICTION = true/.test(userShell));
  t('copy, cut and right-click are intercepted', ['copy', 'cut', 'contextmenu', 'dragstart'].every((e) => userShell.includes(`'${e}'`)));
  t('save, print and view-source shortcuts are intercepted', /\['s', 'p', 'u'\]/.test(userShell));
  t('devtools shortcuts are intercepted', userShell.includes("key === 'f12'"));
  t('text selection is disabled', userShell.includes('user-select:none'));
  t('inputs stay typeable', userShell.includes('input,textarea'));

  const adminShell = await (await admin('/p/npf/')).text();
  t('admin keeps a clean view (no friction)', /var FRICTION = false/.test(adminShell));
  t('admin is still watermarked for attribution', /var WATERMARK = true/.test(adminShell));
  t('admin watermark names the admin', adminShell.includes('admin@test.local'));

  /* ── bulk retrieval cap ─────────────────────────────────────────── */
  section('bulk retrieval cap');
  const grazer = client();
  const grazerUser = await (await admin('/gw/admin/users', {
    method: 'POST', json: { email: 'grazer@test.local', name: 'Grazer', role: 'user', canExport: false, panels: '*' },
  })).json();
  await grazer('/gw/auth/login', { method: 'POST', json: { email: 'grazer@test.local', password: grazerUser.password } });

  let capped = 0;
  for (let i = 0; i < 9; i += 1) {
    const res = await grazer('/p/npf/npf-api/publishers/v1/getLeadDetailsViewList/?page=' + i);
    if (res.status === 429) { capped = i; break; }
  }
  t('paging through leads is capped', capped > 0 && capped <= 7, `blocked at request ${capped}`);
  t('the cap leaves normal browsing alone', capped >= 5, `${capped} requests allowed before the cap`);

  const nonList = await grazer('/p/npf/npf-api/publishers/v1/menuList');
  t('the cap only applies to lead listings', nonList.status === 200);

  // Someone trusted to download the whole list in one click gains nothing from
  // a paging limit, so they are exempt.
  let exporterBlocked = false;
  for (let i = 0; i < 9; i += 1) {
    const res = await exporter('/p/npf/npf-api/publishers/v1/getLeadDetailsViewList/?page=' + i);
    if (res.status === 429) { exporterBlocked = true; break; }
  }
  t('export-permitted users are exempt', !exporterBlocked);

  const capEntries = (await (await admin('/gw/admin/audit?limit=500')).json()).entries;
  t('hitting the cap is recorded against the person', capEntries.some((e) => e.reason === 'bulk-limit' && e.user === 'grazer@test.local'));

} catch (err) {
  fail += 1;
  console.error(`\nFATAL: ${err.stack}`);
} finally {
  shutdown();
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
