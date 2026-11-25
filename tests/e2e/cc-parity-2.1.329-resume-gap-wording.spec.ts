/**
 * CC 2.1.329 parity — "Fixed the line about earlier messages on resume
 * blaming a damaged file when the file was intact".
 *
 * Claudius's resume-gap row (2.1.327) said part of the session's file was
 * "missing or damaged". It now reads the engine's line, which names no cause.
 * Detection and the 2.1.332 dedupe of the engine's own copy are unit-tested
 * in tests/unit/cc-parity-2.1.329-resume-gap-wording.test.ts.
 *
 * Screenshot target: docs/cc-parity/2.1.329/resume-gap-wording.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";
import { assistantText, initEvent, mockChatBackend, userText } from "./helpers/mock-chat";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.329");
mkdirSync(SHOTS_DIR, { recursive: true });

const SESSION = "aaaaaaaa-bbbb-cccc-dddd-000002329a01";
const NOTICE =
  "Earlier messages in this session weren't loaded. Claude won't see them, so repeat anything it still needs.";

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test("the resume-gap line no longer blames a damaged file", async ({ page }) => {
  await mockChatBackend(page, SESSION, [
    { type: "ready", sessionId: SESSION },
    initEvent("sys-init-329g"),
    {
      type: "sdk",
      message: {
        type: "system",
        subtype: "informational",
        level: "warning",
        content: NOTICE,
        uuid: `resume-gap-${SESSION}`,
      },
    },
    assistantText("a-7", "The retry helper now backs off exponentially, capped at 30s."),
    userText("u-8", "Add a test for the cap."),
    assistantText("a-8", "Added `retry.test.ts` covering the 30s ceiling."),
    { type: "replay_done", hasMoreAbove: false },
  ]);
  await page.goto("/");

  const pill = page.getByTestId("system-pill").filter({ hasText: "weren't loaded" });
  await expect(pill).toBeVisible({ timeout: 15_000 });
  await expect(pill).toHaveText(NOTICE);
  await expect(pill).toHaveAttribute("data-info-level", "warning");
  await expect(page.getByText("missing or damaged", { exact: false })).toHaveCount(0);

  await page.screenshot({ path: resolve(SHOTS_DIR, "resume-gap-wording.png"), fullPage: false });
});
