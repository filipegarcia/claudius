/**
 * LiteLLM-backed pricing for the cost page — the same source of truth ccusage
 * uses (https://github.com/ryoppippi/ccusage). Public list prices live in
 * LiteLLM's `model_prices_and_context_window.json`, keyed by model id, in **USD
 * per token** (not per million).
 *
 * Why not the old hardcoded $/MT table? It baked in *today's* Opus rates
 * ($15/$75) and applied them to every "opus" model — but e.g. `claude-opus-4-7`
 * actually lists at $5/$25. Driving cost from LiteLLM keeps Claudius in step
 * with ccusage and with Anthropic's published pricing as models change.
 *
 * Loading strategy (mirrors ccusage's fetch + `--offline` fallback):
 *   1. A pruned snapshot is bundled at `./litellm-prices.json` so we always
 *      have a usable table, even offline / in CI.
 *   2. If a fresher copy has been written to the on-disk cache, it is overlaid
 *      on top of the bundle.
 *   3. When the cache is missing or older than {@link REFRESH_TTL_MS}, a
 *      best-effort background refresh fetches the latest LiteLLM data and
 *      rewrites the cache. It never blocks a request and swallows all errors.
 *
 * This module is **Node-only** (reads/writes disk, hits the network). Never
 * import it from client code — the browser-safe estimator lives in
 * `@/lib/shared/cost-pricing`.
 */
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import bundledRaw from "./litellm-prices.json";

/** The pricing fields we read from a LiteLLM model entry (USD per token). */
export type LiteLlmPricing = {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_creation_input_token_cost?: number;
  cache_read_input_token_cost?: number;
  /** Long-context (>200k input tokens) tiers, present for some models. */
  input_cost_per_token_above_200k_tokens?: number;
  output_cost_per_token_above_200k_tokens?: number;
  cache_creation_input_token_cost_above_200k_tokens?: number;
  cache_read_input_token_cost_above_200k_tokens?: number;
};

export type PricingTable = Record<string, LiteLlmPricing>;

/** Token counts for a single assistant turn. */
export type Usage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
};

const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const DISK_CACHE = join(homedir(), ".claude", ".claudius-litellm-prices.json");
const REFRESH_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const FETCH_TIMEOUT_MS = 5_000;
/** Anthropic's long-context premium kicks in above 200k input tokens. */
const LONG_CONTEXT_THRESHOLD = 200_000;
const PRICE_FIELDS = [
  "input_cost_per_token",
  "output_cost_per_token",
  "cache_creation_input_token_cost",
  "cache_read_input_token_cost",
  "input_cost_per_token_above_200k_tokens",
  "output_cost_per_token_above_200k_tokens",
  "cache_creation_input_token_cost_above_200k_tokens",
  "cache_read_input_token_cost_above_200k_tokens",
] as const;

/** Strip `_meta` and non-pricing keys; keep only known numeric cost fields. */
function normalizeTable(raw: unknown): PricingTable {
  const out: PricingTable = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [model, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (model.startsWith("_")) continue; // _meta and friends
    if (!entry || typeof entry !== "object") continue;
    const src = entry as Record<string, unknown>;
    if (typeof src.input_cost_per_token !== "number") continue; // not a priced model
    const picked: LiteLlmPricing = {};
    for (const f of PRICE_FIELDS) {
      const v = src[f];
      if (typeof v === "number") picked[f] = v;
    }
    out[model] = picked;
  }
  return out;
}

const bundled: PricingTable = normalizeTable(bundledRaw);

let memo: PricingTable | null = null;
let refreshing = false;

/** Outcome of an explicit price refresh, surfaced to the API/UI. */
export type PriceRefreshResult = {
  /** True when fresh prices were fetched and cached. */
  ok: boolean;
  /** Number of priced models now available. */
  models: number;
  /** The fetch URL, or "disabled" when refresh is opted out. */
  source: string;
  /** ISO timestamp of the successful fetch. */
  fetchedAt?: string;
  /** Human-readable explanation when `ok` is false. */
  reason?: string;
};

