import { test, expect, type Page } from "@playwright/test";

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
  test("clicking Chat creates a new session, refresh keeps it, naming persists", async ({ page }) => {
    // ── 1. Open the app and capture the first auto-bound session ─────────
    await page.goto("/");
    const idA = await waitForBoundSession(page);
    test.info().annotations.push({ type: "first-session", description: idA });

    // Give the SSE stream a beat so the bind is fully settled before we
    // navigate away.
    await page.waitForTimeout(500);

    // ── 2. Click the Chat side-nav button → expect a NEW session id ──────
    await page.getByTitle("Chat").first().click();
    const idB = await waitForBoundSession(page, { not: idA });
    test.info().annotations.push({ type: "second-session", description: idB });
    expect(idB).not.toBe(idA);

    // ── 3. Reload — URL must keep the same session id ────────────────────
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
    // Default fallback shape: "Session <8-char prefix>"
    expect(beforeRename).toMatch(/^Session [0-9a-f]{8}$/i);
    expect(beforeRename.toLowerCase()).toContain(idB.slice(0, 8).toLowerCase());

    // ── 5. Rename the session via the inline editor ─────────────────────
    const desiredTitle = `E2E Test ${Date.now().toString(36)}`;
    // Double-click the pill to enter edit mode (a documented affordance —
    // the inline pencil button works too but only appears on hover and is
    // brittle for headless drivers).
    await pill.dblclick();
    const input = page.getByTestId("session-title-input");
    await expect(input).toBeVisible();
    await input.fill(desiredTitle);
    await input.press("Enter");

    // Pill should re-render showing the new title.
    await expect(pillLabel).toHaveText(desiredTitle, { timeout: 10_000 });

    // ── 6. Reload — the title must persist (this is the "internal db"
    //       persistence requirement: the SDK writes the customTitle into
    //       the JSONL header, so a fresh resume picks it back up) ────────
    await page.waitForTimeout(500);
    await page.reload();
    const idAfterRenameReload = await waitForBoundSession(page);
    expect(idAfterRenameReload).toBe(idB);
    await expect(page.getByTestId("session-picker-label")).toHaveText(desiredTitle, {
      timeout: 15_000,
    });
  });
});
