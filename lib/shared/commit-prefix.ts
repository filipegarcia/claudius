/**
 * Per-workspace commit-message prefix derived from the current branch name.
 *
 * Users author two strings:
 *   - `branchPattern`: a literal pattern with `{name}` placeholders that
 *     describes how their branches are shaped. Example: `{type}/{id}-{rest}`.
 *   - `template`: a free-form output string that may reference the same
 *     placeholders. Example: `{type} #{id} - `.
 *
 * The pattern is compiled to a regex where each non-final placeholder
 * matches `[^/-]+` (the common branch separators) and the final placeholder
 * matches `.+`. The literal-before-last + last placeholder is wrapped in an
 * optional group when the pattern has ≥2 placeholders, so a branch like
 * `feat/4729` (no trailing description) still matches `{type}/{id}-{rest}`
 * with `rest` rendered as empty. Single-placeholder patterns still require
 * a match (so `{id}` doesn't silently accept anything). Handles the
 * screenshot case (`feat/4715-add-search-filter` → `feat #4715 - `) and the
 * common bare-id shape without asking the user to write regex.
 */

export type CommitPrefixConfig = {
  enabled: boolean;
  branchPattern: string;
  template: string;
};

const PLACEHOLDER_RE = /\{(\w+)\}/g;

function escapeLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compile a `{name}` pattern into a regex with named capture groups, plus
 * the ordered list of placeholder names. Returns null on malformed input
 * (no placeholders, or duplicate names).
 */
export function compilePattern(
  pattern: string,
): { re: RegExp; names: string[] } | null {
  const names: string[] = [];
  let regex = "";
  let lastIndex = 0;
  // Index into `regex` where the trailing run begins (literal-before-last
  // placeholder onwards). Used below to wrap that run in `(?:...)?` so the
  // last placeholder is optional when there are ≥2 placeholders.
  let trailingStart = 0;
  PLACEHOLDER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PLACEHOLDER_RE.exec(pattern)) !== null) {
    const name = m[1];
    if (names.includes(name)) return null;
    // Snapshot the index *before* writing the literal that precedes this
    // placeholder — on the final loop iteration this points at the start of
    // the optional trailing run.
    trailingStart = regex.length;
    names.push(name);
    regex += escapeLiteral(pattern.slice(lastIndex, m.index));
    // Filled in below — the last placeholder gets `.+`, the rest `[^/-]+`.
    regex += `__PH_${names.length - 1}__`;
    lastIndex = m.index + m[0].length;
  }
  if (names.length === 0) return null;
  regex += escapeLiteral(pattern.slice(lastIndex));
  // Make the trailing run optional only when the pattern has ≥2 placeholders.
  // Otherwise `{id}` would degenerate into "match anything," which would
  // silently mask a misconfiguration.
  if (names.length >= 2) {
    regex =
      regex.slice(0, trailingStart) + "(?:" + regex.slice(trailingStart) + ")?";
  }
  // Replace placeholder markers, picking the right matcher per position.
  regex = regex.replace(/__PH_(\d+)__/g, (_full, idxStr: string) => {
    const i = Number(idxStr);
    const last = i === names.length - 1;
    const name = names[i];
    return `(?<${name}>${last ? ".+" : "[^/-]+"})`;
  });
  try {
    return { re: new RegExp(`^${regex}$`), names };
  } catch {
    return null;
  }
}

/**
 * Apply a commit-prefix config to a branch name. Returns the rendered prefix
 * string when the branch matches the pattern, or null when it doesn't (the
 * caller should leave the textarea empty in that case).
 */
export function renderCommitPrefix(
  branch: string | null | undefined,
  config: CommitPrefixConfig | null | undefined,
): string | null {
  if (!config || !config.enabled) return null;
  if (!branch || !config.branchPattern.trim() || !config.template) return null;
  const compiled = compilePattern(config.branchPattern);
  if (!compiled) return null;
  const m = compiled.re.exec(branch);
  if (!m || !m.groups) return null;
  const groups = m.groups;
  return config.template.replace(PLACEHOLDER_RE, (full, name: string) =>
    name in groups ? (groups[name] ?? "") : full,
  );
}
