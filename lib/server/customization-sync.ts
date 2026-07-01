import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";

import {
  customizationSrcDir,
  getCustomization,
  updateCustomizationRecord,
} from "./customizations-store";
import { hashFileOrNull, listSourceFiles } from "./customization-hash";
import { ensureManifest, writeManifest, type BaseManifest } from "./customization-manifest";
import { getLiveSourceDir } from "./runtime-dir";
import { CLAUDIUS_VERSION } from "@/lib/shared/version";

/**
 * Per-file sync verdict:
 *
 *   - in-sync       custom == live (manifest doesn't matter)
 *   - upstream-only custom == manifest, live ≠ manifest. Safe overwrite.
 *   - user-only     custom ≠ manifest, live == manifest. Don't touch.
 *   - conflict      custom ≠ manifest AND live ≠ manifest AND custom ≠ live.
 *                   The user edited this file; upstream also changed it.
 *                   Manual merge required — never auto-overwrite.
 *   - new-upstream  not in manifest, exists in live, missing in custom.
 *                   Safe add.
 *   - new-user      exists in custom, not in manifest, not in live.
 *                   User-added file.
 *   - deleted-upstream  in manifest, missing in live, custom == manifest.
 *                       Safe delete.
 *   - deleted-user      in manifest, present in live, missing in custom.
 *                       User explicitly removed it; leave alone.
 */
export type SyncVerdict =
  | "in-sync"
  | "upstream-only"
  | "user-only"
  | "conflict"
  | "new-upstream"
  | "new-user"
  | "deleted-upstream"
  | "deleted-user";

export type SyncEntry = {
  path: string;
  verdict: SyncVerdict;
  manifestHash: string | null;
  customHash: string | null;
  liveHash: string | null;
};

export type SyncStatus = {
  manifestCreatedAt: number;
  /** The Claudius version the fork point is aligned to (from the record). */
  baseVersion?: string;
  /** The running Claudius version, for "vX → vY" upgrade prompts. */
  currentVersion: string;
  /** True when baseVersion is set and differs from currentVersion. */
  outdated: boolean;
  totals: Record<SyncVerdict, number>;
  entries: SyncEntry[];
};

const SAFE_VERDICTS: SyncVerdict[] = ["upstream-only", "new-upstream", "deleted-upstream"];

export async function computeSyncStatus(customizationId: string): Promise<SyncStatus> {
  const live = getLiveSourceDir();
  const src = customizationSrcDir(customizationId);
  const manifest = await ensureManifest(customizationId, src);
  const record = await getCustomization(customizationId);
  const baseVersion = record?.baseVersion;

  // Union of paths from manifest, live, and custom — covers added, deleted,
  // and persistent files alike.
  const liveFiles = new Set(await listSourceFiles(live));
  const customFiles = new Set(await listSourceFiles(src));
  const manifestFiles = new Set(Object.keys(manifest.files));
  const all = new Set<string>([...liveFiles, ...customFiles, ...manifestFiles]);

  const entries: SyncEntry[] = [];
  for (const rel of all) {
    const manifestHash = manifest.files[rel] ?? null;
    const liveHash = liveFiles.has(rel) ? await hashFileOrNull(join(live, rel)) : null;
    const customHash = customFiles.has(rel) ? await hashFileOrNull(join(src, rel)) : null;

    const verdict: SyncVerdict = classify({ manifestHash, customHash, liveHash });
    entries.push({ path: rel, verdict, manifestHash, customHash, liveHash });
  }

  entries.sort((a, b) => a.path.localeCompare(b.path));
  const totals = entries.reduce<Record<SyncVerdict, number>>(
    (acc, e) => {
      acc[e.verdict]++;
      return acc;
    },
    {
      "in-sync": 0,
      "upstream-only": 0,
      "user-only": 0,
      "conflict": 0,
      "new-upstream": 0,
      "new-user": 0,
      "deleted-upstream": 0,
      "deleted-user": 0,
    },
  );
  return {
    manifestCreatedAt: manifest.createdAt,
    baseVersion,
    currentVersion: CLAUDIUS_VERSION,
    outdated: baseVersion != null && baseVersion !== CLAUDIUS_VERSION,
    totals,
    entries,
  };
}

