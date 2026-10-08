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

// CC 2.1.257/2.1.284/2.1.219/2.1.280 — current-generation list prices (per MT),
// from the LiteLLM table (verified against ~/.claude/.claudius-litellm-prices
// .json). Cache-write follows Anthropic's standard 1.25×(5m)/2×(1h) of input,
// matching the family entries above. Without these the estimator billed every
// opus at $15/$75 (≈3.75× high for Opus 5.5), every sonnet at $3/$15, and fable
// at Sonnet rates.
const OPUS_5_5: Pricing = { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 };
const OPUS_5: Pricing = { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 };
// Haiku 5.5 (CC 2.1.293): $0.10/$0.50 per MT. Prompts over 100K bill at
// $0.50/$2.50 upstream; this estimator has no per-request tiering, so it uses
// the base rate (the server-side LiteLLM path does tier per turn). Cache
// rates aren't published in the changelog: read at the usual 0.1x of input,
// write at the standard 1.25x (5m) / 2x (1h).
const HAIKU_5_5: Pricing = { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite5m: 0.125, cacheWrite1h: 0.2 };
// Sonnet 5 / 5.5 share a price point.
const SONNET_5: Pricing = { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 };
// Fable 5.1 (current). Fable 5 differs only in cache-read ($1.00); prior gen.
const FABLE_5_1: Pricing = { input: 10, output: 50, cacheRead: 0.25, cacheWrite5m: 12.5, cacheWrite1h: 20 };
const FABLE_5: Pricing = { input: 10, output: 50, cacheRead: 1, cacheWrite5m: 12.5, cacheWrite1h: 20 };

export function priceFor(model: string | undefined): Pricing {
  const m = (model ?? "").toLowerCase();
  // Specific current-gen ids before the generic family fallbacks (match the
  // more specific id first, e.g. opus-5-5 before opus-5 before opus).
  if (m.includes("opus-5-5")) return OPUS_5_5;
  if (m.includes("opus-5")) return OPUS_5;
  if (m.includes("opus")) return OPUS;
  if (m.includes("haiku-5")) return HAIKU_5_5; // CC 2.1.293
  if (m.includes("haiku")) return HAIKU;
  if (m.includes("fable-5-1") || m.includes("fable-5.1")) return FABLE_5_1;
  if (m.includes("fable")) return FABLE_5;
  if (m.includes("sonnet-5")) return SONNET_5; // sonnet-5 and sonnet-5-5
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

/**
 * CC 2.1.239 — US-only inference (data residency) carries a 1.1× premium. The
 * usage row's `inference_geo` (SDK `string | null`) names the residency; the
 * US-only value is `"us"`. Returns the multiplier to apply to a *token-computed*
 * cost estimate (the authoritative JSONL `total_cost_usd` already includes it,
 * so only the fallback estimate needs this). Any other value — `not_available`,
 * null, another region — carries no premium. Matching only the exact canonical
 * value avoids charging a phantom premium on an unrecognized token.
 */
export function inferenceGeoMultiplier(geo: string | null | undefined): number {
  return typeof geo === "string" && geo.toLowerCase() === "us" ? 1.1 : 1;
}
