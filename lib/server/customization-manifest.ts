import { promises as fs } from "node:fs";
import { join } from "node:path";

import { customizationDir } from "./customizations-store";
import { hashFile, hashFileOrNull, listSourceFiles } from "./customization-hash";

/**
 * The base manifest is a snapshot of the live source taken at bootstrap time —
 * the "common ancestor" of any future merge between user edits and upstream
 * fixes. Stored alongside each customization at
 * `<root>/<id>/base-manifest.json`.
 *
 * Without this, we can't tell whether a file in the customization src diverges
 * from live because the user edited it or because upstream moved on after the
 * fork. With it, sync becomes safe: only files where (custom == manifest) get
 * overwritten when (live != manifest).
 */
export type BaseManifest = {
  version: 1;
  /** ms since epoch when the manifest was written. */
  createdAt: number;
  /** Map of POSIX-relative path → sha1 hex. */
  files: Record<string, string>;
};

export function manifestPath(customizationId: string): string {
  return join(customizationDir(customizationId), "base-manifest.json");
}

export async function readManifest(customizationId: string): Promise<BaseManifest | null> {
  try {
    const raw = await fs.readFile(manifestPath(customizationId), "utf8");
    const parsed = JSON.parse(raw) as BaseManifest;
    if (parsed.version === 1 && parsed.files && typeof parsed.files === "object") {
      return parsed;
    }
    return null;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return null;
    throw err;
  }
}

export async function writeManifest(customizationId: string, manifest: BaseManifest): Promise<void> {
  const path = manifestPath(customizationId);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  await fs.rename(tmp, path);
}

/**
 * Walk a source root and return `{ path → sha1 }` for every file. Skips
 * generated/dependency dirs (handled by `listSourceFiles`).
 */
export async function buildManifestFromTree(root: string): Promise<BaseManifest> {
  const files = await listSourceFiles(root);
  const out: Record<string, string> = {};
  for (const rel of files) {
    out[rel] = await hashFile(join(root, rel));
  }
  return { version: 1, createdAt: Date.now(), files: out };
}

/**
 * Best-effort backfill for customizations created before manifests existed.
 * Generates a manifest from the *customization's current content* — meaning
 * any user edits already made are baked into the "base", so future syncs
 * cannot retroactively detect those edits as user-modified. New edits going
 * forward are still tracked correctly.
 */
export async function ensureManifest(customizationId: string, srcRoot: string): Promise<BaseManifest> {
  const existing = await readManifest(customizationId);
  if (existing) return existing;
  const manifest = await buildManifestFromTree(srcRoot);
  await writeManifest(customizationId, manifest);
  return manifest;
}

export async function manifestHash(customizationId: string, relPath: string): Promise<string | null> {
  const m = await readManifest(customizationId);
  return m?.files[relPath] ?? null;
}

/** Convenience for the publish path: hash a file via the same digest used here. */
export { hashFile, hashFileOrNull };
