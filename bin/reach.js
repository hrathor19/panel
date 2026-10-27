#!/usr/bin/env node
// Why a panel will not open. A 502 from /p/<slug>/ means the gateway could not
// fetch the vendor's app, and the browser is told nothing more than that. This
// walks the same chain the request does and names the step that failed.
//
//   npm run reach                 every active panel
//   npm run reach -- npf          one panel, by slug
//
// Run it the way the service runs, or the answer may not match:
//   sudo -u panel node bin/reach.js
import { lookup } from 'node:dns/promises';
import process from 'node:process';

import { listPanelsWithSecrets } from '../src/panels.js';
import { getNpfConstants } from '../src/npf-config.js';
import { login } from '../src/npf-session.js';
import { BROWSER_HEADERS } from '../src/upstream-headers.js';

const only = process.argv.slice(2).find((a) => !a.startsWith('-'));
const line = (mark, text, hint) => console.log(`  ${mark}  ${text}${hint ? `\n        → ${hint}` : ''}`);
const ok = (text) => line('ok  ', text);
const bad = (text, hint) => line('FAIL', text, hint);

// Node reports every outbound failure as "fetch failed"; the cause is one
// level down. These are the ones that actually happen on a fresh server.
function explain(err) {
  const code = err?.cause?.code ?? err?.code ?? '';
  const causes = {
    ENOTFOUND: ['name does not resolve', 'Check the panel URL for a typo, and that the box has a working resolver (resolvectl status).'],
    EAI_AGAIN: ['DNS lookup failed', 'The resolver is not answering. On systemd, a sandboxed unit that cannot reach systemd-resolved fails exactly like this.'],
    ETIMEDOUT: ['connection timed out', 'Outbound 443 is blocked. Open it in the Azure NSG (outbound rule, port 443) and in ufw if it is on.'],
    ECONNREFUSED: ['connection refused', 'Something is listening but rejecting — usually a proxy. Check http_proxy/https_proxy in the unit environment.'],
    ECONNRESET: ['connection reset mid-request', 'A firewall or TLS-inspecting proxy is cutting the connection.'],
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: ['TLS certificate could not be verified', 'Install ca-certificates: sudo apt install --reinstall ca-certificates.'],
    CERT_HAS_EXPIRED: ['TLS certificate rejected as expired', 'Check the server clock (timedatectl) and update ca-certificates.'],
  };
  const [what, fix] = causes[code] ?? [err?.cause?.message ?? err.message, null];
  return { what: code ? `${what} (${code})` : what, fix };
}

async function reachPanel(panel) {
  console.log(`\n${panel.label}  ${panel.origin}  (/p/${panel.slug}/)`);
  const host = new URL(panel.origin).hostname;

  // Split out on purpose: resolution and connection fail for different
  // reasons and get fixed in different places.
  try {
    const all = await lookup(host, { all: true });
    ok(`${host} resolves to ${all.map((a) => a.address).join(', ')}`);
  } catch (err) {
    const { what, fix } = explain(err);
    bad(`${host}: ${what}`, fix);
    return false;
  }

  let html;
  try {
    const res = await fetch(`${panel.origin}/`, { headers: BROWSER_HEADERS });
    html = await res.text();
    if (!res.ok) {
      bad(
        `GET ${panel.origin}/ returned HTTP ${res.status}`,
        res.status === 403 || res.status === 503
          ? 'The vendor is refusing this server. Datacenter addresses are often blocked where an office address is not — ask NoPaperForms to allow this IP.'
          : 'This is the vendor answering, not the gateway. Open the URL in a browser to see what it says.',
      );
      return false;
    }
    ok(`GET ${panel.origin}/ → 200, ${html.length.toLocaleString()} bytes`);
  } catch (err) {
    const { what, fix } = explain(err);
    bad(`GET ${panel.origin}/ failed: ${what}`, fix);
    return false;
  }

  // The gateway rewrites this file. Not finding it means the page would load
  // and then sit there talking to the vendor instead of to us.
  if (/src="main\.[a-f0-9]+\.js"/.test(html)) ok('main bundle located in index.html');
  else bad('no main.*.js in index.html', 'The vendor changed their build. The rewrite in src/npf-config.js needs updating.');

  const npf = await getNpfConstants(panel.origin);
  ok(`API origin ${npf.apiOrigin}, environment ${npf.environment}`);

  try {
    await login(panel);
    ok(`signed in to ${panel.label} with the stored credentials`);
  } catch (err) {
    const { what, fix } = explain(err);
    bad(
      `upstream login failed: ${err.name === 'NpfLoginError' ? err.message : what}`,
      err.name === 'NpfLoginError'
        ? 'The vendor answered, so the network is fine. The stored username or password is wrong — re-enter it in /admin.'
        : fix,
    );
    return false;
  }

  return true;
}

const panels = (await listPanelsWithSecrets()).filter((p) => p.active);
const chosen = only ? panels.filter((p) => p.slug === only || p.label.toLowerCase() === only.toLowerCase()) : panels;

if (chosen.length === 0) {
  console.log(only ? `\nNo active panel matches "${only}".\n` : '\nNo active panels. Add one in /admin.\n');
  process.exit(1);
}

const results = [];
for (const panel of chosen) results.push(await reachPanel(panel));

const broken = results.filter((r) => !r).length;
console.log(
  broken
    ? `\n  ${broken} of ${results.length} panel(s) unreachable — the first FAIL above is the one to fix.\n`
    : `\n  All ${results.length} panel(s) reachable. A 502 now would be something else; check journalctl -u panel.\n`,
);
process.exit(broken ? 1 : 0);
