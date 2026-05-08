import { test, expect, type Page } from "@playwright/test";

const SESSION_RE = /[?&]session=([0-9a-f-]{36})/i;

/**
 * The Activity rail's "+ add tasks" affordance. Submitting the form sends
 * a synthetic prompt to the agent that tells it to append items to its
 * TodoWrite list — verifying that the new items show up in the rail.
 *
 * Hits the real Anthropic API; bypassPermissions so TodoWrite goes
 * through without a permission modal.
 */
test.describe("Activity rail — add tasks via the agent", () => {
  test("submitting two tasks gets them appended to the agent's todos", async ({
    page,
    baseURL,
  }) => {
    test.setTimeout(180_000);

    await page.goto("/");
    await page.waitForURL(SESSION_RE, { timeout: 30_000 });
    const sessionId = page.url().match(SESSION_RE)![1];

    // Bypass permissions so TodoWrite isn't gated.
    const modeRes = await page.request.post(
      `${baseURL}/api/sessions/${sessionId}/mode`,
      { data: { mode: "bypassPermissions" } },
    );
    expect(modeRes.ok()).toBeTruthy();

    // Seed a starting todo so the To-dos section is visible. (The "+" is
    // shown either way — when latestTodos is empty OR onAddTodos exists —
    // but a seeded list is a clearer baseline for the "appended" assertion.)
    const textarea = page.getByTestId("prompt-input");
    await expect(textarea).toBeEnabled({ timeout: 30_000 });
    await textarea.fill("Use TodoWrite now to create one todo: Initial task. Do not write any text.");
    await page.getByTestId("prompt-send").click();
    await expect(page.getByTestId("prompt-send")).toBeVisible({ timeout: 90_000 });

    // The To-dos section should now exist with one item.
    await expect(page.getByTestId("todos-banner-progress")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("todos-banner-progress")).toHaveText("0/1");

    // Click "+" in the rail's To-dos header to open the add form.
    const addBtn = page.getByTestId("todos-add-button");
    await expect(addBtn).toBeVisible();
    await addBtn.click();
    await expect(page.getByTestId("add-todos-form")).toBeVisible();

    // Two tasks. Type the first; press Enter to spawn a second row; type
    // again. Then submit.
    const inputA = page.getByTestId("add-todo-input-0");
    await inputA.fill("Buy milk");
    await inputA.press("Enter");
    const inputB = page.getByTestId("add-todo-input-1");
    await expect(inputB).toBeVisible();
    await inputB.fill("Walk the dog");

    // Submit via the explicit button (Cmd/Ctrl+Enter would also work).
    await page.getByTestId("add-todos-submit").click();

    // Form should close once the prompt is in flight.
    await expect(page.getByTestId("add-todos-form")).not.toBeVisible({ timeout: 5_000 });

    // The agent should append both items, growing the count from 1 to 3.
    // Banner reads as `<done>/<total>` — we want 0/3 (everything pending).
    await expect(page.getByTestId("todos-banner-progress")).toHaveText("0/3", {
      timeout: 90_000,
    });

    // The original item plus both new ones should be in the list.
    const items = page.getByTestId(/^todos-banner-item-/);
    await expect(items).toHaveCount(3);
    const text = (await items.allTextContents()).join("\n");
    expect(text).toContain("Initial task");
    expect(text).toContain("Buy milk");
    expect(text).toContain("Walk the dog");
  });
});
