/**
 * Import-smoke for `electron/ipc/*` modules — Phase 8 deliverable,
 * advisor-recommended at iteration 10 of the ralph loop.
 *
 * These modules are physically loaded only when Claudius is running
 * inside Electron, but we still want vitest to verify that:
 *   1. Their top-level code (imports, side-effect requires) doesn't
 *      throw.
 *   2. Their named exports exist with the right shape.
 *
 * That catches the class of bugs where a `require("electron-updater")`
 * at the top of an IPC file silently breaks because the module isn't
 * resolvable in some packaging mode — without us having to actually
 * launch Electron to find out.
 *
 * `electron` and `electron-updater` are mocked because vitest runs
 * under plain Node where importing the real `electron` triggers the
 * binary launcher.
 */
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    requestSingleInstanceLock: () => true,
    on: vi.fn(),
    whenReady: () => Promise.resolve(),
    quit: vi.fn(),
    setAsDefaultProtocolClient: vi.fn(),
    setBadgeCount: vi.fn(),
    getAllWindows: () => [],
    getVersion: () => "0.0.0-test",
    getName: () => "Claudius",
    isReady: () => true,
  },
  BrowserWindow: class {
    static getAllWindows() {
      return [];
    }
    static getFocusedWindow() {
      return null;
    }
    static fromWebContents() {
      return null;
    }
    webContents = { send: vi.fn(), id: 1 };
    isDestroyed() {
      return false;
    }
  },
  ipcMain: { on: vi.fn(), handle: vi.fn() },
  shell: { openExternal: vi.fn() },
  dialog: { showOpenDialog: vi.fn(), showMessageBox: vi.fn() },
  Menu: { buildFromTemplate: () => ({}), setApplicationMenu: vi.fn() },
  Notification: class {
    static isSupported() {
      return true;
    }
    on = vi.fn();
    show = vi.fn();
  },
  nativeImage: {
    createFromBuffer: (b: Buffer) => ({ isEmpty: () => b.length === 0 }),
  },
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { on: vi.fn(), off: vi.fn(), send: vi.fn(), invoke: vi.fn() },
}));

vi.mock("electron-updater", () => ({
  autoUpdater: {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    logger: null,
    on: vi.fn(),
    checkForUpdates: vi.fn(),
    quitAndInstall: vi.fn(),
  },
}));

afterEach(() => {
  vi.resetModules();
});

describe("electron/ipc imports", () => {
  test("badge handler module loads and exports the expected fn", async () => {
    const mod = await import("@/electron/ipc/badge");
    expect(typeof mod.registerBadgeHandlers).toBe("function");
  });

  test("notifications handler module loads", async () => {
    const mod = await import("@/electron/ipc/notifications");
    expect(typeof mod.registerNotificationHandlers).toBe("function");
  });

  test("updater handler module loads (lazy require of electron-updater works)", async () => {
    const mod = await import("@/electron/ipc/updater");
    expect(typeof mod.registerUpdaterHandlers).toBe("function");
  });

  test("dialogs handler module loads", async () => {
    const mod = await import("@/electron/ipc/dialogs");
    expect(typeof mod.registerDialogHandlers).toBe("function");
  });

  test("context-menu handler module loads and exports its pieces", async () => {
    const mod = await import("@/electron/ipc/context-menu");
    expect(typeof mod.registerContextMenu).toBe("function");
    expect(typeof mod.buildContextMenuTemplate).toBe("function");
    expect(typeof mod.sendNewChatWithText).toBe("function");
    expect(mod.TOPIC_NEW_WITH_TEXT).toBe("chat:new-with-text");
  });

  test("deep-links handler module loads", async () => {
    const mod = await import("@/electron/ipc/deep-links");
    expect(typeof mod.registerProtocol).toBe("function");
    expect(typeof mod.registerDeepLinkHandlers).toBe("function");
  });

  test("bus module loads and creates a working pub/sub", async () => {
    const mod = await import("@/electron/ipc/bus");
    const bus = mod.createBus();
    const received: unknown[] = [];
    const unsub = bus.subscribe("topic", (v) => received.push(v));
    bus.publish("topic", "hello");
    bus.publish("topic", 42);
    unsub();
    bus.publish("topic", "after-unsub");
    expect(received).toEqual(["hello", 42]);
  });
});
