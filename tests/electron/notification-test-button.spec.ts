/**
 * Electron e2e — the "Send test notification" button delivers a native
 * notification end-to-end.
 *
 * Coverage row: COVERAGE.md §5 "Notifications + badge".
 *
 * Unlike `notifications-show-via-bridge.spec.ts` (which calls
 * `bridge.notifications.show(...)` directly), this drives the **actual UI**:
 * open the bell menu on the chat status line → click "Send test
 * notification" → assert the main process received the payload. That
 * exercises the full chain the user hits:
 *   button onClick → sendTestNotification() → window.claudius.notifications
 *   .show() → IPC `notification:show` → main handler.
 *
 * The handler routes through `globalThis.__claudiusNotifSink__` when set
 * (see electron/ipc/notifications.ts), so no real OS banner fires and we can
 * assert the captured payload. (A real banner's *display* is an OS concern
 * Playwright can't observe; the IPC payload is the assertable boundary.)
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

test("notifications: the 'Send test notification' button reaches main with the Claudius payload", async () => {
  const page = await launched.app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForURL(/\/wks_[a-f0-9]+(\?|$)/, { timeout: 30_000 });
  await expect(page.getByTestId("prompt-input")).toBeVisible({ timeout: 30_000 });

  // Install the main-process sink so the handler records the payload
  // instead of constructing a real OS notification.
  await launched.app.evaluate(() => {
    type Payload = { title: string; body: string; silent: boolean; sessionId?: string };
    const g = globalThis as unknown as {
      __claudiusNotifPayloads__?: Payload[];
      __claudiusNotifSink__?: (p: Payload) => void;
    };
    g.__claudiusNotifPayloads__ = [];
    g.__claudiusNotifSink__ = (p: Payload) => g.__claudiusNotifPayloads__!.push(p);
  });

  // Open the bell menu and click the test button — the path a user takes.
  await page.getByTestId("session-notify-trigger").click();
  const testButton = page.getByTestId("session-notify-test");
  await expect(testButton).toBeVisible({ timeout: 5_000 });
  await testButton.click();

  // Main should receive exactly one payload, branded "Claudius".
  await expect
    .poll(
      () =>
        launched.app.evaluate(
          () =>
            (globalThis as unknown as { __claudiusNotifPayloads__?: unknown[] })
              .__claudiusNotifPayloads__?.length ?? 0,
        ),
      { timeout: 5_000 },
    )
    .toBeGreaterThanOrEqual(1);

  const captured = (await launched.app.evaluate(
    () =>
      (globalThis as unknown as { __claudiusNotifPayloads__?: unknown[] })
        .__claudiusNotifPayloads__ ?? [],
  )) as Array<{ title?: string; body?: string }>;

  expect(captured.length).toBe(1);
  expect(captured[0]?.title).toBe("Claudius");
  expect(captured[0]?.body ?? "").toContain("Test notification");

  // The renderer reflects success in the button label.
  await expect(testButton).toContainText("Sent", { timeout: 3_000 });
});
