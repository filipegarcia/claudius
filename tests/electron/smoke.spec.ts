/**
 * End-to-end smoke for the Electron build — Phase 10 of
 * docs/electron-conversion/PLAN.md.
 *
 * This is the loop's first chance to actually exercise main.ts,
 * preload.ts, server.ts (in dev mode via ELECTRON_START_URL), and the
 * IPC bridge end-to-end. Everything more specific (menu accelerators,
 * notification round-trips, deep-link routing) lives in adjacent
 * specs and reuses the same launch helper.
 *
 * The tests use the web Playwright project's webServer for the
 * renderer URL — same `next dev` instance that the browser specs
 * point at. Keeping one server means CI runs both projects in
 * parallel without spawning a second 1GB next process.
 */
// Smoke spec: launches Electron directly (does NOT rely on the shared
// `tests/helpers/test.ts` page fixture — these tests assert main-process
// affordances like the OS menu, so they need the raw `ElectronApplication`
// handle, not just a renderer `page`).
import { expect, test } from "@playwright/test";

import { launchElectron, teardownElectron, type LaunchedElectron } from "./launch";

let launched: LaunchedElectron;

test.beforeEach(async () => {
  launched = await launchElectron();
});

test.afterEach(async () => {
  await teardownElectron(launched);
});

test("first window opens and renders the chat shell", async () => {
  const page = await launched.app.firstWindow();
  // Wait for the body to render — the embedded next server has to
  // finish prepare() and the renderer needs to load /.
  await page.waitForLoadState("domcontentloaded");
  // The Electron build mounts the custom <TitleBar /> which the
  // browser build does not — testid is the cheapest assertion.
  await expect(page.locator('[data-testid="titlebar"]')).toBeVisible({
    timeout: 30_000,
  });
});

test("window.claudius bridge is mounted with the expected shape", async () => {
  const page = await launched.app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const probe = await page.evaluate(() => {
    const c = (window as unknown as { claudius?: Record<string, unknown> }).claudius;
    if (!c) return { mounted: false };
    return {
      mounted: true,
      isElectron: c.isElectron,
      platform: c.platform,
      bridgeVersion: c.bridgeVersion,
      hasMenu: typeof (c.menu as { on?: unknown } | undefined)?.on === "function",
      hasWindow: typeof (c.window as { minimize?: unknown } | undefined)?.minimize === "function",
      hasBadge: typeof (c.badge as { set?: unknown } | undefined)?.set === "function",
      hasNotifications:
        typeof (c.notifications as { show?: unknown } | undefined)?.show === "function",
      hasDialog: typeof (c.dialog as { openWorkspace?: unknown } | undefined)?.openWorkspace === "function",
      hasDeepLinks: typeof (c.deepLinks as { onOpen?: unknown } | undefined)?.onOpen === "function",
      hasUpdater: typeof (c.updater as { check?: unknown } | undefined)?.check === "function",
      hasWorkspaces:
        typeof (c.workspaces as { onOpenFolder?: unknown } | undefined)?.onOpenFolder === "function",
    };
  });

  expect(probe.mounted).toBe(true);
  expect(probe.isElectron).toBe(true);
  expect(typeof probe.platform).toBe("string");
  expect(typeof probe.bridgeVersion).toBe("number");
  expect(probe.hasMenu).toBe(true);
  expect(probe.hasWindow).toBe(true);
  expect(probe.hasBadge).toBe(true);
  expect(probe.hasNotifications).toBe(true);
  expect(probe.hasDialog).toBe(true);
  expect(probe.hasDeepLinks).toBe(true);
  expect(probe.hasUpdater).toBe(true);
  expect(probe.hasWorkspaces).toBe(true);
});

test("sandbox guarantees: require and process are not on window", async () => {
  const page = await launched.app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const probe = await page.evaluate(() => ({
    requireType: typeof (window as unknown as { require?: unknown }).require,
    processType: typeof (window as unknown as { process?: unknown }).process,
  }));
  expect(probe.requireType).toBe("undefined");
  expect(probe.processType).toBe("undefined");
});

test("application menu exists and contains the expected top-level items", async () => {
  // The renderer doesn't get to see the OS menu — query main directly.
  const menuLabels = await launched.app.evaluate(({ Menu }) => {
    const m = Menu.getApplicationMenu();
    if (!m) return null;
    return m.items.map((item) => item.label);
  });
  expect(menuLabels).not.toBeNull();
  const labels = (menuLabels ?? []).map((l) => l.replace(/&/g, ""));
  // On mac there's also the app-name menu at index 0; on win/linux
  // we start directly with File. Assert the union covers our expected
  // tops.
  for (const expected of ["File", "Edit", "View", "Tab", "Window", "Help"]) {
    expect(labels.includes(expected)).toBe(true);
  }
});
