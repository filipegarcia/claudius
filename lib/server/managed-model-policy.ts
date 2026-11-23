import { matchDeniedModels, resolveSettings } from "@anthropic-ai/claude-agent-sdk";

/**
 * CC 2.1.283 — the managed `deniedModels` list and `availableModelsMatch` mode.
 * Read from the managed/policy tier only (via `resolveSettings`, alpha) —
 * these are managed-settings keys the engine honors from managed sources. Used
 * to hide an always-shown model-picker alias the org has denied. Best-effort:
 * a resolution error or no managed value yields empty defaults.
 */
export type ManagedModelPolicy = {
  deniedModels: string[] | undefined;
  availableModelsMatch: "prefix" | "exact";
  /**
   * SDK 0.3.323 `machinePolicy.didNotLoad` — kinds of machine-policy source that
   * may exist but did not load (`profile` / `registry` / `file`). `false` is no
   * proof of a clean load. When non-empty, `deniedModels` above may be missing
   * a managed list the org actually set.
   */
  didNotLoad: false | Array<"profile" | "registry" | "file">;
};

export async function resolveManagedModelPolicy(cwd: string): Promise<ManagedModelPolicy> {
  const out: ManagedModelPolicy = { deniedModels: undefined, availableModelsMatch: "prefix", didNotLoad: false };
  try {
    const resolved = await resolveSettings({ cwd });
    out.didNotLoad = resolved.machinePolicy?.didNotLoad ?? false;
    if (out.didNotLoad) {
      console.warn(
        `[managed-model-policy] machine policy source(s) did not load (${out.didNotLoad.join(", ")}); managed deniedModels may be incomplete`,
      );
    }
    for (let i = resolved.sources.length - 1; i >= 0; i--) {
      const src = resolved.sources[i];
      if (src?.source !== "managed" && src?.source !== "flag") continue;
      const s = src.settings as { deniedModels?: unknown; availableModelsMatch?: unknown } | undefined;
      if (out.deniedModels === undefined && Array.isArray(s?.deniedModels)) {
        out.deniedModels = s!.deniedModels.filter((m): m is string => typeof m === "string");
      }
      if (s?.availableModelsMatch === "exact") out.availableModelsMatch = "exact";
    }
  } catch {
    // resolveSettings is alpha / may be unavailable — treat as no managed policy.
  }
  return out;
}

/**
 * SDK 0.3.323 `matchDeniedModels()` (alpha) — which of `models` the managed
 * `deniedModels` list blocks, by Claude Code's own entry rules. Authoritative
 * for `true` only: the SDK says `false` promises nothing, so callers must OR it
 * with Claudius's own matcher and never let it un-deny. Best-effort — any
 * failure yields all-false.
 */
export async function matchManagedDeniedModels(
  models: readonly string[],
  deniedModels: string[] | undefined,
): Promise<boolean[]> {
  const none = models.map(() => false);
  if (!deniedModels || deniedModels.length === 0 || models.length === 0) return none;
  try {
    const res = await matchDeniedModels(models, deniedModels);
    return models.map((_, i) => res.denied[i] === true);
  } catch {
    return none;
  }
}
