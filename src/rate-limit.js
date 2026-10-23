import { storage } from './storage.js';

// Login throttling. Counted per IP and per account: the IP limit slows a
// scripted sweep across many accounts, the account limit slows a guessing run
// against one. Both are deliberately generous enough that someone fumbling
// their own password a few times is never affected.
//
// Behind a shared office NAT the whole team looks like one IP, so the IP limit
// is the looser of the two — raise LOGIN_MAX_PER_IP if a large team trips it.
const WINDOW_MS = Number(process.env.LOGIN_WINDOW_MINUTES || 15) * 60 * 1000;
const PER_IP = Number(process.env.LOGIN_MAX_PER_IP || 40);
const PER_ACCOUNT = Number(process.env.LOGIN_MAX_PER_ACCOUNT || 8);

export async function checkLoginAllowed(ip, email) {
  const [ipHits, accountHits] = await Promise.all([
    storage.bumpCounter(`login:ip:${ip}`, WINDOW_MS),
    storage.bumpCounter(`login:acct:${String(email ?? '').toLowerCase()}`, WINDOW_MS),
  ]);

  if (ipHits > PER_IP || accountHits > PER_ACCOUNT) {
    return { allowed: false, retryAfterMinutes: Math.ceil(WINDOW_MS / 60000) };
  }
  return { allowed: true };
}

// A successful sign-in clears that account's counter, so someone who got their
// own password right on the fifth try is not locked out afterwards.
export async function clearLoginAttempts(email) {
  await storage.clearCounter(`login:acct:${String(email ?? '').toLowerCase()}`);
}
