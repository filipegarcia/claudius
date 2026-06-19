/**
 * Named accent colors for the per-session prompt bar (`/color`).
 *
 * Mirrors the palette of Claude Code's terminal `/color` command. The chosen
 * name is persisted in the session's `state` JSON blob (server-side) and
 * resolved to one of these hexes when recoloring the composer border.
 *
 * Values are picked to stay legible against both the dark and light themes —
 * they're used only for a 1px border, never for text.
 */
export const PROMPT_COLORS = {
  red: "#e5484d",
  orange: "#e8590c",
  yellow: "#f5a524",
  green: "#46a758",
  cyan: "#00a3c4",
  blue: "#3b82f6",
  purple: "#8b5cf6",
  pink: "#e93d82",
} as const;

export type PromptColorName = keyof typeof PROMPT_COLORS;

/** Words that clear an existing session color back to the theme default. */
export const PROMPT_COLOR_RESET_WORDS = ["default", "none", "off", "clear", "reset"] as const;

export const PROMPT_COLOR_NAMES = Object.keys(PROMPT_COLORS) as PromptColorName[];

export function isPromptColorName(value: string): value is PromptColorName {
  return Object.prototype.hasOwnProperty.call(PROMPT_COLORS, value);
}

/** Resolve a stored name to its hex, or `null` when unset/invalid. */
export function resolvePromptColor(name: string | null | undefined): string | null {
  if (name && isPromptColorName(name)) return PROMPT_COLORS[name];
  return null;
}
