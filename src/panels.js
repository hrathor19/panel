import { randomUUID } from 'node:crypto';
import { getDoc, putDoc } from './storage.js';
import { seal, open } from './crypto-box.js';

const DOC = 'panels';

function slugify(value) {
  return String(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// Accepts whatever an admin pastes — "publisher.nopaperforms.com",
// "https://publisher.nopaperforms.com/login" — and reduces it to an origin.
function normaliseOrigin(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('panel address is required');
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`"${input}" is not a valid address`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('panel address must be http or https');
  return url.origin;
}

async function stored() {
  return getDoc(DOC, []);
}

export async function listPanels() {
  return (await stored()).map(({ passwordSealed, ...rest }) => rest);
}

export async function listPanelsWithSecrets() {
  return stored();
}

export async function findPanel(idOrSlug) {
  return (await stored()).find((p) => p.id === idOrSlug || p.slug === idOrSlug) ?? null;
}

export function panelPassword(panel) {
  return open(panel.passwordSealed);
}

// Slugs become URLs, so they must not collide with the gateway's own routes.
const RESERVED = new Set(['admin', 'login', 'logout', 'panels', 'gw', 'gw-assets', 'api', 'p', 'account']);

export async function addPanel({ label, url, username, password }) {
  const panels = await stored();
  const slug = slugify(label);

  if (!slug) throw new Error('panel name is required');
  if (RESERVED.has(slug)) throw new Error(`"${label}" is a reserved name — pick another`);
  if (panels.some((p) => p.slug === slug)) throw new Error(`a panel named "${label}" already exists`);
  if (!username) throw new Error('panel username is required');
  if (!password) throw new Error('panel password is required');

  const panel = {
    id: randomUUID(),
    slug,
    label: String(label).trim(),
    origin: normaliseOrigin(url),
    username: String(username).trim(),
    passwordSealed: seal(password),
    active: true,
    createdAt: new Date().toISOString(),
  };
  panels.push(panel);
  await putDoc(DOC, panels);
  return panel;
}

export async function updatePanel(id, patch) {
  const panels = await stored();
  const panel = panels.find((p) => p.id === id);
  if (!panel) throw new Error('no such panel');

  if (patch.label !== undefined) {
    const label = String(patch.label).trim();
    const slug = slugify(label);
    if (!slug) throw new Error('panel name is required');
    if (RESERVED.has(slug)) throw new Error(`"${label}" is a reserved name — pick another`);
    if (panels.some((p) => p.slug === slug && p.id !== id)) throw new Error(`a panel named "${label}" already exists`);
    panel.label = label;
    panel.slug = slug;
  }
  if (patch.url !== undefined) panel.origin = normaliseOrigin(patch.url);
  if (patch.username !== undefined) panel.username = String(patch.username).trim();
  if (patch.active !== undefined) panel.active = Boolean(patch.active);
  // An empty password field in the admin form means "leave it alone".
  if (patch.password) panel.passwordSealed = seal(patch.password);

  await putDoc(DOC, panels);
  return panel;
}

export async function deletePanel(id) {
  const panels = await stored();
  const next = panels.filter((p) => p.id !== id);
  if (next.length === panels.length) throw new Error('no such panel');
  await putDoc(DOC, next);
}

export { slugify, normaliseOrigin };
