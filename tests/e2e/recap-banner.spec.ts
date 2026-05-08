import { test, expect } from "@playwright/test";

const SESSION_RE = /[?&]session=([0-9a-f-]{36})/i;

/**
 * Drives the real Anthropic API. Same prerequisites as todos-agent.spec.ts:
 *   - dev server with a working ANTHROPIC_API_KEY
 *   - network access + a few cents per run
 *
 * Verifies two things:
 *   1. /recap populates the RecapBanner during a live turn.
 *   2. Clearing sessionStorage and reloading repopulates the banner from
 *      JSONL replay — the cold-load case the original implementation got
 *      wrong (messagesRef was stale across back-to-back applyEvent calls).
 */
test.describe("Recap banner — /recap response surfaces and survives reload", () => {
  test("populates from live turn and re-populates from replay", async ({ page }) => {
    test.setTimeout(180_000);

    await page.goto("/");
    await page.waitForURL(SESSION_RE, { timeout: 30_000 });
    const sessionId = page.url().match(SESSION_RE)![1];

    const textarea = page.getByTestId("prompt-input");
    await expect(textarea).toBeEnabled({ timeout: 30_000 });
    await expect(page.getByTestId("prompt-send")).toBeVisible({ timeout: 30_000 });

    // Seed the session with one substantive turn so /recap has something to
    // summarize. Without this the recap is degenerate ("there's nothing to
    // recap yet") and the assertion below is too lenient.
    await textarea.fill("In one sentence, what is 2+2? Reply with just the answer.");
    await page.getByTestId("prompt-send").click();
    await expect(page.getByTestId("prompt-send")).toBeVisible({ timeout: 90_000 });

    // 1. Live capture — type /recap, banner should appear.
    await textarea.fill("/recap");
    await page.getByTestId("prompt-send").click();

    const banner = page.getByTestId("recap-banner");
    await expect(banner).toBeVisible({ timeout: 90_000 });
    const body = page.getByTestId("recap-banner-body");
    await expect(body).toBeVisible();
    const liveText = (await body.textContent())?.trim() ?? "";
    expect(liveText.length).toBeGreaterThan(0);

    // Wait for the turn to finish so the persisted JSONL is complete.
    await expect(page.getByTestId("prompt-send")).toBeVisible({ timeout: 90_000 });

    // 2. Cold-load replay — clear the sessionStorage entry that holds the
    //    captured recap, then hard-reload. The banner must repopulate from
    //    the replayed assistant message, proving applyEvent's detection
    //    works without relying on the post-commit messagesRef.
    await page.evaluate((id) => {
      window.sessionStorage.removeItem(`claudius.recap.${id}`);
    }, sessionId);
    await page.reload();

    await expect(banner).toBeVisible({ timeout: 60_000 });
    const replayText = (await body.textContent())?.trim() ?? "";
    expect(replayText.length).toBeGreaterThan(0);
  });
});
