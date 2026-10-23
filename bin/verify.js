#!/usr/bin/env node
// Signs in to every configured panel and reports what came back.
// One attempt per panel: repeated failures against a real account risk a lock.
import { listPanelsWithSecrets } from '../src/panels.js';
import { getNpfConstants } from '../src/npf-config.js';
import { login } from '../src/npf-session.js';

const panels = await listPanelsWithSecrets();

if (panels.length === 0) {
  console.log('\nNo panels configured yet. Add one at /admin.\n');
  process.exit(0);
}

console.log(`\nChecking ${panels.length} panel(s)...\n`);
let failures = 0;

for (const panel of panels) {
  console.log(`── ${panel.label}  (${panel.origin})`);
  console.log(`   account   ${panel.username}`);

  try {
    const npf = await getNpfConstants(panel.origin);
    console.log(`   api       ${npf.apiOrigin}`);
    console.log(`   key       ${npf.accessKey} / ${npf.environment}`);

    const token = await login(panel);
    console.log(`   login     OK — token received (${token.length} chars)\n`);
  } catch (err) {
    failures += 1;
    console.error(`   login     FAILED — ${err.message}`);
    if (err.detail) {
      console.error(`   HTTP      ${err.detail.httpStatus}  ${err.detail.contentType}`);
      console.error(`   body      ${err.detail.body}`);
    }
    console.error('');
  }
}

if (failures) {
  console.error(`${failures} panel(s) failed.

  403 / "Forbidden"      a filter rejected us before any password check
  "incorrect"            the username or password for that panel is wrong
  HTML body              a WAF challenge page sits in front of the API
`);
  process.exit(1);
}

console.log('All panels reachable.\n');
