/**
 * CC 2.1.323 parity — "Fixed plugins with a version list in `enabledPlugins`
 * staying off with no message: /plugin and claude plugin list now say why".
 *
 * `enabledPlugins` values are `string[] | boolean | {…}` (sdk.d.ts: "Only
 * true turns on a marketplace plugin: a list of versions is accepted but
 * leaves it off"). Claudius's plugins page used to treat any truthy value as
 * on, so a version list showed a green scope badge and a checked "enabled
 * here" box for a plugin the engine never loads.
 *
 * - `true` → on.
 * - an array → `version-list`: off, with the engine's reason.
 * - anything else (`false`, a plain object, missing) → off. The engine only
 *   loads an entry whose value is exactly `true`; it gives no reason for an
 *   object, so neither does Claudius.
 */
export type EnabledPluginState = "on" | "off" | "version-list";

export function enabledPluginState(value: unknown): EnabledPluginState {
  if (value === true) return "on";
  if (Array.isArray(value)) return "version-list";
  return "off";
}

/** The engine's wording (`version-list-not-enabled`, 2.1.323 bundle). */
export const VERSION_LIST_NOT_ENABLED_MESSAGE =
  "Not enabled because its enabledPlugins entry is a version list. Only the value true turns on a marketplace plugin.";

export type PluginSettingsScope = "user" | "project" | "local";

/** Later scopes override earlier ones, key by key. */
const PRECEDENCE: Record<PluginSettingsScope, number> = { user: 0, project: 1, local: 2 };

/**
 * Whether the version-list note applies, and how to fix it from the tab the
 * user is on. `null` when no scope holds a version list, or when a scope
 * with higher precedence turns the plugin on with `true` (it then loads, so
 * the note would be wrong).
 */
export function versionListNote(
  versionListIn: readonly PluginSettingsScope[],
  enabledIn: readonly PluginSettingsScope[],
  activeScope: PluginSettingsScope,
): { scopes: PluginSettingsScope[]; fixHere: boolean } | null {
  if (versionListIn.length === 0) return null;
  const topList = Math.max(...versionListIn.map((s) => PRECEDENCE[s]));
  if (enabledIn.some((s) => PRECEDENCE[s] > topList)) return null;
  return { scopes: [...versionListIn], fixHere: versionListIn.includes(activeScope) };
}