/** Where the active pricing came from, for display next to the refresh action. */
export type PricingStatus = {
  source: "cache" | "bundle";
  models: number;
  /** ISO timestamp the on-disk cache was last written (cache source only). */
  fetchedAt?: string;
};

/** Disable the network refresh (offline mode / tests). */
function refreshDisabled(): boolean {
  return process.env.CLAUDIUS_DISABLE_PRICE_REFRESH === "1";
}

/**
 * Keep only Claude entries — Claudius wraps the Claude Agent SDK, so the
 * full multi-provider LiteLLM table (~2.3k models) is just noise. This mirrors
 * the scope of the bundled snapshot so the runtime cache and the bundle report
 * a consistent model count.
 */
function filterToClaude(table: PricingTable): PricingTable {
  const out: PricingTable = {};
  for (const [model, pricing] of Object.entries(table)) {
    if (model.toLowerCase().includes("claude")) out[model] = pricing;
  }
  return out;
}

/** Fetch + normalize the LiteLLM table. Returns null on any failure. */
async function fetchTableFromNetwork(): Promise<PricingTable | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(LITELLM_URL, { signal: controller.signal });
    if (!res.ok) return null;
    const table = filterToClaude(normalizeTable(await res.json()));
    return Object.keys(table).length === 0 ? null : table; // ignore garbage
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Write the fetched table to the on-disk cache and refresh the memo. */
async function persistTable(table: PricingTable): Promise<void> {
  await fs.mkdir(dirname(DISK_CACHE), { recursive: true });
  await fs.writeFile(DISK_CACHE, JSON.stringify(table), "utf8");
  memo = { ...bundled, ...table };
}

/** Background, best-effort refresh — never throws, never blocks a request. */
async function refreshFromNetwork(): Promise<void> {
  if (refreshing || refreshDisabled()) return;
  refreshing = true;
  try {
    const table = await fetchTableFromNetwork();
    if (table) await persistTable(table);
  } catch {
    // offline / rate-limited / malformed — keep using what we have
  } finally {
    refreshing = false;
  }
}

/**
 * Force an immediate price fetch (the `/api/cost/refresh-prices` endpoint).
 * Unlike the background refresh this ignores the TTL and reports a structured
 * result. Subsequent cost aggregation reprices from the updated table — no
 * re-parse of JSONL is needed, since the per-turn cache stores tokens, not USD.
 */
export async function refreshPricing(): Promise<PriceRefreshResult> {
  const current = Object.keys(memo ?? bundled).length;
  if (refreshDisabled()) {
    return {
      ok: false,
      models: current,
      source: "disabled",
      reason: "Price refresh is disabled (CLAUDIUS_DISABLE_PRICE_REFRESH=1).",
    };
  }
  refreshing = true;
  try {
    const table = await fetchTableFromNetwork();
    if (!table) {
      return {
        ok: false,
        models: current,
        source: LITELLM_URL,
        reason: "Could not fetch pricing from LiteLLM (offline, blocked, or rate-limited).",
      };
    }
    await persistTable(table);
    return {
      ok: true,
      models: Object.keys(table).length,
      source: LITELLM_URL,
      fetchedAt: new Date().toISOString(),
    };
  } finally {
    refreshing = false;
  }
}

/** Report whether the active prices come from the refreshed cache or the bundle. */
export async function getPricingStatus(): Promise<PricingStatus> {
  try {
    const [buf, stat] = await Promise.all([
      fs.readFile(DISK_CACHE, "utf8"),
      fs.stat(DISK_CACHE),
    ]);
    const models = Object.keys(normalizeTable(JSON.parse(buf))).length;
    if (models > 0) {
      return { source: "cache", models, fetchedAt: new Date(stat.mtimeMs).toISOString() };
    }
  } catch {
    // no/invalid cache — fall back to the bundled snapshot
  }
  return { source: "bundle", models: Object.keys(bundled).length };
}

