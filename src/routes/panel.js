import express from 'express';
import { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';

import { config } from '../config.js';
import { findPanel } from '../panels.js';
import { findUserById, canUseePanel, verifyUser } from '../users.js';
import { getNpfConstants } from '../npf-config.js';
import { getToken, refreshToken } from '../npf-session.js';
import { decryptPayload } from '../npf-crypto.js';
import { checkPolicy } from '../policy.js';
import { checkVolume } from '../leak-guard.js';
import { protectionScript } from '../protection.js';
import { BROWSER_HEADERS } from '../upstream-headers.js';
import { audit } from '../audit.js';
import { requireUser } from './auth.js';

export const panelRouter = express.Router({ mergeParams: true });

// Rewritten bundles are cached per panel: the same upstream file becomes a
// different file once the panel's slug is baked into it.
const assetCache = new Map(); // `${panelId}:${path}` -> { body, contentType }
const indexCache = new Map(); // panelId -> { html, at }
const INDEX_TTL_MS = 5 * 60 * 1000;

function basePath(panel) {
  return `/p/${panel.slug}/`;
}

function npfJson(res, status, body) {
  // The panel app reads `status` from the body and largely ignores the HTTP
  // code, so mirror its convention.
  return res.status(status).type('application/json').send(JSON.stringify(body));
}

/* ── resolve the panel and check the person may open it ──────────────── */

// Whether this is the app calling for data, rather than someone opening a
// page. Content negotiation is not enough: a browser's XHR sends Accept: */*,
// and answering it with a redirect to an HTML login page makes the app parse
// markup as JSON. The path is the reliable signal.
function isApiCall(req) {
  return req.path === '/npf-api' || req.path.startsWith('/npf-api/');
}

function deny(req, res, status, message) {
  return isApiCall(req)
    ? npfJson(res, status, { status: 0, message })
    : res.status(status).send(message);
}

panelRouter.use((req, res, next) => {
  if (req.session) return next();
  if (isApiCall(req)) {
    return npfJson(res, 401, { status: 0, message: 'Your session has expired. Please sign in again.' });
  }
  return requireUser(req, res, next);
});

panelRouter.use(async (req, res, next) => {
  const panel = await findPanel(req.params.slug);
  if (!panel || !panel.active) return deny(req, res, 404, 'No such panel.');

  const user = await findUserById(req.session.userId);
  if (!user || !user.active || !canUseePanel(user, panel.id)) {
    audit({ event: 'panel-denied', user: req.session.email, panel: panel.slug, ip: req.ip });
    return deny(req, res, 403, 'You do not have access to this panel.');
  }

  req.panel = panel;
  req.gwUser = user;
  return next();
});

/* ── API proxy ───────────────────────────────────────────────────────── */

const api = express.Router({ mergeParams: true });
api.use(express.raw({ type: '*/*', limit: '50mb' }));

// Normally people never see the panel's own login form — the gateway seeds the
// session. This stays as a fallback for when the app logs itself out mid-visit.
api.post('/users/v3/login', async (req, res) => {
  let email;
  let password;
  try {
    const npf = await getNpfConstants(req.panel.origin);
    ({ email, password } = JSON.parse(decryptPayload(req.body.toString('utf8'), npf.requestEncryptionKey)));
  } catch {
    return npfJson(res, 200, { status: 0, message: 'Login could not be processed. Please try again.' });
  }

  const user = await verifyUser(email, password);
  if (!user || !canUseePanel(user, req.panel.id)) {
    audit({ event: 'login-failed', email: String(email ?? '').toLowerCase(), panel: req.panel.slug, ip: req.ip });
    return npfJson(res, 200, { status: 0, message: 'Invalid email or password.' });
  }

  try {
    await getToken(req.panel);
  } catch (err) {
    console.error(`[panel:${req.panel.slug}] upstream unavailable:`, err.message);
    return npfJson(res, 200, { status: 0, message: 'Panel is temporarily unavailable. Please try again shortly.' });
  }

  return npfJson(res, 200, {
    status: 1,
    message: 'Login successful',
    data: { accessToken: randomBytes(24).toString('hex'), userId: user.id, name: user.name, mobile: '', email: user.email },
  });
});

// Ends the gateway's view of things only. Forwarding this upstream would
// invalidate the shared token and sign out everyone else on this panel.
api.get('/users/v1/logout', (req, res) => {
  audit({ event: 'panel-logout', user: req.session.email, panel: req.panel.slug, ip: req.ip });
  return npfJson(res, 200, { status: 1, message: 'Logged out' });
});

// Answered locally: forwarding it reports the *shared* account's reset state
// and can push a reset screen onto an ordinary user.
api.all('/users/v1/checkPasswordReset', (req, res) =>
  npfJson(res, 200, {
    status: 1,
    message: 'ok',
    data: { isPasswordReset: false, passwordReset: false, reset: false, showPopup: false },
  }),
);

api.all(/.*/, async (req, res) => {
  const path = req.path.replace(/^\/+/, '');
  const verdict = checkPolicy(path, { canExport: req.gwUser.canExport });

  if (!verdict.allowed) {
    audit({ event: 'blocked', user: req.session.email, panel: req.panel.slug, path, reason: verdict.reason, ip: req.ip });
    return npfJson(res, 403, {
      status: 0,
      message:
        verdict.reason === 'export-blocked'
          ? 'Downloads are disabled for your account. Ask an administrator if you need an export.'
          : 'This action is not available through the panel gateway.',
    });
  }

  // Bulk retrieval cap. Unlike the in-page restrictions this cannot be worked
  // around from the browser, so it is what actually bounds a leak.
  const volume = await checkVolume(req.gwUser, req.panel.id, path);
  if (!volume.allowed) {
    audit({
      event: 'blocked', user: req.session.email, panel: req.panel.slug, path,
      reason: 'bulk-limit', used: volume.used, limit: volume.limit, ip: req.ip,
    });
    return npfJson(res, 429, {
      status: 0,
      message: `You have opened an unusually large number of lead pages in the last ${volume.windowMinutes} minutes. This has been logged. Try again later, or ask an administrator.`,
    });
  }

  try {
    const token = await getToken(req.panel);
    const upstream = await forward(req, token);
    audit({ event: 'request', user: req.session.email, panel: req.panel.slug, path, status: upstream.status, ip: req.ip });
    return await relay(upstream, req, res, token);
  } catch (err) {
    console.error(`[panel:${req.panel.slug}] ${path} failed:`, err.message);
    return npfJson(res, 502, { status: 0, message: 'Could not reach the panel. Please try again.' });
  }
});

async function forward(req, token) {
  const npf = await getNpfConstants(req.panel.origin);
  const target = new URL(npf.apiOrigin);
  target.pathname = req.path;
  target.search = new URL(req.originalUrl, 'http://x').search;

  const headers = {
    ...BROWSER_HEADERS,
    Origin: req.panel.origin,
    Referer: `${req.panel.origin}/`,
    'access-key': npf.accessKey,
    environment: npf.environment,
    'access-token': token,
    Accept: req.get('accept') || BROWSER_HEADERS.Accept,
  };
  const contentType = req.get('content-type');
  if (contentType) headers['Content-Type'] = contentType;

  const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && req.body?.length;

  return fetch(target, { method: req.method, headers, body: hasBody ? req.body : undefined, redirect: 'manual' });
}

async function relay(upstream, req, res, usedToken) {
  const contentType = upstream.headers.get('content-type') || '';

  // JSON is small enough to buffer, which lets us notice an expired shared
  // token and re-login quietly instead of bouncing the user to a login page.
  if (contentType.includes('application/json')) {
    const text = await upstream.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return res.status(upstream.status).type(contentType).send(text);
    }

    if (isUnauthorised(upstream.status, body)) {
      const fresh = await refreshToken(req.panel, usedToken);
      const retry = await forward(req, fresh);
      audit({ event: 'token-refreshed', user: req.session.email, panel: req.panel.slug, path: req.path });
      return res
        .status(retry.status)
        .type(retry.headers.get('content-type') || 'application/json')
        .send(await retry.text());
    }

    return res.status(upstream.status).type('application/json').send(JSON.stringify(body));
  }

  res.status(upstream.status);
  if (contentType) res.type(contentType);
  const disposition = upstream.headers.get('content-disposition');
  if (disposition) res.set('content-disposition', disposition);

  if (!upstream.body) return res.end();
  return Readable.fromWeb(upstream.body).pipe(res);
}

