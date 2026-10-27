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
  secureCookies: process.env.SECURE_COOKIES === '1' || trustProxy,
  onVercel,

  // Sign-in must carry a browser location. Note this only works where the
  // browser treats the page as a secure context — HTTPS, or localhost. Over
  // plain HTTP on a LAN address the API is refused outright and nobody can get
  // in, so it stays off until TLS is in place.
  requireLocation: process.env.REQUIRE_LOCATION === '1',
  // How stale a reported position may be, and how long to wait for one.
  locationMaxAgeMs: Number(process.env.LOCATION_MAX_AGE_MS || 5 * 60 * 1000),

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
