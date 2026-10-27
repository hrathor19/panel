import { storage } from './storage.js';

// Where the request actually came from, decided by the server.
//
// The browser's own geolocation is the thing people picture, but it is a value
// the page hands us and DevTools can override it to anywhere on earth. The IP
// is observed rather than reported, so it cannot be set by whoever is signing
// in — a VPN moves it, but they cannot simply type a different city.
//
// Keeping both is the point: when the claimed position and the observed one
// disagree by hundreds of kilometres, that disagreement is the signal.

const LOOKUP_URL = process.env.GEO_LOOKUP_URL || 'https://ipapi.co/{ip}/json/';
const ENABLED = process.env.GEO_LOOKUP !== '0';
const CACHE_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = Number(process.env.GEO_TIMEOUT_MS || 4000);

export function normaliseIp(ip) {
  if (!ip) return '';
  // Express hands back IPv4-mapped IPv6 behind a proxy.
  return String(ip).replace(/^::ffff:/, '');
}

export function isPrivateIp(ip) {
  const a = normaliseIp(ip);
  if (!a || a === '::1' || a === '127.0.0.1') return true;
  if (/^10\./.test(a)) return true;
  if (/^192\.168\./.test(a)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(a)) return true;
  if (/^169\.254\./.test(a)) return true;
  if (/^(fc|fd|fe80)/i.test(a)) return true;
  return false;
}

export async function lookupIp(rawIp) {
  const ip = normaliseIp(rawIp);
  if (!ip) return { ip: '', status: 'unknown' };

  // A LAN address says nothing about where someone is, and a lookup would only
  // leak it to a third party for no return.
  if (isPrivateIp(ip)) return { ip, status: 'private' };
  if (!ENABLED) return { ip, status: 'disabled' };

  const key = `geoip:${ip}`;
  const cached = await storage.getCache(key).catch(() => null);
  if (cached) return cached;

  try {
    const res = await fetch(LOOKUP_URL.replace('{ip}', encodeURIComponent(ip)), {
      headers: { Accept: 'application/json', 'User-Agent': 'npf-gateway' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await res.json();

    if (!res.ok || body?.error) {
      return { ip, status: 'lookup-failed', detail: String(body?.reason ?? res.status).slice(0, 120) };
    }

    const place = {
      ip,
      status: 'ok',
      city: body.city ?? null,
      region: body.region ?? null,
      country: body.country_name ?? body.country ?? null,
      latitude: typeof body.latitude === 'number' ? body.latitude : null,
      longitude: typeof body.longitude === 'number' ? body.longitude : null,
      network: body.org ?? body.asn ?? null,
    };
    await storage.setCache(key, place, CACHE_MS).catch(() => {});
    return place;
  } catch (err) {
    // Never let a third party being slow stop someone signing in.
    return { ip, status: 'lookup-failed', detail: err.message.slice(0, 120) };
  }
}

export function describePlace(place) {
  if (!place) return 'Unknown';
  if (place.status === 'private') return 'Local network';
  if (place.status !== 'ok') return 'Unknown';
  return [place.city, place.region, place.country].filter(Boolean).join(', ') || 'Unknown';
}

// Great-circle distance, for comparing a claimed position with the observed one
// and for spotting a jump nobody could physically have made.
export function distanceKm(a, b) {
  if (!a || !b) return null;
  const { latitude: lat1, longitude: lon1 } = a;
  const { latitude: lat2, longitude: lon2 } = b;
  if ([lat1, lon1, lat2, lon2].some((v) => typeof v !== 'number')) return null;

  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}
