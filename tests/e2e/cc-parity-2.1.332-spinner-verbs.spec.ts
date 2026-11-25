/**
 * CC 2.1.332 parity — "[VSCode] Fixed `spinnerVerbs` from Claude Code user and
 * managed settings being ignored".
 *
 * The working row always read "Claude is working…". With `spinnerVerbs` set
 * (user or managed settings), the server sends it on the `tips` frame and the
 * row shows one of the configured verbs. Unset, the row is unchanged.
 *
 * Screenshot target: docs/cc-parity/2.1.332/spinner-verbs.png
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";
import { initEvent, mockChatBackend, userText, type SdkEvent } from "./helpers/mock-chat";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.332");
mkdirSync(SHOTS_DIR, { recursive: true });

const SESSION = "aaaaaaaa-bbbb-cccc-dddd-000002332b09";

function transcript(spinnerVerbs?: { verbs: string[]; includeDefault: boolean }): SdkEvent[] {
  return [
    { type: "ready", sessionId: SESSION },
    initEvent("sys-init-332b9"),
    userText("u-1", "Audit the settings loader for unread keys."),
    {
      type: "tips",
      tips: [{ id: "t-1", text: "Press Esc to interrupt Claude at any time." }],
      ...(spinnerVerbs ? { spinnerVerbs } : {}),
    },
    { type: "replay_done", hasMoreAbove: false },
    // Mid-turn, so the working row renders.
    { type: "turn_status", status: "running" },
  ];
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test("the working row uses a verb from spinnerVerbs", async ({ page }) => {
  await mockChatBackend(page, SESSION, transcript({ verbs: ["Auditing"], includeDefault: false }));
  await page.goto("/");

  const verb = page.getByTestId("spinner-verb");
  await expect(verb).toBeVisible({ timeout: 15_000 });
  await expect(verb).toHaveText("Auditing…");
  await expect(page.getByText("Claude is working…")).toHaveCount(0);

  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(SHOTS_DIR, "spinner-verbs.png"), fullPage: false });
});

test("without the setting the row still reads Claude is working…", async ({ page }) => {
  await mockChatBackend(page, SESSION, transcript());
  await page.goto("/");

  await expect(page.getByText("Claude is working…")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("spinner-verb")).toHaveCount(0);
});
