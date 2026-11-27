import { test, expect, type Page } from "../helpers/test";

/**
 * The find bar pages older history in for a match it can't see yet
 * (components/chat/TranscriptSearch.tsx → ChatSurface's
 * `ensureFindMatchesLoaded` → `useSession().jumpToUuid`).
 *
 * `jumpToUuid` used to resolve against `messagesRef` / `hasMoreAboveRef`,
 * which React syncs only after it commits — later than the `await
 * loadOlder()` continuation. So it re-fetched the first page's cursor and
 * gave up (resolving null) on a match two pages up. It now resolves
 * against the pages it merged and takes the next cursor from them (U01o).
 *
 * Driven over the dev-broadcast bus (no Anthropic key); the older
 * transcript pages and the server search are mocked.
 */

const SESSION_RE = /[?&]session=([0-9a-f-]{36})/i;
const NEEDLE = "quokka";

async function waitForBoundSession(page: Page): Promise<string> {
  await page.waitForURL((url) => SESSION_RE.test(String(url)), { timeout: 30_000 });
  const id = page.url().match(SESSION_RE)?.[1];
  expect(id).toMatch(/^[0-9a-f-]{36}$/i);
  return id!;
}

async function broadcast(page: Page, sessionId: string, event: Record<string, unknown>) {
  const res = await page.request.post(`/api/sessions/${sessionId}/dev-broadcast`, { data: { event } });
  expect(res.ok(), `dev-broadcast ${String(event.type)} should succeed for ${sessionId}`).toBeTruthy();
}

/** A JSONL user record, as `/transcript` pages carry them. */
const jsonlUser = (uuid: string, text: string, timestamp: string) => ({
  type: "user",
  uuid,
  timestamp,
  message: { role: "user", content: text },
});

test.describe("transcript find bar, older history", () => {
  test.beforeEach(async ({ request }) => {
    await request.put("/api/sessions/open-tabs", { data: { tabs: [], activeId: null } });
  });

  test("a match two pages up is paged in, each cursor fetched once", async ({ page }) => {
    test.setTimeout(90_000);

    // Page 1 (just above the live head) has no match; page 2 has it; above
    // that the history ends.
    const page1 = [
      jsonlUser("older-p1-a", "page one, first", "2025-01-02T10:00:00.000Z"),
      jsonlUser("older-p1-b", "page one, second", "2025-01-02T10:01:00.000Z"),
    ];
    const page2 = [
      jsonlUser("older-p2-a", `the ${NEEDLE} lives up here`, "2025-01-01T10:00:00.000Z"),
      jsonlUser("older-p2-b", "page two, second", "2025-01-01T10:01:00.000Z"),
    ];
    const cursors: string[] = [];
    await page.route("**/api/sessions/*/transcript?*", async (route) => {
      const before = new URL(route.request().url()).searchParams.get("before");
      if (before) cursors.push(before);
      const body =
        before === "older-p1-a"
          ? { messages: page2, hasMore: true }
          : before === "older-p2-a"
            ? { messages: [], hasMore: false }
            : { messages: page1, hasMore: true };
      await route.fulfill({ json: body });
    });
    await page.route("**/api/sessions/*/search?*", async (route) => {
      const q = new URL(route.request().url()).searchParams.get("q");
      await route.fulfill({ json: { hits: q === NEEDLE ? [{ messageUuid: "older-p2-a" }] : [] } });
    });

    await page.goto("/");
    const id = await waitForBoundSession(page);

    // Enough live history that the list sits scrolled to the bottom, so the
    // top sentinel doesn't page older history in by itself.
    const filler = Array.from({ length: 8 }, (_, i) => `Filler paragraph ${i + 1}.`).join("\n\n");
    for (let i = 0; i < 12; i++) {
      await broadcast(page, id, {
        type: "sdk",
        message: { type: "user", uuid: `live-u-${i}`, message: { content: [{ type: "text", text: `live ${i}\n\n${filler}` }] } },
      });
    }
    await expect(page.locator('[data-message-uuid="live-u-11"]')).toBeVisible();
    await broadcast(page, id, { type: "replay_done", hasMoreAbove: true });

    await page.keyboard.press("ControlOrMeta+f");
    const input = page.getByTestId("transcript-find-input");
    await expect(input).toBeFocused();
    await input.fill(NEEDLE);

    await expect(page.locator('[data-message-uuid="older-p2-a"]')).toBeAttached({ timeout: 15_000 });
    await expect(page.getByTestId("transcript-find-count")).toHaveText("1 of 1 match");
    // The jump's cursors: the live head, then page 1's oldest — each once.
    expect(cursors.slice(0, 2)).toEqual(["live-u-0", "older-p1-a"]);
    expect(new Set(cursors).size, `cursors fetched: ${cursors.join(", ")}`).toBe(cursors.length);
  });
});
