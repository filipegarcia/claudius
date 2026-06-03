import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { NextResponse } from "next/server";
import { assertWithin, PathInjectionError } from "@/lib/server/safe-path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Filesystem browsing/creation is confined to this root (default the user's
// home directory). Override with CLAUDIUS_FS_ROOT for unusual setups. Resolved
// once so the containment checks below compare against a normalized absolute
// path. The `resolve(...) + startsWith(FS_ROOT + sep)` early guards below
// provide fail-fast 403s; `assertWithin` at each fs sink is the CodeQL-
// recognized barrier (same pattern that closed mcp.ts path-injection #13/#14).
const FS_ROOT = resolve(process.env.CLAUDIUS_FS_ROOT?.trim() || homedir());

const HIDDEN = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  ".turbo",
  ".cache",
  "coverage",
  ".DS_Store",
]);

export async function GET(req: Request) {
  const url = new URL(req.url);
  const requested = url.searchParams.get("path") ?? FS_ROOT;
  const path = isAbsolute(requested) ? resolve(requested) : resolve(FS_ROOT, requested);

  // Confine browsing to FS_ROOT. `resolve` above collapsed any `..`, so the
  // path must equal the root or sit beneath it; anything else escaped.
  if (path !== FS_ROOT && !path.startsWith(FS_ROOT + sep)) {
    return NextResponse.json({ error: "path outside allowed root" }, { status: 403 });
  }

  let stat: import("node:fs").Stats;
  try {
    stat = await fs.stat(path);
  } catch {
    return NextResponse.json({ error: "path does not exist" }, { status: 404 });
  }
  if (!stat.isDirectory()) {
    return NextResponse.json({ error: "path is not a directory" }, { status: 400 });
  }

  let dirents: import("node:fs").Dirent[];
  try {
    dirents = await fs.readdir(path, { withFileTypes: true });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "EACCES") return NextResponse.json({ error: "permission denied" }, { status: 403 });
    throw err;
  }

  const entries: { name: string; path: string }[] = [];
  for (const ent of dirents) {
    if (HIDDEN.has(ent.name) || ent.name.startsWith(".")) continue;
    if (!ent.isDirectory()) continue;
    entries.push({ name: ent.name, path: join(path, ent.name) });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));

  const parent = dirname(path);
  return NextResponse.json({
    path,
    // null at the filesystem root or at FS_ROOT — the UI must not offer an
    // up-link that would resolve outside the allowed root.
    parent: parent === path || path === FS_ROOT ? null : parent,
    entries,
    home: FS_ROOT,
  });
}

/**
 * Create a single subdirectory under `parent`.
 *
 * Body: `{ parent: string, name: string }`.
 *
 * `name` is a file-name only — slashes, NUL bytes, and `.` / `..` are
 * rejected so a buggy client can't traverse out of the intended parent.
 * `parent` is resolved the same way as GET: absolute paths are used as-is,
 * relative paths resolve against $HOME.
 *
 * On success returns `{ path }` so the client can navigate into the new
 * folder without making a follow-up GET to figure out the joined path.
 */
export async function POST(req: Request) {
  let body: { parent?: string; name?: string };
  try {
    body = (await req.json()) as { parent?: string; name?: string };
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const rawParent = body.parent ?? FS_ROOT;
  const parent = isAbsolute(rawParent) ? resolve(rawParent) : resolve(FS_ROOT, rawParent);
  // Confine creation to FS_ROOT before the path reaches any fs sink. `resolve`
  // collapsed any `..`, so `parent` must equal the root or sit beneath it.
  if (parent !== FS_ROOT && !parent.startsWith(FS_ROOT + sep)) {
    return NextResponse.json({ error: "parent outside allowed root" }, { status: 403 });
  }
  const name = (body.name ?? "").trim();

  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  // Reject anything that could escape the parent. We treat this strictly as
  // a basename — the picker UI exposes navigation for traversal, the create
  // endpoint never does.
  if (name.includes("/") || name.includes("\\") || name.includes("\0") || name === "." || name === "..") {
    return NextResponse.json({ error: "invalid folder name" }, { status: 400 });
  }

  try {
    // assertWithin resolves `parent` within FS_ROOT and throws PathInjectionError
    // if it escapes — CodeQL sees the return value as the barrier-resolved path.
    const safeParent = assertWithin(FS_ROOT, parent);
    const stat = await fs.stat(safeParent);
    if (!stat.isDirectory()) {
      return NextResponse.json({ error: "parent is not a directory" }, { status: 400 });
    }
  } catch (err) {
    if (err instanceof PathInjectionError) {
      return NextResponse.json({ error: "parent outside allowed root" }, { status: 403 });
    }
    return NextResponse.json({ error: "parent does not exist" }, { status: 404 });
  }

  try {
    // assertWithin(parent, name) replaces join(parent, name): produces the same
    // resolved path but throws if name somehow escapes parent, giving CodeQL a
    // recognized barrier on `target` directly at the mkdir sink.
    const target = assertWithin(parent, name);
    await fs.mkdir(target);
    return NextResponse.json({ path: target });
  } catch (err) {
    if (err instanceof PathInjectionError) {
      return NextResponse.json({ error: "path outside allowed root" }, { status: 403 });
    }
    const e = err as NodeJS.ErrnoException;
    if (e.code === "EEXIST") {
      return NextResponse.json({ error: "folder already exists" }, { status: 409 });
    }
    if (e.code === "EACCES" || e.code === "EPERM") {
      return NextResponse.json({ error: "permission denied" }, { status: 403 });
    }
    throw err;
  }
}
