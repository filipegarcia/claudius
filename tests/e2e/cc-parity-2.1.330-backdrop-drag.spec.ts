/**
 * CC 2.1.330 parity — "[VSCode] Fixed dialogs closing, and losing typed text,
 * when a text selection was dragged past their edge".
 *
 * Drag-selecting text in a dialog's field and releasing outside the panel
 * fires `click` on the backdrop (the common ancestor of press and release),
 * which closed `Overlay` (here: /rename) and the reopened-question modal,
 * dropping what was typed. Now only a press that starts on the backdrop
 * closes them (`useBackdropDismiss`, unit-tested in
 * tests/unit/cc-parity-2.1.330-backdrop-drag.test.ts). A plain backdrop click
 * still closes.
 *
 * No screenshot: the visible outcome is the dialog simply staying open.
 */

import { test, expect, type Locator, type Page } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";
import { initEvent, mockChatBackend, userText, type SdkEvent } from "./helpers/mock-chat";

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-000002330b10";

const ASK_TOOL_USE: SdkEvent = {
  type: "sdk",
  message: {
    type: "assistant",
    uuid: "a-ask-330",
    message: {
      id: "msg_ask_330",
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_330_ask",
          name: "AskUserQuestion",
          input: {
            questions: [
              {
                question: "Where should the changelog entry go?",
                header: "Changelog",
                multiSelect: false,
                options: [
                  { label: "CHANGELOG.md", description: "The top-level changelog." },
                  { label: "docs/releases", description: "A per-release notes file." },
                ],
              },
            ],
          },
        },
      ],
    },
  },
};

const EVENTS: SdkEvent[] = [
  { type: "ready", sessionId: FAKE_SESSION_ID },
  initEvent("sys-330-bd"),
  { type: "replay_done", hasMoreAbove: false },
  userText("u-330", "Add a changelog entry."),
  ASK_TOOL_USE,
  // The turn ended (the question's permission stream closed), so the session
  // is idle and the composer can run /rename.
  {
    type: "sdk",
    message: { type: "result", uuid: "r-330", subtype: "success", num_turns: 1, duration_ms: 500, total_cost_usd: 0 },
  },
];

/** Press inside `field`, drag to the page's bottom-left corner (backdrop), release. */
async function dragSelectionOutOf(page: Page, field: Locator) {
  const box = await field.boundingBox();
  if (!box) throw new Error("field not laid out");
  const viewport = page.viewportSize()!;
  await page.mouse.move(box.x + 8, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 4, box.y + box.height / 2, { steps: 4 });
  await page.mouse.move(6, viewport.height - 6, { steps: 8 });
  await page.mouse.up();
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
  await mockChatBackend(page, FAKE_SESSION_ID, EVENTS);
  await page.goto("/");
  await expect(page.getByText("Add a changelog entry.")).toBeVisible({ timeout: 15_000 });
});

test("/rename stays open, text intact, when a selection is dragged onto the backdrop", async ({ page }) => {
  const composer = page.getByTestId("prompt-input");
  await expect(composer).toBeEnabled({ timeout: 30_000 });
  await composer.fill("/rename");
  await page.getByTestId("prompt-send").click();

  const input = page.getByPlaceholder("New title");
  await expect(input).toBeVisible();
  await input.fill("Changelog and release notes");

  await dragSelectionOutOf(page, input);
  await expect(input).toBeVisible();
  await expect(input).toHaveValue("Changelog and release notes");

  // A deliberate click on the backdrop still closes it.
  const viewport = page.viewportSize()!;
  await page.mouse.click(6, viewport.height - 6);
  await expect(input).toHaveCount(0);
});

test("the reopened question keeps its Other answer when a selection is dragged out", async ({ page }) => {
  await page.getByTestId("tool-call-answer-pill").click();
  const modal = page.getByTestId("ask-user-question");
  await expect(modal).toBeVisible();

  await page.getByTestId("ask-option-other").click();
  const other = page.getByTestId("ask-other-input");
  await other.fill("Both: CHANGELOG.md and a release note");

  await dragSelectionOutOf(page, other);
  await expect(modal).toBeVisible();
  await expect(other).toHaveValue("Both: CHANGELOG.md and a release note");

  const viewport = page.viewportSize()!;
  await page.mouse.click(6, viewport.height - 6);
  await expect(modal).toHaveCount(0);
});
