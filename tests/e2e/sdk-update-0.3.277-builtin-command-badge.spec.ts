/**
 * SDK 0.3.277 — "Added an optional `builtin` field to `SlashCommand`, set
 * when a command is built into Claude Code."
 *
 * Claudius's `SlashCommandPicker` already merges the SDK's rich
 * `supportedCommands()` payload with the curated static registry
 * (`mergeSuggestions` in `lib/shared/slash-commands.ts`); this adds a small
 * "built-in" badge to SDK-sourced rows the SDK marks `builtin: true`, so a
 * user browsing the picker can tell a Claude Code built-in apart from a
 * plugin/project-provided command with the same rich-command treatment.
 *
 * `GET /api/sessions/[id]/commands` (the route `SlashCommandPicker`'s data
 * ultimately comes from, via `useSdkCommands`) 503s unless the session has
 * an actively-bound SDK query — not guaranteed for a freshly-created e2e
 * session — so this fixtures that route directly rather than relying on a
 * live agent process to report real commands.
 *
 * Screenshot target: docs/sdk-updates/0.3.277/builtin-command-badge.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/sdk-updates/0.3.277");
mkdirSync(SHOTS_DIR, { recursive: true });

const SESSION_RE = /[?&]session=([0-9a-f-]{36})/i;

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test.describe("SDK 0.3.277 — SlashCommand.builtin badge", () => {
  test("a builtin SDK command shows a built-in badge; a non-builtin one doesn't", async ({
    page,
  }) => {
    // Names deliberately not in the curated static registry
    // (`lib/shared/slash-commands.ts`'s `SLASH_COMMANDS`) — a name already
    // claimed there would keep its registry entry, which doesn't carry a
    // `builtin` distinction, and never surface the fixture's field.
    await page.route("**/api/sessions/*/commands", async (route: Route) => {
      if (route.request().method() !== "GET") return route.fallback();
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          commands: [
            {
              name: "zz-core-builtin",
              description: "A Claude Code built-in command",
              builtin: true,
            },
            {
              name: "zz-plugin-cmd",
              description: "A plugin-provided command",
            },
          ],
        }),
      });
    });

    await page.goto("/");
    await page.waitForURL((url) => SESSION_RE.test(String(url)), { timeout: 30_000 });

    const composer = page.getByTestId("prompt-input");
    await expect(composer).toBeVisible({ timeout: 30_000 });
    await expect(composer).toBeEnabled({ timeout: 30_000 });
    await page.waitForTimeout(500);

    await composer.fill("");
    await composer.click();
    await composer.pressSequentially("/zz-", { delay: 20 });
    await page.waitForTimeout(300);

    const builtinRow = page.locator("button", { hasText: "zz-core-builtin" }).first();
    const pluginRow = page.locator("button", { hasText: "zz-plugin-cmd" }).first();
    await expect(builtinRow).toBeVisible({ timeout: 5_000 });
    await expect(pluginRow).toBeVisible({ timeout: 5_000 });

    await expect(builtinRow.getByTestId("slash-command-builtin-badge")).toBeVisible();
    await expect(builtinRow.getByTestId("slash-command-builtin-badge")).toHaveText("built-in");
    await expect(pluginRow.getByTestId("slash-command-builtin-badge")).toHaveCount(0);

    // Screenshot in context — full chat chrome, composer with the picker
    // open above it, both rows (builtin badge + no badge) visible together.
    await page.screenshot({
      path: resolve(SHOTS_DIR, "builtin-command-badge.png"),
      fullPage: false,
    });
  });
});
