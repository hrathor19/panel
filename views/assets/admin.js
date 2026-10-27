import {
  $, el, icon, badge, tag, avatar, api, toast, when, exactly, copy,
  statCard, searchBox, card, dataTable, cell, emptyState, skeletonRows, pagination,
  accountMenu, whoami, themeToggle,
} from '/gw-assets/ui.js';

let PANELS = [];
let USERS = [];
let ME = null;
let currentDialogUser = null;
let applyGlobalFilter = null;   // set by whichever view is on screen

const PAGES = [
  { id: 'overview', label: 'Overview', icon: 'home' },
  { id: 'users', label: 'Users', icon: 'users' },
  { id: 'panels', label: 'Panels', icon: 'layers' },
  { id: 'sessions', label: 'Sessions', icon: 'link' },
  { id: 'signins', label: 'Sign-ins', icon: 'shield' },
  { id: 'activity', label: 'Activity', icon: 'activity' },
];

/* ── shared bits ────────────────────────────────────────────────────── */

function pageHead(title, subtitle, ...actions) {
  return el('div', { class: 'page-head' },
    el('div', {}, el('h1', { text: title }), el('p', { text: subtitle })),
    actions.length ? el('div', { class: 'card-actions' }, ...actions) : null);
}

// A "⋮" menu for the actions that do not deserve a button of their own.
function rowMenu(items) {
  const pop = el('div', { class: 'menu-pop', hidden: true },
    ...items.filter(Boolean).map(([label, iconName, onClick, tone]) =>
      el('button', {
        type: 'button',
        style: tone === 'danger' ? 'color:var(--danger)' : null,
        onClick: (e) => { e.stopPropagation(); pop.hidden = true; onClick(); },
      }, icon(iconName, 16), label)));

  const trigger = el('button', { class: 'sm ghost', type: 'button', 'aria-label': 'More actions' }, icon('more', 16));
  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    for (const other of document.querySelectorAll('.menu-pop')) if (other !== pop) other.hidden = true;
    pop.hidden = !pop.hidden;
  });
  document.addEventListener('click', () => { pop.hidden = true; });
  return el('div', { class: 'menu' }, trigger, pop);
}

for (const button of document.querySelectorAll('[data-close]')) {
  button.addEventListener('click', () => button.closest('dialog').close());
}

function confirmThen(title, body, confirmLabel, action) {
  $('confirmTitle').textContent = title;
  $('confirmBody').textContent = body;
  const go = $('confirmGo');
  go.textContent = confirmLabel;
  go.className = /delete|remove/i.test(confirmLabel) ? 'primary danger' : 'primary';
  const once = async () => { go.removeEventListener('click', once); $('confirmDialog').close(); await action(); };
  go.addEventListener('click', once);
  $('confirmDialog').addEventListener('close', () => go.removeEventListener('click', once), { once: true });
  $('confirmDialog').showModal();
}

function showSecret(password) {
  if (!password) return;
  $('secretValue').textContent = password;
  $('secretDialog').showModal();
}
$('secretCopy').addEventListener('click', () => copy($('secretValue').textContent, 'Password copied'));

const hostOf = (origin) => { try { return new URL(origin).host; } catch { return origin; } };

/* ── overview ───────────────────────────────────────────────────────── */

async function renderOverview(view) {
  view.append(pageHead('Overview', 'Monitor your panel connections, user activity and system status.'));
  const stats = el('div', { class: 'stats' });
  const body = el('div');
  view.append(stats, body);

  const data = await api('/gw/admin/overview');
  const connected = PANELS.filter((p) => p.upstream?.connected).length;

  stats.replaceChildren(
    statCard({ label: 'Total Users', value: data.users.total, note: `${data.users.total} total · ${data.users.admins} admins`, tone: 'tone-blue', iconName: 'users' }),
    statCard({ label: 'Panels', value: `${connected}/${data.panels.active}`, note: 'connected right now', tone: 'tone-violet', iconName: 'layers' }),
    statCard({ label: 'Signed In', value: data.sessions, note: 'active sessions', tone: 'tone-green', iconName: 'activity' }),
    statCard({ label: 'Requests Today', value: data.today.requests, note: `${data.today.logins} sign-ins`, tone: 'tone-amber', iconName: 'file' }),
    statCard({ label: 'Blocked Today', value: data.today.blocked, note: `${data.today.failedLogins} failed sign-ins`, tone: 'tone-red', iconName: 'shield' }),
  );

  let filter = '';
  const search = searchBox('Search panels by name or domain…', (v) => { filter = v; paint(); });
  applyGlobalFilter = (v) => { filter = v; paint(); };

  body.replaceChildren(card({
    iconName: 'layers', tone: 'tone-blue', title: 'Panels',
    description: 'Manage your connected panels and monitor their status.',
    actions: [el('button', { class: 'primary', onClick: () => go('panels') }, icon('settings', 16), 'Manage Panels')],
    children: [
      el('div', { class: 'toolbar' }, search),
      dataTable(['Panel', 'Account', 'Connection', 'Status', 'Last activity', 'Actions'], 'ovPanels'),
      el('div', { id: 'ovFoot' }),
    ],
  }));
  paint();

  function paint() {
    const rows = PANELS.filter((p) => !filter || p.label.toLowerCase().includes(filter) || p.origin.toLowerCase().includes(filter));
    const tbody = $('ovPanels');
    tbody.replaceChildren();

    if (rows.length === 0) {
      tbody.append(el('tr', {}, el('td', { colspan: 6 }, emptyState('layers', 'No panels', 'Add the vendor account your team should share.'))));
      $('ovFoot').replaceChildren();
      return;
    }

    for (const p of rows) {
      tbody.append(el('tr', {},
        cell('Panel', el('div', { class: 'with-avatar' },
          el('div', { class: 'stat-icon tone-blue', style: 'width:36px;height:36px;border-radius:10px' }, icon('globe', 18)),
          el('div', { class: 'stack' },
            el('strong', {}, p.label, ' ', el('a', { href: p.origin, target: '_blank', rel: 'noopener' }, icon('external', 12))),
            el('small', { text: hostOf(p.origin) })))),
        cell('Account', p.username),
        cell('Connection', p.upstream?.connected ? badge('Connected', 'ok', true) : badge('Idle', '', true)),
        cell('Status', p.active ? badge('Active', 'ok') : badge('Disabled', 'bad')),
        cell('Last activity', el('div', { class: 'stack' },
          el('span', { text: p.upstream?.since ? when(p.upstream.since) : '—' }),
          el('small', {}, el('span', { class: `dot ${p.upstream?.connected ? 'live' : 'off'}`, style: 'display:inline-block;margin-right:6px' }),
            p.upstream?.connected ? 'Online' : 'Idle'))),
        el('td', { class: 'right', dataset: { label: 'Actions' } }, el('div', { class: 'row-actions' },
          el('button', { class: 'sm', onClick: () => go('panels') }, icon('eye', 14), 'View'),
          rowMenu([
            ['Test connection', 'refresh', () => testPanel(p)],
            ['Edit', 'edit', () => { go('panels'); setTimeout(() => openPanel(p), 60); }],
          ]))),
      ));
    }
    $('ovFoot').replaceChildren(pagination(rows.length, rows.length, 'panels'));
  }
}

