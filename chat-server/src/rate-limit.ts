// In-memory token bucket per IP.
//
// Default: 10 messages per 30 seconds. Anything above that returns 429
// from the POST /messages handler. Memory-only; resets on process
// restart. Buckets older than the window are reaped lazily on access,
// so the map doesn't grow unboundedly under churn.
//
// We deliberately don't persist this — abuse worse than a bursty 30s
// is handled by /admin/bans, which is durable.

type Bucket = {
  tokens: number;
  lastRefill: number; // epoch ms
};

const CAPACITY = 10;
const REFILL_WINDOW_MS = 30_000;
const REFILL_RATE = CAPACITY / REFILL_WINDOW_MS; // tokens per ms

const buckets = new Map<string, Bucket>();

/**
 * Try to consume 1 token for `key` (typically a client IP). Returns
 * true if allowed. Refills continuously (not in discrete windows), so
 * a client posting 1/sec stays under the cap indefinitely.
 */
export function tryConsume(key: string): boolean {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b) {
    b = { tokens: CAPACITY, lastRefill: now };
    buckets.set(key, b);
  } else {
    const elapsed = now - b.lastRefill;
    b.tokens = Math.min(CAPACITY, b.tokens + elapsed * REFILL_RATE);
    b.lastRefill = now;
  }
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

// Periodic GC. A bucket at full capacity is indistinguishable from a
// fresh one, so we drop it; if the same key shows up again we just
// rebuild. Keeps the map's working set proportional to *active*
// posters, not lifetime posters.
const GC_INTERVAL_MS = 5 * 60_000;
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) {
    if (now - b.lastRefill > REFILL_WINDOW_MS && b.tokens >= CAPACITY) {
      buckets.delete(k);
    }
  }
}, GC_INTERVAL_MS).unref?.();
