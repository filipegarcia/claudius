/**
 * Whether a settings object turns Auto mode off.
 *
 * SDK 0.3.312 added `permissions.disableAutoMode` (`'disable'`) alongside the
 * long-standing top-level `disableAutoMode`. Both are single-literal flags:
 * the string `"disable"` disables Auto mode, anything else (including a
 * mistyped value such as `true`) leaves it available — the CLI skips an
 * invalid auto-mode value rather than honouring it, so we do the same.
 *
 * Browser-safe on purpose (no SDK / Node imports) — shared by
 * `Session.setPermissionMode` (authoritative server-side gate) and the
 * `useDisableAutoMode` client hook (hides "Auto" from the mode picker).
 */
export function isAutoModeDisabled(
  settings:
    | {
        disableAutoMode?: unknown;
        permissions?: { disableAutoMode?: unknown } | null;
      }
    | null
    | undefined,
): boolean {
  if (!settings) return false;
  return (
    settings.disableAutoMode === "disable" ||
    settings.permissions?.disableAutoMode === "disable"
  );
}
