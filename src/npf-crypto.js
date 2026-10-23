import { randomBytes, pbkdf2Sync, createCipheriv, createDecipheriv } from 'node:crypto';

// Mirrors the panel's client-side EncryptionService byte for byte. Its wire
// format is a single hex string:
//   iterations(10 chars, zero-padded) | salt(16B hex) | iv(16B hex) | ciphertext(hex)
// with the key derived PBKDF2-SHA256 down to 256 bits.
const ITERATIONS = 100000;
const KEY_BYTES = 32;
const ITER_LEN = 10;
const SALT_HEX = 32;
const IV_HEX = 32;

export function encryptPayload(plaintext, key) {
  const salt = randomBytes(16);
  const iv = randomBytes(16);
  const derived = pbkdf2Sync(key, salt, ITERATIONS, KEY_BYTES, 'sha256');

  const cipher = createCipheriv('aes-256-cbc', derived, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

  return (
    String(ITERATIONS).padStart(ITER_LEN, '0') +
    salt.toString('hex') +
    iv.toString('hex') +
    ciphertext.toString('hex')
  );
}

// The panel encrypts its login body before sending, so to read what the person
// typed into its own login form we have to undo it with the same parameters.
export function decryptPayload(wire, key) {
  const iterations = Number(wire.slice(0, ITER_LEN));
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 1_000_000) {
    throw new Error('bad iteration count');
  }

  const salt = Buffer.from(wire.slice(ITER_LEN, ITER_LEN + SALT_HEX), 'hex');
  const iv = Buffer.from(wire.slice(ITER_LEN + SALT_HEX, ITER_LEN + SALT_HEX + IV_HEX), 'hex');
  const ciphertext = Buffer.from(wire.slice(ITER_LEN + SALT_HEX + IV_HEX), 'hex');
  if (salt.length !== 16 || iv.length !== 16 || ciphertext.length === 0) {
    throw new Error('malformed payload');
  }

  const derived = pbkdf2Sync(key, salt, iterations, KEY_BYTES, 'sha256');
  const decipher = createDecipheriv('aes-256-cbc', derived, iv);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
