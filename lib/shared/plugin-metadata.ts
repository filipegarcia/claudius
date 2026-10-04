/**
 * CC 2.1.265 (G2) — plugin display metadata prefers the marketplace entry,
 * then falls back to the plugin's own `.claude-plugin/plugin.json`.
 *
 * A marketplace.json entry may omit `description` / `displayName` for a plugin
 * whose metadata lives only in its `plugin.json`. Claude Code reads that file
 * as a fallback; Claudius previously read the marketplace entry only, so such
 * plugins showed a bare name in Discover and the Installed tab.
 *
 * Pure + dependency-free: the path derivation and the precedence merge are
 * unit-testable; the server does the actual file read.
 */

/** A `plugin.json`-ish object (only the display fields we read). */
export type PluginManifest = {
  name?: unknown;
  description?: unknown;
  displayName?: unknown;
};

/**
 * The plugin's directory, relative to its marketplace root, from a
 * marketplace.json entry's `source`. The field is either a bare relative path
 * string (`"./plugins/foo"`) or an object whose `path` names the subdir
 * (`{source:"git-subdir", path:"plugins/foo", …}`). A leading `./` is stripped.
 * Returns `null` when no local subdir can be derived (e.g. a remote-only
 * source with no `path`).
 */
export function pluginSubdirFromSource(source: unknown): string | null {
  const raw =
    typeof source === "string"
      ? source
      : source && typeof source === "object" && typeof (source as { path?: unknown }).path === "string"
        ? ((source as { path: string }).path)
        : null;
  if (!raw) return null;
  const trimmed = raw.replace(/^\.\//, "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

function nonEmpty(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v : undefined;
}

/**
 * Merge display metadata with marketplace-entry-wins precedence, falling back
 * to the plugin's own manifest. Either argument may be `undefined`.
 */
export function mergePluginMeta(
  entry: { description?: unknown; displayName?: unknown } | undefined,
  manifest: PluginManifest | undefined,
): { description?: string; displayName?: string } {
  return {
    description: nonEmpty(entry?.description) ?? nonEmpty(manifest?.description),
    displayName: nonEmpty(entry?.displayName) ?? nonEmpty(manifest?.displayName),
  };
}