/* ── users ──────────────────────────────────────────────────────────── */

function instituteSummary(user) {
  if (!user.institutes || user.institutes === '*') return badge('All', '', false);
  const scoped = Object.entries(user.institutes).filter(([, v]) => Array.isArray(v));
  if (scoped.length === 0) return badge('All', '');
  const total = scoped.reduce((sum, [, ids]) => sum + ids.length, 0);
  return total === 0 ? badge('None', 'bad') : badge(`${total} selected`, 'warn');
}

function panelSummary(user) {
  if (user.panels === '*') return badge('All panels', 'accent');
  const names = PANELS.filter((p) => user.panels?.includes(p.id)).map((p) => p.label);
  if (names.length === 0) return badge('None', 'bad');
  return badge(names.length <= 2 ? names.join(', ') : `${names.length} panels`, 'accent');
}

async function renderUsers(view) {
  view.append(pageHead('Users', 'Manage team members, their roles, panel access and permissions.',
    el('button', { class: 'primary', onClick: () => openUser() }, icon('plus', 16), 'Add User')));

  const stats = el('div', { class: 'stats' });
  const body = el('div');
  view.append(stats, body);

  let filter = '';
  const search = searchBox('Search by name or email…', (v) => { filter = v; paint(); });
  applyGlobalFilter = (v) => { filter = v; paint(); };

  body.replaceChildren(card({
    iconName: 'users', tone: 'tone-blue', title: 'Team members',
    description: 'Everyone who can sign in to the gateway.',
    actions: [el('a', { class: 'btn', href: '/gw/admin/audit.csv' }, icon('download', 15), 'Export')],
    children: [
      el('div', { class: 'toolbar' }, search),
      dataTable(['User', 'Role', 'Exports', 'Panels', 'Institutes', 'Last sign-in', 'Actions'], 'usersBody'),
      el('div', { id: 'usersFoot' }),
    ],
  }));
  skeletonRows($('usersBody'), 4, 7);

  const data = await api('/gw/admin/users');
  USERS = data.users;

  const admins = USERS.filter((u) => u.role === 'admin').length;
  const active = USERS.filter((u) => u.active).length;
  stats.replaceChildren(
    statCard({ label: 'Total Users', value: USERS.length, note: 'across the workspace', tone: 'tone-blue', iconName: 'users' }),
    statCard({ label: 'Active Users', value: active, note: `${Math.round((active / Math.max(USERS.length, 1)) * 100)}% active`, tone: 'tone-green', iconName: 'shieldCheck' }),
    statCard({ label: 'Administrators', value: admins, note: `${Math.round((admins / Math.max(USERS.length, 1)) * 100)}% of users`, tone: 'tone-amber', iconName: 'key' }),
    statCard({ label: 'Panels', value: PANELS.length, note: 'available to assign', tone: 'tone-violet', iconName: 'grid' }),
  );
  paint();

  function paint() {
    const rows = USERS.filter((u) => !filter || u.name.toLowerCase().includes(filter) || u.email.toLowerCase().includes(filter));
    const tbody = $('usersBody');
    tbody.replaceChildren();

    if (rows.length === 0) {
      tbody.append(el('tr', {}, el('td', { colspan: 7 },
        emptyState('users', 'Nobody found', filter ? 'Try a different search.' : 'Add your first user.'))));
      $('usersFoot').replaceChildren();
      return;
    }

    for (const user of rows) {
      const isMe = user.id === ME.id;
      tbody.append(el('tr', {},
        cell('User', el('div', { class: 'with-avatar' }, avatar(user.name),
          el('div', { class: 'stack' },
            el('strong', {}, user.name, isMe ? ' ' : null, isMe ? badge('You', 'accent') : null),
            el('small', { text: user.email })))),
        cell('Role', user.role === 'admin'
          ? badge('Administrator', 'accent')
          : badge('User', '')),
        cell('Exports', user.canExport
          ? el('span', { class: 'badge ok' }, icon('check', 13), 'Allowed')
          : el('span', { class: 'badge' }, '✕ No')),
        cell('Panels', panelSummary(user)),
        cell('Institutes', instituteSummary(user)),
        cell('Last sign-in', el('div', { class: 'stack' },
          el('span', { title: exactly(user.lastLoginAt), text: when(user.lastLoginAt) }),
          el('small', {}, el('span', { class: `dot ${user.active ? 'live' : 'off'}`, style: 'display:inline-block;margin-right:6px' }),
            user.active ? 'Active' : 'Disabled'))),
        el('td', { class: 'right', dataset: { label: 'Actions' } }, el('div', { class: 'row-actions' },
          el('button', { class: 'sm', onClick: () => openUser(user) }, icon('edit', 14), 'Edit'),
          rowMenu([
            ['Reset password', 'key', () => resetPassword(user)],
            [user.active ? 'Disable' : 'Enable', user.active ? 'ban' : 'checkCircle', () => toggleUser(user)],
            !isMe && ['Delete', 'xCircle', () => removeUser(user), 'danger'],
          ]))),
      ));
    }
    $('usersFoot').replaceChildren(pagination(rows.length, rows.length, 'users'));
  }
}

