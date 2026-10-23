import express from 'express';
import { randomBytes } from 'node:crypto';
import {
  listUsers, addUser, updateUser, deleteUser, findUserById, publicUser, ALL_PANELS, MIN_PASSWORD,
} from '../users.js';
import { listPanels, addPanel, updatePanel, deletePanel, findPanel } from '../panels.js';
import { login, sessionState, forgetPanel } from '../npf-session.js';
import { forgetConstants } from '../npf-config.js';
import { clearPanelCaches } from './panel.js';
import { storage } from '../storage.js';
import * as sessions from '../sessions.js';
import { audit, recentAudit } from '../audit.js';
import { requireAdmin } from './auth.js';

export const adminRouter = express.Router();
adminRouter.use(requireAdmin, express.json({ limit: '100kb' }));

// No l/I/1 or O/0, and no punctuation: these get read off a screen, dictated
// over a call, and typed by hand.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

export function generatePassword(length = 14) {
  // Rejection sampling keeps every character equally likely despite the
  // alphabet not dividing evenly into 256.
  const limit = 256 - (256 % ALPHABET.length);
  let out = '';
  while (out.length < length) {
    for (const byte of randomBytes(length)) {
      if (byte >= limit) continue;
      out += ALPHABET[byte % ALPHABET.length];
      if (out.length === length) break;
    }
  }
  return out;
}

const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

/* ── overview ────────────────────────────────────────────────────────── */

adminRouter.get('/overview', handle(async (req, res) => {
  const [users, panels, live, entries] = await Promise.all([
    listUsers(), listPanels(), sessions.list(), recentAudit(500),
  ]);
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const since = (event) => entries.filter((e) => e.event === event && new Date(e.at).getTime() > dayAgo).length;

  res.json({
    users: { total: users.length, active: users.filter((u) => u.active).length, admins: users.filter((u) => u.role === 'admin').length },
    panels: {
      total: panels.length,
      active: panels.filter((p) => p.active).length,
      connected: panels.filter((p) => sessionState(p.id).connected).length,
    },
    sessions: live.length,
    today: {
      logins: since('login'),
      requests: since('request'),
      blocked: since('blocked'),
      failedLogins: since('login-failed') + since('login-throttled'),
    },
    storage: { backend: storage.name, location: storage.location },
  });
}));

/* ── users ───────────────────────────────────────────────────────────── */

adminRouter.get('/users', handle(async (req, res) => {
  res.json({ users: (await listUsers()).map(publicUser), allPanels: ALL_PANELS, minPassword: MIN_PASSWORD });
}));

adminRouter.post('/users', handle(async (req, res) => {
  const { email, name, role, canExport, panels } = req.body ?? {};
  const password = req.body?.password?.trim() || generatePassword();
  const user = await addUser({ email, name, role, canExport, panels: panels ?? ALL_PANELS, password });
  audit({ event: 'admin-user-added', by: req.session.email, user: user.email, role: user.role });
  // The only moment the password is visible — it is a bcrypt hash after this.
  res.json({ user: publicUser(user), password });
}));

adminRouter.patch('/users/:id', handle(async (req, res) => {
  const patch = { ...req.body };
  let generated = null;

  if (patch.resetPassword) {
    generated = patch.password?.trim() || generatePassword();
    patch.password = generated;
  }
  delete patch.resetPassword;

  if (req.params.id === req.session.userId && patch.role && patch.role !== 'admin') {
    throw new Error('you cannot remove your own admin role');
  }

  const user = await updateUser(req.params.id, patch);
  // A disabled account, a changed password or revoked panel access should take
  // hold now, not whenever the person next signs in.
  if (patch.password || patch.active === false || patch.panels !== undefined || patch.role) {
    await sessions.revokeUser(user.id);
  }
  audit({ event: 'admin-user-updated', by: req.session.email, user: user.email, fields: Object.keys(req.body ?? {}) });
  res.json({ user: publicUser(user), password: generated });
}));

