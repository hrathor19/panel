import { storage } from './storage.js';

const LOG = 'audit';

// Audit writes must never break the request that triggered them.
export function audit(entry) {
  Promise.resolve(storage.appendLog(LOG, { at: new Date().toISOString(), ...entry })).catch((err) =>
    console.error('[audit] could not write entry:', err.message),
  );
}

export async function recentAudit(limit = 300) {
  try {
    return await storage.readLog(LOG, limit);
  } catch (err) {
    console.error('[audit] could not read log:', err.message);
    return [];
  }
}
