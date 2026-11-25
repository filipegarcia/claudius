/**
 * CC 2.1.328 parity — "Fixed an image path pasted into a `!` command becoming
 * an attachment".
 *
 * In Claudius a pasted or dropped image file was always attached, even in `!`
 * (shell) mode: an `[Image #N] ` token landed in the command at the caret and
 * the image itself was dropped when the command ran (`!ls [Image #1]` runs
 * `ls [Image`, because `#1]` starts a bash comment). In `!` mode a file now
 * goes in as its path, like the CLI does, as a plain shell word (not the
 * `@path` mention form, which the shell would see literally).
 *
 * Pure (no DOM) so the quoting is unit-testable.
 */

/** Characters that never need quoting in a POSIX shell word. */
const SHELL_SAFE_RE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** Quote one path as a single POSIX shell word. */
export function shellQuotePath(path: string): string {
  if (SHELL_SAFE_RE.test(path)) return path;
  // Single quotes keep everything literal; an embedded `'` closes the quote,
  // adds an escaped quote, and reopens it.
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

/** The text a `!` command gets for dropped or pasted files: quoted paths, space-separated. */
export function bashModeFileInsert(paths: readonly string[]): string {
  return paths.filter((p) => p.length > 0).map(shellQuotePath).join(" ");
}
