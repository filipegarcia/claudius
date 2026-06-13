import { promises as fs } from "node:fs";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { NextResponse } from "next/server";
import { getRepoRoot } from "@/lib/server/git";
import { resolveWorkspaceRoot } from "@/lib/server/workspace-roots";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type FileEntry = {
  name: string;
  /** Path relative to the chosen root, forward-slash. */
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

/**
 * Pick the base directory the request path resolves against.
 *
 * Default is the workspace root (`wsRoot`) — what the Files browser uses.
 * When `?base=git` is passed, resolve against the **git repository root**
 * instead. `git status` reports paths relative to the repo top-level, so the
 * /git diff view (FileEditor) passes `base=git` to read/write the working-tree
 * file. Without it, a workspace opened on a subdirectory of the repo would
 * double up the path (`<wsRoot>/<repo-relative-path>`) and 404 with
 * "path not found" — exactly the bug this fixes.
 *
 * The repo root comes from `git rev-parse --show-toplevel` (trusted, server-
 * resolved) and is always an ancestor of — or equal to — `wsRoot`, so it's a
 * superset boundary, not an escape. Falls back to `wsRoot` when the workspace
 * isn't inside a git work tree.
 */
async function resolveBase(wsRoot: string, baseSel: string | null): Promise<string> {
  if (baseSel !== "git") return wsRoot;
  const repoRoot = await getRepoRoot(wsRoot);
  return repoRoot ? resolve(repoRoot) : wsRoot;
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const rootSel = url.searchParams.get("root");
  const resolved = await resolveWorkspaceRoot(id, rootSel);
  if (!resolved) {
    return NextResponse.json(
      { error: rootSel ? "unknown root" : "workspace not found" },
      { status: 404 },
    );
  }

  const rawPath = url.searchParams.get("path") ?? "";
  const depth = Math.min(3, Math.max(1, Number(url.searchParams.get("depth") ?? "1") || 1));

  // Resolve the path *strictly* under the chosen root. Same shape as before:
  // `rel` is the only client-tainted input; `root` is the trusted server-
  // resolved base. CodeQL's StartsWithDirSanitizer wants `resolve` (not
  // `join`) and the inline check below — see CLAUDE.md "Path safety".
  const root = await resolveBase(resolved.root.absPath, url.searchParams.get("base"));
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
    // Raw binary serve mode — `?serve=1` returns the file bytes directly with
    // the correct Content-Type. Used by the in-app image preview (img src=).
    // The path resolution and inside() check above already bound the target,
    // so we just branch on the extension here. Cap at 10 MB for images.
    const serveRaw = url.searchParams.get("serve") === "1";
    if (serveRaw) {
      const IMAGE_MIME: Record<string, string> = {
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        gif: "image/gif",
        svg: "image/svg+xml",
        webp: "image/webp",
        ico: "image/x-icon",
        bmp: "image/bmp",
        avif: "image/avif",
        tiff: "image/tiff",
        tif: "image/tiff",
      };
      const ext = target.split(".").pop()?.toLowerCase() ?? "";
      const contentType = IMAGE_MIME[ext];
      if (!contentType) {
        return NextResponse.json({ error: "not a supported image type" }, { status: 415 });
      }
      if (stat.size > 10 * 1024 * 1024) {
        return NextResponse.json({ error: "image too large (>10MB)" }, { status: 413 });
      }
      let buf: Buffer;
      try {
        buf = await fs.readFile(target);
      } catch (err) {
        return NextResponse.json(
          { error: err instanceof Error ? err.message : String(err) },
          { status: 500 },
        );
      }
      // Coerce to Uint8Array: Node's `Buffer` extends Uint8Array at runtime,
      // but the lib.dom `BodyInit` type doesn't include Buffer. Cheap wrap,
      // same byte payload.
      return new Response(new Uint8Array(buf), {
        headers: {
          "Content-Type": contentType,
          "Cache-Control": "private, max-age=60",
        },
      });
    }

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
      rootId: resolved.root.id,
      rootPath: root,
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

  // Recursive filename search mode. When `?search=` is present we walk the
  // subtree under `target` and return files whose workspace-relative path
  // matches (case-insensitive substring) — so a nested file (or a whole
  // folder) is findable without expanding the tree by hand.
  const search = (url.searchParams.get("search") ?? "").trim().toLowerCase();
  if (search) {
    const { matches, truncated } = await searchFiles(root, target, search);
    return NextResponse.json({
      rootId: resolved.root.id,
      rootPath: root,
      relPath: relative(root, target).split(sep).join("/"),
      entries: matches,
      truncated,
    });
  }

  // Recursive content-search mode. When `?contentSearch=` is present we walk
  // the subtree under `target`, read each text file (size + binary capped),
  // and return one entry per matching line. The folder-scoped "Find in
  // folder" UI uses this to grep the directory the user picked.
  const contentSearch = url.searchParams.get("contentSearch") ?? "";
  if (contentSearch.trim()) {
    const caseSensitive = url.searchParams.get("case") === "1";
    const { matches, truncated, scanned } = await searchFileContents(
      root,
      target,
      contentSearch,
      caseSensitive,
    );
    return NextResponse.json({
      rootId: resolved.root.id,
      rootPath: root,
      relPath: relative(root, target).split(sep).join("/"),
      matches,
      truncated,
      scanned,
    });
  }

  const entries = await listDir(root, target, depth);
  return NextResponse.json({
    rootId: resolved.root.id,
    rootPath: root,
    relPath: relative(root, target).split(sep).join("/"),
    entries,
  });
}

async function resolveBoundedTarget(
  id: string,
  rootSel: string | null,
  rawPath: string,
  baseSel: string | null = null,
): Promise<{ ok: true; root: string; target: string } | { ok: false; status: number; error: string }> {
  const resolved = await resolveWorkspaceRoot(id, rootSel);
  if (!resolved) {
    return {
      ok: false,
      status: 404,
      error: rootSel ? "unknown root" : "workspace not found",
    };
  }
  if (!rawPath) return { ok: false, status: 400, error: "path required" };
  const root = await resolveBase(resolved.root.absPath, baseSel);
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
  const r = await resolveBoundedTarget(
    id,
    url.searchParams.get("root"),
    url.searchParams.get("path") ?? "",
    url.searchParams.get("base"),
  );
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
  const r = await resolveBoundedTarget(id, url.searchParams.get("root"), url.searchParams.get("path") ?? "");
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
  const r = await resolveBoundedTarget(id, url.searchParams.get("root"), url.searchParams.get("path") ?? "");
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
  // Rename is bound to a single root — moving between roots requires copy +
  // delete, which we don't support here. Both src and dst resolve under the
  // same `?root=`.
  const rootSel = url.searchParams.get("root");
  const src = await resolveBoundedTarget(id, rootSel, url.searchParams.get("path") ?? "");
  if (!src.ok) return NextResponse.json({ error: src.error }, { status: src.status });
  const dst = await resolveBoundedTarget(id, rootSel, url.searchParams.get("newPath") ?? "");
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

// Caps for the recursive search: at most this many matches returned, and at
// most this many entries visited (protects against monorepo-huge trees). Both
// fold into the same `truncated` flag the UI surfaces.
const SEARCH_RESULT_LIMIT = 1000;
const SEARCH_SCAN_LIMIT = 50_000;

/**
 * Iterative (stack-based) walk of the subtree under `baseDir`, collecting
 * files whose workspace-relative path contains `q`. Symlink-safe: it uses
 * dirent types and skips symlinks outright, so it never follows a link out of
 * the root or into a cycle. Honours the same HIDDEN / dotfile skips as
 * `listDir` so results stay a subset of what the tree can browse to.
 */
async function searchFiles(
  root: string,
  baseDir: string,
  q: string,
): Promise<{ matches: FileEntry[]; truncated: boolean }> {
  const matches: FileEntry[] = [];
  const stack: string[] = [baseDir];
  let scanned = 0;
  let truncated = false;
  while (stack.length > 0 && !truncated) {
    const dir = stack.pop()!;
    let names: import("node:fs").Dirent[];
    try {
      names = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of names) {
      if (HIDDEN.has(ent.name) || ent.name.startsWith(".")) continue;
      if (ent.isSymbolicLink()) continue;
      const abs = join(dir, ent.name);
      if (!inside(root, abs)) continue;
      if (++scanned >= SEARCH_SCAN_LIMIT) {
        truncated = true;
        break;
      }
      if (ent.isDirectory()) {
        stack.push(abs);
      } else if (ent.isFile()) {
        const rel = relative(root, abs).split(sep).join("/");
        if (rel.toLowerCase().includes(q)) {
          matches.push({ name: ent.name, relPath: rel, kind: "file" });
          if (matches.length >= SEARCH_RESULT_LIMIT) {
            truncated = true;
            break;
          }
        }
      }
    }
  }
  matches.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return { matches, truncated };
}

// Caps for the recursive content search. `RESULT_LIMIT` covers the wire
// payload (one entry per matching line); `FILE_LIMIT` bounds disk reads
// distinct from match count; `MAX_BYTES` skips obvious large/binary files.
const CONTENT_RESULT_LIMIT = 1000;
const CONTENT_FILE_LIMIT = 5000;
const CONTENT_MAX_BYTES = 1024 * 1024; // 1 MB — heuristic, mirrors VS Code default
const CONTENT_BINARY_PROBE = 8 * 1024; // 8 KB null-byte probe
const CONTENT_LINE_SNIPPET = 400; // chars retained per matching line

type ContentMatch = {
  /** File path relative to the chosen root, forward-slash. */
  relPath: string;
  /** 1-based line number for the match. */
  line: number;
  /** 1-based column of the first match on the line. */
  col: number;
  /** End column (exclusive) of the first match on the line. */
  colEnd: number;
  /** Trimmed line text — at most `CONTENT_LINE_SNIPPET` chars. */
  text: string;
  /** Whether `text` was truncated from the original line. */
  truncated: boolean;
};

/**
 * Iterative content search under `baseDir`. Reads each text file once and
 * returns one entry per matching line (`line`, `col`, snippet). Skips files
 * over 1 MB and files whose first 8 KB contains a NUL byte — the standard
 * "looks binary" heuristic used by ripgrep/grep — so the walk never tries
 * to UTF-8-decode an image or lockfile blob.
 *
 * Same HIDDEN / dotfile / symlink rules as `searchFiles`, so results stay
 * a subset of what the user can browse to in the tree.
 */
async function searchFileContents(
  root: string,
  baseDir: string,
  rawQuery: string,
  caseSensitive: boolean,
): Promise<{ matches: ContentMatch[]; truncated: boolean; scanned: number }> {
  const q = rawQuery;
  if (!q) return { matches: [], truncated: false, scanned: 0 };
  const needle = caseSensitive ? q : q.toLowerCase();
  const matches: ContentMatch[] = [];
  const stack: string[] = [baseDir];
  let filesScanned = 0;
  let truncated = false;
  while (stack.length > 0 && !truncated) {
    const dir = stack.pop()!;
    let names: import("node:fs").Dirent[];
    try {
      names = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of names) {
      if (HIDDEN.has(ent.name) || ent.name.startsWith(".")) continue;
      if (ent.isSymbolicLink()) continue;
      const abs = join(dir, ent.name);
      if (!inside(root, abs)) continue;
      if (ent.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (!ent.isFile()) continue;
      if (++filesScanned >= CONTENT_FILE_LIMIT) {
        truncated = true;
        break;
      }
      let stat: import("node:fs").Stats;
      try {
        stat = await fs.stat(abs);
      } catch {
        continue;
      }
      if (stat.size === 0 || stat.size > CONTENT_MAX_BYTES) continue;
      // Binary probe: read first 8 KB and reject if a NUL byte is present.
      // Cheap (one allocation) and catches PNGs, lockfiles with embedded
      // nuls, native binaries — without a hard mime/extension list.
      let probe: Buffer;
      try {
        const fh = await fs.open(abs, "r");
        try {
          const len = Math.min(CONTENT_BINARY_PROBE, stat.size);
          probe = Buffer.alloc(len);
          await fh.read(probe, 0, len, 0);
        } finally {
          await fh.close();
        }
      } catch {
        continue;
      }
      if (probe.includes(0)) continue;
      let content: string;
      try {
        content = await fs.readFile(abs, "utf8");
      } catch {
        continue;
      }
      const rel = relative(root, abs).split(sep).join("/");
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const hay = caseSensitive ? line : line.toLowerCase();
        const idx = hay.indexOf(needle);
        if (idx === -1) continue;
        let snippet = line;
        let snippetTrunc = false;
        // Centre the snippet on the match if the line is huge — so the user
        // sees context, not just the first 400 chars of a one-liner.
        if (snippet.length > CONTENT_LINE_SNIPPET) {
          const half = Math.floor((CONTENT_LINE_SNIPPET - needle.length) / 2);
          const start = Math.max(0, idx - half);
          const end = Math.min(snippet.length, start + CONTENT_LINE_SNIPPET);
          snippet = snippet.slice(start, end);
          snippetTrunc = true;
          // Adjust col so the highlight aligns with the snippet
          matches.push({
            relPath: rel,
            line: i + 1,
            col: Math.max(1, idx - start + 1),
            colEnd: Math.max(1, idx - start + 1) + q.length,
            text: snippet,
            truncated: snippetTrunc,
          });
        } else {
          matches.push({
            relPath: rel,
            line: i + 1,
            col: idx + 1,
            colEnd: idx + 1 + q.length,
            text: snippet,
            truncated: snippetTrunc,
          });
        }
        if (matches.length >= CONTENT_RESULT_LIMIT) {
          truncated = true;
          break;
        }
      }
      if (truncated) break;
    }
  }
  matches.sort((a, b) => {
    if (a.relPath !== b.relPath) return a.relPath.localeCompare(b.relPath);
    return a.line - b.line;
  });
  return { matches, truncated, scanned: filesScanned };
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
