/**
 * SDK 0.3.267 — `Settings.maxEffortLevel` ("low" | "medium" | "high" |
 * "xhigh" | "max") caps the effort level a user/org can pick: anything above
 * it — an `/effort` or `/model` pick, `--effort`, `CLAUDE_CODE_EFFORT_LEVEL`,
 * or a model default — is clamped to it, on every provider including
 * Bedrock, Vertex and Foundry.
 *
 * The key doesn't appear in the upstream prose changelog for the
 * 0.3.263 → 0.3.267 window — it was found by diffing `sdk.d.ts`. Before this
 * change it was reachable only through the raw "Other" JSON editor, because
 * `ClaudeSettings` passes unknown keys through untouched; the gap was
 * discoverability, not plumbing (the bundled `claude` binary already reads
 * it straight from the same `~/.claude/settings.json` this page writes).
 * `modelSettings.<model>.maxEffortLevel` (the per-model override) stays out
 * of the curated catalog — it's a nested per-model map, not a scalar — and
 * keeps using that same generic "Other" editor, same as
 * `modelSettings.<model>.effortLevel` already does.
 *
 * This spec drives the real setting through the generic SDK-settings catalog
 * on `/settings` (Thinking & effort section) and asserts it round-trips
 * through the settings API.
 *
 * Screenshot target: docs/sdk-updates/0.3.267/max-effort-level-settings.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/sdk-updates/0.3.267");
mkdirSync(SHOTS_DIR, { recursive: true });

type UserSettings = Record<string, unknown>;

/**
 * Drop the key from the shared dev fixture's user-scope settings so the spec
 * starts from "Default" regardless of what a previous run left behind.
 */
async function clearMaxEffortLevel(page: Page): Promise<void> {
  const res = await page.request.get("/api/settings?scope=user");
  const body = (await res.json()) as { settings: UserSettings };
  const rest = { ...body.settings };
  delete rest.maxEffortLevel;
  await page.request.put("/api/settings/full", {
    data: { scope: "user", settings: rest },
  });
}

async function readMaxEffortLevel(page: Page): Promise<UserSettings> {
  const res = await page.request.get("/api/settings?scope=user");
  const body = (await res.json()) as { settings: UserSettings };
  return body.settings;
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
  await clearMaxEffortLevel(page);
});

test.afterEach(async ({ page }) => {
  await clearMaxEffortLevel(page);
});

test.describe("Max effort level setting (SDK 0.3.267)", () => {
  test("renders as an enum row and round-trips through the settings API", async ({ page }) => {
    await page.goto("/settings");
    await page.getByLabel("Search settings").fill("maxEffortLevel");

    const field = page.getByTestId("catalog-field-maxEffortLevel");
    await expect(field).toBeVisible({ timeout: 15_000 });

    // Unset means "no ceiling" — must read as Default, not a silently
    // applied clamp.
    await expect(field.locator("select")).toHaveValue("");

    // Exactly the SDK's five literals, plus the unset row.
    await expect(field.locator("select option")).toHaveText([
      "Default",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);

    await field.locator("select").selectOption("high");
    await page.getByRole("button", { name: /^Save$/ }).click();

    await expect
      .poll(async () => (await readMaxEffortLevel(page)).maxEffortLevel, { timeout: 10_000 })
      .toBe("high");

    // Saving triggers a settings refetch that resets the search box (a
    // pre-existing quirk of the page, unrelated to this feature) — re-apply
    // the filter so the shot shows the row in its section rather than the
    // top of an unfiltered page.
    await page.getByLabel("Search settings").fill("maxEffortLevel");
    await expect(field).toBeVisible();
    await expect(field.locator("select")).toHaveValue("high");
    await page.waitForTimeout(200);

    await page.screenshot({
      path: resolve(SHOTS_DIR, "max-effort-level-settings.png"),
      fullPage: false,
    });
  });

  test("clearing the row removes the key rather than writing an empty string", async ({
    page,
  }) => {
    // An empty string is not a member of the SDK's union — writing one would
    // be a config the CLI has to reject or ignore. "Default" must delete.
    await page.goto("/settings");
    await page.getByLabel("Search settings").fill("maxEffortLevel");
    const field = page.getByTestId("catalog-field-maxEffortLevel");
    await expect(field).toBeVisible({ timeout: 15_000 });

    await field.locator("select").selectOption("low");
    await page.getByRole("button", { name: /^Save$/ }).click();
    await expect
      .poll(async () => (await readMaxEffortLevel(page)).maxEffortLevel, { timeout: 10_000 })
      .toBe("low");

    await page.getByLabel("Search settings").fill("maxEffortLevel");
    await expect(field).toBeVisible();
    await field.locator("select").selectOption("");
    await page.getByRole("button", { name: /^Save$/ }).click();

    await expect
      .poll(async () => "maxEffortLevel" in (await readMaxEffortLevel(page)), {
        timeout: 10_000,
      })
      .toBe(false);
  });
});
