/**
 * CC 2.1.247 — "Added the SendFeedback tool: when something goes wrong in a
 * session, Claude can draft a feedback report for you to review and send
 * from /feedback (turn off with the feedbackDrafts setting)."
 *
 * The `SendFeedback` tool itself is engine-side (baked into the SDK's tool
 * surface, same as Bash/Read/Write) and needs no Claudius code to run — it
 * shows up automatically once the SDK exposes it. What Claudius reimplements
 * is the product surface around it: a `feedbackDrafts` settings row (mirrors
 * the SDK's `Settings.feedbackDrafts` key exactly — config-passthrough, same
 * shape as `keybindingFlavor` / `syncClaudeAiPlugins`, next to the sibling
 * `feedbackSurveyRate` in "Storage & sessions") and a dedicated "Feedback
 * draft" rendering for the tool call in the transcript (see
 * `ToolCall.tsx`'s `SendFeedback` special-case) instead of the generic
 * JSON-dump tool card every other unrecognized tool gets.
 *
 * This spec drives the real enum row through the Settings UI and asserts it
 * round-trips through the settings API.
 *
 * Screenshot target: docs/cc-parity/2.1.247/feedback-drafts-settings.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.247");
mkdirSync(SHOTS_DIR, { recursive: true });

type UserSettings = Record<string, unknown>;

async function readUserSettings(page: Page): Promise<UserSettings> {
  const res = await page.request.get("/api/settings?scope=user");
  const body = (await res.json()) as { settings: UserSettings };
  return body.settings;
}

/** Drop the key from the shared dev fixture's user-scope settings so every run starts from "Default". */
async function clearFeedbackDrafts(page: Page): Promise<void> {
  const settings = await readUserSettings(page);
  const rest = { ...settings };
  delete rest.feedbackDrafts;
  await page.request.put("/api/settings/full", {
    data: { scope: "user", settings: rest },
  });
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
  await clearFeedbackDrafts(page);
});

test.afterEach(async ({ page }) => {
  await clearFeedbackDrafts(page);
});

test.describe("feedbackDrafts settings row (CC 2.1.247)", () => {
  test("renders as an enum row in Storage & sessions and round-trips through the settings API", async ({
    page,
  }) => {
    await page.goto("/settings");
    await page.getByLabel("Search settings").fill("feedbackDrafts");

    const row = page.getByTestId("catalog-field-feedbackDrafts");
    await expect(row).toBeVisible({ timeout: 15_000 });

    // Absent means "notify" (upstream's own default) — the unset state must
    // read as Default, not as a silently-applied value.
    await expect(row.locator("select")).toHaveValue("");
    await expect(row.locator("select option")).toHaveText(["Default", "notify", "quiet", "off"]);

    // Screenshot in context: full Settings page chrome (side nav, search
    // box) with the new row visible in its section.
    await page.waitForTimeout(150);
    await page.screenshot({
      path: resolve(SHOTS_DIR, "feedback-drafts-settings.png"),
      fullPage: false,
    });

    await row.locator("select").selectOption("off");
    await page.getByRole("button", { name: /^Save$/ }).click();

    await expect
      .poll(async () => (await readUserSettings(page)).feedbackDrafts, { timeout: 10_000 })
      .toBe("off");

    // "Default" must delete the key rather than write "notify" explicitly.
    await page.getByLabel("Search settings").fill("feedbackDrafts");
    const rowAfterSave = page.getByTestId("catalog-field-feedbackDrafts");
    await expect(rowAfterSave).toBeVisible();
    await rowAfterSave.locator("select").selectOption("");
    await page.getByRole("button", { name: /^Save$/ }).click();

    await expect
      .poll(async () => "feedbackDrafts" in (await readUserSettings(page)), {
        timeout: 10_000,
      })
      .toBe(false);
  });
});
