/**
 * CC 2.1.284 — "Added `/rate-limit-options` to `/help` and the command menu
 * for claude.ai subscribers, so the usage-limit notices that mention it
 * point to a command you can find."
 *
 * Claudius already has rich rate-limit UI (`RateLimitPill`/`RateLimitHitPanel`
 * with a "Buy credits" CTA, and the `autoRotateOnRateLimit` toggle +
 * provider switching) — all on the Usage page — but had no slash command
 * that jumped straight there, unlike `/usage` and `/upgrade` which already
 * exist as native commands. This release adds `rate-limit-options` to
 * `lib/shared/slash-commands.ts` (so it shows up in `/help` and the command
 * palette generically, same catalog both read from) and a native dispatcher
 * case in `ChatSurface.tsx` that toasts and navigates to `/usage`, matching
 * the exact shape of the existing `usage`/`login`/`setup-bedrock` cases.
 *
 * Screenshot target: docs/cc-parity/2.1.284/rate-limit-options-toast.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.284");
mkdirSync(SHOTS_DIR, { recursive: true });

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
  // Every spec that opens "/" persists a tab into the shared per-cwd open-tabs
  // store; once enough have piled up in a full-suite run, the restored tabs
  // fight `router.push("/usage")` and the URL never changes. Stub the PUT so
  // this spec doesn't depend on (or add to) that shared state.
  await page.route("**/api/sessions/open-tabs", async (route) => {
    if (route.request().method() === "PUT") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    }
    return route.fallback();
  });
});

test.describe("CC 2.1.284 — /rate-limit-options slash command", () => {
  test("shows up in the command palette and navigates to the Usage page", async ({ page }) => {
    await page.goto("/");

    const composer = page.getByTestId("prompt-input");
    await expect(composer).toBeVisible({ timeout: 15_000 });

    // Confirm it's a discoverable command (same catalog /help reads from),
    // not just a hidden dispatcher case.
    await composer.fill("/rate-limit-options");
    await expect(page.getByRole("button", { name: /rate-limit-options/ })).toBeVisible({ timeout: 5_000 });

    await page.getByTestId("prompt-send").click();

    const toast = page.getByTestId("chat-toast");
    await expect(toast).toBeVisible({ timeout: 5_000 });
    await expect(toast).toContainText("Rate-limit options");

    await page.waitForTimeout(150);
    await page.screenshot({
      path: resolve(SHOTS_DIR, "rate-limit-options-toast.png"),
      fullPage: false,
    });

    await expect(page).toHaveURL(/\/usage$/, { timeout: 5_000 });
  });
});