adminRouter.delete('/users/:id', handle(async (req, res) => {
  if (req.params.id === req.session.userId) throw new Error('you cannot delete your own account');
  const target = await findUserById(req.params.id);
  await deleteUser(req.params.id);
  await sessions.revokeUser(req.params.id);
  audit({ event: 'admin-user-deleted', by: req.session.email, user: target?.email });
  res.json({ ok: true });
}));

/* ── panels ──────────────────────────────────────────────────────────── */

adminRouter.get('/panels', handle(async (req, res) => {
  const panels = await listPanels();
  res.json({ panels: panels.map((panel) => ({ ...panel, upstream: sessionState(panel.id) })) });
}));

adminRouter.post('/panels', handle(async (req, res) => {
  const panel = await addPanel(req.body ?? {});
  audit({ event: 'admin-panel-added', by: req.session.email, panel: panel.slug, origin: panel.origin });
  const { passwordSealed, ...safe } = panel;
  res.json({ panel: safe });
}));

adminRouter.patch('/panels/:id', handle(async (req, res) => {
  const panel = await updatePanel(req.params.id, req.body ?? {});
  // Credentials or address changed: drop the cached token and the rewritten
  // bundles so the next request rebuilds everything from the new settings.
  forgetPanel(panel.id);
  forgetConstants(panel.origin);
  clearPanelCaches(panel.id);
  audit({ event: 'admin-panel-updated', by: req.session.email, panel: panel.slug, fields: Object.keys(req.body ?? {}) });
  const { passwordSealed, ...safe } = panel;
  res.json({ panel: safe });
}));

adminRouter.delete('/panels/:id', handle(async (req, res) => {
  const panel = await findPanel(req.params.id);
  await deletePanel(req.params.id);
  if (panel) {
    forgetPanel(panel.id);
    clearPanelCaches(panel.id);
  }
  audit({ event: 'admin-panel-deleted', by: req.session.email, panel: panel?.slug });
  res.json({ ok: true });
}));

// Signs in to the panel right now and reports what came back, so an admin can
// tell a wrong password from an unreachable panel without reading logs.
adminRouter.post('/panels/:id/test', handle(async (req, res) => {
  const panel = await findPanel(req.params.id);
  if (!panel) throw new Error('no such panel');

  forgetPanel(panel.id);
  try {
    await login(panel);
    audit({ event: 'admin-panel-test', by: req.session.email, panel: panel.slug, result: 'ok' });
    res.json({ ok: true, message: `Connected to ${panel.label}.` });
  } catch (err) {
    audit({ event: 'admin-panel-test', by: req.session.email, panel: panel.slug, result: 'failed', detail: err.message });
    res.json({ ok: false, message: err.message, detail: err.detail ?? null });
  }
}));

/* ── live sessions ───────────────────────────────────────────────────── */

adminRouter.get('/sessions', handle(async (req, res) => {
  const live = await sessions.list();
  res.json({
    sessions: live
      .map(({ id, email, name, role, ip, userAgent, createdAt }) => ({
        id, email, name, role, ip, userAgent, createdAt,
        current: id === req.session.id,
      }))
      .sort((a, b) => b.createdAt - a.createdAt),
  });
}));

adminRouter.delete('/sessions/:id', handle(async (req, res) => {
  await sessions.destroyById(req.params.id);
  audit({ event: 'admin-session-revoked', by: req.session.email, session: req.params.id });
  res.json({ ok: true });
}));

/* ── activity ────────────────────────────────────────────────────────── */

adminRouter.get('/audit', handle(async (req, res) => {
  const entries = await recentAudit(Number(req.query.limit) || 500);
  res.json({ entries });
}));

adminRouter.get('/audit.csv', handle(async (req, res) => {
  const entries = await recentAudit(Number(req.query.limit) || 5000);
  const columns = ['at', 'event', 'user', 'by', 'email', 'panel', 'path', 'status', 'reason', 'ip'];
  const escape = (value) => {
    const text = value === undefined || value === null ? '' : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const rows = entries.map((entry) => columns.map((c) => escape(entry[c])).join(','));
  res.type('text/csv')
    .set('content-disposition', `attachment; filename=gateway-activity-${new Date().toISOString().slice(0, 10)}.csv`)
    .send([columns.join(','), ...rows].join('\n'));
}));
