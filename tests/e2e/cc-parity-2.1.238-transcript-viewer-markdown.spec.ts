/**
 * CC 2.1.234 — "your own prompts now render markdown ... the same way
 * replies do", applied to `components/sessions/TranscriptViewer.tsx`.
 *
 * `TranscriptViewer` is a second, independent renderer of the same
 * user/assistant turn content as the live chat (`MessageList` /
 * `UserMessage`) — it's what a session's detail/history route shows for a
 * past session. Found during adversarial review of the primary fix
 * (`UserMessage.tsx`): before this, a reopened historic session would show
 * a user's code-fenced prompt as a literal ```-fenced wall of text, even
 * though the SAME prompt rendered as highlighted markdown while the
 * session was live — an inconsistency the reviewer flagged as a
 * completeness gap left by only fixing the live-chat path.
 *
 * Also covers the accompanying security fix: `allowExecute={false}` must
 * suppress `CodeBlock`'s `!`-mode Execute button here too, for the same
 * reason as `UserMessage.tsx` (this text isn't model-authored).
 *
 * Drives `/dev/transcript-viewer-markdown` (real `TranscriptViewer` + a
 * hand-built `SessionMessage[]` fixture, no session store involved).
 *
 * Screenshot target: docs/cc-parity/2.1.238/transcript-viewer-markdown.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect } from "../helpers/test";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.238");
mkdirSync(SHOTS_DIR, { recursive: true });

test.describe("CC 2.1.234 — TranscriptViewer renders user-turn markdown", () => {
  test("a historic user prompt with a code fence and list renders through Markdown", async ({
    page,
  }) => {
    await page.goto("/dev/transcript-viewer-markdown");
    await expect(page.getByTestId("transcript-viewer-markdown-preview-root")).toBeVisible({
      timeout: 30_000,
    });

    const userTurn = page.locator('[data-message-uuid="u-1"]');
    await expect(userTurn.locator("pre").first()).toContainText("function add(a, b)");
    await expect(userTurn.getByText("```", { exact: false })).toHaveCount(0);
    await expect(userTurn.locator("ul li")).toHaveCount(2);

    await page.screenshot({
      path: resolve(SHOTS_DIR, "transcript-viewer-markdown.png"),
      fullPage: false,
    });
  });

  test("a historic user !-mode shell fence gets no Execute button, unlike the assistant's", async ({
    page,
  }) => {
    await page.goto("/dev/transcript-viewer-markdown");
    await expect(page.getByTestId("transcript-viewer-markdown-preview-root")).toBeVisible({
      timeout: 30_000,
    });

    const userFence = page.locator('[data-message-uuid="u-2"]');
    const assistantFence = page.locator('[data-message-uuid="a-1"]');
    await expect(userFence.locator("pre").first()).toContainText("echo hi");
    await expect(assistantFence.locator("pre").first()).toContainText("echo hi");

    await expect(userFence.getByRole("button", { name: /Execute/i })).toHaveCount(0);
    await expect(assistantFence.getByRole("button", { name: /Execute/i })).toHaveCount(1);
  });
});