function isUnauthorised(httpStatus, body) {
  if (httpStatus === 401) return true;
  const message = String(body?.message ?? '').toLowerCase();
  return message.includes('unauthoris') || message.includes('unauthoriz') || message.includes('invalid token');
}

panelRouter.use('/npf-api', api);

/* ── the panel's own front end ───────────────────────────────────────── */

panelRouter.use(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return res.sendStatus(405);

  // Relative asset paths only resolve correctly from a trailing slash.
  if (req.path === '/' && !req.originalUrl.split('?')[0].endsWith('/')) {
    return res.redirect(301, `${req.baseUrl}/`);
  }

  const isAsset = /\.[a-z0-9]{2,5}$/i.test(req.path);

  try {
    if (!isAsset) return await serveIndex(req, res);
    return await serveAsset(req, res);
  } catch (err) {
    console.error(`[panel:${req.panel.slug}] ${req.path} failed:`, err.message);
    return res.sendStatus(502);
  }
});

async function serveAsset(req, res) {
  const key = `${req.panel.id}:${req.path}`;
  const hit = assetCache.get(key);
  if (hit) return res.type(hit.contentType).send(hit.body);

  const upstream = await fetch(`${req.panel.origin}${req.path}`, { headers: BROWSER_HEADERS });
  if (!upstream.ok) return res.sendStatus(upstream.status);

  const contentType = upstream.headers.get('content-type') || 'application/octet-stream';

  if (contentType.includes('javascript')) {
    const body = await rewriteJs(await upstream.text(), req.panel);
    assetCache.set(key, { body, contentType });
    return res.type(contentType).send(body);
  }

  const body = Buffer.from(await upstream.arrayBuffer());
  assetCache.set(key, { body, contentType });
  return res.type(contentType).send(body);
}

