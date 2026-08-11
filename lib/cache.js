// lib/cache.js
// Shared cache backed by Upstash Redis REST (also works with Vercel KV — same REST interface).
// Node ESM, zero npm deps, plain fetch. Fails OPEN: if the store is unreachable or
// unconfigured, callers transparently fall through to the source of truth (Smartlead).
//
// Env (either naming works):
//   UPSTASH_REDIS_REST_URL   / KV_REST_API_URL
//   UPSTASH_REDIS_REST_TOKEN / KV_REST_API_TOKEN

const REST_URL =
  process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || "";
const REST_TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || "";

export const cacheEnabled = Boolean(REST_URL && REST_TOKEN);

/**
 * Execute one Redis command via the Upstash REST endpoint.
 * Command is an array, e.g. ["GET","key"] or ["SET","key","val","EX","120"].
 * Returns the raw `result` field, or null on any failure (fail-open).
 */
export async function redis(command, { timeoutMs = 1500 } = {}) {
  if (!cacheEnabled) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(REST_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${REST_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(command),
      signal: ctrl.signal,
    });
    if (!r.ok) return null;
    const json = await r.json();
    return json?.result ?? null;
  } catch {
    // Network error, timeout, abort — treat as a miss, never throw.
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Read + JSON-parse a key. Returns null on miss or any error. */
export async function cacheGet(key) {
  const v = await redis(["GET", key]);
  if (v == null) return null;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

/** Write a JSON-serialisable value with a TTL (seconds). Never throws. */
export async function cacheSet(key, value, ttlSeconds) {
  if (value == null) return; // never cache empties
  await redis(["SET", key, JSON.stringify(value), "EX", String(ttlSeconds)]);
}

/** Delete one or more keys. Never throws. */
export async function cacheDel(...keys) {
  const flat = keys.flat().filter(Boolean);
  if (flat.length) await redis(["DEL", ...flat]);
}
