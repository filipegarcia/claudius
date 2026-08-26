/**
 * CC 2.1.210 parity — Claude Code added a startup warning for
 * `Write(path)`, `NotebookEdit(path)`, and `Glob(path)` permission rules,
 * pointing users at `Edit(path)` / `Read(path)` instead (those three tools
 * don't support path-scoped rules the way `Edit`/`Read` do — a rule like
 * `Write(./src/**)` silently behaves as the unscoped `Write`, which is
 * surprising).
 *
 * Claudius has no CLI startup phase to hook, so this is surfaced inline on
 * the `/permissions` page as the user types a rule. Kept pure (no React) so
 * it's unit-testable without a DOM.
 */

const UNSUPPORTED_SCOPED_TOOLS = ["Write", "NotebookEdit", "Glob"] as const;

export type UnsupportedScopedRule = {
  tool: (typeof UNSUPPORTED_SCOPED_TOOLS)[number];
  suggestion: "Edit(path)" | "Read(path)";
};

const SUGGESTIONS: Record<(typeof UNSUPPORTED_SCOPED_TOOLS)[number], "Edit(path)" | "Read(path)"> = {
  Write: "Edit(path)",
  NotebookEdit: "Edit(path)",
  Glob: "Read(path)",
};

/**
 * Returns the matched tool + suggestion when `rule` is a path-scoped form
 * of `Write`, `NotebookEdit`, or `Glob` (e.g. `Write(./src/**)`), or `null`
 * when the rule is unscoped (`Write`, bare — those are fine) or doesn't
 * match one of the three flagged tools at all.
 */
export function lintPermissionRule(rule: string): UnsupportedScopedRule | null {
  const trimmed = rule.trim();
  for (const tool of UNSUPPORTED_SCOPED_TOOLS) {
    if (trimmed.startsWith(`${tool}(`) && trimmed.endsWith(")")) {
      return { tool, suggestion: SUGGESTIONS[tool] };
    }
  }
  return null;
}

/**
 * CC 2.1.246 parity — Claude Code added a startup warning for Bash allow
 * rules with a wildcard *before* the subcommand, e.g. `Bash(git * main)`:
 * the `*` doesn't just stand in for "any subcommand", it also matches
 * options inserted between the command and the fixed trailing word (e.g.
 * `git --exec=... main`), which is rarely what the rule author intended.
 * A trailing wildcard (`Bash(npm run *)`, `Bash(git commit *)`) is the
 * common, safe pattern — "anything after this point" — so only a `*` that
 * has a literal token *after* it is flagged.
 *
 * Claudius has no CLI startup phase to hook, so — matching the
 * `lintPermissionRule` pattern above (CC 2.1.210 parity) — this is
 * surfaced inline on the `/permissions` page as the user types an
 * `allow`-kind Bash rule. Kept pure (no React) so it's unit-testable
 * without a DOM.
 */
export type BashWildcardWarning = { command: string };

export function lintBashWildcardRule(rule: string): BashWildcardWarning | null {
  const trimmed = rule.trim();
  const match = /^Bash\((.*)\)$/.exec(trimmed);
  if (!match) return null;
  const inner = match[1].trim();
  if (!inner) return null;
  const tokens = inner.split(/\s+/);
  // A `*` followed by at least one more literal token is the ambiguous
  // case — a trailing `*` (the last token) is the common "anything after
  // this point" pattern and isn't flagged.
  for (let i = 0; i < tokens.length - 1; i++) {
    if (tokens[i] === "*") {
      return { command: inner };
    }
  }
  return null;
}
