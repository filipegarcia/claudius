/**
 * Portable backup format for Claudius.
 *
 * `SettingsBundle` is the payload `/api/settings/export` emits and the one
 * `/api/settings/import` accepts. It bundles every user-configurable file
 * Claudius writes — both the install-wide ones under `~/.claude/` and the
 * per-workspace `.claude/` directories — into a single JSON blob.
 *
 * Two things are intentionally **not** in the bundle:
 *   - `activeId`: per-machine cursor. Restoring it could land the importer on
 *     a workspace that didn't heal cleanly.
 *   - Updater runtime state (`pending`, `lastCheckAt`, …): describes a
 *     transient check on the source machine; meaningless on the target.
 *
 * The shape is versioned from day one (`version: 1`) so future format changes
 * can be migrated rather than guessed at.
 *
 * Lives in `lib/shared/` so both the server (export/import modules,
 * route handlers) and the client (heal dialog) reference the same types.
 */

import type { ClaudeSettings } from "@/lib/server/settings";
import type { Workspace } from "@/lib/server/workspaces-store";
import type { CustomizeSettings } from "@/lib/server/customize-settings";
import type { UpdaterSettings } from "@/lib/server/updater/settings";
import type { KeybindingsFile } from "@/lib/server/keybindings";

/** Per-workspace contribution to the bundle. */
export type BundledWorkspace = {
  /** Row from `workspaces.json`, untouched. `id` is preserved for collision detection. */
  meta: Workspace;
  /**
   * Workspace icon image bytes, base64-encoded. Only present when the
   * source machine had a custom icon in `~/.claude/.claudius/workspace-icons/`.
   * Letter icons (the default) don't have separate bytes — the rendering is
   * driven entirely by `meta.icon`.
   */
  iconBytes?: { ext: string; base64: string };
  /** `<rootPath>/.claude/settings.json` if it existed; omitted when empty. */
  projectSettings?: ClaudeSettings;
  /** `<rootPath>/.claude/settings.local.json` if it existed; omitted when empty. */
  localSettings?: ClaudeSettings;
};

/** Install-wide files (`~/.claude/…`). All optional — only present when found. */
export type BundledSystem = {
  /** `~/.claude/settings.json` — Claude Code user-scope settings. */
  userSettings?: ClaudeSettings;
  /** `~/.claude/.claudius/customize-settings.json`. */
  customizeSettings?: CustomizeSettings;
  /**
   * `~/.claude/.claudius/updater.json` — but ONLY the user-knob subset.
   * Runtime fields (`state.pending`, `state.lastCheckAt`, …) are stripped.
   */
  updaterSettings?: Pick<UpdaterSettings, "mode" | "remote" | "branch" | "intervalHours">;
  /** `~/.claude/keybindings.json`. */
  keybindings?: KeybindingsFile;
};

export type SettingsBundle = {
  /** Schema version. Bump (and migrate on import) for breaking changes. */
  version: 1;
  /** Epoch ms when the bundle was produced. Surfaced in the import summary. */
  exportedAt: number;
  /** Source-machine fingerprint, for user reference only. */
  exportedFrom: {
    hostname: string;
    /** node's `process.platform` (`"darwin"`, `"linux"`, `"win32"`, …). */
    platform: string;
  };
  system: BundledSystem;
  workspaces: BundledWorkspace[];
};

// ── Heal/resume protocol types ────────────────────────────────────────────
//
// These describe the wire format between the import API and the heal dialog.
// Kept in lib/shared/ so the React client and Node server agree on the shape.

/** Hazard the import worker stopped on. The client renders a UI per `kind`. */
export type ImportPause =
  | {
      kind: "missing_root";
      /** Index into `bundle.workspaces` — drives `cursor` on resolve. */
      wsIndex: number;
      workspace: Workspace;
    }
  | {
      kind: "not_a_directory";
      wsIndex: number;
      workspace: Workspace;
      /** The resolved path that turned out to point at a file or device. */
      rootPath: string;
    }
  | {
      kind: "id_collision";
      wsIndex: number;
      incoming: Workspace;
      existing: Workspace;
    }
  | {
      kind: "path_collision";
      wsIndex: number;
      incoming: Workspace;
      existing: Workspace;
    };

/** User decision the client posts back to `/resolve`. */
export type ImportDecision =
  | { kind: "heal"; newRootPath: string }
  | { kind: "skip" }
  | { kind: "overwrite" }
  | { kind: "rename"; newName: string };

/** Per-workspace audit line, surfaced in the "done" summary. */
export type ImportLogEntry = {
  wsIndex: number;
  workspaceId: string;
  action: "created" | "updated" | "skipped" | "healed" | "renamed";
  /** Free-form note, e.g. "rootPath rewritten to /Users/me/Projects/foo". */
  note?: string;
};

/** Shape returned by `start`, `advance`, `resolve`, and `GET /api/.../[id]`. */
export type ImportProgress =
  | {
      state: "paused";
      importId: string;
      pause: ImportPause;
      /** Workspaces successfully committed so far. */
      processed: number;
      /** Total workspaces in the bundle. */
      total: number;
      log: ImportLogEntry[];
    }
  | {
      state: "done";
      importId: string;
      processed: number;
      total: number;
      log: ImportLogEntry[];
    }
  | {
      state: "error";
      importId: string;
      error: string;
      log: ImportLogEntry[];
    };
