import { test, expect, type Page } from "../helpers/test";

/**
 * Browser-style find-in-transcript (Cmd/Ctrl+F) — components/chat/TranscriptSearch.tsx.
 *
 * Like the native find bar: every occurrence is painted inline through the
 * CSS Custom Highlight API, the counter reads "N of M matches", Enter /
 * Shift+Enter step (and wrap), a match-case toggle narrows the set, and Esc
 * closes the bar and clears the paint.
 *
 * Driven over the dev-broadcast bus (no Anthropic key).
 */

const SESSION_RE = /[?&]session=([0-9a-f-]{36})/i;

async function waitForBoundSession(page: Page): Promise<string> {
  await page.waitForURL((url) => SESSION_RE.test(String(url)), { timeout: 30_000 });
  const id = page.url().match(SESSION_RE)?.[1];
  expect(id).toMatch(/^[0-9a-f-]{36}$/i);
  return id!;
}

async function pushAssistant(page: Page, sessionId: string, text: string, uuid: string) {
  const res = await page.request.post(`/api/sessions/${sessionId}/dev-broadcast`, {
    data: {
      event: {
        type: "sdk",
        message: {
          type: "assistant",
          uuid,
          parent_tool_use_id: null,
          message: {
            model: "claude-sonnet-4-6",
            content: [{ type: "text", text }],
            usage: { input_tokens: 10, output_tokens: 10 },
          },
        },
      },
    },
  });
  expect(res.ok(), `dev-broadcast assistant should succeed for ${sessionId}`).toBeTruthy();
}

async function pushUser(page: Page, sessionId: string, text: string, uuid: string) {
  const res = await page.request.post(`/api/sessions/${sessionId}/dev-broadcast`, {
    data: {
      event: {
        type: "sdk",
        message: { type: "user", uuid, message: { content: [{ type: "text", text }] } },
      },
    },
  });
  expect(res.ok(), `dev-broadcast user should succeed for ${sessionId}`).toBeTruthy();
}

/** Number of ranges currently painted under the "all matches" highlight (-1 = none registered). */
function paintedCount(page: Page): Promise<number> {
  return page.evaluate(() => CSS.highlights.get("transcript-find")?.size ?? -1);
}

/**
 * Text of every painted range. A stale range (its text nodes replaced by a
 * React re-render) collapses to "" — so this doubles as a freshness check.
 */
function paintedTexts(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...(CSS.highlights.get("transcript-find") ?? [])].map((r) => (r as Range).toString()),
  );
}

test.describe("transcript find bar", () => {
  test.beforeEach(async ({ request }) => {
    await request.put("/api/sessions/open-tabs", { data: { tabs: [], activeId: null } });
  });

  test("Cmd+F highlights every hit, counts them, steps with wrap, and clears on Esc", async ({
    page,
  }) => {
    test.setTimeout(60_000);

    await page.goto("/");
    const id = await waitForBoundSession(page);

    // 4 case-insensitive hits across two messages; 2 of them are upper-case.
    await pushUser(page, id, "Tell me about the D10 rule", "find-user-1");
    await pushAssistant(
      page,
      id,
      [
        "The **D10** reminder says held-out is never visible to contributors.",
        "",
        "A second paragraph mentions d10 again, and inline code `use d10` too.",
      ].join("\n"),
      "find-asst-1",
    );
    await expect(page.locator('[data-message-uuid="find-asst-1"]')).toBeVisible();

    await page.keyboard.press("ControlOrMeta+f");
    const bar = page.getByTestId("transcript-find");
    const input = page.getByTestId("transcript-find-input");
    const count = page.getByTestId("transcript-find-count");
    await expect(bar).toBeVisible();
    await expect(input).toBeFocused();

    await input.fill("d10");
    await expect(count).toHaveText("1 of 4 matches");
    expect(await paintedCount(page)).toBe(4);
    expect((await paintedTexts(page)).map((t) => t.toLowerCase())).toEqual(["d10", "d10", "d10", "d10"]);

    // A new message landing while the bar is open is picked up by the
    // mutation rescan, and the already-painted ranges stay live.
    await pushAssistant(page, id, "Late arrival: one more d10 here.", "find-asst-2");
    await expect(count).toHaveText("1 of 5 matches");
    expect((await paintedTexts(page)).map((t) => t.toLowerCase())).toEqual(Array(5).fill("d10"));

    // Enter / Shift+Enter step, wrapping at both ends.
    await input.press("Enter");
    await expect(count).toHaveText("2 of 5 matches");
    await input.press("Shift+Enter");
    await expect(count).toHaveText("1 of 5 matches");
    await input.press("Shift+Enter");
    await expect(count).toHaveText("5 of 5 matches");
    await input.press("Enter");
    await expect(count).toHaveText("1 of 5 matches");

    // Cmd+G steps from anywhere, not just the input.
    await page.keyboard.press("ControlOrMeta+g");
    await expect(count).toHaveText("2 of 5 matches");

    // Match case: the query is lower-case, so only the three lower-case "d10" survive.
    await page.getByTestId("transcript-find-match-case").click();
    await expect(count).toHaveText("1 of 3 matches");
    expect(await paintedCount(page)).toBe(3);
    await page.getByTestId("transcript-find-match-case").click();
    await expect(count).toHaveText("1 of 5 matches");

    // A miss reads as such.
    await input.fill("zzz-not-in-transcript");
    await expect(count).toHaveText("No matches");
    expect(await paintedCount(page)).toBe(0);

    // Esc closes the bar and unregisters the highlights.
    await input.press("Escape");
    await expect(bar).toBeHidden();
    expect(await paintedCount(page)).toBe(-1);

    // Re-opening remembers the last query, like the browser.
    await page.keyboard.press("ControlOrMeta+f");
    await expect(input).toHaveValue("zzz-not-in-transcript");
  });
});
