import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { storage } from './storage.js';

export const COOKIE = 'gw_session';

function sign(id) {
  return createHmac('sha256', config.sessionSecret).update(id).digest('hex').slice(0, 32);
}

export async function create(user, context = {}) {
  const id = randomBytes(24).toString('hex');
  await storage.setSession(
    id,
    {
      userId: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      canExport: user.canExport,
      ip: context.ip ?? null,
      userAgent: String(context.userAgent ?? '').slice(0, 200),
      // Carried on the session so the admin list can answer "who is signed in,
      // from where, on what" without re-reading the sign-in log for each row.
      device: context.device ?? null,
      place: context.place ?? null,
      location: context.location ?? null,
      flags: context.flags ?? [],
      createdAt: Date.now(),
    },
    config.sessionTtlMs,
  );
  return `${id}.${sign(id)}`;
}

export async function read(raw) {
  if (typeof raw !== 'string' || !raw.includes('.')) return null;
  const [id, mac] = raw.split('.', 2);

  // Check the signature before touching storage: an unsigned id is not worth
  // a round trip, and comparing in constant time avoids leaking the secret.
  const expected = Buffer.from(sign(id));
  const given = Buffer.from(mac ?? '');
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;

  const data = await storage.getSession(id);
  return data ? { id, ...data } : null;
}

export async function destroy(raw) {
  if (typeof raw !== 'string') return;
  await storage.deleteSession(raw.split('.', 1)[0]);
}

export async function destroyById(id) {
  await storage.deleteSession(id);
}

// Called when an account is disabled, deleted, or has its password reset —
// whoever is signed in as them should stop being signed in immediately.
export async function revokeUser(userId) {
  await storage.deleteSessionsForUser(userId);
}

export async function list() {
  return storage.listSessions();
}