function classify(h: {
  manifestHash: string | null;
  customHash: string | null;
  liveHash: string | null;
}): SyncVerdict {
  const { manifestHash, customHash, liveHash } = h;

  if (customHash === liveHash && customHash !== null) return "in-sync";

  // Files not present in manifest at all
  if (manifestHash === null) {
    if (customHash === null && liveHash !== null) return "new-upstream";
    if (customHash !== null && liveHash === null) return "new-user";
    if (customHash !== null && liveHash !== null && customHash === liveHash) return "in-sync";
    if (customHash !== null && liveHash !== null) return "conflict";
    return "in-sync"; // both null — shouldn't really hit
  }

  // Files in manifest
  if (customHash === null && liveHash === null) {
    // both deleted post-fork — call it in-sync
    return "in-sync";
  }
  if (customHash === null && liveHash !== null) {
    // user deleted; upstream has it (possibly modified). Don't touch.
    return "deleted-user";
  }
  if (customHash !== null && liveHash === null) {
    // upstream deleted; user still has it.
    if (customHash === manifestHash) return "deleted-upstream";
    return "conflict";
  }
  // Both present
  const userChanged = customHash !== manifestHash;
  const upstreamChanged = liveHash !== manifestHash;
  if (!userChanged && !upstreamChanged) return "in-sync";
  if (userChanged && !upstreamChanged) return "user-only";
  if (!userChanged && upstreamChanged) return "upstream-only";
  // Both changed
  if (customHash === liveHash) return "in-sync";
  return "conflict";
}

export type SyncResult = {
  applied: number;
  added: number;
  deleted: number;
  skippedConflicts: number;
  appliedPaths: string[];
};

export async function applySafeSync(customizationId: string): Promise<SyncResult> {
  const live = getLiveSourceDir();
  const src = customizationSrcDir(customizationId);
  const status = await computeSyncStatus(customizationId);

  const result: SyncResult = {
    applied: 0,
    added: 0,
    deleted: 0,
    skippedConflicts: status.totals["conflict"],
    appliedPaths: [],
  };

  for (const entry of status.entries) {
    if (!SAFE_VERDICTS.includes(entry.verdict)) continue;
    const liveAbs = join(live, entry.path);
    const customAbs = join(src, entry.path);
    if (entry.verdict === "deleted-upstream") {
      try {
        await fs.rm(customAbs, { force: true });
        result.deleted++;
        result.appliedPaths.push(entry.path);
      } catch {
        // skip — cleanup is best-effort
      }
      continue;
    }
    // upstream-only or new-upstream → copy live → custom
    try {
      await fs.mkdir(dirname(customAbs), { recursive: true });
      await fs.copyFile(liveAbs, customAbs);
      if (entry.verdict === "new-upstream") result.added++;
      else result.applied++;
      result.appliedPaths.push(entry.path);
    } catch {
      // skip — file may have raced
    }
  }

  // Refresh the manifest so the just-applied changes become the new common
  // ancestor. Conflicts and user-only files keep their old manifest entry,
  // so future syncs still recognise them correctly.
  const next = await rebuildManifestPreservingUserState(customizationId, status);
  await writeManifest(customizationId, next);

  // The mirror is now re-based onto the running app, so advance the fork-point
  // version. Even a no-op sync (0 safe changes) legitimately re-bases when the
  // only differences are the user's own edits — the base itself is current.
  await updateCustomizationRecord(customizationId, { baseVersion: CLAUDIUS_VERSION }).catch(() => {
    // best-effort: version label is cosmetic; a write failure must not fail the sync
  });

  return result;
}

async function rebuildManifestPreservingUserState(
  customizationId: string,
  status: SyncStatus,
): Promise<BaseManifest> {
  const live = getLiveSourceDir();
  const newFiles: Record<string, string> = {};
  for (const e of status.entries) {
    // After sync, files in these states have custom content == live content,
    // so the new manifest entry is the live hash.
    if (e.verdict === "in-sync" || e.verdict === "upstream-only" || e.verdict === "new-upstream") {
      if (e.liveHash) newFiles[e.path] = e.liveHash;
      // deleted-upstream → drop from manifest entirely
      continue;
    }
    if (e.verdict === "deleted-upstream") {
      // manifest entry removed
      continue;
    }
    if (e.verdict === "user-only") {
      // user diverged; keep the old manifest hash so we still recognise the
      // file as user-modified relative to the original fork point.
      if (e.manifestHash) newFiles[e.path] = e.manifestHash;
      continue;
    }
    if (e.verdict === "conflict") {
      // both diverged; preserve old base so future "Resolve conflicts" UX
      // still has the original ancestor available.
      if (e.manifestHash) newFiles[e.path] = e.manifestHash;
      continue;
    }
    if (e.verdict === "new-user") {
      // not in manifest — leave it that way
      continue;
    }
    if (e.verdict === "deleted-user") {
      if (e.manifestHash) newFiles[e.path] = e.manifestHash;
      continue;
    }
  }
  // Mute unused live var if no upstream-only existed.
  void live;
  return {
    version: 1,
    createdAt: Date.now(),
    files: newFiles,
  };
}
