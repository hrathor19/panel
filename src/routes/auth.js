import express from 'express';
import { config } from '../config.js';
import { verifyUser, findUserById, canUseePanel, publicUser, recordLogin as markLastLogin, changeOwnPassword } from '../users.js';
import { listPanels } from '../panels.js';
import { sessionState } from '../npf-session.js';
import * as sessions from '../sessions.js';
import { audit } from '../audit.js';
import { checkLoginAllowed, clearLoginAttempts } from '../rate-limit.js';
import { describeDevice, deviceFingerprint } from '../device.js';
import { lookupIp, describePlace, reverseGeocode } from '../geo.js';
import { recordLogin, historyFor, assessRisk } from '../login-history.js';

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

// Everything known about a sign-in attempt. The device and client fields come
// from the browser and can say anything; the IP and what it resolves to are
// observed here and cannot. Both are kept so they can be compared.
async function gatherContext(req, location) {
  const userAgent = req.get('user-agent') ?? '';
  const client = req.body?.client ?? {};
  const device = {
    ...describeDevice(userAgent),
    fingerprint: deviceFingerprint(userAgent, client),
    screen: typeof client.screen === 'string' ? client.screen.slice(0, 24) : null,
    timezone: typeof client.timezone === 'string' ? client.timezone.slice(0, 64) : null,
    language: (req.get('accept-language') ?? '').split(',')[0].slice(0, 16) || null,
  };

  const position = cleanLocation(location);
  // Both lookups are best-effort and run together; neither may delay a sign-in.
  const [ipPlace, address] = await Promise.all([
    lookupIp(req.ip),
    position.status === 'granted' ? reverseGeocode(position.latitude, position.longitude) : null,
  ]);
  if (address) position.place = address;

  return { ip: req.ip, device, ipPlace, location: position };
}

// Only the fields we expect, coerced — this came from a browser.
function cleanLocation(location) {
  if (!location || typeof location !== 'object') return { status: 'missing' };
  if (location.status && location.status !== 'granted') {
    return { status: String(location.status).slice(0, 32), message: String(location.message ?? '').slice(0, 160) };
  }
  const lat = Number(location.latitude);
  const lon = Number(location.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return { status: 'invalid' };
  }
  return {
    status: 'granted',
    latitude: Math.round(lat * 1e5) / 1e5,
    longitude: Math.round(lon * 1e5) / 1e5,
    accuracyM: Number.isFinite(Number(location.accuracy)) ? Math.round(Number(location.accuracy)) : null,
    reportedAt: location.timestamp ? new Date(Number(location.timestamp)).toISOString() : null,
  };
}

// Told to the login page before it asks for anything, so a permission prompt
// only appears where it is actually needed.
authRouter.get('/requirements', (req, res) => {
  res.json({ mode: config.locationMode, location: config.locationMode === 'require' });
});

authRouter.post('/login', async (req, res) => {
  const { email, password, location } = req.body ?? {};
  const typedEmail = String(email ?? '').trim().toLowerCase();

  const gate = await checkLoginAllowed(req.ip, email);
  if (!gate.allowed) {
    audit({ event: 'login-throttled', email: typedEmail, ip: req.ip });
    await recordLogin({ email: typedEmail, outcome: 'throttled', ip: req.ip });
    return res.status(429).json({
      error: `Too many attempts. Try again in about ${gate.retryAfterMinutes} minutes.`,
    });
  }

  // Credentials first: someone who cannot sign in anyway should not be told
  // what else the gateway wants, and a failed guess should not cost a lookup.
  const user = await verifyUser(email, password);
  if (!user) {
    audit({ event: 'login-failed', email: typedEmail, ip: req.ip });
    await recordLogin({
      email: typedEmail, outcome: 'bad-credentials', ip: req.ip,
      device: describeDevice(req.get('user-agent')),
    });
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  const context = await gatherContext(req, location);
  const prior = await historyFor(user.id, 300);

  if (config.locationMode === 'require' && context.location.status !== 'granted') {
    const refused = context.location.status === 'denied';
    audit({ event: 'login-location-blocked', user: user.email, status: context.location.status, ip: req.ip });
    await recordLogin({
      ...context, userId: user.id, email: user.email, outcome: 'location-blocked',
      flags: assessRisk({ ...context, at: new Date().toISOString(), outcome: 'location-blocked' }, prior),
    });
    return res.status(403).json({
      error: refused
        ? 'Location access was denied. This panel can only be opened with location sharing turned on — allow it in your browser and try again.'
        : 'Your location could not be read. Allow location access for this site and try again.',
      reason: 'location-required',
    });
  }

  const entry = { ...context, at: new Date().toISOString(), userId: user.id, email: user.email, outcome: 'success' };
  entry.flags = assessRisk(entry, prior);

  const token = await sessions.create(user, {
    ip: req.ip,
    userAgent: req.get('user-agent'),
    device: context.device,
    place: describePlace(context.ipPlace),
    location: context.location,
    flags: entry.flags,
  });
  res.cookie(COOKIE, token, cookieOptions());

  await clearLoginAttempts(email);
  await markLastLogin(user.id, req.ip);
  await recordLogin(entry);
  audit({
    event: 'login', user: user.email, role: user.role, ip: req.ip,
    device: context.device.label, place: describePlace(context.ipPlace),
    flags: entry.flags.length ? entry.flags : undefined,
  });

  return res.json({ ok: true, user: publicUser(user), flags: entry.flags });
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
