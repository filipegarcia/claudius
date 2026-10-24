import { lstat, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";

/**
 * Claude Code 2.1.310 — "Fixed file read permission prompts not showing where
 * a symbolic link leads."
 *
 * The engine resolves the link for its own terminal card (`symlinkTarget` on
 * its file-permission descriptor) but never forwards it through the SDK's
 * `canUseTool` options, so Claudius's browser card showed only the link path:
 * approving a Read of `./notes.txt` could silently read `~/.ssh/id_rsa`.
 * Claudius resolves it itself, server-side, and attaches the result to the
 * `permission_request` event.
 */

/** Which input field holds the path, and whether the tool reads or modifies it. */
const FILE_TOOLS: Record<string, { field: string; operation: "read" | "modify" }> = {
  Read: { field: "file_path", operation: "read" },
  Edit: { field: "file_path", operation: "modify" },
  Write: { field: "file_path", operation: "modify" },
  NotebookEdit: { field: "notebook_path", operation: "modify" },
};

export type PermissionSymlink = {
  /** Fully resolved target (`realpath` of the link — whole chain followed). */
  target: string;
  /** True when the target lies outside the session cwd and every additional directory. */
  outsideWorkingDirs: boolean;
  operation: "read" | "modify";
};

/** The tool's path argument when `toolName` is a file tool this check covers. */
export function permissionFilePath(
  toolName: string,
  input: Record<string, unknown>,
): { path: string; operation: "read" | "modify" } | null {
  const spec = FILE_TOOLS[toolName];
  if (!spec) return null;
  const p = input[spec.field];
  if (typeof p !== "string" || p.length === 0) return null;
  return { path: p, operation: spec.operation };
}

async function realOrResolved(dir: string): Promise<string> {
  try {
    return await realpath(dir);
  } catch {
    return resolve(dir);
  }
}

/**
 * When the file a permission prompt is about is itself a symbolic link,
 * return where it leads. Returns null for a regular file, a missing file (a
 * Write creating it), a dangling link, or any unreadable path — the card then
 * renders exactly as before.
 *
 * Only the final path component is checked (`lstat`). A symlinked *parent*
 * directory is deliberately not flagged: on macOS `/tmp` and `/var/folders`
 * are themselves links into `/private`, so a whole-path `realpath` comparison
 * would warn on nearly every temp-dir path.
 */
export async function resolvePermissionSymlink(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
  additionalDirectories: readonly string[] = [],
): Promise<PermissionSymlink | null> {
  const file = permissionFilePath(toolName, input);
  if (!file) return null;
  const linkPath = resolve(cwd, file.path);
  let target: string;
  try {
    const st = await lstat(linkPath);
    if (!st.isSymbolicLink()) return null;
    target = await realpath(linkPath);
  } catch {
    return null;
  }
  const dirs = await Promise.all(
    [cwd, ...additionalDirectories].map((d) => realOrResolved(resolve(cwd, d))),
  );
  const inside = dirs.some((d) => target === d || target.startsWith(d.endsWith(sep) ? d : d + sep));
  return { target, outsideWorkingDirs: !inside, operation: file.operation };
}
