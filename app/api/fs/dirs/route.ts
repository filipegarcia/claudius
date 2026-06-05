import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { NextResponse } from "next/server";

import {
  categorizeTccPath,
  isHiddenHomeSubpath,
  type TccCategory,
} from "@/lib/shared/tcc-protected";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Filesystem browsing/creation is confined to this root (default the user's
// home directory). Override with CLAUDIUS_FS_ROOT for unusual setups. Resolved
// once so the containment checks below compare against a normalized absolute
// path. Each fs.* sink is guarded by an inline `resolve(...) +
// startsWith(FS_ROOT + sep)` check — CodeQL's StartsWithDirSanitizer is
// recognized only inline at the sink, not through helper-function call
// boundaries (see history of CodeQL alerts #36/#37 and #39/#40 on this file).
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

/**
 * Response shape returned when the caller asked us to descend into a
 * macOS TCC-protected folder (Desktop / Documents / Downloads / Movies /
 * Music / Pictures) without setting `?ack=1`. The picker UI shows an
 * in-app heads-up explaining what's about to happen and only then
 * re-issues the request with `?ack=1`, at which point the OS-level TCC
 * dialog may fire — but the user now has the context they were missing
 * before. See `lib/shared/tcc-protected.ts` for the full rationale.
 */
type NeedsAckResponse = {
  needsAck: true;
  category: TccCategory;
  path: string;
};

export async function GET(req: Request) {
  const url = new URL(req.url);
  const requested = url.searchParams.get("path") ?? FS_ROOT;
  const ack = url.searchParams.get("ack") === "1";
  const path = isAbsolute(requested) ? resolve(requested) : resolve(FS_ROOT, requested);

  // Confine browsing to FS_ROOT. `resolve` above collapsed any `..`, so the
  // path must equal the root or sit beneath it; anything else escaped.
  if (path !== FS_ROOT && !path.startsWith(FS_ROOT + sep)) {
    return NextResponse.json({ error: "path outside allowed root" }, { status: 403 });
  }

  // Hard-block descent into `~/Library/Containers/*` and
  // `~/Library/Group Containers/*`. These trigger the macOS "Claudius
  // would like to access data from other apps" prompt and no workspace
  // legitimately lives under them. We hide them at the entry-listing
  // level too (below), but defend-in-depth at the request boundary so a
  // hand-crafted `?path=` can't slip through.
  if (path !== FS_ROOT && path.startsWith(FS_ROOT + sep)) {
    const relFromRoot = relative(FS_ROOT, path).split(sep).join("/");
    if (isHiddenHomeSubpath(relFromRoot, process.platform)) {
      return NextResponse.json(
        { error: "path is in a hidden system folder" },
        { status: 403 },
      );
    }
  }

  // TCC gate: a request that tries to read into Desktop/Documents/...
  // without `?ack=1` gets a needsAck sentinel instead of an fs.stat. The
  // picker UI uses that to show its in-app explanation BEFORE we make
  // the syscall that fires macOS's own permission dialog. This is the
  // whole point of the feature — see lib/shared/tcc-protected.ts.
  const category = categorizeTccPath(path, FS_ROOT, process.platform);
  if (category && !ack) {
    const body: NeedsAckResponse = { needsAck: true, category, path };
    return NextResponse.json(body);
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

  const entries: { name: string; path: string; protected?: boolean }[] = [];
  for (const ent of dirents) {
    if (HIDDEN.has(ent.name) || ent.name.startsWith(".")) continue;
    if (!ent.isDirectory()) continue;
    const childPath = join(path, ent.name);

    // Suppress Library/Containers and Library/Group Containers entries
    // entirely on macOS so the user never even sees them as an option
    // in the picker. The relative form `path.relative(FS_ROOT, child)`
    // is what isHiddenHomeSubpath expects.
    const childRelFromRoot = relative(FS_ROOT, childPath).split(sep).join("/");
    if (isHiddenHomeSubpath(childRelFromRoot, process.platform)) continue;

    // Tag TCC categories with `protected: true` so the picker can render
    // a lock badge and intercept the click. We deliberately do NOT stat
    // these children — `readdir` of the parent already returned them
    // and we don't need to touch the protected dir to list it as an
    // entry.
    const childCategory = categorizeTccPath(childPath, FS_ROOT, process.platform);
    const entry: { name: string; path: string; protected?: boolean } = {
      name: ent.name,
      path: childPath,
    };
    if (childCategory) entry.protected = true;
    entries.push(entry);
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

  // Inline barrier at the stat sink, canonical `path.relative(...)` form.
  // CodeQL's RelativePathStartsWithSanitizer recognizes this pattern and
  // sanitizes the 2nd arg of `relative` for the fall-through branch — unlike
  // L104's compound `A && !B` whose `parent === FS_ROOT` short-circuit left
  // the stat sink tainted (this is what kept reopening alert #36).
  // `relative(FS_ROOT, FS_ROOT)` returns "" so the legitimate root case
  // passes without needing a disjunct that would re-break the barrier.
  const rel = relative(FS_ROOT, parent);
  if (rel.startsWith("..") || rel === "..") {
    return NextResponse.json({ error: "parent outside allowed root" }, { status: 403 });
  }
  try {
    const stat = await fs.stat(parent);
    if (!stat.isDirectory()) {
      return NextResponse.json({ error: "parent is not a directory" }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: "parent does not exist" }, { status: 404 });
  }

  // Inline barrier at the mkdir sink. `name` is a validated non-empty basename
  // (no slashes / null / `.` / `..`), so `target = resolve(parent, name)` is
  // always strictly below `parent`, which is itself confined to FS_ROOT. The
  // startsWith check below is the CodeQL StartsWithDirSanitizer at the sink.
  const target = resolve(parent, name);
  if (!target.startsWith(FS_ROOT + sep)) {
    return NextResponse.json({ error: "path outside allowed root" }, { status: 403 });
  }
  try {
    await fs.mkdir(target);
    return NextResponse.json({ path: target });
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
}
