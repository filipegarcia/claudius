/**
 * Helpers for turning project file references in the chat into links to the
 * in-app Files browser (`/<workspaceId>/files?path=<relPath>`).
 *
 * "Project file" means a path that resolves inside the active workspace's
 * root (cwd). Absolute paths are linkified only when they live under the
 * root; relative paths are accepted when they're clean (no `..` escape, no
 * url scheme, no npm scope). Everything else returns null so we never
 * linkify URLs, package specifiers (`@scope/pkg`), template tokens
 * (`{{VERSION}}`), shell snippets, or prose.
 *
 * Pure + framework-free so it can be unit-tested in isolation.
 */

function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

const URL_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

/**
 * Resolve `raw` to a workspace-root-relative path (forward-slash), or null
 * when it isn't a file inside the workspace. `cwd` is the workspace root
 * (absolute path).
 */
export function toWorkspaceRelative(raw: string, cwd: string): string | null {
  if (!raw || typeof raw !== "string") return null;
  let p = raw.trim();
  if (!p) return null;
  if (URL_SCHEME_RE.test(p)) return null; // http://, file://, vscode://, …
  if (p.startsWith("@")) return null; // npm scope specifier
  if (p.startsWith("~")) return null; // home shorthand — not workspace-relative

  const root = stripTrailingSlash(cwd ?? "");
  if (p.startsWith("/")) {
    // Absolute path — linkable only when it lives under the workspace root.
    if (!root) return null;
    if (p === root) return null; // the root dir itself: nothing to open
    if (!p.startsWith(root + "/")) return null;
    p = p.slice(root.length + 1);
  } else {
    p = p.replace(/^\.\/+/, ""); // drop a leading ./
  }
  p = stripTrailingSlash(p);
  if (!p || p.startsWith("/")) return null;
  if (p === ".." || p.split("/").includes("..")) return null; // no climbing out
  return p;
}

const FILE_EXT_RE =
  /\.(?:md|mdx|markdown|txt|json|jsonc|ya?ml|toml|ini|env|lock|ts|tsx|js|jsx|mjs|cjs|css|scss|sass|less|html?|xml|svg|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|sql|prisma|graphql|gql|vue|svelte|astro)$/i;

const PATH_PUNCT_RE = /[()<>{}[\]|*?"'`$!,;\s]/;

/** Drop a trailing `:line` / `:line:col` suffix (e.g. `src/app.ts:42`). */
export function stripLineSuffix(s: string): string {
  return s.replace(/:\d+(?::\d+)?$/, "");
}

/**
 * Conservative test for "this inline-code span looks like a project file
 * path". Used to decide whether to linkify single-backtick spans in
 * assistant text. Tuned to avoid false positives on the things that
 * commonly sit in backticks: shell commands, template tokens like
 * `{{VERSION}}`, package specifiers, function calls, prose. Requires a
 * recognised file extension and a clean, single-token path.
 */
export function looksLikeFilePath(s: string): boolean {
  if (!s) return false;
  const t = stripLineSuffix(s.trim());
  if (!t || t.length > 200) return false;
  if (PATH_PUNCT_RE.test(t)) return false; // spaces / code-ish punctuation
  if (t.startsWith("@") || t.startsWith("~")) return false;
  if (URL_SCHEME_RE.test(t)) return false;
  return FILE_EXT_RE.test(t);
}

/** Build the in-app Files browser URL for a workspace-relative path. */
export function filesHref(workspaceId: string, relPath: string): string {
  return `/${workspaceId}/files?path=${encodeURIComponent(relPath)}`;
}
