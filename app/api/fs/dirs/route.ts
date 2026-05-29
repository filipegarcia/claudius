import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Filesystem browsing/creation is confined to this root (default the user's
// home directory). Override with CLAUDIUS_FS_ROOT for unusual setups. Resolved
// once so the containment checks below compare against a normalized absolute
// path. The `resolve(...) + startsWith(FS_ROOT + sep)` containment guard is
// repeated inline at each fs sink on purpose: CodeQL's path-injection barrier
// does not propagate reliably when the check is hidden behind a helper.
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
    const stat = await fs.stat(parent);
    if (!stat.isDirectory()) {
      return NextResponse.json({ error: "parent is not a directory" }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: "parent does not exist" }, { status: 404 });
  }

  const target = join(parent, name);
  // Guard the actual sink value (not just `parent`): `name` is already a
  // validated basename and `parent` is confined, so this is always true at
  // runtime, but CodeQL wants the containment check on the value that reaches
  // fs.mkdir rather than relying on the barrier propagating through `join`.
  if (target !== FS_ROOT && !target.startsWith(FS_ROOT + sep)) {
    return NextResponse.json({ error: "path outside allowed root" }, { status: 403 });
  }
  try {
    await fs.mkdir(target);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "EEXIST") {
      return NextResponse.json({ error: "folder already exists" }, { status: 409 });
    }
    if (e.code === "EACCES" || e.code === "EPERM") {
      return NextResponse.json({ error: "permission denied" }, { status: 403 });
    }
    throw err;
  }

  return NextResponse.json({ path: target });
}
