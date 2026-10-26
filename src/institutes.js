// Per-user institute scoping.
//
// The shared panel account can see every institute, so the panel's own API will
// happily serve any of them to anyone holding the token. Restricting what a
// person sees therefore has to happen here, and it has to cover every way an
// institute can be named in a request — not just the dropdown, which is only
// what the UI chooses to show.
//
// Three surfaces:
//   1. the institute list itself  (GET collegeList — the response is filtered)
//   2. the URL path               (columnsByCollege/<id>/..., and friends)
//   3. the encrypted POST body    (college_id / collegeId / college, any depth)
//
// Filtering only the first would be cosmetic: the id is trivially editable in
// the network tab, and the panel would answer.

export const ALL = '*';

// Endpoints carrying the institute id as the first path segment after the prefix.
const PATH_SCOPED = [
  'publishers/v1/columnsByCollege',
  'publishers/v1/filtersByCollege',
  'publishers/v1/childTaxonomyByParentId',
  'publishers/v1/getEnableTaxonomyFields',
];

const BODY_FIELDS = new Set(['college_id', 'collegeid', 'collegeId', 'college']);

// Endpoints that genuinely have nothing to do with a single institute. Anything
// not on this list is treated as institute-scoped, so a restricted person must
// name an institute they hold — a new endpoint fails closed rather than open.
const INSTITUTE_AGNOSTIC = [
  'publishers/v1/menuList',
  'publishers/v1/collegeList',
  'publishers/v1/getLastSyncedTime',
  'publishers/v1/publisherAPIStatus',
  'publishers/v1/getPreviousSessionList',
  'publishers/v1/syncLiveData',
  'publishers/v1/getpublisherTooltip',
  'permissions/v1/publisherPermissions',
  'users/v1',
  'users/v3',
];

function clean(path) {
  return String(path).split('?')[0].replace(/^\/+/, '').replace(/\/+$/, '');
}

function startsWithEndpoint(path, entry) {
  const c = clean(path);
  return c === entry || c.startsWith(entry + '/');
}

/* ── what a person may see ───────────────────────────────────────────── */

export function allowedFor(user, panelId) {
  const scope = user?.institutes;
  if (!scope || scope === ALL) return ALL;
  const forPanel = scope[panelId];
  // A panel nobody has scoped yet behaves as it always did: everything.
  if (forPanel === undefined || forPanel === ALL) return ALL;
  if (!Array.isArray(forPanel)) return ALL;
  return forPanel.map(String);
}

export function isRestricted(user, panelId) {
  return allowedFor(user, panelId) !== ALL;
}

/* ── finding institute ids in a request ──────────────────────────────── */

export function idsInPath(path) {
  const c = clean(path);
  for (const prefix of PATH_SCOPED) {
    if (c === prefix || c.startsWith(prefix + '/')) {
      const rest = c.slice(prefix.length).replace(/^\/+/, '');
      const first = rest.split('/')[0];
      if (first) return [first];
    }
  }
  return [];
}

export function idsInBody(value, found = []) {
  if (value === null || typeof value !== 'object') return found;
  if (Array.isArray(value)) {
    for (const item of value) idsInBody(item, found);
    return found;
  }
  for (const [key, inner] of Object.entries(value)) {
    if (BODY_FIELDS.has(key) && inner !== null && inner !== undefined && inner !== '') {
      // The field is a scalar in every payload the panel builds, but accept a
      // list too rather than silently skipping one.
      if (Array.isArray(inner)) inner.forEach((v) => found.push(String(v)));
      else if (typeof inner !== 'object') found.push(String(inner));
    } else {
      idsInBody(inner, found);
    }
  }
  return found;
}

export function isInstituteScoped(path) {
  return !INSTITUTE_AGNOSTIC.some((entry) => startsWithEndpoint(path, entry));
}

/* ── the decision ────────────────────────────────────────────────────── */

export function checkInstitutes({ allowed, path, body }) {
  if (allowed === ALL) return { allowed: true };

  const referenced = [...idsInPath(path), ...idsInBody(body)];
  const permitted = new Set(allowed.map(String));

  const denied = [...new Set(referenced.map(String))].filter((id) => !permitted.has(id));
  if (denied.length) return { allowed: false, reason: 'institute-not-assigned', denied };

  // Naming no institute on a scoped endpoint would have the panel answer across
  // all of them, so it is refused rather than allowed through.
  if (referenced.length === 0 && isInstituteScoped(path)) {
    return { allowed: false, reason: 'institute-required' };
  }

  return { allowed: true };
}

/* ── the list the dropdown is built from ─────────────────────────────── */

// Response shape: { status: 1, data: { colleges: { "<id>": "<name>" } } }
export function filterCollegeList(payload, allowed) {
  if (allowed === ALL) return payload;
  const colleges = payload?.data?.colleges;
  if (!colleges || typeof colleges !== 'object') return payload;

  const permitted = new Set(allowed.map(String));
  const kept = {};
  for (const [id, name] of Object.entries(colleges)) {
    if (permitted.has(String(id))) kept[id] = name;
  }
  return { ...payload, data: { ...payload.data, colleges: kept } };
}

export { PATH_SCOPED, INSTITUTE_AGNOSTIC, BODY_FIELDS };
