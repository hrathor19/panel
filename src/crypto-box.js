import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from 'node:crypto';
import { config } from './config.js';

// Panel passwords sit on disk between restarts. Storing them in clear would
// undo the point of the gateway, so they are sealed with a key derived from
// SESSION_SECRET.
//
// The salt below is deliberately NOT renamed along with the project. It is an
// input to the key, not a label: change it and every stored panel password
// becomes unreadable and has to be entered again. Losing that secret means re-entering the panel passwords —
// it does not lock anyone out of the gateway itself.
const KEY = scryptSync(config.sessionSecret, 'npf-gateway-panel-credentials', 32);

export function seal(plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

export function open(sealed) {
  const raw = Buffer.from(sealed, 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ct = raw.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
