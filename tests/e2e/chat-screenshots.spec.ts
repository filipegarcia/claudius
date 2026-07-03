import { test, expect } from "../helpers/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { UPDATE_SCREENSHOTS, hideNextDevOverlay } from "./helpers/marketing-screenshot";

/**
 * Marketing screenshots for the three chat states (empty, todos banner,
 * AskUserQuestion modal). These used to drive the live Claude agent and
 * needed ANTHROPIC_API_KEY — now they snap dev preview pages that
 * hand-render the same visuals from static fixtures. No network or API
 * key required, deterministic across runs.
 *
 * Outputs (only written when UPDATE_SCREENSHOTS=1 — see
 * tests/e2e/helpers/marketing-screenshot.ts):
 *   - site/screenshots/chat.png
 *   - site/screenshots/todos.png
 *   - site/screenshots/ask-user-question.png
 *   - site/screenshots/workflow.png  (full WorkflowBlock state gallery)
 *
 * The previews live under `app/dev/chat-*` and import a shared chrome
 * component (PreviewChrome). Updating the in-app chat UI doesn't auto-
 * update the previews — they're snapshots of intent.
 */

const SHOTS_DIR = resolve(process.cwd(), "site/screenshots");
if (UPDATE_SCREENSHOTS) mkdirSync(SHOTS_DIR, { recursive: true });

test.describe("chat states (fixture-driven)", () => {
  test("chat", async ({ page }) => {
    await page.goto("/dev/chat-empty", { waitUntil: "load" });
    // Wait for the suggestion chips to render.
    await expect(page.getByText("Find TODO comments in the codebase")).toBeVisible({
      timeout: 10_000,
    });
    await page.waitForTimeout(300);
    if (UPDATE_SCREENSHOTS) {
      await hideNextDevOverlay(page);
      await page.screenshot({
        path: resolve(SHOTS_DIR, "chat.png"),
        fullPage: false,
      });
    }
  });

  test("todos", async ({ page }) => {
    await page.goto("/dev/chat-todos", { waitUntil: "load" });
    // "Capturing marketing screenshots" appears in three places (banner
    // header, banner list row, activity rail) — `.first()` to avoid the
    // strict-mode multi-match error.
    await expect(page.getByText("Capturing marketing screenshots").first()).toBeVisible({
      timeout: 10_000,
    });
    await page.waitForTimeout(300);
    if (UPDATE_SCREENSHOTS) {
      await hideNextDevOverlay(page);
      await page.screenshot({
        path: resolve(SHOTS_DIR, "todos.png"),
        fullPage: false,
      });
    }
  });

  test("ask-user-question", async ({ page }) => {
    await page.goto("/dev/chat-ask", { waitUntil: "load" });
    await expect(page.getByTestId("ask-user-question-preview")).toBeVisible({
      timeout: 10_000,
    });
    // Settle: the modal mounts its tabs/options on first render and we want
    // the first question shown with focus rings stable.
    await page.waitForTimeout(500);
    if (UPDATE_SCREENSHOTS) {
      await hideNextDevOverlay(page);
      await page.screenshot({
        path: resolve(SHOTS_DIR, "ask-user-question.png"),
        fullPage: false,
      });
    }
  });

  test("workflow", async ({ page }) => {
    // A dynamic workflow running inline in a realistic chat (the chat shell +
    // the real WorkflowBlock). Viewport snap, matching the sibling chat shots.
    // The full all-states reference lives at /dev/workflow-states (no committed
    // PNG — open it in a browser to see every state).
    await page.goto("/dev/chat-workflow", { waitUntil: "load" });
    await expect(page.getByTestId("chat-workflow-preview")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/skeptics refuting/).first()).toBeVisible({
      timeout: 10_000,
    });
    await page.waitForTimeout(300);
    if (UPDATE_SCREENSHOTS) {
      await hideNextDevOverlay(page);
      await page.screenshot({
        path: resolve(SHOTS_DIR, "workflow.png"),
        fullPage: false,
      });
    }
  });
});
