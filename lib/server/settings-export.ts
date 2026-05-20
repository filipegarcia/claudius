import { hostname, platform } from "node:os";

import { readSettings } from "./settings";
import { listWorkspaces, readIcon } from "./workspaces-store";
import {
  DEFAULT_AUTO_FIX_PROMPT,
  getSettings as getCustomizeSettings,
} from "./customize-settings";
import { getUpdaterSettings } from "./updater/settings";
import { readKeybindings } from "./keybindings";
import type {
  BundledSystem,
  BundledWorkspace,
  SettingsBundle,
} from "@/lib/shared/settings-bundle";

/**
 * Assemble a `SettingsBundle` from everything Claudius has on disk.
 *
 * Read failures on a *missing* file are normal — those entries are simply
 * omitted from the bundle. Any other error (permission denied, malformed
 * JSON the underlying reader didn't tolerate) bubbles up to the route, which
 * surfaces it as a 500. Better to fail loudly than ship a half-empty backup
 * the user later believes is complete.
 *
 * Workspace project/local settings are read against the workspace's
 * `rootPath`. If the rootPath happens to be missing on the source machine
 * (rare — typically only when the user deleted a project they kept in the
 * sidebar), `readSettings` returns `{}` for ENOENT and we drop it. Other
 * I/O errors propagate, which is the right call: an unreadable .claude
 * dir means the user's local backup is bad, not the bundle.
 */
export async function buildExportBundle(): Promise<SettingsBundle> {
  const [userSettings, customizeSettings, updaterFull, keybindingsResult, workspaces] =
    await Promise.all([
      // `pathFor("user", cwd)` ignores cwd — see settings.ts. We pass an
      // empty-ish marker just to satisfy the signature.
      readSettings("user", process.cwd()),
      getCustomizeSettings(),
      getUpdaterSettings(),
      readKeybindings(),
      listWorkspaces(),
    ]);

  const system: BundledSystem = {};
  if (Object.keys(userSettings).length > 0) system.userSettings = userSettings;
  // customize-settings always returns an object with `autoFixPrompt`,
  // defaulted to `DEFAULT_AUTO_FIX_PROMPT` when the file doesn't exist. Only
  // include it in the bundle when the user actually customized the prompt;
  // otherwise we'd ship the canonical template inside every backup, even
  // on fresh installs.
  if (
    customizeSettings &&
    customizeSettings.autoFixPrompt &&
    customizeSettings.autoFixPrompt !== DEFAULT_AUTO_FIX_PROMPT
  ) {
    system.customizeSettings = customizeSettings;
  }
  system.updaterSettings = {
    mode: updaterFull.mode,
    remote: updaterFull.remote,
    branch: updaterFull.branch,
    intervalHours: updaterFull.intervalHours,
  };
  if (keybindingsResult.exists && keybindingsResult.data) {
    system.keybindings = keybindingsResult.data;
  }

  const bundledWorkspaces: BundledWorkspace[] = await Promise.all(
    workspaces.map(async (ws) => {
      const [projectSettings, localSettings, icon] = await Promise.all([
        readSettings("project", ws.rootPath).catch((err) => {
          // rootPath gone on the source machine — treat as "no settings".
          if (isFsLookupError(err)) return {};
          throw err;
        }),
        readSettings("local", ws.rootPath).catch((err) => {
          if (isFsLookupError(err)) return {};
          throw err;
        }),
        readIcon(ws.id),
      ]);
      const out: BundledWorkspace = { meta: ws };
      if (Object.keys(projectSettings).length > 0) out.projectSettings = projectSettings;
      if (Object.keys(localSettings).length > 0) out.localSettings = localSettings;
      if (icon) {
        out.iconBytes = { ext: icon.ext, base64: icon.buf.toString("base64") };
      }
      return out;
    }),
  );

  return {
    version: 1,
    exportedAt: Date.now(),
    exportedFrom: { hostname: hostname(), platform: platform() },
    system,
    workspaces: bundledWorkspaces,
  };
}

/**
 * A lookup that fails because the path doesn't exist at all (the workspace
 * was deleted off-disk but still in the sidebar). Everything else is a real
 * problem and should propagate.
 */
function isFsLookupError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** YYYY-MM-DD slug for the suggested download filename. */
export function suggestedFilename(at: number = Date.now()): string {
  const d = new Date(at);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `claudius-backup-${yyyy}-${mm}-${dd}.json`;
}
