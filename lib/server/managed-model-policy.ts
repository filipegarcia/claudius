import { resolveSettings } from "@anthropic-ai/claude-agent-sdk";

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
};

export async function resolveManagedModelPolicy(cwd: string): Promise<ManagedModelPolicy> {
  const out: ManagedModelPolicy = { deniedModels: undefined, availableModelsMatch: "prefix" };
  try {
    const resolved = await resolveSettings({ cwd });
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