/* ── user dialog ────────────────────────────────────────────────────── */

const instituteCache = new Map();

async function institutesFor(panelId) {
  if (instituteCache.has(panelId)) return instituteCache.get(panelId);
  try {
    const { institutes } = await api(`/gw/admin/panels/${panelId}/institutes`);
    instituteCache.set(panelId, institutes);
    return institutes;
  } catch (err) {
    instituteCache.set(panelId, err);
    return err;
  }
}

function selectedPanels() {
  if ($('uAll').checked) return PANELS;
  const ids = new Set([...$('uPanels').querySelectorAll('input:checked')].map((i) => i.value));
  return PANELS.filter((p) => ids.has(p.id));
}

function renderInstituteGroup(panel, assigned) {
  const chips = el('div', { class: 'inst-chips' });
  const list = el('div', { class: 'inst-list' }, el('div', { class: 'inst-empty', text: 'Loading institutes…' }));
  const count = el('span', { class: 'count', text: '…' });

  const allBox = el('input', {
    type: 'checkbox', checked: assigned === '*' || assigned === undefined,
    onChange: () => { syncMode(); refresh(); },
  });
  const filter = el('input', { type: 'search', placeholder: 'Filter institutes…', onInput: (e) => applyFilter(e.target.value.toLowerCase().trim()) });
  const clear = el('button', { type: 'button', class: 'sm', onClick: () => { for (const b of list.querySelectorAll('input')) b.checked = false; refresh(); } }, 'Clear');
  const tools = el('div', { class: 'inst-tools' }, filter, clear);

  const group = el('div', { class: 'inst-group', dataset: { panel: panel.id } },
    el('div', { class: 'inst-head' }, el('label', { class: 'check' }, allBox, el('span', { text: panel.label })), count),
    chips, tools, list);

  const boxes = () => [...list.querySelectorAll('input[type=checkbox]')];

  function applyFilter(query) {
    let shown = 0;
    for (const row of list.querySelectorAll('.check')) {
      const hit = !query || row.textContent.toLowerCase().includes(query);
      row.hidden = !hit;
      if (hit) shown += 1;
    }
    list.querySelector('.inst-empty')?.remove();
    if (shown === 0) list.append(el('div', { class: 'inst-empty', text: `Nothing matches “${query}”.` }));
  }

  // The chosen few live at the top as chips: with a hundred institutes, a tick
  // somewhere in the scroll is not an answer to "who can he see?".
  function refresh() {
    chips.replaceChildren();
    const picked = boxes().filter((b) => b.checked);
    if (!allBox.checked) {
      for (const box of picked) {
        const name = box.dataset.name;
        chips.append(el('span', { class: 'inst-chip' },
          el('span', { text: name, title: name }),
          el('button', { type: 'button', 'aria-label': `Remove ${name}`, onClick: () => { box.checked = false; refresh(); } }, '×')));
      }
    }
    const total = boxes().length;
    count.textContent = allBox.checked ? `all ${total || ''}`.trim() : `${picked.length} of ${total}`;
    count.className = allBox.checked ? 'count' : `count ${picked.length ? 'some' : 'none'}`;
  }

  function syncMode() {
    const off = allBox.checked;
    chips.hidden = off; tools.hidden = off; list.hidden = off;
    for (const box of boxes()) box.disabled = off;
  }

  institutesFor(panel.id).then((institutes) => {
    list.replaceChildren();
    if (institutes instanceof Error) {
      list.append(el('div', { class: 'inst-empty', text: `Could not load institutes: ${institutes.message}` }));
      count.textContent = '—';
      return;
    }
    if (institutes.length === 0) {
      list.append(el('div', { class: 'inst-empty', text: 'This panel reports no institutes.' }));
      count.textContent = '0';
      return;
    }
    const chosen = new Set(Array.isArray(assigned) ? assigned.map(String) : []);
    for (const inst of institutes) {
      list.append(el('label', { class: 'check' },
        el('input', { type: 'checkbox', value: inst.id, dataset: { name: inst.name }, checked: chosen.has(String(inst.id)), onChange: refresh }),
        el('span', { text: inst.name })));
    }
    syncMode(); refresh();
  });

  syncMode();
  return group;
}

