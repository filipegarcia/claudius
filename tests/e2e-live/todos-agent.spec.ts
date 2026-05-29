import { test, expect } from "@playwright/test";

const SESSION_RE = /[?&]session=([0-9a-f-]{36})/i;

/**
 * IMPORTANT: this test drives the real Anthropic API. It needs:
 *   - the dev server running with a working ANTHROPIC_API_KEY (or
 *     ~/.claude/.credentials.json with valid credentials)
 *   - network access
 *   - a few cents of API budget per run (uses Claude 4.x)
 *
 * It also flips the live session into `bypassPermissions` mode so TodoWrite
 * runs without a permission prompt — the test isn't validating the
 * permissions UX, just the todos surface.
 */
test.describe("Agent todos — banner mirrors TodoWrite", () => {
  test("create 3 todos, then mark one complete", async ({ page, baseURL }) => {
    test.skip(
      !process.env.ANTHROPIC_API_KEY,
      "needs ANTHROPIC_API_KEY (or ~/.claude/.credentials.json on a logged-in machine) — this test drives the live Anthropic agent",
    );
    test.setTimeout(180_000); // 3 min — gives the model up to ~90s per turn.

    // 1. Open the chat and capture the session id.
    await page.goto("/");
    await page.waitForURL(SESSION_RE, { timeout: 30_000 });
    const sessionId = page.url().match(SESSION_RE)![1];

    // 2. Wait for the prompt to be ready (textarea enabled, send button shown).
    const textarea = page.getByTestId("prompt-input");
    await expect(textarea).toBeEnabled({ timeout: 30_000 });
    await expect(page.getByTestId("prompt-send")).toBeVisible({ timeout: 30_000 });

    // 3. Bypass permissions so the agent's TodoWrite call doesn't pop a prompt.
    const modeRes = await page.request.post(
      `${baseURL}/api/sessions/${sessionId}/mode`,
      { data: { mode: "bypassPermissions" } },
    );
    expect(modeRes.ok(), "switching to bypassPermissions should succeed").toBeTruthy();

    // 4. Ask the agent to create exactly 3 todos via TodoWrite.
    const createPrompt = [
      "Use the TodoWrite tool RIGHT NOW to create exactly these 3 todos and then stop.",
      "Do not run any other tools. Do not write any other text in your reply.",
      "",
      "Todos to create (id, content, status):",
      "  1. id=\"buy-milk\"     content=\"Buy milk\"     status=\"pending\"",
      "  2. id=\"walk-dog\"     content=\"Walk the dog\" status=\"pending\"",
      "  3. id=\"read-book\"    content=\"Read a book\"  status=\"pending\"",
      "",
      "Each todo's `activeForm` can be the same as its content. Just call TodoWrite once with all three.",
    ].join("\n");
    await textarea.fill(createPrompt);
    await page.getByTestId("prompt-send").click();

    // 5. Wait for the banner to surface a 3-item todo list.
    const progress = page.getByTestId("todos-banner-progress");
    await expect(progress).toBeVisible({ timeout: 90_000 });
    await expect(progress).toHaveText("0/3", { timeout: 30_000 });

    // 6. Wait for the agent to finish (Send button reappears in place of Interrupt).
    await expect(page.getByTestId("prompt-send")).toBeVisible({ timeout: 90_000 });

    // 7. Verify the banner list shows three items, all pending.
    const bannerList = page.getByTestId("todos-banner-list");
    await expect(bannerList).toBeVisible();
    await expect(page.getByTestId("todos-banner-item-pending")).toHaveCount(3);
    await expect(page.getByTestId("todos-banner-item-completed")).toHaveCount(0);

    // 8. Ask the agent to complete the first todo.
    const completePrompt = [
      "Now use TodoWrite RIGHT NOW to mark only the FIRST todo (id=\"buy-milk\", \"Buy milk\") as completed.",
      "Leave the other two with status=\"pending\". Call TodoWrite once with all three updated entries.",
      "Do not run any other tools. Do not write any other text in your reply.",
    ].join("\n");
    await textarea.fill(completePrompt);
    await page.getByTestId("prompt-send").click();

    // 9. Banner should now read 1/3 with one completed item.
    await expect(progress).toHaveText("1/3", { timeout: 90_000 });
    await expect(page.getByTestId("todos-banner-item-completed")).toHaveCount(1);
    await expect(page.getByTestId("todos-banner-item-pending")).toHaveCount(2);
  });
});
