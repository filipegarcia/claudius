/**
 * CC 2.1.314 — "Fixed model IDs spelled with a dot behind an LLM gateway,
 * such as `claude-opus-4.8`, being treated as an older model with the wrong
 * context window, output limit, effort, thinking mode and cost".
 *
 * Context window, output limit, effort and thinking come from the engine
 * (`supportedModels()` / `modelUsage`), so the engine fix covers them. Cost is
 * Claudius's own: its pricing tables match model families by *dashed*
 * substring (`opus-5-5` before `opus-5`), so a dotted gateway id fell
 * through to the older entry (`claude-opus-5.5` priced as Opus 5).
 *
 * Rewrites only a `[claude-]<family>-<major>.<minor>` version dot to a dash
 * (gateways also send bare `sonnet-5.5`).
 * Every other dot is left alone: `us.anthropic.` / `anthropic.` provider
 * prefixes, `-v1:0` suffixes, and legacy ids like `claude-2.1` or
 * `claude-instant-1.2`. Date suffixes are kept (unlike `canonicalModelId`),
 * because the more specific pricing keys depend on them.
 */
const DOTTED_VERSION = /\b((?:claude-)?(?:opus|sonnet|haiku|fable|mythos)-\d+)\.(\d+)/gi;

export function normalizeDottedModelVersion(model: string): string {
  return model.replace(DOTTED_VERSION, "$1-$2");
}

/**
 * CC 2.1.316 parity — "[VSCode] Fixed the missing Effort slider, Ultracode
 * switch and model name when the model setting has the [1m] tag, such as
 * opus[1m]".
 *
 * The engine's `supportedModels()` drops the `[1m]` tag from a row's `value`
 * where it has no effect (Opus 5.5 is natively 1M), so a session on
 * `opus[1m]` matched no row by exact `value` and the picker lost the Effort
 * row, the Ultracode chip/toggle, the Fast toggle and the row's check mark.
 *
 * Lookup order: exact `value` first (so when both `opus` and `opus[1m]` are
 * listed, each keeps its own row). Only when `current` carries the `[1m]`
 * tag, fall back to a case-insensitive match with the tag stripped from both
 * sides, then to the row whose `resolvedModel` equals `current` without the
 * tag (`claude-opus-5-5[1m]` → the `opus` row resolving to
 * `claude-opus-5-5`), preferring any row over the engine's synthetic
 * `default` row resolving to the same id. Untagged ids keep today's exact-only behaviour. Only
 * the lookup changes; what's persisted / sent to the engine is untouched.
 */
const ONE_M_TAG = /\[1m\]$/i;

export function stripOneMTag(model: string): string {
  return model.trim().replace(ONE_M_TAG, "");
}

export function findModelEntry<T extends { value: string; resolvedModel?: string }>(
  models: readonly T[] | null | undefined,
  current: string | null | undefined,
): T | null {
  if (!models || !current) return null;
  const exact = models.find((m) => m.value === current);
  if (exact) return exact;
  if (!ONE_M_TAG.test(current.trim())) return null;
  const bare = stripOneMTag(current).toLowerCase();
  const byValue = models.find((m) => stripOneMTag(m.value).toLowerCase() === bare);
  if (byValue) return byValue;
  // The engine always lists a synthetic `{ value: "default", resolvedModel:
  // <default model> }` row first, so a plain `find` would check Default for
  // `claude-opus-5-5[1m]` even when an explicit `opus` row resolves to the
  // same id. Prefer any non-default row; Default only when nothing else
  // resolves there.
  const byResolved = models.filter(
    (m) => !!m.resolvedModel && stripOneMTag(m.resolvedModel).toLowerCase() === bare,
  );
  return byResolved.find((m) => m.value !== "default") ?? byResolved[0] ?? null;
}
