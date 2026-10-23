import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

// Two backends behind one interface.
//
//   file   — JSON documents on disk. The default: a VPS, a laptop, a container
//            with a volume. Simple, inspectable, no network.
//   redis  — Upstash/Vercel KV over REST. Required on serverless hosts, where
//            the filesystem is read-only and no two requests share memory.
//
// Everything here is async so callers don't change when the backend does.

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';

/* ── file backend ────────────────────────────────────────────────────── */

function fileBackend() {
  const DATA_DIR = process.env.GW_DATA_DIR ? resolve(process.env.GW_DATA_DIR) : join(PROJECT_ROOT, 'data');
  mkdirSync(DATA_DIR, { recursive: true });

  const sessions = new Map();
  const counters = new Map();
  const cache = new Map();

  return {
    name: 'file',
    location: DATA_DIR,

    async readDoc(name, fallback) {
      const file = join(DATA_DIR, `${name}.json`);
      if (!existsSync(file)) return fallback;
      try {
        return JSON.parse(readFileSync(file, 'utf8'));
      } catch (err) {
        // Stopping beats handing back an empty list and letting the caller
        // overwrite a file that merely failed to parse.
        throw new Error(`${name}.json is unreadable (${err.message}) — fix or remove it`);
      }
    },

    async writeDoc(name, value) {
      // Write beside the target and rename, so a crash mid-write cannot leave
      // a truncated user or panel list behind.
      const file = join(DATA_DIR, `${name}.json`);
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
      renameSync(tmp, file);
    },

    async appendLog(name, entry) {
      appendFileSync(join(DATA_DIR, `${name}.log`), JSON.stringify(entry) + '\n');
    },

    async readLog(name, limit) {
      const file = join(DATA_DIR, `${name}.log`);
      if (!existsSync(file)) return [];
      return readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .slice(-limit)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .reverse();
    },

    async getSession(id) {
      const hit = sessions.get(id);
      if (!hit) return null;
      if (Date.now() > hit.expiresAt) {
        sessions.delete(id);
        return null;
      }
      return hit.data;
    },

    async setSession(id, data, ttlMs) {
      sessions.set(id, { data, expiresAt: Date.now() + ttlMs });
    },

    async deleteSession(id) {
      sessions.delete(id);
    },

    async listSessions() {
      const now = Date.now();
      const out = [];
      for (const [id, hit] of sessions) {
        if (now > hit.expiresAt) sessions.delete(id);
        else out.push({ id, ...hit.data });
      }
      return out;
    },

    async deleteSessionsForUser(userId) {
      for (const [id, hit] of sessions) {
        if (hit.data.userId === userId) sessions.delete(id);
      }
    },

    async bumpCounter(name, ttlMs) {
      const now = Date.now();
      const hit = counters.get(name);
      if (!hit || now > hit.expiresAt) {
        counters.set(name, { count: 1, expiresAt: now + ttlMs });
        return 1;
      }
      hit.count += 1;
      return hit.count;
    },

    async clearCounter(name) {
      counters.delete(name);
    },

    async getCache(name) {
      const hit = cache.get(name);
      if (!hit) return null;
      if (Date.now() > hit.expiresAt) {
        cache.delete(name);
        return null;
      }
      return hit.value;
    },

    async setCache(name, value, ttlMs) {
      cache.set(name, { value, expiresAt: Date.now() + ttlMs });
    },

    async deleteCache(name) {
      cache.delete(name);
    },
  };
}

/* ── redis backend ───────────────────────────────────────────────────── */

