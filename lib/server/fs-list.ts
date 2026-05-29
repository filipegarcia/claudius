import { promises as fs } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const IGNORE = new Set([
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

export type FsEntry = {
  /** Path relative to root (forward-slash). */
  relPath: string;
  /** Absolute path. */
  absPath: string;
  type: "file" | "dir";
};

type WalkOptions = {
  /** Maximum entries to collect. */
  max: number;
  /** Maximum directory depth. */
  maxDepth: number;
};

/**
 * Walks a directory tree breadth-first, skipping common large/irrelevant
 * folders (node_modules, .git, etc.) and bailing out at a hard cap. Returns
 * relative paths joined with forward slashes — safe for `@path` tokens.
 */
async function walk(root: string, opts: WalkOptions): Promise<FsEntry[]> {
  const out: FsEntry[] = [];
  const queue: Array<{ abs: string; depth: number }> = [{ abs: root, depth: 0 }];
  while (queue.length > 0 && out.length < opts.max) {
    const { abs, depth } = queue.shift()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (out.length >= opts.max) break;
      if (IGNORE.has(ent.name) || ent.name.startsWith(".")) continue;
      const childAbs = join(abs, ent.name);
      const rel = relative(root, childAbs).split(sep).join("/");
      if (ent.isDirectory()) {
        out.push({ relPath: rel + "/", absPath: childAbs, type: "dir" });
        if (depth + 1 < opts.maxDepth) queue.push({ abs: childAbs, depth: depth + 1 });
      } else if (ent.isFile()) {
        out.push({ relPath: rel, absPath: childAbs, type: "file" });
      }
    }
  }
  return out;
}

export type ListOptions = {
  cwd: string;
  query?: string;
  limit?: number;
};

export async function listFs(opts: ListOptions): Promise<FsEntry[]> {
  const root = resolve(opts.cwd);
  // We always walk broadly (capped at 5000) so a small `limit` doesn't starve
  // queries that match deep paths. The `limit` only applies after scoring.
  const all = await walk(root, { max: 5000, maxDepth: 6 });
  const q = (opts.query ?? "").trim().toLowerCase();
  if (!q) return all.slice(0, opts.limit ?? 200);
  // Score by closest match: prefix > substring > subsequence.
  type Scored = { e: FsEntry; score: number };
  const scored: Scored[] = [];
  for (const e of all) {
    const hay = e.relPath.toLowerCase();
    let score = -1;
    if (hay.startsWith(q)) score = 1000 - hay.length;
    else {
      const idx = hay.indexOf(q);
      if (idx >= 0) score = 500 - idx - hay.length / 100;
      else {
        // subsequence
        let n = 0;
        let h = 0;
        while (h < hay.length && n < q.length) {
          if (hay[h] === q[n]) n += 1;
          h += 1;
        }
        if (n === q.length) score = 100 - hay.length / 100;
      }
    }
    if (score > 0) scored.push({ e, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, opts.limit ?? 200).map((s) => s.e);
}
