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
 * - a plain object → on, unchanged from before. The engine reports no reason
 *   for that shape, so Claudius doesn't invent one.
 * - anything else (`false`, missing) → off.
 */
export type EnabledPluginState = "on" | "off" | "version-list";

export function enabledPluginState(value: unknown): EnabledPluginState {
  if (value === true) return "on";
  if (Array.isArray(value)) return "version-list";
  if (value !== null && typeof value === "object") return "on";
  return "off";
}

/** The engine's wording (`version-list-not-enabled`, 2.1.323 bundle). */
export const VERSION_LIST_NOT_ENABLED_MESSAGE =
  "Not enabled because its enabledPlugins entry is a version list. Only the value true turns on a marketplace plugin.";
