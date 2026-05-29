import { test, expect } from "@playwright/test";

/**
 * Diagnostic test that captures browser console output and network state
 * across the failing flow:
 *
 *   1. Load /chat root (opens session SSE → 1 connection to localhost:3000)
 *   2. Click Community in the side rail (soft nav)
 *   3. Click Chat back (soft nav)
 *   4. Click Community again (soft nav) — the case the user reports as broken
 *
 * Notifications are enabled in localStorage so the provider opens its
 * per-room SSEs (matching the user's environment).
 *
 * Test output prints every browser console message + every chat-server
 * request (URL + status). Run with:
 *   CLAUDIUS_E2E_PORT=3000 NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL=http://localhost:8787 \
 *     bunx playwright test tests/e2e/community-logs.spec.ts --reporter=list
 */

const SERVER_URL = process.env.NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL ?? "";

test("capture logs for /community ↔ /chat soft-nav", async ({ browser }) => {
  test.skip(!SERVER_URL, "needs NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL set");

  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // Pre-seed: a nick + notifications ON so the provider opens its SSEs.
  await page.addInitScript(() => {
    try {
      localStorage.setItem("claudius.community.nick", "alice");
      localStorage.setItem("claudius.community.notifications.enabled", "1");
    } catch {}
  });

  // Capture browser console.
  const logs: string[] = [];
  page.on("console", (msg) => {
    logs.push(`[${msg.type()}] ${msg.text()}`);
  });

  // Track every SSE / stream request on either origin so we can see if
  // the localhost:3000 session stream is leaking past unmount and if the
  // localhost:8787 chat-server slots are saturating.
  const wantedHosts = [SERVER_URL, "http://localhost:3000"];
  const isStreamish = (url: string) =>
    /\/stream\b|\/rooms\b/.test(url) && wantedHosts.some((h) => url.startsWith(h));

  const chatRequests: string[] = [];
  page.on("request", (req) => {
    if (isStreamish(req.url())) {
      chatRequests.push(`→ ${req.method()} ${req.url()}`);
    }
  });
  page.on("response", (res) => {
    if (isStreamish(res.url())) {
      chatRequests.push(`  ${res.status()} ${res.url()}`);
    }
  });
  page.on("requestfailed", (req) => {
    if (isStreamish(req.url())) {
      chatRequests.push(`  FAIL ${req.url()} (${req.failure()?.errorText})`);
    }
  });

  // 1. Land on / (workspace chat). Wait briefly so its session SSE fires.
  await page.goto("/");
  await page.waitForTimeout(1500);

  // 2. First nav to /community — soft nav.
  await page.locator('[data-pane-name="workspace-switcher"] a[href="/community"]').click();
  await expect(page).toHaveURL(/\/community/);
  await expect(page.getByTestId("community-page")).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(1500);

  // 3. Back to chat — soft nav.
  await page.getByRole("link", { name: /^Chat$/ }).first().click();
  await expect(page).toHaveURL(/\/$|\/\?/);
  await page.waitForTimeout(1500);

  // 4. Back to /community — the failing case.
  await page.locator('[data-pane-name="workspace-switcher"] a[href="/community"]').click();
  await expect(page).toHaveURL(/\/community/);
  await page.waitForTimeout(2500);

  // Print captured signals so the test output shows them whether or not
  // the assertions pass.
  console.log("=== BROWSER CONSOLE ===");
  for (const l of logs) console.log(l);
  console.log("=== CHAT-SERVER REQUESTS ===");
  for (const r of chatRequests) console.log(r);

  // Assertion: on the second /community visit, the rooms list should
  // have at least one room. If this fails, the captured logs above tell
  // us why.
  await expect(page.getByRole("button", { name: "general" })).toBeVisible({
    timeout: 5_000,
  });

  await ctx.close();
});
