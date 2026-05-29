/**
 * Updater feed-config gate.
 *
 * `electron-updater` reads `app-update.yml` from `process.resourcesPath`.
 * Local `--dir` packages are `app.isPackaged === true` but ship no such file,
 * so `checkForUpdates()` throws `ENOENT … app-update.yml` and paints a
 * permanent red "Updater error" banner. `registerUpdaterHandlers` must treat a
 * packaged-but-unconfigured build like dev: settle to `idle`, never `error`,
 * and never reach `checkForUpdates()`.
 *
 * `electron` / `electron-updater` are mocked (vitest runs under plain Node);
 * `node:fs` is mocked so we can toggle the presence of `app-update.yml`.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const send = vi.fn();
const ipcHandlers = new Map<string, (...args: unknown[]) => void>();
const checkForUpdates = vi.fn(() => Promise.resolve(null));

vi.mock("electron", () => ({
  app: { isPackaged: true },
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send } }],
  },
  ipcMain: {
    on: (topic: string, handler: (...args: unknown[]) => void) => {
      ipcHandlers.set(topic, handler);
    },
  },
}));

vi.mock("electron-updater", () => ({
  autoUpdater: {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    logger: null,
    on: vi.fn(),
    checkForUpdates,
    quitAndInstall: vi.fn(),
  },
}));

let updateConfigPresent = false;
vi.mock("node:fs", () => ({
  default: { existsSync: () => updateConfigPresent },
}));

beforeEach(() => {
  // `process.resourcesPath` is typed read-only; cast to override it for the
  // test (the updater config gate reads it to locate bundled resources).
  (process as unknown as { resourcesPath: string }).resourcesPath = "/tmp/fake-resources";
  send.mockClear();
  checkForUpdates.mockClear();
  ipcHandlers.clear();
});

afterEach(() => {
  vi.resetModules();
});

async function loadAndRegister() {
  const mod = await import("@/electron/ipc/updater");
  mod.registerUpdaterHandlers();
}

describe("updater feed-config gate", () => {
  test("packaged but no app-update.yml → check broadcasts idle, never error, never calls checkForUpdates", async () => {
    updateConfigPresent = false;
    await loadAndRegister();

    const check = ipcHandlers.get("updater:check");
    expect(check).toBeTypeOf("function");
    check!();

    expect(send).toHaveBeenCalledWith("updater:status", { kind: "idle" });
    expect(send).not.toHaveBeenCalledWith(
      "updater:status",
      expect.objectContaining({ kind: "error" }),
    );
    expect(checkForUpdates).not.toHaveBeenCalled();
  });

  // NOTE: the config-present path defers to `electron-updater`, which the
  // module pulls in via a lazy CommonJS `require(...)` that bypasses vitest's
  // `vi.mock`. Exercising it here would instantiate the real `MacUpdater`
  // against a stubbed Electron `app` and crash on version probing — not a
  // useful unit-level assertion. The gate's behavior is covered by the
  // unconfigured case above; the configured path is exercised by the packaged
  // smoke build.
});
