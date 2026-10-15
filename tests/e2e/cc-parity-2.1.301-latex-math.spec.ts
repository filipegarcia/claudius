/**
 * CC 2.1.301 parity — "[VSCode] Added LaTeX math rendering in Claude's
 * responses, including `$$` and multi-line `\[ … \]` blocks and inline
 * `$…$` and `\(…\)` math".
 *
 * Claudius's chat Markdown now typesets Claude's math with KaTeX. A
 * delimiter pre-pass keeps prices and code literal, and the user's own
 * prompt keeps its dollars as typed.
 *
 * Screenshot target: docs/cc-parity/2.1.301/latex-math.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";
import { assistantText, initEvent, mockChatBackend, userText } from "./helpers/mock-chat";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.301");
mkdirSync(SHOTS_DIR, { recursive: true });

const SESSION = "aaaaaaaa-bbbb-cccc-dddd-000002301a01";

const REPLY = [
  "The sum of the first $n$ integers is a classic result. Written out:",
  "",
  "\\[",
  "\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}",
  "\\]",
  "",
  "So for \\(n = 100\\) you get $5050$. Euler's identity in display form:",
  "",
  "$$",
  "e^{i\\pi} + 1 = 0",
  "$$",
  "",
  "Prices stay prose: the course costs $5 and the book $10. Code stays code: `echo $HOME`.",
].join("\n");

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test("Claude's math is typeset; prices, code and the user's own dollars are not", async ({ page }) => {
  await mockChatBackend(page, SESSION, [
    { type: "ready", sessionId: SESSION },
    initEvent("sys-init-301m"),
    userText("u-1", "What's the sum of 1..n? (budget: $5 to $10)"),
    assistantText("a-1", REPLY),
    { type: "replay_done", hasMoreAbove: false },
  ]);
  await page.goto("/");

  await expect(page.locator(".katex-display")).toHaveCount(2, { timeout: 15_000 });
  // $n$, \(n = 100\), $5050$ + the two display blocks (each also a .katex).
  await expect(page.locator(".katex")).toHaveCount(5);
  await expect(page.getByText("the course costs $5 and the book $10", { exact: false })).toBeVisible();
  await expect(page.locator("code", { hasText: "echo $HOME" })).toBeVisible();
  // The user's prompt is not typeset.
  await expect(page.getByText("budget: $5 to $10", { exact: false })).toBeVisible();

  await page.locator(".katex-display").first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(SHOTS_DIR, "latex-math.png"), fullPage: false });
});
