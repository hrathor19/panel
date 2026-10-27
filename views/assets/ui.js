/* Shared runtime for the gateway's own pages. No build step, no framework. */

export const $ = (id) => document.getElementById(id);

/* ── elements ───────────────────────────────────────────────────────── */

// Builds DOM rather than assembling HTML strings: names, panel labels and
// audit lines are all attacker-influenced, and textContent cannot be escaped
// wrong.
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
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
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  layers: '<path d="m12 2 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5"/><path d="m3 17 9 5 9-5"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  shieldCheck: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>',
  bell: '<path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  refresh: '<path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.5 9a9 9 0 0 1 14.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15"/>',
  filter: '<path d="M22 3H2l8 9.5V19l4 2v-8.5L22 3z"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z"/><circle cx="12" cy="12" r="3"/>',
  edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5Z"/>',
  more: '<circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 0 20 15.3 15.3 0 0 1 0-20Z"/>',
  external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6M10 14 21 3"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  checkCircle: '<circle cx="12" cy="12" r="10"/><path d="m8 12 3 3 5-6"/>',
  xCircle: '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6M9 9l6 6"/>',
  ban: '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1Z"/>',
  key: '<path d="M21 2l-2 2m-7.6 7.6a5.5 5.5 0 1 1-7.8 7.8 5.5 5.5 0 0 1 7.8-7.8Zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  chart: '<path d="M18 20V10M12 20V4M6 20v-6"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-5M12 8h.01"/>',
  left: '<path d="m15 18-6-6 6-6"/>',
  right: '<path d="m9 18 6-6-6-6"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H1a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 2.6 7a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H7a1.6 1.6 0 0 0 1-1.5V1a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V7a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z"/>',
};

export function icon(name, size = 18) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.9');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.innerHTML = ICONS[name] ?? '';
  return svg;
}

export function badge(text, tone = '', withDot = false) {
  return el('span', { class: `badge ${tone}` }, withDot ? el('span', { class: 'dot' }) : null, text);
}

export function tag(text, tone = '', withLed = false) {
  return el('span', { class: `tag ${tone}` }, withLed ? el('span', { class: 'led' }) : null, text);
}

// Stable colour per person, so the same face keeps the same tile.
export function avatar(name, size = '') {
  const letter = (String(name ?? '?').trim()[0] ?? '?').toUpperCase();
  let hash = 0;
  for (const ch of String(name ?? '')) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const variant = ['', 'v1', 'v2', 'v3', 'v4', 'v5'][hash % 6];
  return el('div', { class: `avatar ${size} ${variant}`.trim(), text: letter });
}

/* ── theme ──────────────────────────────────────────────────────────── */

const THEME_KEY = 'gw-theme';

export function currentTheme() {
  try {
    return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme === 'dark' ? 'dark' : 'light');
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* private window */ }
}

export function themeToggle() {
  const button = el('button', { class: 'icon-btn', type: 'button', title: 'Switch theme', 'aria-label': 'Switch theme' });
  const paint = () => {
    const dark = currentTheme() === 'dark';
    button.replaceChildren(icon(dark ? 'sun' : 'moon', 18));
    button.title = dark ? 'Switch to light theme' : 'Switch to dark theme';
  };
  button.addEventListener('click', () => { applyTheme(currentTheme() === 'dark' ? 'light' : 'dark'); paint(); });
  paint();
  return button;
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
  const node = el('div', { class: `toast ${kind}` },
    icon(kind === 'error' ? 'xCircle' : 'checkCircle', 17),
    el('span', { text: message }));
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
  // navigator.clipboard does not exist outside a secure context, so on a
  // plain-HTTP deployment (a bare IP has no certificate) the modern call is
  // simply absent. The old execCommand path still works there, and copying a
  // freshly generated password is not a flow worth losing.
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else if (!legacyCopy(text)) {
      throw new Error('execCommand refused');
    }
    toast(label);
  } catch {
    toast('Could not copy — select the text and copy it manually.', 'error');
  }
}

function legacyCopy(text) {
  const field = document.createElement('textarea');
  field.value = text;
  // Off-screen rather than hidden: the selection has to be real to be copied.
  field.setAttribute('readonly', '');
  field.style.cssText = 'position:fixed;top:-1000px;opacity:0';
  document.body.append(field);
  field.select();
  try {
    return document.execCommand('copy');
  } finally {
    field.remove();
  }
}

