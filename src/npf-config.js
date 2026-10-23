// Each panel ships its own settings inside its Angular bundle. We read them off
// the live bundle per panel rather than hardcoding, so a rotated access key or
// encryption key doesn't silently break every request.
const FALLBACK = {
  accessKey: 'SNRqSP4mz9',
  requestEncryptionKey: '6NitGRUTASKAAM1kxXLJ1YSzLokPtx8XGCHj8_VV',
  environment: 'live',
  mode: 'web',
  appType: 'publisher',
  apiOrigin: 'https://services.nopaperforms.com',
};

const REFRESH_MS = 6 * 60 * 60 * 1000;

const cache = new Map(); // spaOrigin -> { values, at }
const inflight = new Map();

const PATTERNS = {
  accessKey: /accessKey:"([^"]+)"/,
  requestEncryptionKey: /request_encryption_key:"([^"]+)"/,
  environment: /environment:"([^"]+)"/,
  mode: /mode:"([^"]+)"/,
  appType: /appType:"([^"]+)"/,
};

async function scrape(spaOrigin) {
  const indexRes = await fetch(`${spaOrigin}/`);
  if (!indexRes.ok) throw new Error(`index.html -> HTTP ${indexRes.status}`);
  const html = await indexRes.text();

  const bundle = html.match(/src="(main\.[a-f0-9]+\.js)"/)?.[1];
  if (!bundle) throw new Error('could not locate the main bundle in index.html');

  const jsRes = await fetch(`${spaOrigin}/${bundle}`);
  if (!jsRes.ok) throw new Error(`${bundle} -> HTTP ${jsRes.status}`);
  const js = await jsRes.text();

  const values = {};
  for (const [key, pattern] of Object.entries(PATTERNS)) {
    const found = js.match(pattern)?.[1];
    if (found) values[key] = found;
  }

  const apiBase = js.match(/apiBaseUrl:"([^"]+)"/)?.[1];
  if (apiBase) {
    try {
      values.apiOrigin = new URL(apiBase).origin;
    } catch {
      // A relative apiBaseUrl means this bundle was already rewritten by a
      // proxy — fall through to the default rather than trusting it.
    }
  }

  if (!values.accessKey || !values.requestEncryptionKey) {
    throw new Error('bundle parsed but auth constants were absent');
  }
  return { ...FALLBACK, ...values };
}

export async function getNpfConstants(spaOrigin) {
  const hit = cache.get(spaOrigin);
  if (hit && Date.now() - hit.at < REFRESH_MS) return hit.values;
  if (inflight.has(spaOrigin)) return inflight.get(spaOrigin);

  const task = scrape(spaOrigin)
    .then((values) => {
      cache.set(spaOrigin, { values, at: Date.now() });
      return values;
    })
    .catch((err) => {
      const previous = cache.get(spaOrigin)?.values;
      console.warn(`[npf-config] ${spaOrigin}: scrape failed (${err.message}); using ${previous ? 'cached' : 'fallback'} values`);
      const values = previous ?? { ...FALLBACK };
      cache.set(spaOrigin, { values, at: Date.now() });
      return values;
    })
    .finally(() => inflight.delete(spaOrigin));

  inflight.set(spaOrigin, task);
  return task;
}

export function forgetConstants(spaOrigin) {
  cache.delete(spaOrigin);
}
