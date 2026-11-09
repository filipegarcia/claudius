/**
 * CC 2.1.318 parity (shipped in the 2.1.319 run) — "Added the date a stored
 * claude.ai sign-in ends to … `claude -p` JSON results (`credential_expires_at`)"
 * and the 10-day sign-in-end warning, which the engine only prints on `-p`
 * stderr. Claudius reads `credential_expires_at` off each live result and
 * warns once per session through the existing token-expiring banner, with
 * sign-in wording.
 *
 * The server half (`signInEndToWarn`, `Session.noteSignInEnding`) is
 * unit-tested; here the stream carries the event the server broadcasts.
 *
 * Screenshot target: docs/cc-parity/2.1.319/sign-in-ends.png
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.319");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-00000319sign";
const DAY = 24 * 60 * 60 * 1000;

type SdkEvent = Record<string, unknown>;
const sseBody = (events: SdkEvent[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");

async function mockChatBackend(page: Page, expiresAt: number) {
  await page.route("**/api/sessions", async (route: Route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: FAKE_SESSION_ID }) });
  });
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/stream*`, async (route: Route) =>
    route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
      body: sseBody([
        { type: "ready", sessionId: FAKE_SESSION_ID },
        { type: "sdk", message: { type: "system", subtype: "init", uuid: "sys-init-0", model: "claude-sonnet-5-5" } },
        { type: "replay_done", hasMoreAbove: false },
        { type: "token_expiring_required", expiresAt, kind: "sign_in" },
      ]),
    }),
  );
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/pending-prompts`, async (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ asks: [], permissions: [] }) }),
  );
  await page.route("**/api/sessions/open-tabs", async (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ activeId: null, tabs: [] }) }),
  );
  await page.route("**/api/limits*", async (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ limits: { sessionUsd: 0, projectDailyUsd: 0 } }) }),
  );
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test("a claude.ai sign-in ending within 10 days shows the sign-in banner", async ({ page }) => {
  test.setTimeout(60_000);
  await mockChatBackend(page, Date.now() + 6 * DAY + 60_000);
  await page.goto("/");

  const banner = page.getByTestId("token-expiring-panel");
  await expect(banner).toBeVisible({ timeout: 20_000 });
  await expect(banner).toHaveAttribute("data-kind", "sign_in");
  await expect(banner).toContainText("Your claude.ai sign-in ends in about 6 days");
  await expect(banner).toContainText("sign in again");
  await expect(banner).not.toContainText("Your login expires");
  await expect(banner.getByRole("link", { name: "Open accounts" })).toHaveAttribute("href", "/usage#accounts");

  await page.waitForTimeout(150);
  await page.screenshot({ path: resolve(SHOTS_DIR, "sign-in-ends.png"), fullPage: false });

  await banner.getByRole("button", { name: "Dismiss" }).click();
  await expect(banner).toBeHidden();
});
