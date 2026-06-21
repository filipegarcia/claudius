/**
 * Preload script for the Claudius renderer.
 *
 * Phase 2 of docs/electron-conversion/PLAN.md.
 *
 * Mounts the full `window.claudius` bridge defined by the contract in
 * `lib/shared/electron.d.ts`. Every method is wired to an IPC channel
 * here, even when the matching main-process handler hasn't landed yet
 * — later phases (3 menu, 4 window, 6 notifications, 7 updater, 8
 * deeplinks) only add `ipcMain.handle/on` registrations, not preload
 * changes. Renderer code can therefore feature-detect once
 * (`window.claudius?.foo(...)`) and stay forward-compatible.
 *
 * Hard rules enforced by sandbox + contextIsolation:
 *  - No `require` in the renderer.
 *  - No raw `ipcRenderer` reaches the renderer — only the typed
 *    surface below.
 *  - No `BrowserWindow` / `Menu` / `Notification` constructors here;
 *    those live in main.
 */
import { contextBridge, ipcRenderer, webUtils } from "electron";

// Topic names — keep these in sync with `electron/main.ts` once each
// phase adds the matching handler. The convention is
// `<namespace>:<verb>`; renderer → main uses `invoke`/`send`, main →
// renderer uses `webContents.send` with the renderer subscribing via
// `on`.
const TOPICS = {
  menuAction: "menu:action",
  menuSetAccelerators: "menu:set-accelerators",
  menuSetRecording: "menu:set-recording",
  windowMinimize: "window:minimize",
  windowMaximize: "window:maximize",
  windowClose: "window:close",
  windowToggleFullscreen: "window:toggle-fullscreen",
  windowToggleDevTools: "window:toggle-devtools",
  badgeSet: "badge:set",
  notificationShow: "notification:show",
  notificationClick: "notification:click",
  dialogOpenWorkspace: "dialog:open-workspace",
  dialogOpenFile: "dialog:open-file",
  permissionStatus: "permission:status",
  permissionRunScan: "permission:run-scan",
  permissionMarkSeen: "permission:mark-seen",
  deepLinkOpen: "deeplink:open",
  updaterCheck: "updater:check",
  updaterApply: "updater:apply",
  updaterStatus: "updater:status",
  updaterOpenAppManagementSettings: "updater:open-app-management-settings",
  workspaceOpenFolder: "workspace:open-folder",
  chatNewWithText: "chat:new-with-text",
  chatAppendToComposer: "chat:append-to-composer",
  linkTargetSet: "link-target:set",
} as const;

/**
 * Helper that wires a main → renderer push channel into the typed
 * unsubscribe shape used by the bridge.
 */
function subscribe<T>(
  channel: string,
  cb: (payload: T) => void,
): () => void {
  const handler = (_evt: Electron.IpcRendererEvent, payload: T) =>
    cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.off(channel, handler);
}

