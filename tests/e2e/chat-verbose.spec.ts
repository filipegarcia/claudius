import { test, expect, type Page } from "@playwright/test";

/**
 * Mocked e2e for the chat verbosity selector.
 *
 * Drives /dev/chat-verbose, which mounts the REAL MessageList component
 * with a fixed corpus of mock messages — every block kind (text, thinking,
 * tool_use, Task) is represented across multiple assistant turns. A small
 * left-side control switches the verbose level; a right-side hand-built
 * "rail" list is held constant across switches to encode the contract
 * that "the right rail is independent of verbose".
 *
 * What we assert per level:
 *   - compact: only text blocks are visible in the chat; tool_use rows
 *     and thinking rows are absent; thinking-only / tool-only assistant
 *     messages disappear entirely (no empty bubbles).
 *   - normal:  text + tool_use survive; thinking is gone; the thinking-
 *     only assistant message also disappears.
 *   - verbose: every block kind is rendered in the chat.
 *
 * What stays the same regardless of level:
 *   - The user prompts always render (both of them).
 *   - The right-rail tool count is constant across all three levels —
 *     this is the central contract the user asked for.
 */

// Two distinct kinds of "tool call" block in the chat:
//   - ToolCall  → every tool_use except `Task` (data-testid="tool-call")
//   - TaskBlock → the subagent block emitted for `Task` (data-testid="task-block")
// The verbose filter treats both as "tool_use" — at compact level they
// both vanish; at normal level they both survive. So the spec asserts on
// the UNION (CSS comma selector) when it wants "any tool call".
const TOOL_CALL_ROW = '[data-testid="tool-call"]';
const TASK_BLOCK = '[data-testid="task-block"]';
const ANY_TOOL = '[data-testid="tool-call"], [data-testid="task-block"]';
const THINKING_ROW = '[data-testid="thinking-block"]';
const ASSISTANT_BUBBLE = '[data-message-role="assistant"]';
const USER_BUBBLE = '[data-message-role="user"]';

async function setLevel(page: Page, level: "compact" | "normal" | "verbose") {
  await page.getByTestId(`set-verbose-${level}`).click();
  await expect(page.getByTestId("verbose-current")).toHaveText(level);
  await expect(page.getByTestId("verbose-preview-chat")).toHaveAttribute(
    "data-verbose",
    level,
  );
}

async function railToolCount(page: Page): Promise<number> {
  return page.getByTestId("rail-tool").count();
}

test.describe("Chat verbosity", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/dev/chat-verbose");
    await expect(page.getByTestId("verbose-preview-root")).toBeVisible();
  });

  test("default level renders the full normal view", async ({ page }) => {
    // The preview defaults to "normal".
    await expect(page.getByTestId("verbose-current")).toHaveText("normal");
    // Both user prompts always render.
    await expect(page.locator(USER_BUBBLE)).toHaveCount(2);
    // Two surviving assistant messages: a-1 (has text + tool_use) and
    // a-2 (Task tool_use). a-3 (thinking-only) is hidden at normal.
    await expect(page.locator(ASSISTANT_BUBBLE)).toHaveCount(2);
    // At normal, every tool_use survives: Bash (ToolCall) + Task (TaskBlock).
    await expect(page.locator(TOOL_CALL_ROW)).toHaveCount(1); // Bash
    await expect(page.locator(TASK_BLOCK)).toHaveCount(1); // Task
    await expect(page.locator(ANY_TOOL)).toHaveCount(2);
    // Thinking is hidden at normal.
    await expect(page.locator(THINKING_ROW)).toHaveCount(0);
  });

  test("compact hides every tool call and every thinking row", async ({ page }) => {
    await setLevel(page, "compact");
    await expect(page.locator(USER_BUBBLE)).toHaveCount(2);
    // Only a-1 survives at compact (it has text). a-2 (Task only) and
    // a-3 (thinking only) collapse to nothing.
    await expect(page.locator(ASSISTANT_BUBBLE)).toHaveCount(1);
    await expect(page.locator(ANY_TOOL)).toHaveCount(0);
    await expect(page.locator(THINKING_ROW)).toHaveCount(0);
  });

  test("verbose shows everything — text, tool calls, and thinking", async ({ page }) => {
    await setLevel(page, "verbose");
    await expect(page.locator(USER_BUBBLE)).toHaveCount(2);
    // Every assistant message survives.
    await expect(page.locator(ASSISTANT_BUBBLE)).toHaveCount(3);
    // Bash (ToolCall) + Task (TaskBlock).
    await expect(page.locator(TOOL_CALL_ROW)).toHaveCount(1);
    await expect(page.locator(TASK_BLOCK)).toHaveCount(1);
    await expect(page.locator(ANY_TOOL)).toHaveCount(2);
    // Two thinking blocks (a-1's, a-3's).
    await expect(page.locator(THINKING_ROW)).toHaveCount(2);
  });

  test("right rail tool list does NOT change when the verbose level changes", async ({
    page,
  }) => {
    // This is the central contract — every tool call (and thinking row)
    // remains visible on the right regardless of what the chat surface
    // shows. The rail count is taken at "normal", then we flip through
    // compact and verbose and re-assert.
    const baseline = await railToolCount(page);
    expect(baseline).toBeGreaterThan(0); // sanity: corpus does have tools

    await setLevel(page, "compact");
    expect(await railToolCount(page)).toBe(baseline);

    await setLevel(page, "verbose");
    expect(await railToolCount(page)).toBe(baseline);

    await setLevel(page, "normal");
    expect(await railToolCount(page)).toBe(baseline);
  });

  test("transitioning compact → verbose → compact returns to the same chat shape", async ({
    page,
  }) => {
    // Regression-shaped: filtering is a pure projection of the underlying
    // unfiltered message list, so the chat at compact should be identical
    // before and after a round-trip through verbose.
    await setLevel(page, "compact");
    const userBefore = await page.locator(USER_BUBBLE).count();
    const assistantBefore = await page.locator(ASSISTANT_BUBBLE).count();

    await setLevel(page, "verbose");
    await setLevel(page, "compact");

    await expect(page.locator(USER_BUBBLE)).toHaveCount(userBefore);
    await expect(page.locator(ASSISTANT_BUBBLE)).toHaveCount(assistantBefore);
    await expect(page.locator(ANY_TOOL)).toHaveCount(0);
    await expect(page.locator(THINKING_ROW)).toHaveCount(0);
  });

  test("user prompts remain visible at every level (filter never drops user messages)", async ({
    page,
  }) => {
    for (const level of ["compact", "normal", "verbose"] as const) {
      await setLevel(page, level);
      await expect(page.locator(USER_BUBBLE)).toHaveCount(2);
      await expect(
        page.locator(`${USER_BUBBLE} >> text=List the files and tell me which is biggest.`),
      ).toBeVisible();
      await expect(page.locator(`${USER_BUBBLE} >> text=Great, thanks.`)).toBeVisible();
    }
  });
});