/* ── building blocks ────────────────────────────────────────────────── */

export function statCard({ label, value, note, tone = 'tone-blue', iconName = 'chart', trend }) {
  return el('div', { class: 'stat' },
    el('div', { class: 'stat-ghost' }, icon(iconName, 76)),
    el('div', { class: 'stat-top' },
      el('div', { class: `stat-icon ${tone}` }, icon(iconName, 21)),
      el('div', { class: 'stat-label', text: label }),
      trend ? el('span', { class: `stat-trend ${trend.direction ?? 'flat'}`, text: trend.text }) : null,
    ),
    el('div', { class: 'stat-value', text: String(value) }),
    note ? el('div', { class: 'stat-note', text: note }) : null,
  );
}

export function searchBox(placeholder, onInput) {
  return el('div', { class: 'search' },
    el('span', { class: 'at-start' }, icon('search', 16)),
    el('input', { type: 'search', placeholder, onInput: (e) => onInput(e.target.value.toLowerCase().trim()) }),
  );
}

export function card({ iconName, tone = 'tone-blue', title, description, actions = [], children = [] }) {
  return el('div', { class: 'card' },
    (title || actions.length)
      ? el('div', { class: 'card-head' },
          iconName ? el('div', { class: `card-icon ${tone}` }, icon(iconName, 20)) : null,
          el('div', {}, el('h2', { text: title }), description ? el('p', { text: description }) : null),
          actions.length ? el('div', { class: 'card-actions' }, ...actions) : null)
      : null,
    ...children,
  );
}

export function dataTable(columns, bodyId) {
  return el('table', {},
    el('thead', {}, el('tr', {}, ...columns.map((c) => el('th', { text: c })))),
    el('tbody', { id: bodyId }),
  );
}

export const cell = (label, ...children) => el('td', { dataset: { label } }, ...children);

export function emptyState(iconName, title, detail) {
  return el('div', { class: 'empty' }, icon(iconName, 40), el('p', { text: title }), el('span', { text: detail }));
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

export function pagination(shown, total, noun = 'rows') {
  return el('div', { class: 'pagination' },
    el('span', { text: total === 0 ? `No ${noun}` : `Showing 1 to ${shown} of ${total} ${noun}` }),
    el('div', { class: 'pages' },
      el('button', { class: 'sm', disabled: true }, icon('left', 14)),
      el('button', { class: 'sm', 'aria-current': 'true', text: '1' }),
      el('button', { class: 'sm', disabled: true }, icon('right', 14)),
    ),
  );
}

/* ── account menu ───────────────────────────────────────────────────── */

export function accountMenu(user) {
  const pop = el('div', { class: 'menu-pop', hidden: true },
    el('div', { class: 'head' }, el('strong', { text: user.name }), el('span', { text: user.email })),
    el('a', { href: '/panels' }, icon('grid', 16), 'Panels'),
    el('a', { href: '/account' }, icon('key', 16), 'Change password'),
    user.role === 'admin' ? el('a', { href: '/admin' }, icon('shield', 16), 'Administration') : null,
    el('hr'),
    el('button', {
      onClick: async () => {
        await fetch('/gw/auth/logout', { method: 'POST' });
        location.href = '/login';
      },
    }, icon('logout', 16), 'Sign out'),
  );

  const trigger = el('button', { class: 'account', type: 'button', 'aria-haspopup': 'true' },
    avatar(user.name),
    el('span', { class: 'who' },
      el('strong', { text: user.name }),
      el('span', { text: user.role === 'admin' ? 'Administrator' : 'User' })),
    icon('right', 14),
  );
  trigger.lastChild.style.transform = 'rotate(90deg)';
  trigger.addEventListener('click', (event) => { event.stopPropagation(); pop.hidden = !pop.hidden; });
  document.addEventListener('click', () => { pop.hidden = true; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') pop.hidden = true; });

  return el('div', { class: 'menu' }, trigger, pop);
}

export async function whoami() {
  const res = await fetch('/gw/auth/me');
  if (!res.ok) {
    location.href = `/login?next=${encodeURIComponent(location.pathname)}`;
    throw new Error('signed out');
  }
  return res.json();
}
