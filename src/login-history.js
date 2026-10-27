import { storage } from './storage.js';
import { distanceKm, describePlace } from './geo.js';

// A durable record of every sign-in attempt, kept separately from the audit log
// so it survives being skimmed and can be reasoned about per person.
//
// The flags are prompts for a human, not verdicts. "New device" means someone
// bought a laptop as often as it means an account is being used by two people.
// The one worth acting on without thinking twice is impossible travel.

const LOG = 'logins';

// Faster than any airliner, so two sign-ins that imply it were not the same
// person travelling.
const MAX_PLAUSIBLE_KMH = 900;
// A phone's reported position and its network's registered location disagree by
// tens of kilometres routinely; hundreds is a different matter.
const GPS_IP_TOLERANCE_KM = 300;

export async function recordLogin(entry) {
  try {
    await storage.appendLog(LOG, { at: new Date().toISOString(), ...entry });
  } catch (err) {
    console.error('[login-history] could not write entry:', err.message);
  }
}

export async function readHistory(limit = 500) {
  try {
    return await storage.readLog(LOG, limit);
  } catch (err) {
    console.error('[login-history] could not read log:', err.message);
    return [];
  }
}

export async function historyFor(userId, limit = 500) {
  return (await readHistory(limit)).filter((e) => e.userId === userId);
}

export function assessRisk(current, previousForUser) {
  const flags = [];

  const successes = previousForUser.filter((e) => e.outcome === 'success');

  if (current.location?.status === 'denied') flags.push('location-denied');
  else if (!current.location?.latitude && current.location?.status !== 'skipped') flags.push('location-missing');

  if (successes.length > 0) {
    if (current.device?.fingerprint && !successes.some((e) => e.device?.fingerprint === current.device.fingerprint)) {
      flags.push('new-device');
    }
    const place = describePlace(current.ipPlace);
    if (place !== 'Unknown' && place !== 'Local network') {
      const seen = successes.map((e) => describePlace(e.ipPlace));
      if (!seen.includes(place)) flags.push('new-location');
    }
  } else {
    flags.push('first-sign-in');
  }

  // Claimed position versus observed network position.
  if (current.location?.latitude != null && current.ipPlace?.latitude != null) {
    const gap = distanceKm(current.location, current.ipPlace);
    if (gap !== null && gap > GPS_IP_TOLERANCE_KM) {
      flags.push('location-disagrees-with-network');
      current.locationGapKm = gap;
    }
  }

  // Two sign-ins no single person could have made.
  const last = successes[0]; // readLog returns newest first
  if (last) {
    const from = last.location?.latitude != null ? last.location : last.ipPlace;
    const to = current.location?.latitude != null ? current.location : current.ipPlace;
    const km = distanceKm(from, to);
    const hours = (new Date(current.at ?? Date.now()) - new Date(last.at)) / 3_600_000;
    if (km !== null && hours > 0 && km > 100) {
      const kmh = km / hours;
      if (kmh > MAX_PLAUSIBLE_KMH) {
        flags.push('impossible-travel');
        current.travel = { km, hours: Math.round(hours * 10) / 10, kmh: Math.round(kmh) };
      }
    }
  }

  return flags;
}

export const RISK_LABELS = {
  'first-sign-in': 'First sign-in',
  'new-device': 'New device',
  'new-location': 'New location',
  'location-denied': 'Location refused',
  'location-missing': 'No location',
  'location-disagrees-with-network': 'Location disagrees with network',
  'impossible-travel': 'Impossible travel',
};
