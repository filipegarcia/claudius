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
 * Claude Code 2.1.271 extended the multiplier from a discount-only knob
 * (< 1) to also support values above 1, up to 10x, for marked-up internal
 * chargeback rates. `applyModelPricing` clamps to that ceiling
 * ({@link MODEL_PRICING_MULTIPLIER_MAX}) so a hand-edited or managed
 * `settings.json` can't push a session's displayed cost to an arbitrary
 * multiple — same ceiling the Settings UI enforces client-side.
 *
 * Scoped to the Cost page only (see run-notes for 2.1.245) — the
 * StatusLine's live per-turn `$` tile reconciles to the SDK's own
 * authoritative `total_cost_usd` within seconds of every turn, so an
 * override there would flicker and then get silently overwritten.
 */

import { resolveSettings } from "@anthropic-ai/claude-agent-sdk";
import { MODEL_PRICING_MULTIPLIER_MAX } from "@/lib/shared/cost-pricing";

/** $/MT (per-million-token) rate overrides for one model. Any subset. */
export type ModelPricingRate = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
};

/**
 * The SDK's real per-model override shape (CC 2.1.271, `sdk.d.ts` `modelPricing
 * .overrides`): all four $/MT rates required, and a single `cacheWrite` that
 * prices BOTH the 5-minute and 1-hour cache writes.
 */
export type ModelPricingOverrideRate = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

export type ModelPricingSettings = {
  /**
   * CC 2.1.271 — the SDK's `modelPricing.multiplier` (0,10]: scales every
   * computed cost, matched or not. Takes precedence over the legacy
   * `discountMultiplier` below.
   */
  multiplier?: number;
  /**
   * CC 2.1.271 — the SDK's `modelPricing.overrides`: per-model $/MT rates keyed
   * by model id/alias (matched exact-first, then substring). Takes precedence
   * over the legacy `rates` below.
   */
  overrides?: Record<string, ModelPricingOverrideRate>;

  // ── Legacy Claudius keys, still read for back-compat with existing
  // settings.json. New configs should use `multiplier`/`overrides` (the keys
  // the engine itself honors). ──
  /** @deprecated use {@link multiplier}. */
  discountMultiplier?: number;
  /** @deprecated use {@link overrides}. */
  rates?: Record<string, ModelPricingRate>;
};

/**
 * Collapse the SDK `overrides` and the legacy `rates` into the internal
 * `ModelPricingRate` shape `costFromOverrideRate` consumes. The SDK's single
 * `cacheWrite` maps to the internal `cacheWrite5m` slot (cost-aggregate carries
 * one `cacheWrite` token bucket). `overrides` wins over legacy `rates`.
 */
export function effectiveOverrideRates(
  pricing: ModelPricingSettings,
): Record<string, ModelPricingRate> | undefined {
  if (pricing.overrides && Object.keys(pricing.overrides).length > 0) {
    const out: Record<string, ModelPricingRate> = {};
    for (const [key, r] of Object.entries(pricing.overrides)) {
      out[key] = { input: r.input, output: r.output, cacheRead: r.cacheRead, cacheWrite5m: r.cacheWrite };
    }
    return out;
  }
  return pricing.rates;
}

/** The effective multiplier — SDK `multiplier` preferred over legacy `discountMultiplier`. */
export function effectiveMultiplier(pricing: ModelPricingSettings): number | undefined {
  return pricing.multiplier ?? pricing.discountMultiplier;
}

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
 * regardless of whether a per-model rate matched. The multiplier clamps to
 * {@link MODEL_PRICING_MULTIPLIER_MAX} (Claude Code 2.1.271) — a value
 * above that ceiling behaves as if it were exactly the ceiling, rather than
 * scaling cost figures without bound.
 */
export function applyModelPricing(
  baseUsd: number,
  model: string,
  tokens: OverrideTokens,
  pricing: ModelPricingSettings | undefined,
): number {
  if (!pricing) return baseUsd;
  const rate = matchModelPricingRate(model, effectiveOverrideRates(pricing));
  const usd = rate ? costFromOverrideRate(rate, tokens) : baseUsd;
  const mult = effectiveMultiplier(pricing);
  if (typeof mult !== "number" || !Number.isFinite(mult) || mult <= 0) return usd;
  return usd * Math.min(mult, MODEL_PRICING_MULTIPLIER_MAX);
}

/**
 * CC 2.1.271 — the engine honors `modelPricing` ONLY from managed/policy tiers
 * (managed-settings.json, MDM, `--settings`), ignoring user/project/local. The
 * Cost page previously read only user scope, so an MDM/gateway-pushed rate was
 * ignored. Resolve the effective settings cascade (`resolveSettings`, alpha)
 * and return `modelPricing` from the highest-precedence managed/flag source
 * that sets it — or undefined when none does (caller falls back to Claudius's
 * own user-scope setting). Best-effort: a resolution error yields undefined.
 */
export async function resolveManagedModelPricing(
  cwd: string,
): Promise<ModelPricingSettings | undefined> {
  try {
    const resolved = await resolveSettings({ cwd });
    // sources are low→high precedence; walk from the top so the winning
    // managed tier is taken first.
    for (let i = resolved.sources.length - 1; i >= 0; i--) {
      const src = resolved.sources[i];
      const mp = (src?.settings as { modelPricing?: ModelPricingSettings } | undefined)?.modelPricing;
      if ((src?.source === "managed" || src?.source === "flag") && mp) {
        return mp;
      }
    }
  } catch {
    // resolveSettings is alpha / may be unavailable — treat as no managed override.
  }
  return undefined;
}

/** True when `modelPricing` has anything configured worth noting in the UI. */
export function hasModelPricingOverride(pricing: ModelPricingSettings | undefined): boolean {
  if (!pricing) return false;
  const mult = effectiveMultiplier(pricing);
  const rates = effectiveOverrideRates(pricing);
  return (
    (typeof mult === "number" && mult > 0) || Boolean(rates && Object.keys(rates).length > 0)
  );
}