function renderInstitutes(user) {
  const host = $('uInstPanels');
  host.replaceChildren();
  const panels = selectedPanels();
  if (panels.length === 0) {
    host.append(el('div', { class: 'inst-empty', text: 'Choose at least one panel first.' }));
    return;
  }
  const scope = user?.institutes;
  for (const panel of panels) {
    host.append(renderInstituteGroup(panel, !scope || scope === '*' ? '*' : scope[panel.id]));
  }
}

function collectInstitutes() {
  if ($('uAllInst').checked) return '*';
  const out = {};
  for (const group of $('uInstPanels').querySelectorAll('.inst-group')) {
    const allBox = group.querySelector('.inst-head input');
    out[group.dataset.panel] = allBox.checked ? '*' : [...group.querySelectorAll('.inst-list input:checked')].map((i) => i.value);
  }
  return out;
}

function openUser(user = null) {
  $('userTitle').textContent = user ? 'Edit user' : 'Add user';
  $('userLede').textContent = user ? user.email : 'They sign in with their own password, never a panel password.';
  $('userError').textContent = '';
  $('uName').value = user?.name ?? '';
  $('uEmail').value = user?.email ?? '';
  $('uEmail').disabled = Boolean(user);
  $('uRole').value = user?.role ?? 'user';
  $('uPassword').value = '';
  $('uPasswordField').hidden = Boolean(user);
  $('uExport').checked = Boolean(user?.canExport);
  $('uExport').disabled = user?.role === 'admin';

  const allPanels = !user || user.panels === '*';
  $('uAll').checked = allPanels;
  $('uPanelsWrap').hidden = allPanels;

  const list = $('uPanels');
  list.replaceChildren();
  if (PANELS.length === 0) list.append(el('span', { class: 'muted', text: 'No panels exist yet.' }));
  for (const panel of PANELS) {
    const box = el('input', { type: 'checkbox', value: panel.id, checked: Array.isArray(user?.panels) && user.panels.includes(panel.id) });
    box.addEventListener('change', () => { if (!$('uAllInst').checked) renderInstitutes(currentDialogUser); });
    list.append(el('label', { class: 'check', style: 'margin:0' }, box,
      el('div', {}, el('span', { text: panel.label }), el('div', { class: 'hint', text: hostOf(panel.origin) }))));
  }

  currentDialogUser = user;
  const everyInstitute = !user || !user.institutes || user.institutes === '*';
  $('uAllInst').checked = everyInstitute;
  $('uInstWrap').hidden = everyInstitute;
  if (!everyInstitute) renderInstitutes(user); else $('uInstPanels').replaceChildren();

  $('userForm').dataset.id = user?.id ?? '';
  $('userDialog').showModal();
}

$('uAll').addEventListener('change', (e) => {
  $('uPanelsWrap').hidden = e.target.checked;
  if (!$('uAllInst').checked) renderInstitutes(currentDialogUser);
});
$('uAllInst').addEventListener('change', (e) => {
  $('uInstWrap').hidden = e.target.checked;
  if (!e.target.checked) renderInstitutes(currentDialogUser);
});
$('uRole').addEventListener('change', (e) => {
  const isAdmin = e.target.value === 'admin';
  if (isAdmin) $('uExport').checked = true;
  $('uExport').disabled = isAdmin;
});

$('userForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('userError').textContent = '';
  const id = $('userForm').dataset.id;
  const panels = $('uAll').checked ? '*' : [...$('uPanels').querySelectorAll('input:checked')].map((i) => i.value);
  const payload = { name: $('uName').value, role: $('uRole').value, canExport: $('uExport').checked, panels, institutes: collectInstitutes() };

  $('uSave').disabled = true;
  try {
    if (id) {
      await api(`/gw/admin/users/${id}`, { method: 'PATCH', body: payload });
      toast('User updated.');
    } else {
      const result = await api('/gw/admin/users', { method: 'POST', body: { ...payload, email: $('uEmail').value, password: $('uPassword').value } });
      showSecret(result.password);
    }
    $('userDialog').close();
    await refresh();
  } catch (err) {
    $('userError').textContent = err.message;
  } finally {
    $('uSave').disabled = false;
  }
});

function resetPassword(user) {
  confirmThen('Reset password?', `${user.email} will be signed out and will need the new password.`, 'Reset', async () => {
    try {
      const { password } = await api(`/gw/admin/users/${user.id}`, { method: 'PATCH', body: { resetPassword: true } });
      showSecret(password);
      await refresh();
    } catch (err) { toast(err.message, 'error'); }
  });
}

async function toggleUser(user) {
  try {
    await api(`/gw/admin/users/${user.id}`, { method: 'PATCH', body: { active: !user.active } });
    toast(user.active ? `${user.email} disabled.` : `${user.email} enabled.`);
    await refresh();
  } catch (err) { toast(err.message, 'error'); }
}

function removeUser(user) {
  confirmThen('Delete this user?', `${user.email} will lose access immediately. This cannot be undone.`, 'Delete', async () => {
    try {
      await api(`/gw/admin/users/${user.id}`, { method: 'DELETE' });
      toast(`${user.email} deleted.`);
      await refresh();
    } catch (err) { toast(err.message, 'error'); }
  });
}

/* ── panels ─────────────────────────────────────────────────────────── */

