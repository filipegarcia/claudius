/**
 * CC 2.1.299 parity — "Fixed a settings file being ignored when
 * enabledMcpjsonServers or disabledMcpjsonServers held a single server name
 * as a plain string".
 *
 * Claude Code now accepts a bare string where a `string[]` setting is
 * expected and reads it as a one-item list. The Settings catalog's
 * `string[]` field used to render any non-array as empty — while the row was
 * still badged as set — so a hand-written `"enabledMcpjsonServers": "fs"`
 * looked blank. This maps the stored value to the list the field shows;
 * editing the field then saves a proper array.
 *
 * Pure + dependency-free so it's unit-testable.
 */
export function stringListSettingValue(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string" && value.trim()) return [value];
  return [];
}
