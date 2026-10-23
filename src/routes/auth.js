import express from 'express';
import { config } from '../config.js';
import { verifyUser, findUserById, canUseePanel, publicUser, recordLogin, changeOwnPassword } from '../users.js';
import { listPanels } from '../panels.js';
import { sessionState } from '../npf-session.js';
import * as sessions from '../sessions.js';
import { audit } from '../audit.js';
import { checkLoginAllowed, clearLoginAttempts } from '../rate-limit.js';

export const COOKIE = sessions.COOKIE;

export function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.secureCookies,
    path: '/',
    maxAge: config.sessionTtlMs,
  };
}

export async function withSession(req, res, next) {
  try {
    req.session = await sessions.read(req.cookies?.[COOKIE]);
  } catch (err) {
    console.error('[auth] session lookup failed:', err.message);
    req.session = null;
  }
  next();
}

function wantsHtml(req) {
  // Content negotiation cannot tell these apart: a browser's fetch() sends
  // Accept: */*, exactly like a plain navigation. Answering an XHR with a
  // redirect to an HTML page makes the caller parse markup as JSON. The path
  // is the reliable signal — everything under /gw/ is an API.
  return !req.originalUrl.startsWith('/gw/');
}

export function requireUser(req, res, next) {
  if (req.session) return next();
  return wantsHtml(req)
    ? res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`)
    : res.status(401).json({ error: 'not signed in' });
}

export function requireAdmin(req, res, next) {
  if (!req.session) return requireUser(req, res, next);
  if (req.session.role !== 'admin') {
    return wantsHtml(req)
      ? res.status(403).send('Administrators only.')
      : res.status(403).json({ error: 'administrators only' });
  }
  return next();
}

// Panel access is read fresh from the user record rather than the session, so
// an admin's change takes effect without the person signing out and in.
export async function visiblePanels(session) {
  const user = await findUserById(session.userId);
  if (!user || !user.active) return [];
  const panels = await listPanels();
  return panels
    .filter((panel) => panel.active && canUseePanel(user, panel.id))
    .map(({ id, slug, label, origin }) => ({ id, slug, label, origin, upstream: sessionState(id) }));
}

export const authRouter = express.Router();
authRouter.use(express.json({ limit: '100kb' }));

authRouter.post('/login', async (req, res) => {
  const { email, password } = req.body ?? {};

  const gate = await checkLoginAllowed(req.ip, email);
  if (!gate.allowed) {
    audit({ event: 'login-throttled', email: String(email ?? '').toLowerCase(), ip: req.ip });
    return res.status(429).json({
      error: `Too many attempts. Try again in about ${gate.retryAfterMinutes} minutes.`,
    });
  }

  const user = await verifyUser(email, password);
  if (!user) {
    audit({ event: 'login-failed', email: String(email ?? '').toLowerCase(), ip: req.ip });
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  const token = await sessions.create(user, { ip: req.ip, userAgent: req.get('user-agent') });
  res.cookie(COOKIE, token, cookieOptions());
  await clearLoginAttempts(email);
  await recordLogin(user.id, req.ip);
  audit({ event: 'login', user: user.email, role: user.role, ip: req.ip });

  return res.json({ ok: true, user: publicUser(user) });
});

authRouter.post('/logout', async (req, res) => {
  if (req.session) audit({ event: 'logout', user: req.session.email, ip: req.ip });
  await sessions.destroy(req.cookies?.[COOKIE]);
  res.clearCookie(COOKIE, { path: '/' });
  return res.json({ ok: true });
});

authRouter.get('/me', requireUser, async (req, res) => {
  res.json({
    user: {
      name: req.session.name,
      email: req.session.email,
      role: req.session.role,
      canExport: req.session.canExport,
    },
    panels: await visiblePanels(req.session),
  });
});

authRouter.post('/password', requireUser, async (req, res) => {
  const { currentPassword, newPassword } = req.body ?? {};
  try {
    await changeOwnPassword(req.session.userId, currentPassword, newPassword);
    // Every other session for this person ends; the one making the change
    // continues, so they are not thrown out of the page they are standing on.
    const current = req.cookies?.[COOKIE];
    await sessions.revokeUser(req.session.userId);
    const user = await findUserById(req.session.userId);
    res.cookie(COOKIE, await sessions.create(user, { ip: req.ip, userAgent: req.get('user-agent') }), cookieOptions());
    audit({ event: 'password-changed', user: req.session.email, ip: req.ip });
    return res.json({ ok: true, replaced: Boolean(current) });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});
