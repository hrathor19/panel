import { app, ensureBootstrapped } from './app.js';
import { config } from './config.js';
import { listUsers } from './users.js';
import { listPanelsWithSecrets } from './panels.js';
import { login } from './npf-session.js';
import { storage } from './storage.js';

// Long-running host (VPS, container, laptop). On Vercel, api/index.js imports
// the app directly and this file never runs.

try {
  await ensureBootstrapped();
} catch (err) {
  console.error(`\n[gateway] cannot start: ${err.message}\n`);
  process.exit(1);
}

app.listen(config.port, async () => {
  console.log(`[gateway] listening on http://localhost:${config.port}`);
  console.log(`[gateway] storage: ${storage.name} (${storage.location})`);

  const [users, panels] = [await listUsers(), await listPanelsWithSecrets()];
  console.log(`[gateway] ${users.length} user(s), ${panels.length} panel(s)`);

  // Warm each panel, so the first person in does not wait on a login and a bad
  // credential shows up in the log now rather than at nine in the morning.
  for (const panel of panels.filter((p) => p.active)) {
    login(panel)
      .then(() => console.log(`[gateway] ${panel.label}: connected`))
      .catch((err) => console.error(`[gateway] ${panel.label}: ${err.message}`));
  }
});
