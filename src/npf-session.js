import { getNpfConstants } from './npf-config.js';
import { encryptPayload } from './npf-crypto.js';
import { BROWSER_HEADERS } from './upstream-headers.js';
import { panelPassword } from './panels.js';
import { storage } from './storage.js';

// One upstream session per panel, shared by everybody with access to it. The
// token is held in storage so that every process — including a fleet of
// serverless instances — reuses a single sign-in instead of each logging in
// separately and tripping the panel's rate limits.
//
// It never reaches a browser.

const TOKEN_TTL_MS = 50 * 60 * 1000;

const local = new Map(); // panel.id -> { token, issuedAt }  (saves a round trip)
const inflight = new Map(); // panel.id -> Promise

export class NpfLoginError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'NpfLoginError';
    this.detail = detail;
  }
}

const cacheKey = (panel) => `npf-token:${panel.id}`;

async function performLogin(panel) {
  const npf = await getNpfConstants(panel.origin);

  const body = encryptPayload(
    JSON.stringify({
      email: panel.username,
      password: panelPassword(panel),
      mode: npf.mode,
      appType: npf.appType,
    }),
    npf.requestEncryptionKey,
  );

  const res = await fetch(`${npf.apiOrigin}/users/v3/login`, {
    method: 'POST',
    headers: {
      ...BROWSER_HEADERS,
      Origin: panel.origin,
      Referer: `${panel.origin}/`,
      'access-key': npf.accessKey,
      environment: npf.environment,
      'Content-Type': 'text/plain',
    },
    body,
  });

  const raw = await res.text();
  const detail = { httpStatus: res.status, contentType: res.headers.get('content-type'), body: raw.slice(0, 600) };

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new NpfLoginError(`${panel.label}: panel returned non-JSON (HTTP ${res.status})`, detail);
  }

  if (payload?.status !== 1 || !payload?.data?.accessToken) {
    throw new NpfLoginError(`${panel.label}: ${payload?.message ?? `HTTP ${res.status}`}`, detail);
  }

  const token = payload.data.accessToken;
  local.set(panel.id, { token, issuedAt: Date.now() });
  await storage.setCache(cacheKey(panel), { token, issuedAt: Date.now() }, TOKEN_TTL_MS);
  console.log(`[npf-session] ${panel.label}: logged in`);
  return token;
}

// Collapses concurrent callers onto a single login per panel, so ten people
// opening NPF5 at once produce one upstream login rather than ten.
export function login(panel) {
  if (inflight.has(panel.id)) return inflight.get(panel.id);
  const task = performLogin(panel).finally(() => inflight.delete(panel.id));
  inflight.set(panel.id, task);
  return task;
}

export async function getToken(panel) {
  const hit = local.get(panel.id);
  if (hit && Date.now() - hit.issuedAt < TOKEN_TTL_MS) return hit.token;

  const shared = await storage.getCache(cacheKey(panel));
  if (shared?.token) {
    local.set(panel.id, shared);
    return shared.token;
  }

  return login(panel);
}

export async function refreshToken(panel, staleToken) {
  const hit = local.get(panel.id);
  if (hit && hit.token !== staleToken) return hit.token; // someone already refreshed

  local.delete(panel.id);
  const shared = await storage.getCache(cacheKey(panel));
  if (shared?.token && shared.token !== staleToken) {
    local.set(panel.id, shared);
    return shared.token;
  }

  await storage.deleteCache(cacheKey(panel));
  return login(panel);
}

// Synchronous, for list views: reports what this process knows without a
// round trip. "Not connected" here only means this instance has not used it.
export function sessionState(panelId) {
  const hit = local.get(panelId);
  return hit ? { connected: true, since: new Date(hit.issuedAt).toISOString() } : { connected: false };
}

export function forgetPanel(panelId) {
  local.delete(panelId);
  Promise.resolve(storage.deleteCache(`npf-token:${panelId}`)).catch(() => {});
}
