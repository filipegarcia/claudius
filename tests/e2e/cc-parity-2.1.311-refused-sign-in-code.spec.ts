/**
 * CC 2.1.311 parity — "Improved the message shown when a pasted sign-in code
 * is refused: it now says the code may have expired or been used, and to sign
 * in again".
 *
 * Claudius's "Add account" form on /usage runs its own paste-the-code OAuth
 * flow (`lib/server/account-oauth.ts`). A refused code (`invalid_grant`, which
 * OAuth servers send as a 400) used to surface as the raw
 * `token exchange failed (400): {…}` body. It now reads the engine's string,
 * and the form drops back to the sign-in button: the server spends the flow
 * on every attempt, so the old code box could only answer "flow expired".
 *
 * `/api/accounts` and `/api/accounts/oauth` are mocked; the message itself is
 * pinned against the real server code in
 * `tests/unit/account-oauth-refused-code.test.ts`.
 *
 * Screenshot target: docs/cc-parity/2.1.311/refused-sign-in-code.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.311");
mkdirSync(SHOTS_DIR, { recursive: true });

// Kept in step with REFUSED_AUTH_CODE_MESSAGE (server-only module, so not
// imported into the browser-facing spec).
const REFUSED =
  "That code wasn't accepted. It may be incomplete, expired, already used, or from an earlier sign-in attempt. Sign in again to get a new code.";

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
  await page.addInitScript(() => {
    // The flow opens the sign-in page in a new tab; keep the test in one.
    window.open = () => null;
  });
  await page.route("**/api/accounts", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ profiles: [], activeProfileId: null, autoRotateOnRateLimit: false }),
    });
  });
  await page.route("**/api/accounts/oauth", async (route) => {
    const body = route.request().postDataJSON() as { action?: string };
    if (body.action === "start") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ flowId: "flow-311", authUrl: "https://claude.ai/oauth/authorize?state=x" }),
      });
    }
    return route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ error: REFUSED }),
    });
  });
});

test("a refused pasted sign-in code says to sign in again, and the form starts over", async ({ page }) => {
  await page.goto("/usage");
  await page.getByTestId("accounts-add-btn").click();
  await page.getByTestId("account-add-label").fill("Work");
  await page.getByTestId("account-oauth-start").click();
  await page.getByTestId("account-oauth-code").fill("stale-code#x");
  await page.getByTestId("account-oauth-submit").click();

  const error = page.getByTestId("account-add-error");
  await expect(error).toHaveText(REFUSED);
  await expect(error).not.toContainText("token exchange failed");
  // The spent flow is gone: the code box is replaced by the sign-in button.
  await expect(page.getByTestId("account-oauth-code")).toHaveCount(0);
  await expect(page.getByTestId("account-oauth-start")).toBeVisible();

  const section = page.getByTestId("accounts-add-btn").or(page.getByTestId("account-add-label")).first();
  await section.scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(SHOTS_DIR, "refused-sign-in-code.png") });
});
