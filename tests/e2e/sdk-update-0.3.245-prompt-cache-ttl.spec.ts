/**
 * SDK 0.3.245 — `Settings.promptCacheTtl` and `Settings.subagentPromptCacheTtl`
 * ("5m" | "1h") control the prompt-cache TTL for, respectively, the main
 * conversation and everything outside it (subagents, workflows, background
 * and helper requests).
 *
 * Neither key appears in the upstream prose changelog for the
 * 0.3.241 → 0.3.245 window — both were found by diffing `sdk.d.ts`. Before
 * this change they were reachable only through the raw "Other" JSON editor,
 * because `ClaudeSettings` passes unknown keys through untouched; the gap
 * was discoverability, not plumbing (the bundled `claude` binary reads them
 * straight from the same `~/.claude/settings.json` this page writes).
 *
 * This spec drives both real settings through the generic SDK-settings
 * catalog on `/settings` (Context & compaction section) and asserts they
 * round-trip through the settings API.
 *
 * Screenshot target: docs/sdk-updates/0.3.245/prompt-cache-ttl-settings.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/sdk-updates/0.3.245");
mkdirSync(SHOTS_DIR, { recursive: true });

type UserSettings = Record<string, unknown>;

/**
 * Drop both keys from the shared dev fixture's user-scope settings so the
 * spec starts from "Default" regardless of what a previous run left behind.
 */
async function clearTtlSettings(page: Page): Promise<void> {
  const res = await page.request.get("/api/settings?scope=user");
  const body = (await res.json()) as { settings: UserSettings };
  const rest = { ...body.settings };
  delete rest.promptCacheTtl;
  delete rest.subagentPromptCacheTtl;
  await page.request.put("/api/settings/full", {
    data: { scope: "user", settings: rest },
  });
}

async function readTtlSettings(page: Page): Promise<UserSettings> {
  const res = await page.request.get("/api/settings?scope=user");
  const body = (await res.json()) as { settings: UserSettings };
  return body.settings;
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
  await clearTtlSettings(page);
});

test.afterEach(async ({ page }) => {
  await clearTtlSettings(page);
});

test.describe("Prompt cache TTL settings (SDK 0.3.245)", () => {
  test("both TTL keys render as enum rows and round-trip through the settings API", async ({
    page,
  }) => {
    await page.goto("/settings");
    await page.getByLabel("Search settings").fill("promptCacheTtl");

    const main = page.getByTestId("catalog-field-promptCacheTtl");
    const subagent = page.getByTestId("catalog-field-subagentPromptCacheTtl");

    // The search matches both keys — `subagentPromptCacheTtl` contains
    // `PromptCacheTtl` as a substring, and the catalog filter is
    // case-insensitive over key + description.
    await expect(main).toBeVisible({ timeout: 15_000 });
    await expect(subagent).toBeVisible();

    // Absent means "automatic" — the SDK picks 1h on a subscription and 5m
    // on an API key — so the unset state must read as Default, not as a
    // silently-applied value.
    await expect(main.locator("select")).toHaveValue("");
    await expect(subagent.locator("select")).toHaveValue("");

    // Exactly the SDK's two literals, plus the unset row.
    await expect(main.locator("select option")).toHaveText(["Default", "5m", "1h"]);
    await expect(subagent.locator("select option")).toHaveText(["Default", "5m", "1h"]);

    // Set them to different values so a wire-up that writes one key for both
    // rows would fail this assertion.
    await main.locator("select").selectOption("1h");
    await subagent.locator("select").selectOption("5m");
    await page.getByRole("button", { name: /^Save$/ }).click();

    await expect
      .poll(async () => await readTtlSettings(page), { timeout: 10_000 })
      .toMatchObject({ promptCacheTtl: "1h", subagentPromptCacheTtl: "5m" });

    // Saving triggers a settings refetch that resets the search box (a
    // pre-existing quirk of the page, unrelated to this feature) — re-apply
    // the filter so the shot shows the two rows in their section rather than
    // the top of an unfiltered page.
    await page.getByLabel("Search settings").fill("promptCacheTtl");
    await expect(main).toBeVisible();
    await expect(main.locator("select")).toHaveValue("1h");
    await expect(subagent.locator("select")).toHaveValue("5m");
    await page.waitForTimeout(200);

    await page.screenshot({
      path: resolve(SHOTS_DIR, "prompt-cache-ttl-settings.png"),
      fullPage: false,
    });
  });

  test("clearing a TTL row removes the key rather than writing an empty string", async ({
    page,
  }) => {
    // An empty string is not a member of the SDK's union — writing one would
    // be a config the CLI has to reject or ignore. "Default" must delete.
    await page.goto("/settings");
    await page.getByLabel("Search settings").fill("promptCacheTtl");
    const main = page.getByTestId("catalog-field-promptCacheTtl");
    await expect(main).toBeVisible({ timeout: 15_000 });

    await main.locator("select").selectOption("5m");
    await page.getByRole("button", { name: /^Save$/ }).click();
    await expect
      .poll(async () => (await readTtlSettings(page)).promptCacheTtl, { timeout: 10_000 })
      .toBe("5m");

    await page.getByLabel("Search settings").fill("promptCacheTtl");
    await expect(main).toBeVisible();
    await main.locator("select").selectOption("");
    await page.getByRole("button", { name: /^Save$/ }).click();

    await expect
      .poll(async () => "promptCacheTtl" in (await readTtlSettings(page)), {
        timeout: 10_000,
      })
      .toBe(false);
  });
});
