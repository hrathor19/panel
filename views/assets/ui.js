/* Shared helpers for the gateway's own pages. No build step, no framework. */

export const $ = (id) => document.getElementById(id);

/* ── elements ───────────────────────────────────────────────────────── */

// Builds DOM rather than assembling HTML strings: user names, panel labels and
// audit lines are all attacker-influenced, and textContent cannot be escaped
// wrong.
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value; // only ever given icon markup below
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const ICONS = {
  grid: '<path d="M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  server: '<rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><path d="M6 6h.01M6 18h.01"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  key: '<path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  refresh: '<path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6M10 14L21 3"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
};

export function icon(name, size = 16) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.innerHTML = ICONS[name] ?? '';
  return svg;
}

export function tag(text, kind = '', withLed = false) {
  return el('span', { class: `tag ${kind}` }, withLed ? el('span', { class: 'led' }) : null, text);
}

/* ── network ────────────────────────────────────────────────────────── */

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401) {
    location.href = `/login?next=${encodeURIComponent(location.pathname)}`;
    throw new Error('signed out');
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/* ── toasts ─────────────────────────────────────────────────────────── */

export function toast(message, kind = 'ok') {
  let host = $('toasts');
  if (!host) {
    host = el('div', { id: 'toasts' });
    document.body.append(host);
  }
  const node = el('div', { class: `toast ${kind}` }, icon(kind === 'error' ? 'shield' : 'check', 16), el('span', { text: message }));
  host.append(node);
  setTimeout(() => {
    node.style.transition = 'opacity .2s';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 220);
  }, kind === 'error' ? 7000 : 4000);
}

/* ── formatting ─────────────────────────────────────────────────────── */

export function when(value) {
  if (!value) return 'Never';
  const date = new Date(value);
  const seconds = (Date.now() - date.getTime()) / 1000;
  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hr ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)} d ago`;
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function exactly(value) {
  return value ? new Date(value).toLocaleString() : '';
}

export async function copy(text, label = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast(label);
  } catch {
    toast('Could not copy — select the text and copy it manually.', 'error');
  }
}

/* ── shell ──────────────────────────────────────────────────────────── */

export function emptyState(iconName, title, detail) {
  return el('div', { class: 'empty' }, icon(iconName, 34), el('p', { text: title }), el('span', { text: detail }));
}

export function skeletonRows(tbody, rows, columns) {
  tbody.replaceChildren();
  for (let r = 0; r < rows; r += 1) {
    const tr = el('tr');
    for (let c = 0; c < columns; c += 1) {
      tr.append(el('td', {}, el('div', { class: 'skeleton', style: `width:${40 + ((r + c) % 4) * 15}%` })));
    }
    tbody.append(tr);
  }
}

// Builds the account menu in the top bar, shared by every signed-in page.
export function accountMenu(user) {
  const pop = el('div', { class: 'menu-pop', hidden: true },
    el('div', { class: 'head' }, el('strong', { text: user.name }), el('span', { text: user.email })),
    el('a', { href: '/panels' }, icon('grid'), 'Panels'),
    el('a', { href: '/account' }, icon('key'), 'Change password'),
    user.role === 'admin' ? el('a', { href: '/admin' }, icon('shield'), 'Administration') : null,
    el('button', {
      onClick: async () => {
        await fetch('/gw/auth/logout', { method: 'POST' });
        location.href = '/login';
      },
    }, icon('logout'), 'Sign out'),
  );

  const trigger = el('button', { class: 'ghost', 'aria-haspopup': 'true' },
    el('span', { text: user.name }),
    el('span', { class: 'muted', text: '▾' }),
  );
  trigger.addEventListener('click', (event) => {
    event.stopPropagation();
    pop.hidden = !pop.hidden;
  });
  document.addEventListener('click', () => { pop.hidden = true; });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') pop.hidden = true; });

  return el('div', { class: 'menu' }, trigger, pop);
}

// Fetches the signed-in person, bouncing to the login page if the session died.
export async function whoami() {
  const res = await fetch('/gw/auth/me');
  if (!res.ok) {
    location.href = `/login?next=${encodeURIComponent(location.pathname)}`;
    throw new Error('signed out');
  }
  return res.json();
}
