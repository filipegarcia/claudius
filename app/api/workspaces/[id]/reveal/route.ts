import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { isAbsolute, normalize, relative, resolve } from "node:path";
import { NextResponse } from "next/server";
import { getWorkspace } from "@/lib/server/workspaces-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Reveal a workspace-relative path in the host OS file manager.
 *
 * POST body: `{ relPath?: string }` — empty / missing opens the workspace
 * root itself. For files we "reveal" (select in parent), for directories
 * we open them; the choice is made server-side from `fs.stat` so a stale
 * client `kind` (deleted-but-shown-in-git, renamed, …) doesn't matter.
 *
 * Returns immediately on spawn — the child is detached + `unref`'d so we
 * don't keep the request open while Finder/Explorer renders, and we don't
 * await an exit code (Windows' `explorer /select,…` is famously non-zero
 * on success).
 *
 * SECURITY: This invokes a native OS handler with a path the caller chose.
 * Claudius's threat model is local-only / single-user (same as
 * `lib/server/shell.ts`'s `execShellCommand`) — the worst this does is
 * pop up a Finder window for an arbitrary path on the user's machine.
 * The path is bounded under the workspace root anyway. We pass it as a
 * single argv entry (NOT through `bash -c`) so spaces, semicolons, and
 * shell metacharacters in filenames can't break out of the argument.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "workspace not found" }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as { relPath?: unknown };
  const rawRel = typeof body.relPath === "string" ? body.relPath : "";

  const root = resolve(ws.rootPath);
  const rel = normalize(rawRel).replace(/^\/+/, "");
  // Bound under root — same check as the files route. Belt-and-braces given
  // that anything outside still just opens the user's Finder; we keep it so
  // the API contract is "workspace-scoped" rather than "arbitrary path."
  if (rel === ".." || rel.startsWith("../")) {
    return NextResponse.json({ error: "path escapes workspace root" }, { status: 400 });
  }
  const target = rel === "" || rel === "." ? root : resolve(root, rel);
  const r = relative(root, target);
  if (r !== "" && (r.startsWith("..") || isAbsolute(r))) {
    return NextResponse.json({ error: "path escapes workspace root" }, { status: 400 });
  }

  let isDir: boolean;
  try {
    const st = await fs.stat(target);
    isDir = st.isDirectory();
  } catch {
    // Most common cause: the row is a `D` (deleted) entry in /git, or a
    // file that was just renamed off-disk. Either way there's nothing for
    // Finder to select — surface 404 so the client can show a toast.
    return NextResponse.json({ error: "path not found on disk" }, { status: 404 });
  }

  try {
    revealOnHost(target, isDir);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true });
}

/**
 * Spawn the platform-specific reveal command, detached + unref'd so we
 * return to the renderer immediately. `spawn` (not `exec`) with an argv
 * array means the path is never re-parsed by a shell.
 *
 *  - macOS: `open -R <file>` selects the file in Finder; `open <dir>`
 *    opens the directory window. Both correct.
 *  - Windows: `explorer /select,<file>` selects in Explorer (non-zero
 *    exit on success — that's why we don't await). `explorer <dir>` opens.
 *  - Linux: `xdg-open` has no portable "select" verb, so for files we
 *    open the containing directory. For directories we open them.
 */
function revealOnHost(absPath: string, isDir: boolean): void {
  const plat = process.platform;
  if (plat === "darwin") {
    const args = isDir ? [absPath] : ["-R", absPath];
    spawn("open", args, { detached: true, stdio: "ignore" }).unref();
    return;
  }
  if (plat === "win32") {
    // /select expects no space between the flag and path; pass as a single
    // argv token. detached + windowsHide so we don't flash a console.
    const args = isDir ? [absPath] : [`/select,${absPath}`];
    spawn("explorer", args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
    return;
  }
  // Linux / other Unix. Best-effort — distros vary on which file manager
  // honors a "--select" extension, so we open the dir and let the user
  // spot the file by name. If `xdg-open` is missing the spawn throws and
  // the caller returns 500.
  const dir = isDir ? absPath : resolve(absPath, "..");
  spawn("xdg-open", [dir], { detached: true, stdio: "ignore" }).unref();
}
