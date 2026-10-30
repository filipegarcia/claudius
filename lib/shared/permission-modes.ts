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

/**
 * The slice of the SDK's `ModelInfo` (`supportedModels()` catalog row) the
 * auto-mode capability check reads. Structural so callers can pass a full
 * `ModelInfo` or a local mirror without importing the SDK type graph.
 */
export type AutoModeModelInfo = {
  value: string;
  resolvedModel?: string;
  displayName?: string;
  supportsAutoMode?: boolean;
};

/**
 * Find a model's catalog row by the id Claudius holds for it — either the
 * row's `value` (alias like `"sonnet"` or a pinned id) or its
 * `resolvedModel` (the canonical wire id an alias resolves to). Same match
 * `Session.setModel` uses for the fast-mode capability diff.
 */
export function findModelInfo<T extends { value: string; resolvedModel?: string }>(
  models: readonly T[],
  id: string | undefined,
): T | undefined {
  if (!id) return undefined;
  return models.find((m) => m.value === id || m.resolvedModel === id);
}

/**
 * CC 2.1.299 parity — "Fixed SDK and headless sessions staying in auto mode
 * after the host switched to a model that doesn't support auto mode".
 * Claudius is the host and owns the session's permission mode, so it has to
 * leave `auto` itself when the model moves to one whose catalog row says it
 * can't run there (the engine drops to `default` on its side with "<model>
 * doesn't support auto mode").
 *
 * Strictly `supportsAutoMode === false`: an absent flag (older CLI, or a
 * model the catalog doesn't list) is "unknown", not "unsupported" — kicking
 * the user out of auto on missing data would be a regression for every
 * model the catalog simply doesn't describe.
 */
export function shouldLeaveAutoForModel(
  mode: PermissionMode,
  info: Pick<AutoModeModelInfo, "supportsAutoMode"> | undefined,
): boolean {
  return mode === "auto" && info?.supportsAutoMode === false;
}

/** User-facing notice text for a model-switch auto-mode kick-out. */
export function autoModeOffNoticeText(modelDisplayName: string): string {
  return `Auto mode is off: ${modelDisplayName} doesn't support auto mode.`;
}

/**
 * CC 2.1.314 parity — "[Cloud sessions] Fixed the permission mode picker
 * staying on Auto after a running … session refused the switch; it now shows
 * the mode in use and tells you". What `Session.setPermissionMode` and
 * `POST /api/sessions/:id/mode` report: the mode actually in use, and — when
 * the engine refused the switch — what was asked for and the engine's reason.
 */
export type PermissionModeRefusal = { requested: PermissionMode; reason: string };
export type SetPermissionModeResult = { mode: PermissionMode; refused?: PermissionModeRefusal };
