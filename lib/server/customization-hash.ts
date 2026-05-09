import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * File-level + tree-level hashing helpers used by publish, revert, and
 * upgrade detection. Kept dependency-free so `bin/claudius-revert` can use
 * the same primitives without pulling in the rest of the server.
 *
 * The "live source" tree-hash deliberately excludes ephemeral / regenerable
 * dirs that change on every `npm install` or `next dev` run — otherwise a
 * pristine restart would always be flagged as an "upgrade" and trigger
 * spurious reverts.
 */

export const TREE_SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".git",
  ".turbo",
  ".cache",
  "dist",
  "out",
  "playwright-report",
  "test-results",
  ".vercel",
]);

const TREE_SKIP_FILES = new Set([".DS_Store"]);

export async function hashFile(absPath: string): Promise<string> {
  const buf = await fs.readFile(absPath);
  const h = createHash("sha1");
  h.update(buf);
  return h.digest("hex");
}

export async function hashFileOrNull(absPath: string): Promise<string | null> {
  try {
    return await hashFile(absPath);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return null;
    throw err;
  }
}

async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const stack: string[] = [""];
  while (stack.length > 0) {
    const rel = stack.pop()!;
    const dir = join(root, rel);
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") continue;
      throw err;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (TREE_SKIP_DIRS.has(e.name)) continue;
        stack.push(join(rel, e.name));
      } else if (e.isFile()) {
        if (TREE_SKIP_FILES.has(e.name)) continue;
        out.push(join(rel, e.name));
      }
    }
  }
  // Sort using POSIX separators so the tree hash is stable across platforms.
  return out.map((p) => p.split(sep).join("/")).sort();
}

export async function listSourceFiles(root: string): Promise<string[]> {
  return walkFiles(root);
}

/**
 * Hash of an entire source tree — concatenates per-file (path + sha1) into a
 * single digest. Used as the "base hash" stored alongside a publish so we
 * can detect when the live source has been upgraded out from under us.
 */
export async function hashTree(root: string): Promise<string> {
  const files = await walkFiles(root);
  const h = createHash("sha1");
  for (const rel of files) {
    const sha = await hashFile(join(root, rel));
    h.update(rel);
    h.update("\0");
    h.update(sha);
    h.update("\n");
  }
  return h.digest("hex");
}

export function relPosix(root: string, abs: string): string {
  return relative(root, abs).split(sep).join("/");
}
