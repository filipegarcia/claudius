/**
 * CC 2.1.293 parity — "Fixed keybindings.json checks: a lone " " (space key)
 * is no longer reported as an error, and keys like "ctrl+ k" now get a
 * warning".
 *
 * Claudius's Keybindings page edits the same `~/.claude/keybindings.json` the
 * CLI reads, through free-text key and chord fields with no checks at all,
 * so a stray space next to a `+` went unnoticed until the CLI complained.
 * Returns a warning for a key string with whitespace on either side of a
 * `+` between two key names, or null. A lone `" "` is the space key, and a
 * trailing `"ctrl+ "` names ctrl+space, so neither is flagged.
 */
export function keybindingKeyWarning(key: string | undefined): string | null {
  if (!key || !/\S\s+\+|\+\s+\S/.test(key)) return null;
  const suggested = key.trim().replace(/\s*\+\s*/g, "+");
  return `"${key}" has a space next to "+" — write it as "${suggested}".`;
}
