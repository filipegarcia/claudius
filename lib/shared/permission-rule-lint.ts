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
