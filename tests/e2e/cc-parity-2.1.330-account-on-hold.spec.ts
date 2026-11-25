/**
 * CC 2.1.330 parity — "[VSCode] Fixed signing in to an account on hold
 * showing a generic failure instead of the on-hold notice and appeal link".
 *
 * Signing in an on-hold account from /usage's "Add account" form showed the
 * raw `token exchange failed (400): {…"account_on_hold"…}` body. It now shows
 * the engine's notice, with the appeal link as a link (the server vets it;
 * see tests/unit/cc-parity-2.1.330-account-on-hold.test.ts).
 *
 * `/api/accounts` and `/api/accounts/oauth` are mocked.
 *
 * Screenshot target: docs/cc-parity/2.1.330/account-on-hold.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.330");
mkdirSync(SHOTS_DIR, { recursive: true });

const REF = "TS-0a1b2c3d-1111-2222-3333-444455556666";
const APPEAL = `https://claude.ai/restricted?ref=${REF}`;
const NOTICE = `Your account is on hold and can't sign in to Claude Code. View details or appeal: ${APPEAL} (Reference: ${REF})`;

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
  await page.addInitScript(() => {
    // The flow opens the sign-in page in a new tab; keep the test in one.
    window.open = () => null;
  });
  await page.route("**/api/accounts", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({ json: { profiles: [], activeProfileId: null, autoRotateOnRateLimit: false } });
  });
  await page.route("**/api/accounts/oauth", async (route) => {
    const body = route.request().postDataJSON() as { action?: string };
    if (body.action === "start") {
      return route.fulfill({ json: { flowId: "flow-330", authUrl: "https://claude.ai/oauth/authorize?state=x" } });
    }
    return route.fulfill({ status: 400, json: { error: NOTICE, appealUrl: APPEAL } });
  });
});

test("an on-hold account's sign-in shows the on-hold notice and appeal link", async ({ page }) => {
  await page.goto("/usage");
  await page.getByTestId("accounts-add-btn").click();
  await page.getByTestId("account-add-label").fill("Work");
  await page.getByTestId("account-oauth-start").click();
  await page.getByTestId("account-oauth-code").fill("code#x");
  await page.getByTestId("account-oauth-submit").click();

  const error = page.getByTestId("account-add-error");
  await expect(error).toHaveText(NOTICE);
  await expect(error).not.toContainText("token exchange failed");
  const link = error.getByTestId("account-on-hold-appeal");
  await expect(link).toHaveAttribute("href", APPEAL);
  await expect(link).toHaveAttribute("target", "_blank");

  await error.scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(SHOTS_DIR, "account-on-hold.png") });
});