function redisBackend() {
  async function command(...args) {
    const res = await fetch(REDIS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args.map(String)),
    });
    if (!res.ok) throw new Error(`Redis ${args[0]} failed: HTTP ${res.status} ${await res.text()}`);
    const { result, error } = await res.json();
    if (error) throw new Error(`Redis ${args[0]} failed: ${error}`);
    return result;
  }

  const key = (name) => `gw:${name}`;

  return {
    name: 'redis',
    location: new URL(REDIS_URL).host,

    async readDoc(name, fallback) {
      const raw = await command('GET', key(`doc:${name}`));
      if (raw === null || raw === undefined) return fallback;
      try {
        return typeof raw === 'string' ? JSON.parse(raw) : raw;
      } catch (err) {
        throw new Error(`stored ${name} is unreadable (${err.message})`);
      }
    },

    async writeDoc(name, value) {
      await command('SET', key(`doc:${name}`), JSON.stringify(value));
    },

    async appendLog(name, entry) {
      const list = key(`log:${name}`);
      await command('LPUSH', list, JSON.stringify(entry));
      // Keep the log bounded; nobody scrolls past a few thousand lines and an
      // unbounded list eventually costs real money.
      await command('LTRIM', list, 0, 4999);
    },

    async readLog(name, limit) {
      const rows = (await command('LRANGE', key(`log:${name}`), 0, limit - 1)) ?? [];
      return rows
        .map((row) => {
          try {
            return typeof row === 'string' ? JSON.parse(row) : row;
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    },

    async getSession(id) {
      const raw = await command('GET', key(`sess:${id}`));
      if (!raw) return null;
      return typeof raw === 'string' ? JSON.parse(raw) : raw;
    },

    async setSession(id, data, ttlMs) {
      await command('SET', key(`sess:${id}`), JSON.stringify(data), 'PX', Math.round(ttlMs));
      // A per-user index so revoking someone does not mean scanning every key.
      await command('SADD', key(`usess:${data.userId}`), id);
      await command('SADD', key('sess:index'), id);
    },

    async deleteSession(id) {
      const data = await this.getSession(id);
      await command('DEL', key(`sess:${id}`));
      await command('SREM', key('sess:index'), id);
      if (data?.userId) await command('SREM', key(`usess:${data.userId}`), id);
    },

    async listSessions() {
      const ids = (await command('SMEMBERS', key('sess:index'))) ?? [];
      const out = [];
      for (const id of ids) {
        const data = await this.getSession(id);
        // Expired keys vanish on their own; tidy the index as we notice them.
        if (data) out.push({ id, ...data });
        else await command('SREM', key('sess:index'), id);
      }
      return out;
    },

    async deleteSessionsForUser(userId) {
      const ids = (await command('SMEMBERS', key(`usess:${userId}`))) ?? [];
      for (const id of ids) {
        await command('DEL', key(`sess:${id}`));
        await command('SREM', key('sess:index'), id);
      }
      await command('DEL', key(`usess:${userId}`));
    },

    async bumpCounter(name, ttlMs) {
      const k = key(`ctr:${name}`);
      const count = await command('INCR', k);
      if (count === 1) await command('PEXPIRE', k, Math.round(ttlMs));
      return count;
    },

    async clearCounter(name) {
      await command('DEL', key(`ctr:${name}`));
    },

    async getCache(name) {
      const raw = await command('GET', key(`cache:${name}`));
      if (raw === null || raw === undefined) return null;
      try {
        return typeof raw === 'string' ? JSON.parse(raw) : raw;
      } catch {
        return null;
      }
    },

    async setCache(name, value, ttlMs) {
      await command('SET', key(`cache:${name}`), JSON.stringify(value), 'PX', Math.round(ttlMs));
    },

    async deleteCache(name) {
      await command('DEL', key(`cache:${name}`));
    },
  };
}

function chooseBackend() {
  if (REDIS_URL && REDIS_TOKEN) return redisBackend();

  // Serverless hosts have a read-only filesystem and no shared memory between
  // invocations, so the file backend cannot work there. Say so plainly rather
  // than failing later with an EROFS deep in a write.
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    throw new Error(
      'No Redis configured. On a serverless host the gateway needs KV_REST_API_URL ' +
      'and KV_REST_API_TOKEN (Vercel KV) or UPSTASH_REDIS_REST_URL and ' +
      'UPSTASH_REDIS_REST_TOKEN (Upstash) — the filesystem there is read-only and ' +
      'nothing kept in memory survives between requests.',
    );
  }
  return fileBackend();
}

export const storage = chooseBackend();

/* ── document cache ──────────────────────────────────────────────────── */
// The proxy reads the user list on every forwarded request. Against Redis that
// is a network hop per API call, so documents are held briefly in process.
// Writes clear the entry, which makes changes immediate on a single host; on
// several hosts another instance can lag by up to the TTL. Session lookups are
// deliberately NOT cached, so disabling an account still takes effect at once.

const CACHE_TTL_MS = Number(process.env.DOC_CACHE_MS ?? 3000);
const docCache = new Map();

export async function getDoc(name, fallback) {
  const hit = docCache.get(name);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const value = await storage.readDoc(name, fallback);
  docCache.set(name, { value, at: Date.now() });
  return value;
}

export async function putDoc(name, value) {
  await storage.writeDoc(name, value);
  docCache.set(name, { value, at: Date.now() });
}

export function invalidateDoc(name) {
  docCache.delete(name);
}