async function renderPanels(view) {
  view.append(pageHead('Panels', 'Manage your connected panels and monitor their status, connections and settings.'));
  const stats = el('div', { class: 'stats' });
  const body = el('div');
  view.append(stats, body);

  const connected = PANELS.filter((p) => p.upstream?.connected).length;
  const active = PANELS.filter((p) => p.active).length;
  stats.replaceChildren(
    statCard({ label: 'Total Panels', value: PANELS.length, note: 'all configured panels', tone: 'tone-blue', iconName: 'layers' }),
    statCard({ label: 'Connected Panels', value: connected, note: `${Math.round((connected / Math.max(PANELS.length, 1)) * 100)}% connected`, tone: 'tone-green', iconName: 'link' }),
    statCard({ label: 'Active Panels', value: active, note: `${Math.round((active / Math.max(PANELS.length, 1)) * 100)}% active`, tone: 'tone-cyan', iconName: 'checkCircle' }),
    statCard({ label: 'Disabled Panels', value: PANELS.length - active, note: active === PANELS.length ? 'No disabled panels' : 'needs attention', tone: 'tone-red', iconName: 'ban' }),
  );

  let filter = '';
  const search = searchBox('Search panels by name or domain…', (v) => { filter = v; paint(); });
  applyGlobalFilter = (v) => { filter = v; paint(); };

  body.replaceChildren(card({
    iconName: 'layers', tone: 'tone-blue', title: 'Panels', description: 'View and manage all your panel connections.',
    actions: [el('button', { class: 'primary', onClick: () => openPanel() }, icon('plus', 16), 'Add Panel')],
    children: [el('div', { class: 'toolbar' }, search), dataTable(['Panel', 'Address', 'Account', 'Connection', 'Status', 'Actions'], 'panelsBody')],
  }));
  paint();

  function paint() {
    const rows = PANELS.filter((p) => !filter || p.label.toLowerCase().includes(filter) || p.origin.toLowerCase().includes(filter));
    const tbody = $('panelsBody');
    tbody.replaceChildren();
    if (rows.length === 0) {
      tbody.append(el('tr', {}, el('td', { colspan: 6 }, emptyState('layers', 'No panels yet', 'Add the vendor account your team should share.'))));
      return;
    }
    for (const p of rows) {
      tbody.append(el('tr', {},
        cell('Panel', el('div', { class: 'with-avatar' },
          el('div', { class: 'stat-icon tone-blue', style: 'width:36px;height:36px;border-radius:10px' }, icon('globe', 18)),
          el('strong', { text: p.label }))),
        cell('Address', el('span', { class: 'mono', text: hostOf(p.origin) })),
        cell('Account', p.username),
        cell('Connection', p.upstream?.connected ? badge('Connected', 'ok', true) : badge('Idle', '', true)),
        cell('Status', p.active ? badge('Active', 'ok') : badge('Disabled', 'bad')),
        el('td', { class: 'right', dataset: { label: 'Actions' } }, el('div', { class: 'row-actions' },
          el('button', { class: 'sm', onClick: (e) => testPanel(p, e.currentTarget) }, 'Test'),
          el('button', { class: 'sm', onClick: () => openPanel(p) }, 'Edit'),
          el('button', { class: 'sm', onClick: () => togglePanel(p) }, p.active ? 'Disable' : 'Enable'),
          el('button', { class: 'sm danger', onClick: () => removePanel(p) }, 'Delete'))),
      ));
    }
  }
}

function openPanel(panel = null) {
  $('panelTitle').textContent = panel ? 'Edit panel' : 'Add panel';
  $('panelError').textContent = '';
  $('pLabel').value = panel?.label ?? '';
  $('pUrl').value = panel?.origin ?? 'https://publisher.nopaperforms.com';
  $('pUser').value = panel?.username ?? '';
  $('pPass').value = '';
  $('pPass').required = !panel;
  $('pPassHint').textContent = panel
    ? 'Leave blank to keep the current password.'
    : 'Encrypted before it is stored. Nobody signing in through the gateway ever sees it.';
  $('panelForm').dataset.id = panel?.id ?? '';
  $('panelDialog').showModal();
}

$('panelForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('panelError').textContent = '';
  const id = $('panelForm').dataset.id;
  const payload = { label: $('pLabel').value, url: $('pUrl').value, username: $('pUser').value, password: $('pPass').value };
  $('pSave').disabled = true;
  try {
    await api(id ? `/gw/admin/panels/${id}` : '/gw/admin/panels', { method: id ? 'PATCH' : 'POST', body: payload });
    $('panelDialog').close();
    await refresh();
    toast('Saved. Use Test to confirm the credentials work.');
  } catch (err) {
    $('panelError').textContent = err.message;
  } finally {
    $('pSave').disabled = false;
  }
});

async function testPanel(panel, button) {
  const label = button?.textContent;
  if (button) { button.disabled = true; button.textContent = 'Testing…'; }
  try {
    const result = await api(`/gw/admin/panels/${panel.id}/test`, { method: 'POST' });
    toast(result.message, result.ok ? 'ok' : 'error');
    await refresh();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    if (button) { button.disabled = false; button.textContent = label; }
  }
}

async function togglePanel(panel) {
  try { await api(`/gw/admin/panels/${panel.id}`, { method: 'PATCH', body: { active: !panel.active } }); await refresh(); }
  catch (err) { toast(err.message, 'error'); }
}

function removePanel(panel) {
  confirmThen('Delete this panel?', `Anyone using ${panel.label} loses access immediately.`, 'Delete', async () => {
    try { await api(`/gw/admin/panels/${panel.id}`, { method: 'DELETE' }); toast(`${panel.label} deleted.`); await refresh(); }
    catch (err) { toast(err.message, 'error'); }
  });
}

/* ── sessions ───────────────────────────────────────────────────────── */

