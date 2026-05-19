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
import { contextBridge, ipcRenderer } from "electron";

// Topic names — keep these in sync with `electron/main.ts` once each
// phase adds the matching handler. The convention is
// `<namespace>:<verb>`; renderer → main uses `invoke`/`send`, main →
// renderer uses `webContents.send` with the renderer subscribing via
// `on`.
const TOPICS = {
  menuAction: "menu:action",
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
  deepLinkOpen: "deeplink:open",
  updaterCheck: "updater:check",
  updaterApply: "updater:apply",
  updaterStatus: "updater:status",
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
  bridgeVersion: 2 as const,

  menu: {
    on(action: string, cb: () => void): () => void {
      const handler = (_evt: Electron.IpcRendererEvent, payload: string) => {
        if (payload === action) cb();
      };
      ipcRenderer.on(TOPICS.menuAction, handler);
      return () => ipcRenderer.off(TOPICS.menuAction, handler);
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
          | { kind: "error"; message: string },
      ) => void,
    ) => subscribe(TOPICS.updaterStatus, cb),
  },
};

contextBridge.exposeInMainWorld("claudius", api);
