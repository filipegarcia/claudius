/**
 * CC 2.1.314 parity — "[Cloud sessions] Fixed the permission mode picker
 * staying on Auto after a running cloud or Remote Control session refused
 * the switch; it now shows the mode in use and tells you".
 *
 * Claudius's composer mode pill set the new mode optimistically and ignored
 * the server's answer, and the server dropped the engine's refusal. Now
 * `POST /api/sessions/:id/mode` answers 409 with the mode still in use; the
 * pill shows that mode and a transient notice says the switch was refused.
 *
 * The engine refusal itself needs a live CLI that refuses (pinned by the
 * vitest `cc-parity-2.1.314-mode-change-refused.test.ts`); here the route's
 * 409 is fulfilled so the client half runs against the real app.
 *
 * Screenshot target: docs/cc-parity/2.1.314/mode-change-refused.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.314");
mkdirSync(SHOTS_DIR, { recursive: true });

const REASON = "set_permission_mode rejected — the session can't switch to that mode right now";

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

const LABEL: Record<string, string> = {
  default: "Default",
  acceptEdits: "Accept edits",
  auto: "Auto",
  plan: "Plan",
  dontAsk: "Don't ask",
  bypassPermissions: "Bypass",
};

test("a refused mode switch keeps the pill on the mode in use and says so", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto("/");
  await page.waitForURL(/[?&]session=[0-9a-f-]{36}/i, { timeout: 30_000 });
  const sessionId = page.url().match(/[?&]session=([0-9a-f-]{36})/i)![1];
  const trigger = page.getByTestId("mode-selector-trigger");
  await expect(trigger).toBeVisible({ timeout: 15_000 });

  // The session may still be adopting the workspace's default mode right
  // after boot; wait until the server's mode and the pill agree.
  const serverMode = async () =>
    ((await (await page.request.get(`/api/sessions/${sessionId}/mode`)).json()) as { mode: string }).mode;
  let inUse = await serverMode();
  await expect
    .poll(async () => {
      inUse = await serverMode();
      return (await trigger.getAttribute("title")) ?? "";
    }, { timeout: 15_000 })
    .toContain(`Permission mode: ${LABEL[inUse]} —`);
  const requested = inUse === "auto" ? "acceptEdits" : "auto";

  // The engine refusing needs a live CLI that refuses (see the vitest); the
  // route answers as the server does then: 409 + the mode still in use.
  let modePosts = 0;
  await page.route("**/api/sessions/*/mode", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    modePosts++;
    const { mode } = route.request().postDataJSON() as { mode: string };
    return route.fulfill({
      status: 409,
      json: { ok: false, mode: inUse, refused: { requested: mode, reason: REASON } },
    });
  });

  await trigger.click();
  await page.getByTestId(`mode-selector-option-${requested}`).click();

  const notice = page.getByTestId("mode-change-refused-notice");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText(
    `Couldn't switch to ${LABEL[requested]}: the session refused. Still in ${LABEL[inUse]}.`,
  );
  await expect(page.getByTestId("mode-change-refused-reason")).toHaveText(REASON);
  // The pill shows the mode actually in use, not the refused pick.
  await expect(trigger).toHaveAttribute("title", new RegExp(`^Permission mode: ${LABEL[inUse]} —`));
  expect(modePosts).toBe(1);
  expect(await serverMode()).toBe(inUse);

  await page.waitForTimeout(200);
  await page.screenshot({ path: resolve(SHOTS_DIR, "mode-change-refused.png"), fullPage: false });

  // Dismissible like its sibling notices.
  await notice.getByRole("button", { name: "Dismiss" }).click();
  await expect(notice).toHaveCount(0);
});

test("an accepted switch shows no notice", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto("/");
  await page.waitForURL(/[?&]session=[0-9a-f-]{36}/i, { timeout: 30_000 });
  const sessionId = page.url().match(/[?&]session=([0-9a-f-]{36})/i)![1];
  const trigger = page.getByTestId("mode-selector-trigger");
  await expect(trigger).toBeVisible({ timeout: 15_000 });
  const serverMode = async () =>
    ((await (await page.request.get(`/api/sessions/${sessionId}/mode`)).json()) as { mode: string }).mode;
  // Wait for the boot-time workspace default to settle, then remember it.
  let original = await serverMode();
  await expect
    .poll(async () => {
      original = await serverMode();
      return (await trigger.getAttribute("title")) ?? "";
    }, { timeout: 15_000 })
    .toContain(`Permission mode: ${LABEL[original]} —`);
  const target = original === "acceptEdits" ? "plan" : "acceptEdits";

  await trigger.click();
  await page.getByTestId(`mode-selector-option-${target}`).click();
  await expect(trigger).toHaveAttribute("title", new RegExp(`^Permission mode: ${LABEL[target]} —`));
  await expect.poll(serverMode).toBe(target);
  await page.waitForTimeout(500);
  await expect(page.getByTestId("mode-change-refused-notice")).toHaveCount(0);

  // Leave the real session as we found it: later specs may resume it.
  const restore = await page.request.post(`/api/sessions/${sessionId}/mode`, { data: { mode: original } });
  expect(restore.ok()).toBeTruthy();
});
