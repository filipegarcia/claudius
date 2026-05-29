import { promises as fs } from "node:fs";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { NextResponse } from "next/server";
import { getWorkspace } from "@/lib/server/workspaces-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type FileEntry = {
  name: string;
  /** Path relative to the workspace root, forward-slash. */
  relPath: string;
  kind: "file" | "dir";
  sizeBytes?: number;
  modifiedMs?: number;
};

const HIDDEN = new Set([".git", "node_modules", ".next", "dist", "build", ".turbo", ".cache", "coverage", ".DS_Store"]);

function inside(root: string, target: string): boolean {
  const r = relative(root, target);
  if (r === "") return true;
  return !r.startsWith("..") && !isAbsolute(r);
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "workspace not found" }, { status: 404 });

  const url = new URL(req.url);
  const rawPath = url.searchParams.get("path") ?? "";
  const depth = Math.min(3, Math.max(1, Number(url.searchParams.get("depth") ?? "1") || 1));

  // Resolve the path *strictly* under the workspace root.
  const root = resolve(ws.rootPath);
  const rel = normalize(rawPath).replace(/^\/+/, "");
  const target = resolve(root, rel);
  if (!inside(root, target)) {
    return NextResponse.json({ error: "path escapes workspace root" }, { status: 400 });
  }

  let stat: import("node:fs").Stats;
  try {
    stat = await fs.stat(target);
  } catch {
    return NextResponse.json({ error: "path not found" }, { status: 404 });
  }
  if (stat.isFile()) {
    // File content mode — return as UTF-8 text. Size-cap at 2 MB to avoid
    // accidentally streaming large binaries through the editor.
    if (stat.size > 2 * 1024 * 1024) {
      return NextResponse.json({ error: "file too large to edit (>2MB)" }, { status: 413 });
    }
    let content: string;
    try {
      content = await fs.readFile(target, "utf8");
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : String(err) },
        { status: 500 },
      );
    }
    return NextResponse.json({
      root,
      relPath: relative(root, target).split(sep).join("/"),
      kind: "file",
      content,
      sizeBytes: stat.size,
      modifiedMs: stat.mtimeMs,
    });
  }
  if (!stat.isDirectory()) {
    return NextResponse.json({ error: "path is not a directory" }, { status: 400 });
  }

  const entries = await listDir(root, target, depth);
  return NextResponse.json({
    root,
    relPath: relative(root, target).split(sep).join("/"),
    entries,
  });
}

async function resolveBoundedTarget(
  id: string,
  rawPath: string,
): Promise<{ ok: true; root: string; target: string } | { ok: false; status: number; error: string }> {
  const ws = await getWorkspace(id);
  if (!ws) return { ok: false, status: 404, error: "workspace not found" };
  if (!rawPath) return { ok: false, status: 400, error: "path required" };
  const root = resolve(ws.rootPath);
  const rel = normalize(rawPath).replace(/^\/+/, "");
  if (rel === ".." || rel.startsWith("../")) {
    return { ok: false, status: 400, error: "path escapes workspace root" };
  }
  const target = resolve(root, rel);
  if (!inside(root, target) || target === root) {
    return { ok: false, status: 400, error: "path escapes workspace root or is root itself" };
  }
  return { ok: true, root, target };
}

/** PUT — overwrite (or create) a UTF-8 text file. Body is the new content. */
export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const r = await resolveBoundedTarget(id, url.searchParams.get("path") ?? "");
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  const body = await req.text();
  // Reject if target is an existing directory.
  try {
    const s = await fs.stat(r.target);
    if (s.isDirectory()) {
      return NextResponse.json({ error: "target is a directory" }, { status: 400 });
    }
  } catch {
    // ENOENT — fine, we'll create.
  }
  try {
    await fs.mkdir(resolve(r.target, ".."), { recursive: true });
    await fs.writeFile(r.target, body, "utf8");
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true });
}

/** POST — create a new file or directory. ?kind=file|dir. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const kind = url.searchParams.get("kind");
  if (kind !== "file" && kind !== "dir") {
    return NextResponse.json({ error: "kind must be file or dir" }, { status: 400 });
  }
  const r = await resolveBoundedTarget(id, url.searchParams.get("path") ?? "");
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  // Reject if anything already exists at the target.
  try {
    await fs.stat(r.target);
    return NextResponse.json({ error: "already exists" }, { status: 409 });
  } catch {
    // ENOENT — proceed.
  }
  try {
    if (kind === "dir") {
      await fs.mkdir(r.target, { recursive: false });
    } else {
      await fs.mkdir(resolve(r.target, ".."), { recursive: true });
      await fs.writeFile(r.target, "", { flag: "wx", encoding: "utf8" });
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true });
}

/** DELETE — remove a file or directory (recursive for dirs). */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const r = await resolveBoundedTarget(id, url.searchParams.get("path") ?? "");
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  try {
    await fs.rm(r.target, { recursive: true, force: false });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

/** PATCH — rename (move within the workspace). ?path=&newPath= */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const src = await resolveBoundedTarget(id, url.searchParams.get("path") ?? "");
  if (!src.ok) return NextResponse.json({ error: src.error }, { status: src.status });
  const dst = await resolveBoundedTarget(id, url.searchParams.get("newPath") ?? "");
  if (!dst.ok) return NextResponse.json({ error: dst.error }, { status: dst.status });
  // Reject if dst already exists — explicit overwrite is a separate operation.
  try {
    await fs.stat(dst.target);
    return NextResponse.json({ error: "destination already exists" }, { status: 409 });
  } catch {
    // ENOENT — fine.
  }
  try {
    await fs.mkdir(resolve(dst.target, ".."), { recursive: true });
    await fs.rename(src.target, dst.target);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true });
}

async function listDir(root: string, dir: string, depth: number): Promise<FileEntry[]> {
  let names: import("node:fs").Dirent[];
  try {
    names = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: FileEntry[] = [];
  for (const ent of names) {
    if (HIDDEN.has(ent.name)) continue;
    if (ent.name.startsWith(".")) continue;
    const abs = join(dir, ent.name);
    if (!inside(root, abs)) continue;
    let stat: import("node:fs").Stats | null = null;
    try {
      stat = await fs.stat(abs);
    } catch {
      continue;
    }
    const rel = relative(root, abs).split(sep).join("/");
    if (stat.isDirectory()) {
      out.push({
        name: ent.name,
        relPath: rel + "/",
        kind: "dir",
        modifiedMs: stat.mtimeMs,
      });
    } else if (stat.isFile()) {
      out.push({
        name: ent.name,
        relPath: rel,
        kind: "file",
        sizeBytes: stat.size,
        modifiedMs: stat.mtimeMs,
      });
    }
  }
  out.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  // depth>1 expansion is left to the caller for now (lazy load on click).
  void depth;
  return out;
}
