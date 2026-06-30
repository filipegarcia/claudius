import {
  activePublishesOrdered,
  customizationsRoot,
  markPublishReverted,
  stripCustomizationWorkspaceIds,
} from "./customizations-store";
import { hashTree } from "./customization-hash";
import { getLiveSourceDir } from "./runtime-dir";
import { revertPublish } from "./customization-revert";
import { deleteWorkspace, listWorkspaces } from "./workspaces-store";

/**
 * Boot-time upgrade detection.
 *
 * Each publish stores `baseHash` — the SHA1 of the live-source tree taken
 * AFTER the publish applied. If the live tree no longer matches that hash on
 * startup, base files were changed externally (npm update, git pull, manual
 * edit) and our snapshot can't safely be applied — restoring it would
 * overwrite the new base with old contents.
 *
 * Behavior: for each active publish whose stored hash mismatches the current
 * tree, run revert via the same CLI path the user would. The revert deletes
 * "added" files and copies snapshots back; if the user upgraded only files
 * the customization didn't touch, this is a no-op for those, while still
 * marking the publish as `stale_at_upgrade`.
 *
 * Best-effort: failures are logged but don't crash startup. The user sees
 * the stale records on /customize and can manually re-publish.
 */
/**
 * True when the current process is serving Next from inside a customization
 * mirror — i.e. it's an auto-spawned preview dev server, not the primary
 * Claudius. The preview process must NOT run upgrade detection: its tree is
 * intentionally divergent from base, so the check would always trigger and
 * the auto-revert would clobber the user's customization src.
 */
export function isRunningInsideCustomizationMirror(): boolean {
  const live = getLiveSourceDir();
  const root = customizationsRoot();
  // Normalize trailing slash so a sibling dir starting with the same prefix
  // doesn't accidentally match.
  return live === root || live.startsWith(root.endsWith("/") ? root : root + "/");
}

/**
 * Idempotent boot-time migration: customizations are no longer backed by a
 * dedicated Workspace record. This (1) strips the legacy `workspaceId` field
 * from every customization record, and (2) deletes every workspace tagged
 * `kind:"customization"` (the now-orphaned mirror workspaces).
 *
 * `deleteWorkspace` already reassigns `workspaces.json`'s `activeId` to the
 * next surviving workspace when it removes the active one, so the active-
 * workspace hint self-heals. A stale `claudius.workspace` cookie pointing at a
 * deleted id is tolerated by `resolveActiveWorkspace` (falls back to the hint /
 * first workspace), so no cookie surgery is needed here.
 *
 * Idempotent: once the field is stripped and the workspaces deleted, a second
 * boot finds nothing to do and writes nothing.
 */
export async function reconcileCustomizationWorkspaces(): Promise<void> {
  if (isRunningInsideCustomizationMirror()) return;
  try {
    const stripped = await stripCustomizationWorkspaceIds();
    if (stripped > 0) {
      console.log(`[customizations] stripped legacy workspaceId from ${stripped} record(s)`);
    }
    const workspaces = await listWorkspaces();
    for (const ws of workspaces) {
      if (ws.kind !== "customization") continue;
      await deleteWorkspace(ws.id);
      console.log(`[customizations] removed legacy customization workspace ${ws.id}`);
    }
  } catch (err) {
    console.warn("[customizations] could not reconcile customization workspaces:", err);
  }
}

export async function runCustomizationsUpgradeCheck(): Promise<void> {
  if (isRunningInsideCustomizationMirror()) {
    // Preview process — skip. The primary Claudius handles upgrade detection.
    return;
  }
  const active = await activePublishesOrdered();
  if (active.length === 0) return;
  const live = getLiveSourceDir();
  let currentHash: string;
  try {
    currentHash = await hashTree(live);
  } catch (err) {
    console.warn("[customizations] could not hash live source:", err);
    return;
  }
  for (const pub of active) {
    if (pub.baseHash === currentHash) continue;
    console.warn(
      `[customizations] active publish ${pub.id} is stale (base tree changed); auto-reverting`,
    );
    try {
      await revertPublish(pub.id);
      await markPublishReverted(pub.id, "stale_at_upgrade");
    } catch (err) {
      console.warn(`[customizations] auto-revert of ${pub.id} failed:`, err);
    }
  }
}
