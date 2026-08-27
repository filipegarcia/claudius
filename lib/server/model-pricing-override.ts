/**
 * Org-contracted pricing override for the Cost page — Claude Code 2.1.243:
 * "Added modelPricing managed setting so an organization's contracted
 * per-model rates and discount multiplier are used for /cost, the status
 * line, and telemetry cost figures instead of list price."
 *
 * Claudius's Cost page (`app/[workspaceId]/cost/page.tsx`) already computes
 * spend from LiteLLM public list pricing (`lib/server/litellm-pricing.ts`).
 * This module is a thin override layer on top of that: when the user (or an
 * org, via a managed `settings.json`) configures `modelPricing`, matching
 * rows use the contracted $/MT rate instead of the list rate, and every row
 * (matched or not) gets the discount multiplier applied — mirroring the
 * upstream description ("per-model rates AND discount multiplier").
 *
 * Scoped to the Cost page only (see run-notes for 2.1.245) — the
 * StatusLine's live per-turn `$` tile reconciles to the SDK's own
 * authoritative `total_cost_usd` within seconds of every turn, so an
 * override there would flicker and then get silently overwritten.
 */

/** $/MT (per-million-token) rate overrides for one model. Any subset. */
export type ModelPricingRate = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
};

export type ModelPricingSettings = {
  /**
   * Multiplier applied to every computed cost figure, matched or not (e.g.
   * 0.9 for a 10% contracted discount). Applied last, after per-model rates.
   */
  discountMultiplier?: number;
  /**
   * Per-model $/MT overrides, keyed by a model id/alias substring — matched
   * the same permissive way `litellm-pricing.ts#priceForModel` matches
   * (exact key first, then substring-of-model-id).
   */
  rates?: Record<string, ModelPricingRate>;
};

/** Token counts for one turn, in the same shape `cost-aggregate.ts` already carries. */
export type OverrideTokens = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

/**
 * Find the override rate for a model id, if any. Exact key match first (so
 * a pinned id like `claude-opus-4-8` wins over a looser alias), then a
 * case-insensitive substring match (so `{"opus": {...}}` covers every Opus
 * snapshot) — mirrors `priceForModel`'s family-fallback behavior.
 */
export function matchModelPricingRate(
  model: string,
  rates: Record<string, ModelPricingRate> | undefined,
): ModelPricingRate | undefined {
  if (!rates) return undefined;
  if (rates[model]) return rates[model];
  const lower = model.toLowerCase();
  for (const [key, rate] of Object.entries(rates)) {
    if (lower.includes(key.toLowerCase())) return rate;
  }
  return undefined;
}

/** Cost (USD) for `tokens` using an org-contracted $/MT rate. */
export function costFromOverrideRate(rate: ModelPricingRate, tokens: OverrideTokens): number {
  return (
    (tokens.input * (rate.input ?? 0) +
      tokens.output * (rate.output ?? 0) +
      tokens.cacheRead * (rate.cacheRead ?? 0) +
      tokens.cacheWrite * (rate.cacheWrite5m ?? 0)) /
    1_000_000
  );
}

/**
 * Apply `modelPricing` to a single row's cost. `baseUsd` is whatever
 * `cost-aggregate.ts` would otherwise use (the JSONL's authoritative
 * `total_cost_usd`, or the LiteLLM-list-priced fallback) — replaced by a
 * matched per-model rate, then the discount multiplier is applied
 * regardless of whether a per-model rate matched.
 */
export function applyModelPricing(
  baseUsd: number,
  model: string,
  tokens: OverrideTokens,
  pricing: ModelPricingSettings | undefined,
): number {
  if (!pricing) return baseUsd;
  const rate = matchModelPricingRate(model, pricing.rates);
  const usd = rate ? costFromOverrideRate(rate, tokens) : baseUsd;
  const mult = pricing.discountMultiplier;
  return typeof mult === "number" && mult > 0 && Number.isFinite(mult) ? usd * mult : usd;
}

/** True when `modelPricing` has anything configured worth noting in the UI. */
export function hasModelPricingOverride(pricing: ModelPricingSettings | undefined): boolean {
  if (!pricing) return false;
  return (
    (typeof pricing.discountMultiplier === "number" && pricing.discountMultiplier > 0) ||
    Boolean(pricing.rates && Object.keys(pricing.rates).length > 0)
  );
}
