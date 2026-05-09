import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";

import {
  customizationPublishesDir,
  customizationSrcDir,
  newPublishId,
  recordPublish,
  type PublishRecord,
  type PublishedFile,
} from "./customizations-store";
import {
  hashFile,
  hashFileOrNull,
  hashTree,
  listSourceFiles,
} from "./customization-hash";
import { getLiveSourceDir } from "./runtime-dir";

/**
 * Diff summary returned to the UI before the user hits Publish — so they
 * can see exactly which base files are about to be touched.
 */
export type DiffSummary = {
  changedFiles: number;
  addedFiles: number;
  identicalFiles: number;
  files: { path: string; kind: "added" | "changed"; customHash: string; baseHash: string | null }[];
};

export async function computeDiff(customizationId: string): Promise<DiffSummary> {
  const live = getLiveSourceDir();
  const src = customizationSrcDir(customizationId);
  const files = await listSourceFiles(src);
  const summary: DiffSummary = {
    changedFiles: 0,
    addedFiles: 0,
    identicalFiles: 0,
    files: [],
  };
  for (const rel of files) {
    const customAbs = join(src, rel);
    const baseAbs = join(live, rel);
    const [customHash, baseHash] = await Promise.all([
      hashFile(customAbs),
      hashFileOrNull(baseAbs),
    ]);
    if (baseHash == null) {
      summary.addedFiles++;
      summary.files.push({ path: rel, kind: "added", customHash, baseHash: null });
    } else if (baseHash !== customHash) {
      summary.changedFiles++;
      summary.files.push({ path: rel, kind: "changed", customHash, baseHash });
    } else {
      summary.identicalFiles++;
    }
  }
  // Sort for stable display.
  summary.files.sort((a, b) => a.path.localeCompare(b.path));
  return summary;
}

async function copyFile(srcAbs: string, dstAbs: string): Promise<void> {
  await fs.mkdir(dirname(dstAbs), { recursive: true });
  await fs.copyFile(srcAbs, dstAbs);
}

export async function publishCustomization(customizationId: string): Promise<PublishRecord> {
  const live = getLiveSourceDir();
  const src = customizationSrcDir(customizationId);
  const diff = await computeDiff(customizationId);
  if (diff.changedFiles + diff.addedFiles === 0) {
    throw new Error("nothing to publish");
  }

  const publishId = newPublishId();
  const pubRoot = join(customizationPublishesDir(customizationId), publishId);
  const snapshotRoot = join(pubRoot, "snapshot");
  await fs.mkdir(snapshotRoot, { recursive: true });

  // Snapshot existing base files BEFORE touching anything. If snapshotting
  // fails, abort cleanly without applying any changes.
  for (const f of diff.files) {
    if (f.kind === "added") continue;
    await copyFile(join(live, f.path), join(snapshotRoot, f.path));
  }

  // Apply: copy customization files into base.
  const applied: PublishedFile[] = [];
  for (const f of diff.files) {
    await copyFile(join(src, f.path), join(live, f.path));
    applied.push({ path: f.path, baseHash: f.baseHash, customHash: f.customHash });
  }

  // Hash the full live tree AFTER applying — that way a future revert can
  // re-verify "is the live tree still the one this publish produced?".
  // (Upgrade detection compares the post-publish hash to the current tree at
  // startup; mismatch means base was changed externally → auto-revert.)
  const baseHashAfterPublish = await hashTree(live);

  const manifest = {
    publishId,
    customizationId,
    publishedAt: Date.now(),
    files: applied,
    baseHashAfterPublish,
  };
  await fs.writeFile(join(pubRoot, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");

  const rec: PublishRecord = {
    id: publishId,
    customizationId,
    publishedAt: manifest.publishedAt,
    revertedAt: null,
    baseHash: baseHashAfterPublish,
    files: applied,
    snapshotDir: snapshotRoot,
  };
  await recordPublish(rec);
  return rec;
}