const FLAG_TONE = {
  'impossible-travel': 'bad', 'location-denied': 'bad', 'location-disagrees-with-network': 'bad',
  'new-device': 'warn', 'new-location': 'warn', 'location-missing': 'warn', 'first-sign-in': '',
};

async function renderSessions(view) {
  view.append(pageHead('Sessions', 'Monitor and manage active sign-in sessions across your workspace.'));
  const stats = el('div', { class: 'stats' });
  const body = el('div');
  view.append(stats, body);

  const { sessions } = await api('/gw/admin/sessions');
  const { entries } = await api('/gw/admin/logins?limit=200');

  const today = entries.filter((e) => e.outcome === 'success' && new Date(e.at).toDateString() === new Date().toDateString()).length;
  const worrying = entries.filter((e) => (e.flags ?? []).some((f) => FLAG_TONE[f] === 'bad')).length;

  stats.replaceChildren(
    statCard({ label: 'Active Sessions', value: sessions.length, note: 'Currently signed in', tone: 'tone-blue', iconName: 'users' }),
    statCard({ label: 'Signed in Today', value: today, note: 'Total sign-ins today', tone: 'tone-violet', iconName: 'calendar' }),
    statCard({
      label: 'Security Status', value: worrying === 0 ? 'Secure' : 'Attention',
      note: worrying === 0 ? 'No suspicious activity' : `${worrying} flagged sign-in${worrying === 1 ? '' : 's'}`,
      tone: worrying === 0 ? 'tone-green' : 'tone-red', iconName: 'shieldCheck',
    }),
  );

  let filter = '';
  const search = searchBox('Search by name, email, device or IP…', (v) => { filter = v; paint(); });
  applyGlobalFilter = (v) => { filter = v; paint(); };

  body.replaceChildren(card({
    iconName: 'grid', tone: 'tone-blue', title: 'Signed-in sessions',
    description: 'View and manage all active sign-in sessions.',
    actions: [el('button', { class: 'sm', onClick: () => go('sessions') }, icon('refresh', 15), 'Refresh')],
    children: [
      el('div', { class: 'toolbar' }, search),
      dataTable(['Person', 'Signed in', 'Where', 'Device', 'Status', 'Actions'], 'sessionsBody'),
      el('div', { class: 'note' }, el('span', { class: 'note-icon' }, icon('info', 18)),
        el('span', { text: 'If you notice any unfamiliar activity, sign out from that session immediately and consider changing that person’s password.' })),
    ],
  }));
  paint();

  function paint() {
    const rows = sessions.filter((s) => !filter || JSON.stringify(s).toLowerCase().includes(filter));
    const tbody = $('sessionsBody');
    tbody.replaceChildren();
    if (rows.length === 0) {
      tbody.append(el('tr', {}, el('td', { colspan: 6 }, emptyState('key', 'Nobody signed in', 'Sessions appear here as people sign in.'))));
      return;
    }
    for (const s of rows) {
      tbody.append(el('tr', {},
        cell('Person', el('div', { class: 'with-avatar' }, avatar(s.name),
          el('div', { class: 'stack' },
            el('strong', {}, s.name, s.current ? ' ' : null, s.current ? badge('This device', 'accent') : null),
            el('small', { text: s.email })))),
        cell('Signed in', el('span', { title: exactly(s.createdAt), text: when(s.createdAt) })),
        cell('Where', el('div', { class: 'stack' },
          el('span', { text: s.place ?? '—' }), el('small', { class: 'mono', text: s.ip ?? '' }))),
        cell('Device', el('div', { class: 'stack' },
          el('span', { text: s.device?.label ?? '—' }),
          el('small', { text: [s.device?.kind, s.device?.timezone].filter(Boolean).join(' · ') }))),
        cell('Status', (s.flags ?? []).length
          ? el('div', { style: 'display:flex;flex-wrap:wrap;gap:4px' },
              ...s.flags.map((f) => tag(f.replace(/-/g, ' '), FLAG_TONE[f] ?? '')))
          : badge(s.current ? 'Current session' : 'Active', 'ok', true)),
        el('td', { class: 'right', dataset: { label: 'Actions' } },
          el('button', { class: 'sm danger', disabled: s.current, onClick: () => revokeSession(s) }, icon('logout', 14), 'Sign out')),
      ));
    }
  }
}

function revokeSession(session) {
  confirmThen('Sign this person out?', `${session.email} will have to sign in again.`, 'Sign out', async () => {
    try { await api(`/gw/admin/sessions/${session.id}`, { method: 'DELETE' }); toast('Session ended.'); go('sessions'); }
    catch (err) { toast(err.message, 'error'); }
  });
}

/* ── sign-ins ───────────────────────────────────────────────────────── */

const OUTCOME_TONE = { success: 'ok', 'bad-credentials': 'bad', 'location-blocked': 'bad', throttled: 'bad' };
const OUTCOME_LABEL = { success: 'Signed in', 'bad-credentials': 'Wrong password', 'location-blocked': 'Location refused', throttled: 'Throttled' };

