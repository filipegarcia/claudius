import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";

/**
 * Canonical Shift+Tab cycle order for permission modes. Split out of
 * `components/chat/ModeSelector.tsx` (which re-exports both names) so the
 * cycling logic is plain TS with no React/lucide-react imports — that lets
 * it live in the node-only vitest suite instead of requiring a Playwright
 * spec for pure cycling-math coverage.
 */
export const PERMISSION_MODE_ORDER: PermissionMode[] = [
  "default",
  "acceptEdits",
  "auto",
  "plan",
  "dontAsk",
  "bypassPermissions",
];

/**
 * Advance to the next mode in `PERMISSION_MODE_ORDER`, optionally skipping
 * any mode listed in `disabledModes` (Claude Code TUI parity, 2.1.207's
 * `disableAutoMode` setting — see `useDisableAutoMode`). The CURRENT mode is
 * never filtered out even if it's in `disabledModes`, so a session already
 * sitting in a since-disabled mode can still cycle away from it; it just
 * can't be cycled back INTO.
 */
export function nextPermissionMode(
  mode: PermissionMode,
  disabledModes?: PermissionMode[],
): PermissionMode {
  const cycle = disabledModes?.length
    ? PERMISSION_MODE_ORDER.filter((m) => m === mode || !disabledModes.includes(m))
    : PERMISSION_MODE_ORDER;
  const idx = cycle.indexOf(mode);
  if (idx < 0) return "default";
  return cycle[(idx + 1) % cycle.length];
}
