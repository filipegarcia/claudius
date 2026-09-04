/**
 * CC 2.1.259 — "Improved `/workflows` agent detail: JSON outcomes are
 * pretty-printed with syntax colors and real line breaks, and long
 * outcomes fold behind an expand toggle."
 *
 * Claudius has no dedicated `/workflows` screen (the Workflow tool
 * integration is surfaced inline in chat via `WorkflowBlock.tsx`), and its
 * "Args" / result-JSON rendering was a plain `JSON.stringify(value, null,
 * 2)` dump inside a `<pre>` — real line breaks, but no syntax colors, and
 * no fold-when-long behavior beyond the outer `<details>` section label.
 * This spec exercises the new `JsonBlock` component (syntax-colored,
 * folds behind an expand toggle past 12 lines) in a completed
 * `WorkflowBlock`'s "Args" and "Raw output" disclosures.
 *
 * Uses the `/dev/chat-workflow-completed` fixture — a dedicated preview
 * (distinct from `/dev/chat-workflow`, which feeds the committed
 * `workflow.png` marketing shot and stays script-only/running) showing a
 * COMPLETED workflow with args + a parsed result, on the same chat chrome
 * (tab strip, side rails) the marketing shot uses.
 *
 * Screenshot target: docs/cc-parity/2.1.260/workflow-json-pretty.png
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.260");
mkdirSync(SHOTS_DIR, { recursive: true });

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test.describe("Syntax-colored JSON rendering in WorkflowBlock (CC 2.1.259/2.1.260 parity)", () => {
  test("Args and Raw output render as syntax-colored JSON, not a plain dump", async ({ page }) => {
    await page.goto("/dev/chat-workflow-completed", { waitUntil: "load" });
    await expect(page.getByTestId("chat-workflow-completed-preview")).toBeVisible({ timeout: 10_000 });

    const block = page.getByTestId("workflow-block");
    await expect(block).toBeVisible();

    // Expand both disclosures — WorkflowBlock's outer card is open by
    // default (`defaultOpen`), but the nested <details> for Args/Raw
    // output start closed regardless.
    await block.getByText("Args", { exact: true }).click();
    await block.getByText("Raw output", { exact: true }).click();

    // Syntax-colored tokens are real DOM structure, not just text — assert
    // the key/string/boolean/number token classes actually render, not
    // just that the substring appears somewhere.
    const jsonBlocks = block.getByTestId("json-block");
    await expect(jsonBlocks.first()).toBeVisible();

    // Args: {"topic": "v0.9 release", "tone": "confident, no hype"}
    await expect(block.locator('[class*="text-sky-300"]').filter({ hasText: '"topic"' })).toBeVisible();
    await expect(block.locator('[class*="text-emerald-300"]').filter({ hasText: "v0.9 release" })).toBeVisible();

    // Raw output includes a boolean and a number, both colored distinctly
    // from strings — proves this is a real tokenizer, not a monochrome dump.
    await expect(block.locator('[class*="text-purple-300"]').filter({ hasText: "true" })).toBeVisible();
    await expect(block.locator('[class*="text-amber-300"]').filter({ hasText: "3" })).toBeVisible();

    await page.waitForTimeout(200);
    await page.screenshot({ path: resolve(SHOTS_DIR, "workflow-json-pretty.png"), fullPage: false });
  });
});
