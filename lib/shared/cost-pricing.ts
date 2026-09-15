/**
 * Approximate Anthropic public list pricing (USD per million tokens) as of
 * 2026-Q1. Numbers are *estimates* — the official source of truth is
 * https://www.anthropic.com/pricing and the user's `total_cost_usd` field on
 * live SDK result events. We use these to back-compute cost from the on-disk
 * JSONL, where only token counts are persisted.
 *
 * If a model isn't listed, we fall back to Sonnet 4 pricing (the most common
 * default).
 */

export type Pricing = {
  /** $/MT for fresh input. */
  input: number;
  /** $/MT for output (incl. thinking). */
  output: number;
  /** $/MT for cache read. */
  cacheRead: number;
  /** $/MT for cache write (5-minute TTL). */
  cacheWrite5m: number;
  /** $/MT for cache write (1-hour TTL). */
  cacheWrite1h: number;
};

const SONNET: Pricing = {
  input: 3,
  output: 15,
  cacheRead: 0.3,
  cacheWrite5m: 3.75,
  cacheWrite1h: 6,
};

const OPUS: Pricing = {
  input: 15,
  output: 75,
  cacheRead: 1.5,
  cacheWrite5m: 18.75,
  cacheWrite1h: 30,
};

const HAIKU: Pricing = {
  input: 1,
  output: 5,
  cacheRead: 0.1,
  cacheWrite5m: 1.25,
  cacheWrite1h: 2,
};

export function priceFor(model: string | undefined): Pricing {
  const m = (model ?? "").toLowerCase();
  if (m.includes("opus")) return OPUS;
  if (m.includes("haiku")) return HAIKU;
  return SONNET; // sonnet covers most defaults including unknown
}

export type TokenBreakdown = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
};

export function costFromTokens(model: string | undefined, t: TokenBreakdown): number {
  const p = priceFor(model);
  return (
    (t.input * p.input +
      t.output * p.output +
      t.cacheRead * p.cacheRead +
      t.cacheWrite5m * p.cacheWrite5m +
      t.cacheWrite1h * p.cacheWrite1h) /
    1_000_000
  );
}

/**
 * Ceiling for the `modelPricing.discountMultiplier` setting (Claude Code
 * 2.1.271 — "Added support for a multiplier above 1, up to 10, in the
 * modelPricing managed setting... for marked-up internal chargeback
 * rates"). Originally (2.1.243) the field only had to support a *discount*
 * (< 1); this release extends it to a markup use case, capped at 10x.
 * Shared between the server-side clamp (`lib/server/model-pricing-override.ts`)
 * and the client-side Settings input (`app/settings/page.tsx`) so both sides
 * agree on the same ceiling without either importing the other's module
 * (the override module is `lib/server/`-only; this file is browser-safe).
 */
export const MODEL_PRICING_MULTIPLIER_MAX = 10;
