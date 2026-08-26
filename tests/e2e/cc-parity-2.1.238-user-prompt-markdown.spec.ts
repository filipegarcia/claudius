/**
 * CC 2.1.234 — "Improved the transcript: your own prompts now render
 * markdown (highlighted code blocks, inline code, lists) the same way
 * replies do."
 *
 * This entry from the 2.1.234 changelog was never actually classified or
 * shipped by any prior cc-parity run (the `2.1.237.md` run-notes file's
 * title claims "2.1.234 → 2.1.237" but its body only classifies 2.1.235+
 * entries — see the 2.1.238 run-notes Risks section). It's a clean
 * bucket-B fit: pure browser-UI change, translates directly, no engine
 * involvement.
 *
 * `components/chat/UserMessage.tsx`'s `InlineUserText` previously rendered
 * the user's own prompt as a plain `whitespace-pre-wrap` block — no code
 * fences, no inline code, no lists — while `AssistantMessage` already ran
 * replies through the shared `<Markdown>` component. Fixed by routing
 * image-token-free user text through the same `<Markdown>` component,
 * with a new `breaks` prop (backed by `remark-breaks`) so a multi-line
 * prompt without blank lines between lines doesn't get silently reflowed
 * into one paragraph (CommonMark's default single-newline-is-a-space
 * behavior would otherwise be a real regression from the old
 * `whitespace-pre-wrap` rendering, for the most common shape of prompt).
 *
 * Drives `/dev/chat-user-markdown` (real `MessageList` + mock corpus, no
 * live agent needed — see that page's doc comment).
 *
 * Screenshot target: docs/cc-parity/2.1.238/user-prompt-markdown.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect } from "../helpers/test";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.238");
mkdirSync(SHOTS_DIR, { recursive: true });

test.describe("CC 2.1.234 — user prompts render markdown like replies do", () => {
  test("a user prompt with a code fence, inline code, and a list renders through Markdown", async ({
    page,
  }) => {
    await page.goto("/dev/chat-user-markdown");
    await expect(page.getByTestId("user-markdown-preview-root")).toBeVisible({ timeout: 30_000 });

    const userBubble = page.locator('[data-message-uuid="u-1"]');
    await expect(userBubble).toBeVisible();

    // Fenced code block → a highlighted <pre>/code element, not literal
    // "```ts" text sitting in a whitespace-pre-wrap block.
    await expect(userBubble.locator("pre code")).toContainText("function add(a, b)");
    await expect(userBubble.getByText("```", { exact: false })).toHaveCount(0);

    // Inline code span for `sum`.
    await expect(userBubble.locator("code").filter({ hasText: "sum" })).toBeVisible();

    // Bullet list renders as an actual <ul><li> pair, not literal "- add types".
    const list = userBubble.locator("ul li");
    await expect(list).toHaveCount(2);
    await expect(list.first()).toHaveText("add types");

    // The chat surface auto-scrolls to the latest message; scroll back to
    // the top so the screenshot shows the full transcript in context
    // (header chrome + the first user bubble in full), not just whatever
    // scrolled into view at the bottom. `MessageList`'s own scroll
    // container (not the `main` wrapper) is the one that actually scrolls.
    await page
      .getByTestId("user-markdown-preview-chat")
      .locator(".overflow-y-auto")
      .first()
      .evaluate((el) => {
        el.scrollTop = 0;
      });
    await page.waitForTimeout(200);

    // Screenshot in context — full preview chrome (header + both bubbles),
    // not the bubble in isolation.
    await page.screenshot({
      path: resolve(SHOTS_DIR, "user-prompt-markdown.png"),
      fullPage: false,
    });
  });

  test("assistant replies render the same markdown shapes (visual parity)", async ({ page }) => {
    await page.goto("/dev/chat-user-markdown");
    await expect(page.getByTestId("user-markdown-preview-root")).toBeVisible({ timeout: 30_000 });

    const assistantBubble = page.locator('[data-message-uuid="a-1"]');
    await expect(assistantBubble.locator("pre code")).toContainText("function sum(");
    await expect(assistantBubble.locator("ul li")).toHaveCount(2);
  });

  test("a plain multi-line prompt without blank lines keeps each line on its own line", async ({
    page,
  }) => {
    await page.goto("/dev/chat-user-markdown");
    await expect(page.getByTestId("user-markdown-preview-root")).toBeVisible({ timeout: 30_000 });

    const plainBubble = page.locator('[data-message-uuid="u-2"]');
    await expect(plainBubble).toBeVisible();
    await expect(plainBubble).toContainText("First line.");
    await expect(plainBubble).toContainText("Second line.");
    await expect(plainBubble).toContainText("Third line.");

    // The regression this guards against: CommonMark's default treats a
    // single "\n" as a space, which would collapse all three sentences
    // onto one visual line. `remark-breaks` (via `<Markdown breaks>`)
    // inserts a real line-break element per newline instead — assert at
    // least two of them (three lines needs two breaks).
    const breakCount = await plainBubble.locator("br").count();
    expect(breakCount).toBeGreaterThanOrEqual(2);
  });

  test("a user-authored !-mode shell fence gets no Execute button, unlike the same fence from the assistant", async ({
    page,
  }) => {
    // Regression coverage for a real issue an adversarial review caught:
    // routing user text through the shared Markdown -> CodeBlock pipeline
    // also pulled in CodeBlock's `!`-mode Execute button, which was scoped
    // to model-proposed commands only. `allowExecute={false}` (UserMessage,
    // TranscriptViewer) must suppress it; the assistant path is unchanged.
    await page.goto("/dev/chat-user-markdown");
    await expect(page.getByTestId("user-markdown-preview-root")).toBeVisible({ timeout: 30_000 });

    const userFence = page.locator('[data-message-uuid="u-3"]');
    const assistantFence = page.locator('[data-message-uuid="a-2"]');
    await expect(userFence.locator("pre").first()).toContainText("echo hi");
    await expect(assistantFence.locator("pre").first()).toContainText("echo hi");

    await expect(userFence.getByRole("button", { name: /Execute/i })).toHaveCount(0);
    await expect(assistantFence.getByRole("button", { name: /Execute/i })).toHaveCount(1);
  });
});
