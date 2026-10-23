import { storage } from './storage.js';

// The only leak control that does not depend on the browser cooperating.
//
// Blocking copy and watermarking the screen raise effort; they cannot stop
// someone who opens the network tab, or replays their session cookie with curl.
// What stops a bulk extraction is refusing to serve the volume: a person
// working leads reads a few pages an hour, a scraper reads hundreds. Counting
// per account, server-side, catches that regardless of what the client does.
//
// Export permission exempts you — if you are trusted to download the list in
// one click, a paging limit is theatre.

const LIST_ENDPOINTS = [
  'publishers/v1/getLeadDetailsViewList',
  'publishers/v1/getCampaignDetailsViewList',
  'publishers/v1/getGeographicalStateViewList',
  'publishers/v1/getLeadDetailsSummary',
];

const WINDOW_MS = Number(process.env.BULK_WINDOW_MINUTES || 60) * 60 * 1000;
const LIMIT = Number(process.env.BULK_MAX_PER_WINDOW || 300);

function isListEndpoint(path) {
  const clean = path.split('?')[0].replace(/^\/+/, '').replace(/\/+$/, '');
  return LIST_ENDPOINTS.some((entry) => clean === entry || clean.startsWith(entry + '/'));
}

export async function checkVolume(user, panelId, path) {
  if (user.canExport) return { allowed: true };
  if (!isListEndpoint(path)) return { allowed: true };

  const used = await storage.bumpCounter(`bulk:${user.id}:${panelId}`, WINDOW_MS);
  if (used > LIMIT) {
    return {
      allowed: false,
      used,
      limit: LIMIT,
      windowMinutes: Math.round(WINDOW_MS / 60000),
    };
  }
  return { allowed: true, used, limit: LIMIT };
}

export { LIST_ENDPOINTS, LIMIT as BULK_LIMIT };
