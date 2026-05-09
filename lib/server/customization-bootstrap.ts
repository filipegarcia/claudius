import { constants as fsConstants, promises as fs } from "node:fs";
import { join, relative } from "node:path";

import { getLiveSourceDir } from "./runtime-dir";
import {
  createCustomizationRecord,
  customizationSrcDir,
  updateCustomizationRecord,
  type Customization,
} from "./customizations-store";
import { createWorkspace, updateWorkspace } from "./workspaces-store";
import { buildManifestFromTree, writeManifest } from "./customization-manifest";

/**
 * Directories we never copy into a customization mirror — they're either huge,
 * regenerable, or environment-specific and would just bloat the user's edit
 * surface. The Next dev server inside the customization src will rebuild
 * `.next/` on first run and `npm install` will recreate `node_modules/`.
 */
const SKIP_DIRS = new Set([
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

const SKIP_FILES = new Set([
  ".DS_Store",
  // Claudius's own scheduler lock — copying it into the mirror leaves a
  // stale pid+sessionId that confuses the scheduler in any process that
  // boots from the mirror (e.g. the auto-spawned preview).
  "scheduled_tasks.lock",
]);

async function copyForMirror(src: string, dst: string): Promise<void> {
  // True copy semantics required: a hardlink would share the same inode, so
  // editing the customization file would also mutate the running app's file.
  // Prefer reflink (COPYFILE_FICLONE) where the FS supports it (APFS, Btrfs,
  // XFS) — it's effectively free until the first edit. On other filesystems
  // Node falls back to a real byte-copy automatically.
  await fs.copyFile(src, dst, fsConstants.COPYFILE_FICLONE);
}

/**
 * Recreate `<live>/node_modules/` inside `<dst>/node_modules/` using
 * hardlinks for files and verbatim copies of symlinks. Hardlinks share inodes
 * with the live source so disk cost is near-zero, but each path lives
 * physically inside the customization src — Turbopack (Next 16's bundler)
 * rejects a single top-level symlink because it "points out of the
 * filesystem". This walk produces an in-tree clone instead.
 *
 * Internal node_modules symlinks (e.g. `.bin/next` → `../next/dist/bin/next`)
 * use relative targets, so re-creating them bit-for-bit keeps them resolving
 * inside `<dst>/node_modules/`.
 */
export async function ensureNodeModulesMirror(srcDir: string): Promise<void> {
  const live = getLiveSourceDir();
  const liveNm = join(live, "node_modules");
  const dstNm = join(srcDir, "node_modules");

  // Detect a legacy symlink left by an older bootstrap and replace it. A
  // symlink at the root is what Turbopack barfs on, so we always normalise.
  let needsRebuild = true;
  try {
    const st = await fs.lstat(dstNm);
    if (st.isSymbolicLink()) {
      await fs.unlink(dstNm);
    } else if (st.isDirectory()) {
      // Already a real dir — assume a previous run populated it.
      needsRebuild = false;
    }
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== "ENOENT") throw err;
  }

  if (!needsRebuild) return;
  try {
    await fs.access(liveNm);
  } catch {
    // No node_modules in the live source — nothing to mirror. The user can
    // run `npm install` inside the customization workspace if they need deps.
    return;
  }
  await hardlinkTree(liveNm, dstNm);
}

async function hardlinkTree(src: string, dst: string): Promise<void> {
  await fs.mkdir(dst, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const s = join(src, e.name);
    const d = join(dst, e.name);
    if (e.isSymbolicLink()) {
      // Preserve the original target (relative or absolute) verbatim. Most
      // npm-installed symlinks inside node_modules are relative and stay
      // resolved inside the new tree.
      try {
        const target = await fs.readlink(s);
        await fs.symlink(target, d);
      } catch (err) {
        const ec = (err as NodeJS.ErrnoException).code;
        if (ec === "EEXIST") continue;
        // On platforms that forbid symlink creation (locked-down Windows),
        // skip rather than fail the whole bootstrap.
      }
    } else if (e.isDirectory()) {
      await hardlinkTree(s, d);
    } else if (e.isFile()) {
      try {
        await fs.link(s, d);
      } catch (err) {
        const ec = (err as NodeJS.ErrnoException).code;
        if (ec === "EEXIST") continue;
        // Cross-device or permission denied — fall back to a real copy.
        try {
          await fs.copyFile(s, d);
        } catch {
          // give up on this file but keep walking the rest of the tree
        }
      }
    }
  }
}

async function copyTree(srcRoot: string, dstRoot: string): Promise<number> {
  let count = 0;
  const stack: string[] = [""];
  while (stack.length > 0) {
    const rel = stack.pop()!;
    const srcDir = join(srcRoot, rel);
    const dstDir = join(dstRoot, rel);
    await fs.mkdir(dstDir, { recursive: true });
    const entries = await fs.readdir(srcDir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        stack.push(join(rel, e.name));
      } else if (e.isFile()) {
        if (SKIP_FILES.has(e.name)) continue;
        await copyForMirror(join(srcDir, e.name), join(dstDir, e.name));
        count++;
      }
      // Symlinks: skip — copying through them risks following links outside
      // the source tree. Customizations don't need them in v1.
    }
  }
  return count;
}

export type BootstrapResult = {
  customization: Customization;
  workspaceId: string;
  filesCopied: number;
  srcDir: string;
};

/**
 * Creates a new customization: mirror the live source into
 * `<root>/<id>/src/`, register the customization, and create a linked
 * workspace whose `rootPath` is the mirror so the existing chat / git / files
 * panes work unchanged inside it.
 */
export async function bootstrapCustomization(input: { name: string }): Promise<BootstrapResult> {
  const live = getLiveSourceDir();
  const cust = await createCustomizationRecord({ name: input.name });
  const dst = customizationSrcDir(cust.id);
  await fs.mkdir(dst, { recursive: true });

  const filesCopied = await copyTree(live, dst);

  // Snapshot the fork point. Subsequent "Sync from base" calls treat this
  // manifest as the common ancestor when categorising user vs upstream
  // changes. Built from the freshly-copied mirror so customHash and
  // manifestHash start identical for every file.
  const manifest = await buildManifestFromTree(dst);
  await writeManifest(cust.id, manifest);

  // Sanity: the mirror must not overlap the live source (would cause the
  // copyTree to recurse into itself if a future change moves ROOT under cwd).
  const rel = relative(live, dst);
  if (!rel.startsWith("..") && rel !== "") {
    // The mirror is somehow inside the live source — abort to avoid corrupting
    // the user's workspace. Keep the record so the user sees the error.
    throw new Error(`refusing to bootstrap: mirror dir ${dst} is inside live source ${live}`);
  }

  const ws = await createWorkspace({
    name: `Customize · ${cust.name}`,
    rootPath: dst,
    defaults: undefined,
  });
  // Tag the workspace as a customization so the UI can differentiate it.
  // `createWorkspace` doesn't accept `kind` directly, so patch it after.
  await updateWorkspace(ws.id, { kind: "customization" });

  // Mirror node_modules from the live source so the user can run lint /
  // tsc / tests inside the customization workspace immediately. Uses
  // hardlinks so disk cost is near-zero. Turbopack rejects out-of-tree
  // symlinks, so this MUST be a real in-tree directory of hardlinks rather
  // than a single top-level symlink.
  await ensureNodeModulesMirror(dst);

  await updateCustomizationRecord(cust.id, { workspaceId: ws.id });

  return { customization: cust, workspaceId: ws.id, filesCopied, srcDir: dst };
}
