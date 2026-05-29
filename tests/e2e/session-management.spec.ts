import { test, expect, type Page } from "../helpers/test";

const SESSION_RE = /[?&]session=([0-9a-f-]{36})/i;

async function currentSessionId(page: Page): Promise<string | null> {
  const m = page.url().match(SESSION_RE);
  return m ? m[1] : null;
}

async function waitForBoundSession(page: Page, opts: { not?: string } = {}): Promise<string> {
  // Wait until the URL carries ?session=<some-uuid>, optionally NOT equal to
  // a previously-captured id (used after clicking Chat to ensure we got a
  // *new* session, not the same one).
  await page.waitForURL(
    (url) => {
      const m = String(url).match(SESSION_RE);
      if (!m) return false;
      if (opts.not && m[1] === opts.not) return false;
      return true;
    },
    { timeout: 30_000 },
  );
  const id = await currentSessionId(page);
  expect(id).toMatch(/^[0-9a-f-]{36}$/i);
  if (opts.not) expect(id, "expected a different session id from before").not.toBe(opts.not);
  return id!;
}

test.describe("Session management workflow", () => {
  test("Chat resumes the last-active session, refresh keeps it, naming persists", async ({ page }) => {
    // ── 1. Open the app and capture the first auto-bound session ─────────
    await page.goto("/");
    const idA = await waitForBoundSession(page);
    test.info().annotations.push({ type: "first-session", description: idA });

    // Give the SSE stream a beat so the bind is fully settled before we
    // navigate away.
    await page.waitForTimeout(500);

    // ── 2. Open a new tab via the "+" button → fresh session id ──────────
    // This is the explicit "give me a new conversation" affordance now —
    // the SideNav Chat button no longer forces new.
    await page.locator('button[title="New session tab"]').click();
    const idB = await waitForBoundSession(page, { not: idA });
    test.info().annotations.push({ type: "second-session", description: idB });
    expect(idB).not.toBe(idA);

    // ── 3. Navigate away, then click Chat → expect to land back on idB ───
    // Chat is no longer "new session" — it resumes the last-active tab.
    await page.waitForTimeout(500);
    await page.goto("/sessions");
    await page.getByTitle("Chat").first().click();
    const idAfterChat = await waitForBoundSession(page);
    expect(
      idAfterChat,
      `Chat must resume the last-active session — was ${idB}, now ${idAfterChat}`,
    ).toBe(idB);

    // ── 4. Reload — URL must keep the same session id ────────────────────
    await page.waitForTimeout(500);
    await page.reload();
    const idAfterReload = await waitForBoundSession(page);
    expect(
      idAfterReload,
      `expected the same session id after reload — was ${idB}, now ${idAfterReload}`,
    ).toBe(idB);

    // ── 4. The header pill shows the session id (truncated) ─────────────
    const pill = page.getByTestId("session-picker-button");
    await expect(pill).toBeVisible();
    const pillLabel = page.getByTestId("session-picker-label");
    const beforeRename = (await pillLabel.textContent())?.trim() ?? "";
    // Pill shape: "Session <8-char prefix>" — title now lives on the
    // RecapBanner, so the pill is permanently terse.
    expect(beforeRename).toMatch(/^Session [0-9a-f]{8}$/i);
    expect(beforeRename.toLowerCase()).toContain(idB.slice(0, 8).toLowerCase());

    // ── 5. Rename the session via the RecapBanner inline editor ─────────
    const desiredTitle = `E2E Test ${Date.now().toString(36)}`;
    // The banner is always rendered (showing "Untitled session" until the
    // SDK surfaces a real title), so the rename surface is reachable
    // immediately — no need to wait for an auto-summary.
    const recapButton = page.getByTestId("recap-banner-button");
    await expect(recapButton).toBeVisible();
    const recapTitle = page.getByTestId("recap-banner-title");
    await expect(recapTitle).toHaveText("Untitled session");
    await recapButton.click();
    const input = page.getByTestId("recap-title-input");
    await expect(input).toBeVisible();
    await input.fill(desiredTitle);
    await input.press("Enter");

    // RecapBanner should re-render showing the new title; pill is unaffected.
    await expect(recapTitle).toHaveText(desiredTitle, { timeout: 10_000 });
    await expect(pillLabel).toHaveText(beforeRename);

    // The active session tab in the SessionTabs row above the pill must
    // mirror the renamed title — so the user can identify the tab by name.
    const activeTabLabel = page.locator(
      '[data-testid="session-tab"][data-tab-active="true"] [data-testid="session-tab-label"]',
    );
    await expect(activeTabLabel).toHaveText(desiredTitle, { timeout: 10_000 });

    // ── 6. Reload — the title must persist (this is the "internal db"
    //       persistence requirement: the SDK writes the customTitle into
    //       the JSONL header, so a fresh resume picks it back up) ────────
    await page.waitForTimeout(500);
    await page.reload();
    const idAfterRenameReload = await waitForBoundSession(page);
    expect(idAfterRenameReload).toBe(idB);
    await expect(page.getByTestId("recap-banner-title")).toHaveText(desiredTitle, {
      timeout: 15_000,
    });
    // After reload, the tab label is also reconstructed from persisted state
    // (sessionTitle on the active tab; sessions[].title for inactive ones).
    await expect(
      page.locator('[data-testid="session-tab"][data-tab-active="true"] [data-testid="session-tab-label"]'),
    ).toHaveText(desiredTitle, { timeout: 15_000 });
  });
});
