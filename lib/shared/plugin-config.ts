/**
 * CC 2.1.285 (G3) — the plugin options form. A plugin's `plugin.json` may
 * declare a `userConfig` schema (named options with type/title/description/
 * default/enum/sensitive); the chosen values persist under
 * `pluginConfigs.<pluginId>.options.<name>` in settings.json
 * (`pluginId` = `plugin@marketplace`). The sibling `.mcpServers` sub-key holds
 * per-MCP-server config and must be preserved across option edits.
 *
 * Sensitive options are NOT written to settings.json (the CLI routes them to
 * secure storage); the form renders them read-only. This module is the pure,
 * testable core: parse the manifest schema, read current values, and apply one
 * option edit while preserving everything else.
 */

export type PluginOptionType = "string" | "boolean" | "number" | "enum" | "array";
export type PluginOptionValue = string | number | boolean | string[];

export type PluginConfigOption = {
  name: string;
  type: PluginOptionType;
  title?: string;
  description?: string;
  default?: PluginOptionValue;
  /** Enum choices (present → `type` is "enum"). */
  options?: string[];
  /** Author-flagged secret — not persisted to settings.json. */
  sensitive?: boolean;
};

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/**
 * Parse a plugin manifest's `userConfig` map into a normalized option list.
 * An entry with a string `options` array becomes an `enum`; otherwise the
 * `type` maps to string/boolean/number/array, defaulting to string.
 */
export function parseUserConfig(manifest: unknown): PluginConfigOption[] {
  const uc = isObject(manifest) ? manifest.userConfig : undefined;
  if (!isObject(uc)) return [];
  const out: PluginConfigOption[] = [];
  for (const [name, raw] of Object.entries(uc)) {
    if (!isObject(raw)) continue;
    const enumOptions =
      Array.isArray(raw.options) && raw.options.every((x) => typeof x === "string")
        ? (raw.options as string[])
        : undefined;
    const t = raw.type;
    let type: PluginOptionType;
    if (enumOptions) type = "enum";
    else if (t === "boolean") type = "boolean";
    else if (t === "number" || t === "integer") type = "number";
    else if (t === "array") type = "array";
    else type = "string";
    const def = raw.default;
    out.push({
      name,
      type,
      title: str(raw.title),
      description: str(raw.description),
      default:
        typeof def === "string" || typeof def === "number" || typeof def === "boolean"
          ? def
          : Array.isArray(def) && def.every((x) => typeof x === "string")
            ? (def as string[])
            : undefined,
      options: enumOptions,
      sensitive: raw.sensitive === true,
    });
  }
  return out;
}

/** Current option VALUES for one plugin, from a `pluginConfigs` settings map. */
export function readPluginOptions(
  pluginConfigs: unknown,
  pluginId: string,
): Record<string, PluginOptionValue> {
  const entry = isObject(pluginConfigs) ? pluginConfigs[pluginId] : undefined;
  const opts = isObject(entry) ? entry.options : undefined;
  return isObject(opts) ? (opts as Record<string, PluginOptionValue>) : {};
}

/**
 * The value an option form control shows: the stored value when this plugin's
 * `options` map has one, else the manifest default.
 *
 * CC 2.1.295 parity — "Fixed plugin options named constructor or prototype
 * always reading as their default and never reloading the plugin when
 * edited". `values` is a plain JSON-parsed object, so `name in values` also
 * sees `Object.prototype` keys: an unset `constructor` (or `toString`,
 * `valueOf`, `hasOwnProperty`, …) option resolved to the inherited function
 * instead of its default — a boolean defaulting to true rendered unchecked
 * and a string rendered blank. Own keys only.
 */
export function currentOptionValue(
  values: Record<string, PluginOptionValue>,
  option: Pick<PluginConfigOption, "name" | "default">,
): PluginOptionValue | undefined {
  return Object.hasOwn(values, option.name) ? values[option.name] : option.default;
}

/**
 * Set (or, with `value === undefined`, clear) one option for a plugin,
 * preserving every other plugin entry, this plugin's `mcpServers` sub-key and
 * any other fields, and pruning emptied containers. Returns the next
 * `pluginConfigs` map, or `undefined` when it would be empty (so the caller
 * drops the key).
 */
export function setPluginOption(
  pluginConfigs: unknown,
  pluginId: string,
  name: string,
  value: PluginOptionValue | undefined,
): Record<string, unknown> | undefined {
  const base = isObject(pluginConfigs) ? { ...pluginConfigs } : {};
  const entry = isObject(base[pluginId]) ? { ...(base[pluginId] as Record<string, unknown>) } : {};
  const options = isObject(entry.options) ? { ...(entry.options as Record<string, unknown>) } : {};
  if (value === undefined) delete options[name];
  else options[name] = value;
  if (Object.keys(options).length > 0) entry.options = options;
  else delete entry.options;
  if (Object.keys(entry).length > 0) base[pluginId] = entry;
  else delete base[pluginId];
  return Object.keys(base).length > 0 ? base : undefined;
}
