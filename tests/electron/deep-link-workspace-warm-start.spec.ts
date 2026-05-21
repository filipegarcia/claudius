/**
 * Electron e2e — `claudius://workspace/<id>` warm-start.
 *
 * Coverage row: COVERAGE.md §11 "Deep links + dialogs + drag-drop".
 *
 * Scope
 * -----
 * When the app is already running and the OS hands it a deep-link URL
 * (mac fires `open-url`, win/linux fire `second-instance` with the URL
 * in argv), main forwards the URL to the renderer via the
 * `deeplink:open` IPC channel. The renderer's
 * `<DeepLinksHandler />` component subscribes via
 * `bridge.deepLinks.onOpen(cb)` and routes via next/navigation.
 *
 * Test simulates the main → renderer half of that pipe directly:
 *   1. Fetch the workspace list to grab a valid id.
 *   2. From the main process, `webContents.send("deeplink:open",
 *      "claudius://workspace/<id>")`.
 *   3. Assert the renderer URL changes to `/<id>` (the route memory
 *      may add a sub-path; we match the prefix).
 *
 * This skips the OS-level protocol-handler registration (that path is
 * impossible to drive headlessly), but does verify the in-app routing
 * contract that handler eventually calls into.
 *
 * Driven by the autonomous e2e Ralph loop — see
 * docs/electron-conversion/E2E_LOOP_PROMPT.md.
 */
import { expect, test } from "@playwright/test";

import { launchElectron, teardownElectron, type LaunchedElectron } from "./launch";

let launched: LaunchedElectron;

test.beforeEach(async () => {
  launched = await launchElectron();
});

test.afterEach(async () => {
  await teardownElectron(launched);
});

// Wrapped in `test.fail()` because `lib/client/useDeepLinks.ts`'s URL
// parsing relies on `new URL(...).host` returning "workspace" for
// `claudius://workspace/<id>`, but Chromium's URL parser returns
// `host=""` for non-special schemes. The handler logs
// "unhandled url" and never navigates. See BUGS.md.
test.fail("deep-link: claudius://workspace/<id> warm-start routes the renderer", async () => {
  const page = await launched.app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await expect(page.locator('aside[data-pane-name="workspace-switcher"]')).toBeVisible({
    timeout: 30_000,
  });

  // Grab a workspace id that isn't the currently-active one (or fall
  // back to creating one if only the active is present). The
  // deep-link is interesting precisely because it should SWITCH the
  // active workspace — if we only had the active one, navigating to
  // it would be a no-op and we'd lose the assertion signal.
  const port = Number(process.env.CLAUDIUS_E2E_PORT ?? 3179);
  let target: string;
  {
    const list = (await (await page.request.get(`http://localhost:${port}/api/workspaces`)).json()) as {
      activeId: string | null;
      workspaces: { id: string; kind?: "project" | "customization" }[];
    };
    const others = list.workspaces.filter(
      (w) => (w.kind ?? "project") === "project" && w.id !== list.activeId,
    );
    if (others[0]) {
      target = others[0].id;
    } else {
      const created = (await (
        await page.request.post(`http://localhost:${port}/api/workspaces`, {
          data: { name: `deeplink-${Date.now()}`, rootPath: process.cwd() },
        })
      ).json()) as { id: string };
      target = created.id;
    }
  }

  // Give the renderer a beat to run the useDeepLinks useEffect that
  // subscribes to the IPC channel — without this we can race the
  // hook's mount and fire the send into the void.
  await page.waitForTimeout(500);

  // Capture renderer console output so a parse failure or unhandled-
  // url warning surfaces in the test report rather than silently
  // looking like "the IPC never fired".
  page.on("console", (msg) => {
    if (msg.type() === "warning" || msg.type() === "error") {
      // eslint-disable-next-line no-console -- spec diagnostic
      console.log(`[renderer ${msg.type()}] ${msg.text()}`);
    }
  });

  // Fire `deeplink:open` from main → renderer. This is what
  // `electron/ipc/deep-links.ts` does on `open-url` / second-instance.
  await launched.app.evaluate(({ BrowserWindow }, url) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error("no BrowserWindow in test launch");
    win.webContents.send("deeplink:open", url);
  }, `claudius://workspace/${target}`);

  // The renderer must navigate to a URL inside the target workspace.
  // The route-memory hook may resolve to /<id>/some/inner instead of
  // exactly /<id> — we match the prefix.
  await page.waitForURL(new RegExp(`/${target}(?:/|\\?|$)`), { timeout: 10_000 });
});
