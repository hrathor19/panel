// What someone behind the gateway may ask a panel for. Paths are matched with
// the /p/<slug>/npf-api prefix already stripped, e.g.
// "publishers/v1/downloadLeadDetailsViewList".

// Bulk export endpoints: the ones that turn "looking at leads" into "taking the
// lead database home". Gated on the per-user export permission.
const EXPORT_ENDPOINTS = [
  'publishers/v1/downloadLeadDetailsViewList',
  'publishers/v1/downloadCampaignDetailsViewList',
  'publishers/v1/downloadGeographicalStateViewList',
  'publishers/v1/downloadDashboardSummaryPDF',
  'publishers/v1/downloadTaxonomy',
];

// Account-mutating endpoints. These act on the *shared* panel account, so
// nobody may reach them — not even a gateway admin. Changing the panel
// password from in here would lock out every other user at once.
const NEVER_FORWARD = [
  'users/v1/editProfile',
  'users/v1/resetPassword',
  'users/v1/forgot',
  'users/v1/checkPasswordReset',
  'users/v1/logout',
];

function matches(path, list) {
  const clean = path.split('?')[0].replace(/^\/+/, '').replace(/\/+$/, '');
  return list.some((entry) => clean === entry || clean.startsWith(entry + '/'));
}

export function checkPolicy(path, { canExport }) {
  if (matches(path, NEVER_FORWARD)) return { allowed: false, reason: 'account-endpoint-blocked' };
  if (!canExport && matches(path, EXPORT_ENDPOINTS)) return { allowed: false, reason: 'export-blocked' };
  return { allowed: true };
}

export function isExportEndpoint(path) {
  return matches(path, EXPORT_ENDPOINTS);
}

export { EXPORT_ENDPOINTS, NEVER_FORWARD };