// Three substitutions turn the vendor's single-tenant app into one that can be
// mounted under a path, more than once, on our origin:
//   apiBaseUrl  -> this panel's proxy, so data calls come back to us
//   cookiePath  -> this panel's prefix, so two panels in two tabs don't collide
//   base href   -> this panel's prefix, so relative assets and routing resolve
async function rewriteJs(js, panel) {
  const npf = await getNpfConstants(panel.origin);
  return js
    .split(`${npf.apiOrigin}/`)
    .join(`${basePath(panel)}npf-api/`)
    .split('cookiePath:"/"')
    .join(`cookiePath:"${basePath(panel)}"`);
}

function jsString(value) {
  // < keeps a stray "</script>" in a name from ending the tag early.
  return JSON.stringify(String(value ?? '')).replace(/</g, '\\u003c');
}

// Seeds what the app expects to find after its own login, so the person lands
// on the dashboard instead of a login form they have no password for.
function bootstrapScript(user) {
  return `<script>try{
localStorage.setItem('userId',${jsString(user.id)});
localStorage.setItem('userName',${jsString(user.name)});
localStorage.setItem('userEmail',${jsString(user.email)});
localStorage.setItem('userMobile','');
}catch(e){}</script>`;
}

async function serveIndex(req, res) {
  const panel = req.panel;
  const cached = indexCache.get(panel.id);
  let html;

  if (cached && Date.now() - cached.at < INDEX_TTL_MS) {
    html = cached.html;
  } else {
    const upstream = await fetch(`${panel.origin}/`, { headers: BROWSER_HEADERS });
    if (!upstream.ok) throw new Error(`index.html -> HTTP ${upstream.status}`);
    html = await rewriteJs(await upstream.text(), panel);
    html = html.replace(/<base href="[^"]*">/i, `<base href="${basePath(panel)}">`);
    indexCache.set(panel.id, { html, at: Date.now() });
  }

  // The app only checks that this cookie exists; the gateway authenticates on
  // its own HttpOnly cookie, so this value carries no authority.
  res.cookie('access_token', randomBytes(24).toString('hex'), {
    httpOnly: false,
    sameSite: 'lax',
    secure: config.secureCookies,
    path: basePath(panel),
  });

  const isPlainUser = req.gwUser.role !== 'admin';
  const guard = protectionScript({
    user: req.gwUser,
    panel,
    brand: config.brand,
    opacity: config.watermarkOpacity,
    // Attribution costs nothing, so it defaults to everyone. An admin needs a
    // clean view to debug the panel, hence the 'users' mode.
    watermark: config.watermarkMode === 'all' || (config.watermarkMode === 'users' && isPlainUser),
    friction: config.frictionForUsers && isPlainUser,
  });

  const withInjections = html
    .replace(/<\/head>/i, `${bootstrapScript(req.gwUser)}</head>`)
    .replace(/<\/body>/i, `${guard}</body>`);

  return res.type('html').send(withInjections);
}

export function clearPanelCaches(panelId) {
  indexCache.delete(panelId);
  for (const key of assetCache.keys()) {
    if (key.startsWith(`${panelId}:`)) assetCache.delete(key);
  }
}
