#!/usr/bin/env node
// Preflight check. Run on the server after changing configuration, or when
// something is wrong and you want to know what. Exits non-zero on real
// problems so it can gate a deploy.
import { statSync, accessSync, constants } from 'node:fs';
import { createServer } from 'node:net';
import process from 'node:process';

const problems = [];
const warnings = [];
const notes = [];

const fail = (what, fix) => problems.push({ what, fix });
const warn = (what, fix) => warnings.push({ what, fix });
const ok = (what) => notes.push(what);

/* ── runtime ─────────────────────────────────────────────────────────── */

const [major, minor] = process.versions.node.split('.').map(Number);
if (major > 20 || (major === 20 && minor >= 12)) ok(`Node ${process.versions.node}`);
else fail(`Node ${process.versions.node} is too old`, 'Install Node 20.12 or newer; the gateway uses process.loadEnvFile().');

/* ── configuration ───────────────────────────────────────────────────── */

let config;
try {
  ({ config } = await import('../src/config.js'));
  ok('configuration loads');
} catch (err) {
  fail(`configuration will not load: ${err.message}`, 'Check .env against .env.example.');
}

if (config) {
  const secret = process.env.SESSION_SECRET ?? '';
  if (secret.length < 32) {
    fail(`SESSION_SECRET is only ${secret.length} characters`, 'Use at least 32: openssl rand -hex 32');
  } else if (/change|placeholder|example|secret|test|password/i.test(secret)) {
    fail('SESSION_SECRET looks like a placeholder', 'Replace it: openssl rand -hex 32 — do this before adding panels.');
  } else {
    ok('SESSION_SECRET looks real');
  }

  if (config.trustProxy) ok('TRUST_PROXY is on (correct behind nginx)');
  else warn('TRUST_PROXY is off', 'Behind nginx, set TRUST_PROXY=1 so the audit log records real client IPs and cookies are marked Secure.');

  if (config.secureCookies) ok('cookies will be marked Secure');
  else warn('cookies are not marked Secure', 'Expected only if you are serving plain HTTP on a private network.');

  if (config.seed.password) {
    warn('NPF_PASSWORD is still set in the environment', 'It seeds a panel when none exist. Comment it out once your panels are configured in /admin.');
  }
}

/* ── .env permissions ────────────────────────────────────────────────── */

try {
  const mode = statSync('.env').mode & 0o777;
  if (mode & 0o077) fail(`.env is mode ${mode.toString(8)} — readable by other users`, 'chmod 600 .env');
  else ok('.env is not world-readable');
} catch {
  notes.push('.env not found in the working directory (fine if the environment is supplied another way)');
}

/* ── storage ─────────────────────────────────────────────────────────── */

let storage;
try {
  ({ storage } = await import('../src/storage.js'));
  ok(`storage backend: ${storage.name} (${storage.location})`);
  if (storage.name === 'file') {
    try {
      accessSync(storage.location, constants.W_OK);
      ok('data directory is writable');
    } catch {
      fail(`cannot write to ${storage.location}`, `chown -R npfgw:npfgw ${storage.location}`);
    }
  }
} catch (err) {
  fail(`storage will not initialise: ${err.message}`, 'See the deployment notes in README.md.');
}

/* ── accounts and panels ─────────────────────────────────────────────── */

if (storage) {
  try {
    const { listUsers } = await import('../src/users.js');
    const { listPanels } = await import('../src/panels.js');
    const users = await listUsers();
    const panels = await listPanels();

    const admins = users.filter((u) => u.role === 'admin' && u.active);
    if (users.length === 0) notes.push('no users yet — one administrator is created on first start');
    else if (admins.length === 0) fail('no active administrator', 'npm run useradd -- --promote you@example.com');
    else ok(`${users.length} user(s), ${admins.length} active admin(s)`);

    if (panels.length === 0) warn('no panels configured', 'Add them in /admin once the gateway is up.');
    else ok(`${panels.length} panel(s): ${panels.map((p) => p.label).join(', ')}`);
  } catch (err) {
    fail(`cannot read users or panels: ${err.message}`, 'Check the data directory and its permissions.');
  }
}

/* ── port ────────────────────────────────────────────────────────────── */

if (config) {
  const free = await new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(config.port, '0.0.0.0');
  });
  if (free) ok(`port ${config.port} is free`);
  else notes.push(`port ${config.port} is in use — expected if the gateway is already running`);
}

/* ── report ──────────────────────────────────────────────────────────── */

console.log('');
for (const note of notes) console.log(`  ok    ${note}`);
for (const { what, fix } of warnings) console.log(`  warn  ${what}\n          → ${fix}`);
for (const { what, fix } of problems) console.log(`  FAIL  ${what}\n          → ${fix}`);

console.log('');
if (problems.length) {
  console.log(`  ${problems.length} problem(s) to fix before this is ready.\n`);
  process.exit(1);
}
console.log(warnings.length ? `  Usable, with ${warnings.length} warning(s).\n` : '  All good.\n');
