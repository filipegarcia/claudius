import { resolveSettings } from "@anthropic-ai/claude-agent-sdk";

/**
 * CC 2.1.331 — "[VSCode] Changed permission cards to show only Yes and No
 * when `allowManagedPermissionRulesOnly` is set and the card would offer an
 * allow rule".
 *
 * With that managed setting on, the engine ignores permission rules from
 * user, project, local and `--settings` files, so an "Always allow" click
 * writes a rule that never takes effect and the next identical call asks
 * again. The SDK documents the key as honored only "when true (and set in
 * managed settings)", so only `managed` sources count here: the same key in
 * a user, project or `--settings` (flag) file is ignored by the engine too.
 */
export function managedRulesOnlyFromSources(
  sources: ReadonlyArray<{ source?: string; settings?: unknown } | undefined>,
): boolean {
  return sources.some(
    (src) =>
      src?.source === "managed" &&
      (src.settings as { allowManagedPermissionRulesOnly?: unknown } | undefined)?.allowManagedPermissionRulesOnly ===
        true,
  );
}

/**
 * Whether managed settings for `cwd` turn on `allowManagedPermissionRulesOnly`.
 * Best-effort: `resolveSettings` is alpha, so an error reads as "not set" and
 * the card keeps its Always buttons, as it did before.
 */
export async function resolveManagedRulesOnly(cwd: string): Promise<boolean> {
  try {
    const resolved = await resolveSettings({ cwd });
    return managedRulesOnlyFromSources(resolved.sources);
  } catch {
    return false;
  }
}
