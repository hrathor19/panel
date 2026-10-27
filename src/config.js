import process from 'node:process';

try {
  process.loadEnvFile();
} catch {
  // No .env on disk — rely on real environment variables (systemd, Vercel, ...).
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name} (see .env.example)`);
  return value;
}

const onVercel = Boolean(process.env.VERCEL);
const trustProxy = process.env.TRUST_PROXY === '1' || onVercel;

export const config = {
  port: Number(process.env.PORT) || 8080,
  sessionSecret: required('SESSION_SECRET'),
  sessionTtlMs: Number(process.env.SESSION_HOURS || 12) * 60 * 60 * 1000,

  // Behind nginx/Vercel the real client IP arrives in X-Forwarded-For, and the
  // connection to the browser is TLS even though this process speaks plain HTTP.
  trustProxy,
  // Usually the same fact, but not always: a reverse proxy serving plain HTTP
  // on a bare IP (no domain, so no certificate) trusts a proxy without
  // terminating TLS. Marking the cookie Secure there means the browser throws
  // it away and nobody can sign in at all, so SECURE_COOKIES=0 has to win.
  secureCookies: process.env.SECURE_COOKIES === '0'
    ? false
    : process.env.SECURE_COOKIES === '1' || trustProxy,
  onVercel,

  // What the sign-in page does about location.
  //   off      never ask
  //   capture  ask and record, but let people in either way
  //   require  ask, and refuse the sign-in without one
  // All three need a secure context to produce anything: browsers refuse
  // geolocation over plain HTTP on anything but localhost.
  locationMode: (() => {
    if (process.env.REQUIRE_LOCATION === '1') return 'require';   // older name
    const mode = (process.env.LOCATION_MODE || 'off').toLowerCase();
    return ['off', 'capture', 'require'].includes(mode) ? mode : 'off';
  })(),

  // Turn the reported coordinates into a readable address. Sends those
  // coordinates to the geocoder, so it is opt-out.
  reverseGeocode: process.env.REVERSE_GEOCODE !== '0',

  // Leak controls. Watermarking is attribution, not prevention: a screenshot
  // cannot be blocked by a web page, so the aim is that any capture carries
  // the viewer's identity.
  //   all   — watermark everybody (default; attribution is free)
  //   users — only role=user, leaving admins a clean view for debugging
  //   off   — nobody
  watermarkMode: (process.env.WATERMARK_MODE || 'all').toLowerCase(),
  brand: process.env.BRAND || 'KollegeApply',
  // How strong the mark is. Lower reads more comfortably over dense tables;
  // too low and a compressed screenshot no longer shows who took it, which is
  // the only reason the mark is there. 0.12-0.22 is the usable range.
  watermarkOpacity: Math.min(Math.max(Number(process.env.WATERMARK_OPACITY || 0.17), 0.04), 0.5),
  // Copy/selection/right-click/print blocking, applied to role=user only.
  frictionForUsers: process.env.DISABLE_COPY !== '0',

  // Only used once, to seed the first panel on an install that predates the
  // multi-panel admin. Panels are managed in the admin UI after that.
  seed: {
    email: process.env.NPF_EMAIL || '',
    password: process.env.NPF_PASSWORD || '',
    url: process.env.NPF_URL || 'https://publisher.nopaperforms.com',
    label: process.env.NPF_LABEL || 'NPF',
  },
};
