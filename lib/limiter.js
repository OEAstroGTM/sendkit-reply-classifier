// lib/limiter.js
// Cross-invocation Smartlead rate limiter, backed by the shared Redis store.
// Serverless functions don't share memory, so an in-process counter can't protect
// a global API budget — this keeps the count in Redis where every invocation sees it.
//
//   1. Fixed-window budget: cap outgoing Smartlead calls per rolling minute-window,
//      kept safely under Smartlead's hard 200/min so bursts don't trip 429.
//   2. Circuit breaker: when Smartlead returns 429, set a short cooldown flag that
//      every concurrent invocation honours, instead of all of them hammering.
//
// Fails OPEN: with no cache configured it allows everything, so behaviour is
// unchanged until you provision Redis.

import { redis, cacheEnabled } from "./cache.js";

const DEFAULT_LIMIT = Number(process.env.SMARTLEAD_RPM || 150); // headroom under 200
const WINDOW_SEC = 60;
const BREAKER_KEY = "sl:breaker";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function windowKey(nowSec) {
  return `sl:rate:${Math.floor(nowSec / WINDOW_SEC)}`;
}

/** Consume one unit of the per-minute budget. Fail-open when cache is off. */
export async function tryAcquire({ limit = DEFAULT_LIMIT } = {}) {
  if (!cacheEnabled) return { allowed: true, count: 0, limit, resetInSec: 0 };
  const nowSec = Math.floor(Date.now() / 1000);
  const key = windowKey(nowSec);
  const count = Number(await redis(["INCR", key])) || 0;
  if (count === 1) await redis(["EXPIRE", key, String(WINDOW_SEC)]);
  return {
    allowed: count <= limit,
    count,
    limit,
    resetInSec: WINDOW_SEC - (nowSec % WINDOW_SEC),
  };
}

/** Is Smartlead currently in a 429 cooldown set by another invocation? */
export async function inCooldown() {
  if (!cacheEnabled) return false;
  return (await redis(["GET", BREAKER_KEY])) != null;
}

/** Trip the breaker for `seconds` after a 429. All invocations back off. */
export async function tripBreaker(seconds = 15) {
  if (!cacheEnabled) return;
  await redis(["SET", BREAKER_KEY, String(Date.now()), "EX", String(seconds)]);
}

/**
 * Acquire a slot before a Smartlead call. Honours the breaker and waits briefly
 * for budget, but never long enough to blow the serverless timeout.
 * Throws RateLimitError if it can't get a slot — callers decide whether to serve
 * stale cache (reads) or surface a retryable error (writes).
 */
export async function acquire({ limit = DEFAULT_LIMIT, maxWaitMs = 2500 } = {}) {
  if (!cacheEnabled) return { allowed: true, count: 0, limit, resetInSec: 0 };
  const deadline = Date.now() + maxWaitMs;
  if (await inCooldown()) throw new RateLimitError("cooldown", 5);

  for (;;) {
    const s = await tryAcquire({ limit });
    if (s.allowed) return s;
    if (Date.now() >= deadline) throw new RateLimitError("budget_exhausted", s.resetInSec);
    await sleep(Math.min(300, Math.max(0, deadline - Date.now())));
  }
}

export class RateLimitError extends Error {
  constructor(reason, retryAfterSec = 5) {
    super(`smartlead rate limited: ${reason}`);
    this.name = "RateLimitError";
    this.reason = reason;
    this.retryAfterSec = retryAfterSec;
  }
}