async function renderSignins(view) {
  view.append(pageHead('Sign-ins', 'Every attempt, where it came from and what it was on — for tracing unauthorised access.'));
  const stats = el('div', { class: 'stats' });
  const body = el('div');
  view.append(stats, body);

  const { entries, labels } = await api('/gw/admin/logins?limit=500');
  const dayAgo = Date.now() - 86_400_000;
  const recent = entries.filter((e) => new Date(e.at).getTime() > dayAgo);

  stats.replaceChildren(
    statCard({ label: 'Sign-ins Today', value: recent.filter((e) => e.outcome === 'success').length, note: 'successful', tone: 'tone-green', iconName: 'checkCircle' }),
    statCard({ label: 'Rejected Today', value: recent.filter((e) => e.outcome !== 'success').length, note: 'wrong password, refused or throttled', tone: 'tone-red', iconName: 'xCircle' }),
    statCard({ label: 'Flagged', value: entries.filter((e) => (e.flags ?? []).length).length, note: 'worth a look', tone: 'tone-amber', iconName: 'shield' }),
    statCard({ label: 'Devices Seen', value: new Set(entries.map((e) => e.device).filter(Boolean)).size, note: 'distinct browser and OS pairs', tone: 'tone-violet', iconName: 'grid' }),
  );

  let filter = '';
  let only = '';
  const kinds = el('select', { style: 'max-width:190px', onChange: (e) => { only = e.target.value; paint(); } },
    el('option', { value: '', text: 'All sign-ins' }),
    el('option', { value: 'flagged', text: 'Flagged only' }),
    el('option', { value: 'success', text: 'Successful' }),
    el('option', { value: 'bad-credentials', text: 'Wrong password' }),
    el('option', { value: 'location-blocked', text: 'Location refused' }));

  const search = searchBox('Search person, place, device…', (v) => { filter = v; paint(); });
  applyGlobalFilter = (v) => { filter = v; paint(); };

  body.replaceChildren(card({
    iconName: 'shield', tone: 'tone-amber', title: 'Sign-in history',
    description: 'Location, device and network recorded for every attempt.',
    actions: [
      el('a', { class: 'btn sm', href: '/gw/admin/logins.csv' }, icon('download', 15), 'CSV'),
      el('button', { class: 'sm', onClick: () => go('signins') }, icon('refresh', 15), 'Refresh'),
    ],
    children: [
      el('div', { class: 'toolbar' }, search, kinds),
      dataTable(['When', 'Person', 'Outcome', 'Where', 'Device', 'Flags'], 'signinBody'),
    ],
  }));
  paint();

  function paint() {
    const rows = entries.filter((e) => {
      if (only === 'flagged' && (e.flags ?? []).length === 0) return false;
      if (only && only !== 'flagged' && e.outcome !== only) return false;
      return !filter || JSON.stringify(e).toLowerCase().includes(filter);
    });
    const tbody = $('signinBody');
    tbody.replaceChildren();
    if (rows.length === 0) {
      tbody.append(el('tr', {}, el('td', { colspan: 6 }, emptyState('shield', 'Nothing to show', 'Sign-ins appear here as people use the gateway.'))));
      return;
    }
    for (const e of rows.slice(0, 300)) {
      const coords = e.location?.latitude != null
        ? el('a', { href: `https://www.google.com/maps?q=${e.location.latitude},${e.location.longitude}`, target: '_blank', rel: 'noopener', class: 'mono',
            title: `Reported by the browser, accurate to about ${e.location.accuracyM ?? '?'} m` },
          `${e.location.latitude.toFixed(3)}, ${e.location.longitude.toFixed(3)}`)
        : el('span', { class: 'muted', text: e.location?.status ?? 'none' });

      tbody.append(el('tr', {},
        cell('When', el('span', { class: 'nowrap', title: exactly(e.at), text: when(e.at) })),
        cell('Person', el('div', { class: 'stack' }, el('strong', { text: e.email ?? '—' }), el('small', { class: 'mono', text: e.ip ?? '' }))),
        cell('Outcome', badge(OUTCOME_LABEL[e.outcome] ?? e.outcome, OUTCOME_TONE[e.outcome] ?? '')),
        cell('Where', el('div', { class: 'stack' }, el('span', { text: e.place }), el('small', {}, coords))),
        cell('Device', el('div', { class: 'stack' }, el('span', { text: e.device ?? '—' }),
          el('small', { text: [e.kind, e.screen, e.timezone].filter(Boolean).join(' · ') }))),
        cell('Flags', el('div', { style: 'display:flex;flex-wrap:wrap;gap:4px' },
          ...(e.flags ?? []).map((f) => {
            const extra = f === 'impossible-travel' && e.travel ? ` (${e.travel.km} km in ${e.travel.hours} h)`
              : f === 'location-disagrees-with-network' && e.locationGapKm ? ` (${e.locationGapKm} km apart)` : '';
            return tag((labels[f] ?? f) + extra, FLAG_TONE[f] ?? '');
          }))),
      ));
    }
  }
}

/* ── activity ───────────────────────────────────────────────────────── */

const EVENT_TONE = {
  login: 'ok', logout: '', 'login-failed': 'bad', 'login-throttled': 'bad', 'login-location-blocked': 'bad',
  blocked: 'bad', request: 'accent', 'token-refreshed': 'warn', 'panel-denied': 'bad', 'password-changed': 'accent',
};

