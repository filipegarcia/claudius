/**
 * Electron e2e — `bridge.notifications.show(...)` reaches the main
 * process with the expected payload.
 *
 * Coverage row: COVERAGE.md §5 "Notifications + badge" — first
 * concrete row enabled by the new Notification spy infra in
 * `electron/ipc/notifications.ts`.
 *
 * Spy infra
 * ---------
 * `electron/ipc/notifications.ts` now checks for a globally-mounted
 * test sink (`globalThis.__claudiusNotifSink__`) before constructing
 * a real OS Notification. The sink receives the same payload the
 * production code would have used; the OS toast never fires.
 *
 * We picked a globalThis hook (rather than mutating
 * `require("electron").Notification`) because Playwright's
 * `electronApp.evaluate(cb)` passes the electron module as a snapshot
 * — mutating it from the spec doesn't propagate back to the
 * dynamically-resolving handler. `globalThis` IS the same reference
 * across spec evaluates and main-process modules, so global hooks
 * persist where module mutations don't.
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

test("notifications: bridge.show reaches main and calls the sink with the payload", async () => {
  const page = await launched.app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  // Install the test sink. It pushes every payload into a global
  // array; the spec reads that array back after triggering.
  await launched.app.evaluate(() => {
    type Payload = { title: string; body: string; silent: boolean; sessionId?: string };
    const g = globalThis as unknown as {
      __claudiusNotifPayloads__?: Payload[];
      __claudiusNotifSink__?: (p: Payload) => void;
    };
    g.__claudiusNotifPayloads__ = [];
    g.__claudiusNotifSink__ = (p: Payload) => {
      g.__claudiusNotifPayloads__!.push(p);
    };
  });

  // Drive the renderer: call bridge.notifications.show with a payload
  // we'll later assert against. The renderer's preload exposes this
  // on `window.claudius.notifications.show`.
  const ts = Date.now();
  await page.evaluate(
    ({ ts }) => {
      const bridge = (
        window as unknown as { claudius?: { notifications: { show: (o: object) => void } } }
      ).claudius;
      if (!bridge) throw new Error("window.claudius not present — preload not loaded?");
      bridge.notifications.show({
        title: `e2e-${ts}`,
        body: `hello from spec at ${ts}`,
        sessionId: "sess-abc",
        silent: true,
      });
    },
    { ts },
  );

  // Wait for the sink to receive at least one payload. The IPC
  // roundtrip is async on the renderer side (`ipcRenderer.send`) but
  // synchronous on main (`ipcMain.on`); a short poll covers the
  // dispatch latency.
  await expect
    .poll(
      async () =>
        await launched.app.evaluate(() => {
          const arr = (globalThis as unknown as { __claudiusNotifPayloads__?: unknown[] })
            .__claudiusNotifPayloads__;
          return arr?.length ?? 0;
        }),
      { timeout: 5_000 },
    )
    .toBeGreaterThanOrEqual(1);

  const captured = await launched.app.evaluate(() => {
    const arr = (globalThis as unknown as { __claudiusNotifPayloads__?: unknown[] })
      .__claudiusNotifPayloads__;
    return arr ?? [];
  });

  expect(captured.length).toBe(1);
  const first = captured[0] as {
    title?: string;
    body?: string;
    silent?: boolean;
    sessionId?: string;
  };
  expect(first.title).toBe(`e2e-${ts}`);
  expect(first.body).toBe(`hello from spec at ${ts}`);
  expect(first.silent).toBe(true);
  expect(first.sessionId).toBe("sess-abc");
});
