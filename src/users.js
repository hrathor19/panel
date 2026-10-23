import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { getDoc, putDoc } from './storage.js';

const DOC = 'users';
export const ALL_PANELS = '*';
export const MIN_PASSWORD = 10;

// Users predate panels and roles were viewer/admin. Bring old records forward
// on read so an existing install keeps working without manual editing.
function migrate(user) {
  const base = { canExport: false, panels: ALL_PANELS, lastLoginAt: null, lastLoginIp: null, ...user };
  if (user.role === 'viewer') return { ...base, role: 'user', canExport: false };
  if (user.role === 'admin') return { ...base, canExport: true };
  return base;
}

export async function listUsers() {
  return (await getDoc(DOC, [])).map(migrate);
}

async function persist(users) {
  await putDoc(DOC, users);
}

export async function findUser(email) {
  const wanted = String(email ?? '').trim().toLowerCase();
  return (await listUsers()).find((u) => u.email === wanted) ?? null;
}

export async function findUserById(id) {
  return (await listUsers()).find((u) => u.id === id) ?? null;
}

export function validatePassword(password) {
  if (!password || password.length < MIN_PASSWORD) {
    throw new Error(`password must be at least ${MIN_PASSWORD} characters`);
  }
  return password;
}

export async function addUser({ email, password, name, role = 'user', canExport = false, panels = ALL_PANELS }) {
  const users = await listUsers();
  const normalised = String(email ?? '').trim().toLowerCase();

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalised)) throw new Error('a valid email address is required');
  if (users.some((u) => u.email === normalised)) throw new Error(`${normalised} already exists`);
  if (!['admin', 'user'].includes(role)) throw new Error('role must be admin or user');
  validatePassword(password);

  const user = {
    id: randomUUID(),
    email: normalised,
    name: name?.trim() || normalised.split('@')[0],
    role,
    canExport: role === 'admin' ? true : Boolean(canExport),
    panels,
    passwordHash: bcrypt.hashSync(password, 12),
    active: true,
    lastLoginAt: null,
    lastLoginIp: null,
    createdAt: new Date().toISOString(),
  };
  users.push(user);
  await persist(users);
  return user;
}

export async function updateUser(id, patch) {
  const users = await listUsers();
  const user = users.find((u) => u.id === id);
  if (!user) throw new Error('no such user');

  if (patch.name !== undefined) user.name = String(patch.name).trim() || user.name;
  if (patch.role !== undefined) {
    if (!['admin', 'user'].includes(patch.role)) throw new Error('role must be admin or user');
    if (user.role === 'admin' && patch.role !== 'admin') await assertNotLastAdmin(users, user.id);
    user.role = patch.role;
  }
  if (patch.canExport !== undefined) user.canExport = Boolean(patch.canExport);
  if (patch.active !== undefined) {
    if (user.active && patch.active === false) await assertNotLastAdmin(users, user.id);
    user.active = Boolean(patch.active);
  }
  if (patch.panels !== undefined) user.panels = patch.panels;
  if (patch.password) {
    validatePassword(patch.password);
    user.passwordHash = bcrypt.hashSync(patch.password, 12);
  }
  // An admin can always export; keeping the flag true avoids a confusing UI
  // where the box is unticked but exports still work.
  if (user.role === 'admin') user.canExport = true;

  await persist(users);
  return user;
}

// Locking everyone out of the admin UI is unrecoverable without shell access,
// so the last way in is protected at the model layer, not just in the UI.
async function assertNotLastAdmin(users, exceptId) {
  const remaining = users.filter((u) => u.role === 'admin' && u.active && u.id !== exceptId);
  if (remaining.length === 0) throw new Error('that is the last active admin — promote someone else first');
}

export async function deleteUser(id) {
  const users = await listUsers();
  const user = users.find((u) => u.id === id);
  if (!user) throw new Error('no such user');
  if (user.role === 'admin' && user.active) await assertNotLastAdmin(users, id);
  await persist(users.filter((u) => u.id !== id));
}

export async function verifyUser(email, password) {
  const user = await findUser(email);
  // Spend the hashing time either way, so a missing account is not detectably
  // faster than a wrong password.
  const hash = user?.passwordHash ?? '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidei';
  const ok = bcrypt.compareSync(String(password ?? ''), hash);
  return ok && user?.active ? user : null;
}

export async function changeOwnPassword(id, currentPassword, newPassword) {
  const user = await findUserById(id);
  if (!user) throw new Error('no such user');
  if (!bcrypt.compareSync(String(currentPassword ?? ''), user.passwordHash)) {
    throw new Error('your current password is not correct');
  }
  validatePassword(newPassword);
  if (bcrypt.compareSync(newPassword, user.passwordHash)) {
    throw new Error('the new password must be different from the old one');
  }
  return updateUser(id, { password: newPassword });
}

export async function recordLogin(id, ip) {
  const users = await listUsers();
  const user = users.find((u) => u.id === id);
  if (!user) return;
  user.lastLoginAt = new Date().toISOString();
  user.lastLoginIp = ip ?? null;
  await persist(users);
}

export function canUseePanel(user, panelId) {
  return user.panels === ALL_PANELS || (Array.isArray(user.panels) && user.panels.includes(panelId));
}

export function publicUser(user) {
  const { passwordHash, ...rest } = user;
  return rest;
}
