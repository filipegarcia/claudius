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
 * matches `.+`. That handles the screenshot case (`feat/4715-natixis-trend`
 * → `feat #4715 - `) and most repo-wide naming schemes without asking the
 * user to write regex.
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
  PLACEHOLDER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PLACEHOLDER_RE.exec(pattern)) !== null) {
    const name = m[1];
    if (names.includes(name)) return null;
    names.push(name);
    regex += escapeLiteral(pattern.slice(lastIndex, m.index));
    // Filled in below — the last placeholder gets `.+`, the rest `[^/-]+`.
    regex += `__PH_${names.length - 1}__`;
    lastIndex = m.index + m[0].length;
  }
  if (names.length === 0) return null;
  regex += escapeLiteral(pattern.slice(lastIndex));
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
