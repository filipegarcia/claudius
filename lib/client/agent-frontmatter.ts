// Pure, browser-safe helpers for reading/writing the `isolation: worktree`
// flag in an agent file's YAML frontmatter. These do SURGICAL line editing
// rather than yaml.parse/stringify so the TEMPLATE's load-bearing
// `# Optional advanced fields` comments and the user's key ordering survive a
// round-trip through the editor.
//
// The frontmatter boundary regex mirrors `lib/server/agents.ts` so both sides
// agree on what counts as a frontmatter block.

// Matches a leading `---\n … \n---\n?` block and captures the inner YAML.
const FM_BLOCK_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

// A bare `isolation: worktree` line inside the frontmatter block.
const ISOLATION_WORKTREE_RE = /^isolation:\s*worktree\s*$/m;

// Any `isolation:` line (for replace/strip).
const ISOLATION_LINE_RE = /^isolation:.*$/m;

/**
 * True when `raw` has a frontmatter block whose body contains a bare
 * `isolation: worktree` line. Returns false when there is no frontmatter.
 */
export function hasIsolationWorktree(raw: string): boolean {
  const m = FM_BLOCK_RE.exec(raw);
  if (!m) return false;
  return ISOLATION_WORKTREE_RE.test(m[1]);
}

/**
 * Returns `raw` with the `isolation: worktree` frontmatter flag set or cleared,
 * via surgical line editing that preserves the body and the original `\n` vs
 * `\r\n` line style.
 */
export function setIsolationWorktree(raw: string, on: boolean): string {
  const m = FM_BLOCK_RE.exec(raw);

  if (!m) {
    // Body-only file with no frontmatter block.
    if (!on) return raw;
    const nl = /\r\n/.test(raw) ? "\r\n" : "\n";
    return `---${nl}isolation: worktree${nl}---${nl}${raw}`;
  }

  const block = m[0]; // the whole `---\n … \n---\n?` match
  const inner = m[1]; // the YAML body between the delimiters (no trailing newline)
  const body = raw.slice(block.length);
  const nl = /\r\n/.test(block) ? "\r\n" : "\n";

  let newInner: string;
  if (on) {
    if (ISOLATION_LINE_RE.test(inner)) {
      // Replace an existing isolation line in place.
      newInner = inner.replace(ISOLATION_LINE_RE, "isolation: worktree");
    } else {
      // Append just before the closing `---`.
      newInner = inner.length > 0 ? `${inner}${nl}isolation: worktree` : "isolation: worktree";
    }
  } else {
    // Strip any isolation line (and its trailing newline).
    newInner = inner.replace(/^isolation:.*(?:\r?\n)?/m, "");
    if (newInner === inner) return raw; // nothing to remove
    // Drop a now-trailing blank line so we don't leave a dangling separator.
    newInner = newInner.replace(/(\r?\n)$/, "");
  }

  // Rebuild from parts: the regex strips the trailing newline off `inner`, so a
  // single `nl` before the closing `---` reproduces the canonical block shape.
  return `---${nl}${newInner}${nl}---${nl}${body}`;
}