async function renderActivity(view) {
  view.append(pageHead('Activity', 'Track all system events, user actions and API requests across your panels.'));
  const stats = el('div', { class: 'stats' });
  const body = el('div');
  view.append(stats, body);

  const { entries } = await api('/gw/admin/audit?limit=500');
  const today = entries.filter((e) => new Date(e.at).toDateString() === new Date().toDateString());
  const count = (name) => today.filter((e) => e.event === name).length;

  stats.replaceChildren(
    statCard({ label: 'Total Events', value: entries.length, note: 'All system activity', tone: 'tone-blue', iconName: 'file' }),
    statCard({ label: 'Successful Logins', value: count('login'), note: 'Today', tone: 'tone-green', iconName: 'users' }),
    statCard({ label: 'Failed Logins', value: count('login-failed') + count('login-throttled'), note: 'Today', tone: 'tone-red', iconName: 'shield' }),
    statCard({ label: 'API Requests', value: count('request'), note: 'Today', tone: 'tone-violet', iconName: 'chart' }),
  );

  let filter = '';
  let only = '';
  const kinds = el('select', { style: 'max-width:180px', onChange: (e) => { only = e.target.value; paint(); } },
    el('option', { value: '', text: 'All events' }),
    el('option', { value: 'blocked', text: 'Blocked only' }),
    el('option', { value: 'login', text: 'Sign-ins' }),
    el('option', { value: 'login-failed', text: 'Failed sign-ins' }),
    el('option', { value: 'admin', text: 'Admin changes' }));

  const search = searchBox('Search by person, panel, path…', (v) => { filter = v; paint(); });
  applyGlobalFilter = (v) => { filter = v; paint(); };

  body.replaceChildren(card({
    iconName: 'activity', tone: 'tone-violet', title: 'Activity Log',
    description: 'Real-time view of all user actions, API requests and system events.',
    actions: [
      el('a', { class: 'btn sm', href: '/gw/admin/audit.csv' }, icon('download', 15), 'CSV'),
      el('button', { class: 'sm', onClick: () => go('activity') }, icon('refresh', 15), 'Refresh'),
    ],
    children: [el('div', { class: 'toolbar' }, search, kinds), dataTable(['When', 'Event', 'Who', 'Panel', 'Detail'], 'auditBody')],
  }));
  paint();

  function paint() {
    const rows = entries.filter((entry) => {
      if (only === 'admin' && !entry.event.startsWith('admin-')) return false;
      if (only && only !== 'admin' && entry.event !== only) return false;
      return !filter || JSON.stringify(entry).toLowerCase().includes(filter);
    });
    const tbody = $('auditBody');
    tbody.replaceChildren();
    if (rows.length === 0) {
      tbody.append(el('tr', {}, el('td', { colspan: 5 }, emptyState('activity', 'Nothing matching', 'Try a different filter.'))));
      return;
    }
    for (const entry of rows.slice(0, 300)) {
      const { at, event, user, by, email, panel, ip, ...rest } = entry;
      const detail = Object.entries(rest)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join('  ');
      tbody.append(el('tr', {},
        cell('When', el('span', { class: 'nowrap', title: exactly(at), text: when(at) })),
        cell('Event', tag(event, EVENT_TONE[event] ?? (event.startsWith('admin-') ? 'accent' : ''), true)),
        cell('Who', user || by || email || '—'),
        cell('Panel', panel || '—'),
        cell('Detail', el('span', { class: 'mono muted', text: detail || (ip ? `ip=${ip}` : '') })),
      ));
    }
  }
}

/* ── routing ────────────────────────────────────────────────────────── */

const RENDERERS = { overview: renderOverview, users: renderUsers, panels: renderPanels, sessions: renderSessions, signins: renderSignins, activity: renderActivity };

async function go(id) {
  const page = PAGES.find((p) => p.id === id) ?? PAGES[0];
  for (const link of $('nav').children) {
    if (link.dataset.id === page.id) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  applyGlobalFilter = null;
  $('globalSearch').value = '';

  const view = $('view');
  view.replaceChildren();
  try {
    await RENDERERS[page.id](view);
  } catch (err) {
    view.replaceChildren(el('div', { class: 'card' }, el('div', { style: 'padding:20px' }, el('div', { class: 'inline-error', text: err.message }))));
  }
}

async function refresh() {
  const { panels } = await api('/gw/admin/panels');
  PANELS = panels;
  await go(location.hash.slice(1) || 'overview');
}

window.addEventListener('hashchange', () => go(location.hash.slice(1) || 'overview'));

/* ── boot ───────────────────────────────────────────────────────────── */

(async () => {
  $('brandMark').append(icon('layers', 19));
  $('searchIcon').append(icon('search', 16));
  $('bell').append(icon('bell', 18));
  $('themeSlot').append(themeToggle());

  const { user } = await whoami();
  ME = user;
  $('accountSlot').append(accountMenu(user));

  for (const page of PAGES) {
    $('nav').append(el('a', { href: `#${page.id}`, dataset: { id: page.id } }, icon(page.icon, 18), el('span', { text: page.label })));
  }

  $('globalSearch').addEventListener('input', (e) => {
    if (applyGlobalFilter) applyGlobalFilter(e.target.value.toLowerCase().trim());
  });
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('globalSearch').focus(); }
  });

  // Health drives the sidebar footer and the bell pip.
  try {
    const health = await (await fetch('/gw/health')).json();
    const up = (health.panels ?? []).filter((p) => p.upstream?.connected).length;
    $('sysTitle').textContent = 'System Status';
    $('sysNote').textContent = health.panels?.length ? `${up}/${health.panels.length} panels connected` : 'No panels configured';
  } catch { $('sysNote').textContent = 'Unavailable'; }

  try {
    const { entries } = await api('/gw/admin/logins?limit=100');
    if (entries.some((e) => (e.flags ?? []).some((f) => FLAG_TONE[f] === 'bad'))) {
      $('bell').append(el('span', { class: 'pip' }));
      $('bell').addEventListener('click', () => { location.hash = '#signins'; });
    }
  } catch { /* nothing to flag */ }

  // The session says who you are but not your id, and several views need it
  // to mark "you" and to stop you deleting your own account.
  const users = await api('/gw/admin/users');
  USERS = users.users;
  ME.id = USERS.find((u) => u.email === user.email)?.id;

  await refresh();
})();
