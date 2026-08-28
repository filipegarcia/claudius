/**
 * CC parity 2.1.251: pure derivation for the "prompt cache" line the CLI
 * added to `/cost` (hit ratio, misses, tokens re-cached, warm/cold).
 *
 * Upstream's `/cost` line is computed CLI-side from data that never crosses
 * the wire to Claudius — there is no new field on
 * `Query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` for it
 * (checked against the latest published `@anthropic-ai/claude-agent-sdk`
 * `.d.ts`: the only "prompt cache" fields that exist anywhere in the SDK are
 * `prompt_cache_warm` / `prompt_cache_likely_expired` on the NEW
 * `PreModelSwitch` / `PostModelSwitch` / `SessionStart` HOOK INPUT payloads —
 * unrelated to `/cost` display and already bucket A). So this is reimplemented
 * entirely client-side from totals Claudius already has: `SessionUsage`'s
 * `inputTokens` / `cacheReadInputTokens` / `cacheCreationInputTokens`.
 *
 * CONSERVATIVE READING: these totals are cumulative for the whole session, not
 * per-turn, so a cumulative "warm/cold" derived here would reflect "has this
 * session ever hit cache" rather than a true last-turn warm/cold flag (which
 * would need per-turn granularity Claudius doesn't retain) — after one cache
 * hit it would stay pinned to "warm" for the rest of the session, reading as
 * live status when it isn't. `computePromptCacheStats` still returns `warm`
 * (and the raw `tokensRecached`/`cacheWriteTokens` split, which is just a
 * pass-through of the inputs) for completeness and testability, but
 * `CostOverlay` deliberately renders only `hitRatioPct`/`missRatioPct` — the
 * raw counts already have a home in the overlay's main stat grid (Cache
 * read / Cache writes), and the ratios convey the same "how warm is this
 * session" signal honestly without the misleading badge. See run-notes
 * Risks for the rejected per-turn alternative.
 */

export type PromptCacheStats = {
  /** Share of prompt tokens served from cache, 0-100. Null with no prompt tokens yet. */
  hitRatioPct: number | null;
  /** Share of prompt tokens that were NOT served from cache, 0-100. */
  missRatioPct: number | null;
  /** Cache-read tokens ("tokens re-cached"), i.e. cache hits. */
  tokensRecached: number;
  /** Cache-creation (cold write) tokens. */
  cacheWriteTokens: number;
  /**
   * Session-level warm/cold signal: true once any turn this session has hit
   * the cache. Not a live "is the cache warm right now" flag — see the
   * module doc comment.
   */
  warm: boolean;
};

export function computePromptCacheStats(usage: {
  inputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}): PromptCacheStats {
  const inputTokens = Math.max(0, usage.inputTokens);
  const cacheReadInputTokens = Math.max(0, usage.cacheReadInputTokens);
  const cacheCreationInputTokens = Math.max(0, usage.cacheCreationInputTokens);

  const totalPromptTokens = inputTokens + cacheReadInputTokens + cacheCreationInputTokens;
  const hitRatioPct = totalPromptTokens > 0 ? (cacheReadInputTokens / totalPromptTokens) * 100 : null;

  return {
    hitRatioPct,
    missRatioPct: hitRatioPct === null ? null : 100 - hitRatioPct,
    tokensRecached: cacheReadInputTokens,
    cacheWriteTokens: cacheCreationInputTokens,
    warm: cacheReadInputTokens > 0,
  };
}
