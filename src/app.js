import express from 'express';
import cookieParser from 'cookie-parser';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { config } from './config.js';
import { withSession, requireUser, requireAdmin, authRouter } from './routes/auth.js';
import { adminRouter, generatePassword } from './routes/admin.js';
import { panelRouter } from './routes/panel.js';
import { listUsers, addUser } from './users.js';
import { listPanels, addPanel } from './panels.js';
import { sessionState } from './npf-session.js';
import { storage } from './storage.js';
import * as sessions from './sessions.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const VIEWS = join(ROOT, 'views');

export const app = express();
app.disable('x-powered-by');
if (config.trustProxy) app.set('trust proxy', 1);
app.use(cookieParser());

app.use((req, res, next) => {
  // The gateway's own pages should never be framed by anyone else.
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'same-origin');
  next();
});

/* ── first-run setup ─────────────────────────────────────────────────── */
// Runs once per process, before the first request is answered. On a long-lived
// server that is effectively boot time; on serverless there is no boot, so it
// has to hang off the request path.

let bootstrapTask = null;

async function bootstrap() {
  if (await listPanels().then((p) => p.length === 0) && config.seed.email && config.seed.password) {
    const panel = await addPanel({
      label: config.seed.label,
      url: config.seed.url,
      username: config.seed.email,
      password: config.seed.password,
    });
    console.log(`[gateway] seeded panel "${panel.label}" from the environment`);
  }

  if ((await listUsers()).length === 0) {
    const email = process.env.ADMIN_EMAIL || config.seed.email || 'admin@example.com';
    // A hosted deployment should set ADMIN_PASSWORD: digging a generated one
    // out of function logs is a poor first experience.
    const password = process.env.ADMIN_PASSWORD || generatePassword();

    try {
      await addUser({ email, name: 'Administrator', role: 'admin', password });
    } catch (err) {
      // Without an administrator nobody can ever sign in, so this has to be a
      // stop — but with an instruction rather than a stack trace.
      throw new Error(
        `Could not create the first administrator (${err.message}). ` +
        `Check ADMIN_EMAIL (currently "${email}") and ADMIN_PASSWORD.`,
      );
    }

    console.log('');
    console.log('  ┌─ first run: an administrator account was created ─────────┐');
    console.log(`     email:    ${email}`);
    if (!process.env.ADMIN_PASSWORD) console.log(`     password: ${password}`);
    else console.log('     password: (the ADMIN_PASSWORD you set)');
    console.log('     Sign in at /login and change it.');
    console.log('  └───────────────────────────────────────────────────────────┘');
    console.log('');
  }
}

export function ensureBootstrapped() {
  if (!bootstrapTask) {
    bootstrapTask = bootstrap().catch((err) => {
      // Let the next request try again rather than wedging the process.
      bootstrapTask = null;
      throw err;
    });
  }
  return bootstrapTask;
}

app.use(async (req, res, next) => {
  try {
    await ensureBootstrapped();
    next();
  } catch (err) {
    console.error('[gateway] setup failed:', err.message);
    res.status(503).send('The gateway could not reach its storage. Try again shortly.');
  }
});

app.use(withSession);

/* ── pages ───────────────────────────────────────────────────────────── */

const page = (name) => (req, res) => res.sendFile(join(VIEWS, name));

app.get('/', (req, res) => res.redirect(req.session ? '/panels' : '/login'));
app.get('/login', (req, res) => (req.session ? res.redirect('/panels') : res.sendFile(join(VIEWS, 'login.html'))));
app.get('/panels', requireUser, page('panels.html'));
app.get('/account', requireUser, page('account.html'));
app.get('/admin', requireAdmin, page('admin.html'));

app.use('/gw-assets', express.static(join(VIEWS, 'assets'), { maxAge: '1h', fallthrough: false }));

/* ── apis ────────────────────────────────────────────────────────────── */

app.use('/gw/auth', authRouter);
app.use('/gw/admin', adminRouter);

app.get('/gw/health', async (req, res) => {
  try {
    const [users, panels, live] = await Promise.all([listUsers(), listPanels(), sessions.list()]);
    res.json({
      ok: true,
      storage: storage.name,
      users: users.length,
      sessions: live.length,
      panels: panels.map((p) => ({ slug: p.slug, label: p.label, active: p.active, upstream: sessionState(p.id) })),
    });
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message });
  }
});

/* ── the panels themselves ───────────────────────────────────────────── */

app.use('/p/:slug', panelRouter);

app.use((req, res) => res.status(404).send('Not found.'));

app.use((err, req, res, next) => {
  console.error('[gateway] unhandled:', err);
  if (res.headersSent) return next(err);
  return res.status(500).json({ error: 'Something went wrong.' });
});
