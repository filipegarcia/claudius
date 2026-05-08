import { test, expect } from "@playwright/test";

const SESSION_RE = /[?&]session=([0-9a-f-]{36})/i;

async function waitForBoundSession(page: import("@playwright/test").Page): Promise<string> {
  await page.waitForURL(SESSION_RE, { timeout: 30_000 });
  const url = new URL(page.url());
  const id = url.searchParams.get("session");
  expect(id, "session id should be present in URL after bind").toBeTruthy();
  expect(id, "session id should look like a UUID").toMatch(/^[0-9a-f-]{36}$/i);
  return id!;
}

test.describe("Session URL persistence", () => {
  test("refreshing /?session=<id> keeps the same session id", async ({ page }) => {
    // 1. Land on / and let Claudius create a session. The client writes the
    //    bound id back into the URL via history.replaceState.
    await page.goto("/");
    const initialId = await waitForBoundSession(page);
    test.info().annotations.push({ type: "session-bound", description: initialId });

    // Give the SSE stream a beat to settle so the reload is comparable to a
    // real "user comes back" scenario, not a half-bound state.
    await page.waitForTimeout(750);

    // 2. Reload. The URL still carries ?session=<initialId>; the client's
    //    boot effect should resume *that* session, not create a new one.
    await page.reload();
    const afterReloadId = await waitForBoundSession(page);

    // 3. The URL's session id must be identical after reload.
    expect(
      afterReloadId,
      `expected the same session id after reload — was ${initialId}, now ${afterReloadId}`,
    ).toBe(initialId);

    // 4. Sanity: the URL itself must contain ?session=<initialId>.
    await expect(page).toHaveURL(new RegExp(`session=${initialId}`));
  });

  test("opening /?session=<id> in a fresh browser context resumes it", async ({ browser }) => {
    // First context: create a session, capture its id.
    const ctxA = await browser.newContext();
    const pageA = await ctxA.newPage();
    await pageA.goto("/");
    const id = await waitForBoundSession(pageA);
    await pageA.waitForTimeout(750);
    await ctxA.close();

    // Second context (fresh — simulates "open in a new tab/window with no
    // shared cookies/storage"): visit the URL with the captured id.
    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await pageB.goto(`/?session=${id}`);
    const afterId = await waitForBoundSession(pageB);

    expect(
      afterId,
      `expected fresh-tab navigation to /?session=${id} to resume the same session`,
    ).toBe(id);

    await ctxB.close();
  });
});
