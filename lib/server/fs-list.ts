import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

import {
  categorizeTccPath,
  isHiddenHomeSubpath,
} from "@/lib/shared/tcc-protected";

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

/**
 * Snapshot the user's home directory at module load. Used by the walk
 * below to decide whether descending into a child would cross into a
 * macOS TCC-protected category (Desktop/Documents/...). The path is
 * stable across the process lifetime; recomputing per-call would be
 * pointless overhead.
 */
const HOME = resolve(homedir());

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
 *
 * **macOS TCC gating.** This walk runs on every keystroke of the chat
 * composer's `@`-mention picker (`components/chat/AtMentionPicker.tsx`
 * → `/api/fs/list`), with `root = session.cwd`. If a session's cwd is
 * `~` (or any near-home directory whose subtree reaches Desktop /
 * Documents / Movies / Music / Pictures / Library within `maxDepth`),
 * a plain BFS would call `fs.readdir` on every one of those subdirs
 * and trigger macOS's TCC consent dialogs MID-CHAT, with no foreground
 * action to anchor them to. That's the "I'm on another prompt and
 * suddenly Photos is asking for permission" scenario.
 *
 * The fix below refuses to descend when the transition would cross
 * from non-protected into protected space — the entry for the
 * protected directory itself still appears in `out` (so the user can
 * `@Desktop` to reference the folder by name), but its contents
 * aren't enumerated and we never fs.* anything inside. `~/Library/
 * Containers` and `~/Library/Group Containers` (which produce the
 * generic "data from other apps" prompt) are dropped from `out` too.
 *
 * When the root itself is already inside a protected category (the
 * user has explicitly set their workspace cwd there), we DO descend —
 * the access is already implicit in the cwd choice, and gating it
 * would break @-mentions for projects living under `~/Desktop` etc.
 */
async function walk(root: string, opts: WalkOptions): Promise<FsEntry[]> {
  const out: FsEntry[] = [];
  const queue: Array<{ abs: string; depth: number }> = [{ abs: root, depth: 0 }];
  while (queue.length > 0 && out.length < opts.max) {
    const { abs, depth } = queue.shift()!;
    // Track the current node's TCC category so we can decide if a child
    // would be CROSSING into a protected subtree (parent: null → child:
    // non-null). When the parent is already inside a protected category,
    // the access is already granted and we walk normally.
    const parentCategory = categorizeTccPath(abs, HOME, process.platform);
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

      // Hard-drop `~/Library/Containers` and `~/Library/Group Containers`.
      // Descent there fires the macOS "Claudius would like to access
      // data from other apps" dialog and the contents are never useful
      // as @-mention candidates. Compare via path-relative-to-home so
      // walk roots outside home pass through unchanged.
      const relFromHome = relative(HOME, childAbs).split(sep).join("/");
      if (
        process.platform === "darwin" &&
        !relFromHome.startsWith("..") &&
        isHiddenHomeSubpath(relFromHome, process.platform)
      ) {
        continue;
      }

      const rel = relative(root, childAbs).split(sep).join("/");
      if (ent.isDirectory()) {
        out.push({ relPath: rel + "/", absPath: childAbs, type: "dir" });
        // Refuse to descend if doing so would cross from non-protected
        // space into a TCC category. The protected entry itself is
        // already in `out` above, so the user can still see/select it
        // by name — we just don't read what's inside.
        if (depth + 1 < opts.maxDepth) {
          const childCategory = categorizeTccPath(
            childAbs,
            HOME,
            process.platform,
          );
          const crossingIntoProtected =
            parentCategory === null && childCategory !== null;
          if (!crossingIntoProtected) {
            queue.push({ abs: childAbs, depth: depth + 1 });
          }
        }
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