/**
 * Resolve the active pricing table. Always returns synchronously-usable data
 * (bundle at minimum). Kicks off a background refresh when the disk cache is
 * stale; the refreshed values are picked up on a later call.
 */
export async function getPricingTable(): Promise<PricingTable> {
  if (memo) {
    // Re-validate staleness cheaply without re-reading the (already merged) cache.
    void maybeRefresh();
    return memo;
  }
  let table: PricingTable = { ...bundled };
  try {
    const [buf, stat] = await Promise.all([
      fs.readFile(DISK_CACHE, "utf8"),
      fs.stat(DISK_CACHE),
    ]);
    table = { ...bundled, ...normalizeTable(JSON.parse(buf)) };
    if (Date.now() - stat.mtimeMs > REFRESH_TTL_MS) void refreshFromNetwork();
  } catch {
    // no cache yet — use bundle and try to populate the cache in the background
    void refreshFromNetwork();
  }
  memo = table;
  return table;
}

async function maybeRefresh(): Promise<void> {
  try {
    const stat = await fs.stat(DISK_CACHE);
    if (Date.now() - stat.mtimeMs > REFRESH_TTL_MS) await refreshFromNetwork();
  } catch {
    await refreshFromNetwork();
  }
}

/**
 * Look up pricing for a model id. Tries an exact match, then strips a provider
 * prefix (`anthropic/claude-…`), then falls back to a same-family entry
 * (opus/sonnet/haiku). Returns `undefined` when nothing matches.
 */
export function priceForModel(
  model: string | undefined,
  table: PricingTable,
): LiteLlmPricing | undefined {
  if (!model) return undefined;
  const m = model.trim();
  if (table[m]) return table[m];

  const slash = m.lastIndexOf("/");
  if (slash >= 0) {
    const bare = m.slice(slash + 1);
    if (table[bare]) return table[bare];
  }

  const lower = m.toLowerCase();
  for (const family of ["opus", "sonnet", "haiku"] as const) {
    if (!lower.includes(family)) continue;
    // Prefer a canonical `claude-<family>-…` key; fall back to any match.
    let fallback: LiteLlmPricing | undefined;
    for (const [key, val] of Object.entries(table)) {
      const k = key.toLowerCase();
      if (!k.includes(family)) continue;
      if (k.startsWith(`claude-${family}`)) return val;
      fallback ??= val;
    }
    if (fallback) return fallback;
  }
  return undefined;
}

/**
 * Cost (USD) for one turn's token usage given its model's pricing. Applies the
 * long-context (>200k) tier when the entry's input footprint crosses the
 * threshold and the model publishes premium rates. Returns 0 when the model is
 * unpriced.
 */
export function costFromUsage(pricing: LiteLlmPricing | undefined, usage: Usage): number {
  if (!pricing) return 0;
  const longContext =
    usage.input + usage.cacheRead + usage.cacheCreation > LONG_CONTEXT_THRESHOLD;

  const inputRate =
    (longContext ? pricing.input_cost_per_token_above_200k_tokens : undefined) ??
    pricing.input_cost_per_token ??
    0;
  const outputRate =
    (longContext ? pricing.output_cost_per_token_above_200k_tokens : undefined) ??
    pricing.output_cost_per_token ??
    0;
  const cacheReadRate =
    (longContext ? pricing.cache_read_input_token_cost_above_200k_tokens : undefined) ??
    pricing.cache_read_input_token_cost ??
    0;
  const cacheWriteRate =
    (longContext ? pricing.cache_creation_input_token_cost_above_200k_tokens : undefined) ??
    pricing.cache_creation_input_token_cost ??
    0;

  return (
    usage.input * inputRate +
    usage.output * outputRate +
    usage.cacheRead * cacheReadRate +
    usage.cacheCreation * cacheWriteRate
  );
}

/** Test seam: reset the in-memory memoized table. */
export function __resetPricingMemo(): void {
  memo = null;
}