const api = {
  isElectron: true as const,
  platform: process.platform,
  bridgeVersion: 8 as const,

  menu: {
    on(action: string, cb: () => void): () => void {
      const handler = (_evt: Electron.IpcRendererEvent, payload: string) => {
        if (payload === action) cb();
      };
      ipcRenderer.on(TOPICS.menuAction, handler);
      return () => ipcRenderer.off(TOPICS.menuAction, handler);
    },
    setAccelerators(accelerators: Record<string, string>): void {
      ipcRenderer.send(TOPICS.menuSetAccelerators, accelerators);
    },
    setRecording(enabled: boolean): void {
      ipcRenderer.send(TOPICS.menuSetRecording, enabled);
    },
  },

  window: {
    minimize: () => ipcRenderer.send(TOPICS.windowMinimize),
    maximize: () => ipcRenderer.send(TOPICS.windowMaximize),
    close: () => ipcRenderer.send(TOPICS.windowClose),
    toggleFullscreen: () => ipcRenderer.send(TOPICS.windowToggleFullscreen),
    toggleDevTools: () => ipcRenderer.send(TOPICS.windowToggleDevTools),
  },

  badge: {
    set: (count: number) => ipcRenderer.send(TOPICS.badgeSet, count),
  },

  notifications: {
    show: (opts: {
      title: string;
      body: string;
      sessionId?: string;
      silent?: boolean;
    }) => ipcRenderer.send(TOPICS.notificationShow, opts),
    onClick: (cb: (sessionId: string | undefined) => void) =>
      subscribe<string | undefined>(TOPICS.notificationClick, cb),
  },

  dialog: {
    openWorkspace: (): Promise<string | null> =>
      ipcRenderer.invoke(TOPICS.dialogOpenWorkspace),
    openFile: (opts?: {
      filters?: { name: string; extensions: string[] }[];
    }): Promise<string | null> =>
      ipcRenderer.invoke(TOPICS.dialogOpenFile, opts),
  },

  deepLinks: {
    onOpen: (cb: (url: string) => void) =>
      subscribe<string>(TOPICS.deepLinkOpen, cb),
  },

  permission: {
    status: (): Promise<{
      completed: boolean;
      platform: NodeJS.Platform;
    }> => ipcRenderer.invoke(TOPICS.permissionStatus),
    runScan: (): Promise<
      { category: string; path: string; ok: boolean; error?: string }[]
    > => ipcRenderer.invoke(TOPICS.permissionRunScan),
    markSeen: (): Promise<boolean> =>
      ipcRenderer.invoke(TOPICS.permissionMarkSeen),
  },

  updater: {
    check: () => ipcRenderer.send(TOPICS.updaterCheck),
    apply: () => ipcRenderer.send(TOPICS.updaterApply),
    onStatus: (
      cb: (
        status:
          | { kind: "idle" }
          | { kind: "checking" }
          | { kind: "available"; version: string }
          | { kind: "downloading"; percent: number }
          | { kind: "downloaded"; version: string }
          | { kind: "error"; message: string }
          | { kind: "blocked-app-management"; message: string }
          | { kind: "manual-download"; version: string; url: string },
      ) => void,
    ) => subscribe(TOPICS.updaterStatus, cb),
    openAppManagementSettings: () =>
      ipcRenderer.send(TOPICS.updaterOpenAppManagementSettings),
  },

  workspaces: {
    onOpenFolder: (cb: (path: string) => void) =>
      subscribe<string>(TOPICS.workspaceOpenFolder, cb),
  },

  chat: {
    /**
     * Fires when the user picks "Start New Chat With Selection" from the
     * Electron context menu. Payload is the raw selection text the user
     * right-clicked on. Renderer reacts by creating a fresh session and
     * prefilling the composer (NOT auto-sending). Added in bridgeVersion 4.
     */
    onNewWithText: (cb: (text: string) => void) =>
      subscribe<string>(TOPICS.chatNewWithText, cb),
    /**
     * Fires when the user picks "Append Selection to Current Chat" from
     * the Electron context menu. Payload is the raw selection text.
     * Renderer appends it to the active composer's draft (NOT auto-sending).
     */
    onAppendToComposer: (cb: (text: string) => void) =>
      subscribe<string>(TOPICS.chatAppendToComposer, cb),
  },

  linkTarget: {
    /**
     * Push the user's outbound-link preference ("external" — default
     * browser; "in-app" — sandboxed BrowserWindow inside Claudius) to
     * the main process. Main caches it and consults the cache from
     * `setWindowOpenHandler` on every click — no async round-trip per
     * link. Added in bridgeVersion 5.
     */
    set: (target: "external" | "in-app") =>
      ipcRenderer.send(TOPICS.linkTargetSet, target),
  },

  files: {
    /**
     * Resolve a dropped (or picked) `File` to its absolute filesystem
     * path. The HTML5 File API only exposes the basename via `file.name`;
     * `webUtils.getPathForFile` is Electron's modern (≥32) replacement
     * for the deprecated `file.path` getter and is the supported way to
     * recover the full OS path inside a sandboxed renderer.
     *
     * Returns `null` when Electron can't recover a path — e.g. a `File`
     * synthesised from a `Blob` rather than backed by a real file on
     * disk. Callers should treat that as "no path available" and fall
     * back to `file.name`.
     *
     * Added in bridgeVersion 6.
     */
    getPath(file: File): string | null {
      try {
        const p = webUtils.getPathForFile(file);
        return p ? p : null;
      } catch {
        return null;
      }
    },
  },
};

contextBridge.exposeInMainWorld("claudius", api);
