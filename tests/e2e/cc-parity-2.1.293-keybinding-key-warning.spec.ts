/**
 * Claude Code 2.1.293 parity — "Fixed keybindings.json checks: a lone " "
 * (space key) is no longer reported as an error, and keys like "ctrl+ k" now
 * get a warning".
 *
 * Claudius's Keybindings page edits the CLI's `~/.claude/keybindings.json`
 * through free-text fields with no checks. It now warns under a binding whose
 * key or chord has a space next to a `+`, and stays quiet for a lone space.
 * Nothing is saved: the page reads the isolated e2e HOME's (absent) file.
 *
 * Screenshot target: docs/cc-parity/2.1.293/keybinding-key-warning.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.293");
mkdirSync(SHOTS_DIR, { recursive: true });

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test("the Keybindings editor warns on a key like \"ctrl+ k\" but not on a lone space", async ({ page }) => {
  const { workspaces } = (await (await page.request.get("/api/workspaces")).json()) as {
    workspaces: { id: string; name: string }[];
  };
  const ws = workspaces.find((w) => w.name === "claudius");
  expect(ws, "seeded claudius workspace").toBeTruthy();

  // Seed the (isolated e2e HOME's) keybindings.json through the page's own
  // API, so the warning comes from loaded data and survives the one-off
  // remount a first dev-server visit can trigger.
  const seeded = await page.request.put("/api/keybindings", {
    data: {
      data: {
        bindings: [
          { key: "ctrl+ k", command: "chat:clear" },
          { key: " ", command: "chat:submit" },
        ],
      },
    },
  });
  expect(seeded.ok(), "seeding keybindings.json").toBeTruthy();

  await page.goto(`/${ws!.id}/keybindings`);
  const keyInputs = page.getByPlaceholder("key (e.g. ctrl+s)");
  await expect(keyInputs).toHaveCount(2, { timeout: 20_000 });

  // Only the "ctrl+ k" row warns; the lone space is the space key.
  const warning = page.getByTestId("keybinding-key-warning");
  await expect(warning).toHaveCount(1);
  await expect(warning).toHaveText('"ctrl+ k" has a space next to "+" — write it as "ctrl+k".');
  await page.screenshot({ path: resolve(SHOTS_DIR, "keybinding-key-warning.png"), fullPage: false });

  // Fixing the key clears the warning as you type.
  await page.waitForTimeout(2_000);
  await keyInputs.first().fill("ctrl+k");
  await expect(warning).toHaveCount(0);
});
