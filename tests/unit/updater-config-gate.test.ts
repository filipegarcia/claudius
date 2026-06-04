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
  app: {
    isPackaged: true,
    // Used by the post-quit swap-failure detector to compare against the
    // persisted target. The tests inject `currentVersion` directly so this
    // value is incidental — but updater.ts reads it at the production call
    // site, so the mock must expose something.
    getVersion: () => "0.0.0-test",
    getPath: (key: string) => (key === "userData" ? "/tmp" : "/tmp"),
  },
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send } }],
  },
  ipcMain: {
    on: (topic: string, handler: (...args: unknown[]) => void) => {
      ipcHandlers.set(topic, handler);
    },
  },
  // App Management → Settings deep link uses shell.openExternal; the
  // config-gate tests don't exercise that handler but updater.ts imports
  // `shell` at module top, so the mock must expose it.
  shell: { openExternal: vi.fn(() => Promise.resolve()) },
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

describe("updater App Management classifier", () => {
  const originalPlatform = process.platform;
  function setPlatform(p: NodeJS.Platform): void {
    Object.defineProperty(process, "platform", { value: p, configurable: true });
  }
  afterEach(() => {
    setPlatform(originalPlatform);
  });

  // Test classifyUpdaterError directly — the IPC-level integration path
  // routes through a lazy `require("electron-updater")` that bypasses
  // vi.mock (see note on the config-gate describe block above), so an
  // end-to-end assertion would fight the module system. The classifier
  // is the only piece of logic that meaningfully changes between the
  // two error variants; exporting + testing it directly is honest.
  test("darwin EPERM → blocked-app-management", async () => {
    setPlatform("darwin");
    const { classifyUpdaterError } = await import("@/electron/ipc/updater");
    expect(
      classifyUpdaterError(
        "EPERM: operation not permitted, rename '/Applications/Claudius.app'",
      ),
    ).toEqual({
      kind: "blocked-app-management",
      message: expect.stringContaining("EPERM"),
    });
  });

  test("darwin EACCES → blocked-app-management", async () => {
    setPlatform("darwin");
    const { classifyUpdaterError } = await import("@/electron/ipc/updater");
    expect(classifyUpdaterError("EACCES: permission denied").kind).toBe(
      "blocked-app-management",
    );
  });

  test("darwin 'Operation not permitted' (no errno) → blocked-app-management", async () => {
    setPlatform("darwin");
    const { classifyUpdaterError } = await import("@/electron/ipc/updater");
    expect(
      classifyUpdaterError(
        "Could not move update bundle: Operation not permitted",
      ).kind,
    ).toBe("blocked-app-management");
  });

  test("non-darwin EPERM stays generic error (avoids false-positive remediation)", async () => {
    setPlatform("linux");
    const { classifyUpdaterError } = await import("@/electron/ipc/updater");
    expect(
      classifyUpdaterError("EPERM: operation not permitted").kind,
    ).toBe("error");
  });

  test("darwin unrelated network error stays generic error", async () => {
    setPlatform("darwin");
    const { classifyUpdaterError } = await import("@/electron/ipc/updater");
    expect(
      classifyUpdaterError("net::ERR_NAME_NOT_RESOLVED github.com").kind,
    ).toBe("error");
  });
});

describe("detectPostQuitSwapFailure", () => {
  // Pure-function test — the production call site threads
  // process.platform/app.getVersion()/Date.now() in; we substitute
  // controlled values per case so the staleness window, version
  // comparison, and platform gate can each be exercised independently.
  const NOW = 1_700_000_000_000; // fixed instant, sidesteps clock drift
  const RECENT = NOW - 1000;

  test("darwin + downloaded but version didn't advance → blocked-app-management", async () => {
    const { detectPostQuitSwapFailure } = await import("@/electron/ipc/updater");
    const result = detectPostQuitSwapFailure({
      platform: "darwin",
      currentVersion: "1.0.0",
      now: NOW,
      consume: () => ({ targetVersion: "1.1.0", attemptedAt: RECENT }),
    });
    expect(result?.kind).toBe("blocked-app-management");
    expect(result?.kind === "blocked-app-management" && result.message).toMatch(/1\.1\.0/);
    expect(result?.kind === "blocked-app-management" && result.message).toMatch(/1\.0\.0/);
  });

  test("version matches → swap succeeded → null (no banner)", async () => {
    const { detectPostQuitSwapFailure } = await import("@/electron/ipc/updater");
    expect(
      detectPostQuitSwapFailure({
        platform: "darwin",
        currentVersion: "1.1.0",
        now: NOW,
        consume: () => ({ targetVersion: "1.1.0", attemptedAt: RECENT }),
      }),
    ).toBeNull();
  });

  test("no pending marker → null", async () => {
    const { detectPostQuitSwapFailure } = await import("@/electron/ipc/updater");
    expect(
      detectPostQuitSwapFailure({
        platform: "darwin",
        currentVersion: "1.0.0",
        now: NOW,
        consume: () => null,
      }),
    ).toBeNull();
  });

  test("stale marker (>14d) → null (user just never restarted)", async () => {
    const { detectPostQuitSwapFailure } = await import("@/electron/ipc/updater");
    const tooOld = NOW - 15 * 24 * 60 * 60 * 1000;
    expect(
      detectPostQuitSwapFailure({
        platform: "darwin",
        currentVersion: "1.0.0",
        now: NOW,
        consume: () => ({ targetVersion: "1.1.0", attemptedAt: tooOld }),
      }),
    ).toBeNull();
  });

  test("non-darwin → null (Windows/Linux failure modes are different)", async () => {
    const { detectPostQuitSwapFailure } = await import("@/electron/ipc/updater");
    expect(
      detectPostQuitSwapFailure({
        platform: "win32",
        currentVersion: "1.0.0",
        now: NOW,
        consume: () => ({ targetVersion: "1.1.0", attemptedAt: RECENT }),
      }),
    ).toBeNull();
  });
});
