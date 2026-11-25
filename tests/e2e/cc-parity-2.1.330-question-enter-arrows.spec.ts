/**
 * CC 2.1.330 parity — "[VSCode] Fixed Enter on a question card sending your
 * earlier answer instead of picking the focused one, and arrow keys not
 * working after an 'Other' answer; answered questions reopen on your pick".
 *
 * Claudius's reopened-question modal (a past AskUserQuestion reopened from
 * its transcript row; submitting sends the answer as a new prompt):
 *   - press 1, ArrowDown, Enter used to send option 1 — now it sends the
 *     highlighted option 2;
 *   - with focus in Other's textarea the arrows never got back to the
 *     options — now ArrowUp from the start of the text does.
 * Pure rules are unit-tested in
 * tests/unit/cc-parity-2.1.330-question-enter-arrows.test.ts. The "reopen on
 * your pick" part is partial in Claudius: going Back to an answered question
 * highlights its pick, but a question reopened from the transcript doesn't
 * know the earlier answer.
 *
 * Screenshot target: docs/cc-parity/2.1.330/question-enter-arrows.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";
import { initEvent, mockChatBackend, userText, type SdkEvent } from "./helpers/mock-chat";

const SCREENSHOT_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.330");
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-000002330b06";

const EVENTS: SdkEvent[] = [
  { type: "ready", sessionId: FAKE_SESSION_ID },
  initEvent("sys-330-en"),
  { type: "replay_done", hasMoreAbove: false },
  userText("u-330-en", "Set up tests for the pricing module."),
  {
    type: "sdk",
    message: {
      type: "assistant",
      uuid: "a-ask-330-en",
      message: {
        id: "msg_ask_330_en",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_330_en",
            name: "AskUserQuestion",
            input: {
              questions: [
                {
                  question: "Which test runner should I set up?",
                  header: "Runner",
                  multiSelect: false,
                  options: [
                    { label: "Vitest", description: "Fast, Vite-native." },
                    { label: "Jest", description: "The long-standing default." },
                    { label: "Mocha", description: "Minimal, bring your own assertions." },
                  ],
                },
              ],
            },
          },
        ],
      },
    },
  },
  {
    type: "sdk",
    message: { type: "result", uuid: "r-330-en", subtype: "success", num_turns: 1, duration_ms: 500, total_cost_usd: 0 },
  },
];

/** Capture what the modal sends: a reopened question's answer goes out as a new prompt. */
async function captureSends(page: Page): Promise<string[]> {
  const sent: string[] = [];
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/input`, async (route: Route) => {
    sent.push(String((route.request().postDataJSON() as { text?: string }).text ?? ""));
    return route.fulfill({ status: 200, json: { ok: true } });
  });
  return sent;
}

async function reopen(page: Page, events: SdkEvent[] = EVENTS) {
  await mockChatBackend(page, FAKE_SESSION_ID, events);
  await page.goto("/");
  await page.getByTestId("tool-call-answer-pill").click();
  const modal = page.getByTestId("ask-user-question");
  await expect(modal).toBeVisible({ timeout: 15_000 });
  return modal;
}

/** The same transcript, with a second question after the first. */
function withSecondQuestion(): SdkEvent[] {
  return EVENTS.map((e) => {
    const msg = (e as { message?: { uuid?: string } }).message;
    if (msg?.uuid !== "a-ask-330-en") return e;
    const clone = structuredClone(e) as {
      message: { message: { content: { input: { questions: unknown[] } }[] } };
    };
    clone.message.message.content[0].input.questions.push({
      question: "Where should the tests live?",
      header: "Location",
      multiSelect: false,
      options: [
        { label: "Next to the code", description: "pricing.test.ts beside pricing.ts." },
        { label: "tests/unit", description: "The shared unit-test folder." },
      ],
    });
    return clone as unknown as SdkEvent;
  });
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test("1, ArrowDown, Enter sends the highlighted option, not the earlier pick", async ({ page }) => {
  const sent = await captureSends(page);
  await reopen(page);

  await page.keyboard.press("1");
  await expect(page.getByTestId("ask-option-0")).toHaveAttribute("data-selected", "true");
  await page.keyboard.press("ArrowDown");
  await expect(page.getByTestId("ask-option-1")).toBeFocused();

  await page.keyboard.press("Enter");
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]).toContain("Jest");
  expect(sent[0]).not.toContain("Vitest");
});

test("with nothing picked, ArrowDown twice and Enter sends that option", async ({ page }) => {
  const sent = await captureSends(page);
  await reopen(page);

  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]).toContain("Mocha");
});

test("after a digit, the arrows step from the row it picked", async ({ page }) => {
  await captureSends(page);
  await reopen(page);

  await expect(page.getByTestId("ask-option-0")).toBeFocused();
  await page.keyboard.press("3");
  await expect(page.getByTestId("ask-option-2")).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(page.getByTestId("ask-option-1")).toBeFocused();
});

test("going Back to an answered question puts the highlight and focus on its pick", async ({ page }) => {
  await captureSends(page);
  await reopen(page, withSecondQuestion());

  await page.keyboard.press("2");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("ask-question-text")).toHaveText("Where should the tests live?");
  await page.getByTestId("ask-prev").click();

  await expect(page.getByTestId("ask-question-text")).toHaveText("Which test runner should I set up?");
  await expect(page.getByTestId("ask-option-1")).toBeFocused();
  await expect(page.getByTestId("ask-option-1")).toHaveAttribute("data-selected", "true");
});

test("ArrowUp from the start of Other's text goes back to the options", async ({ page }) => {
  await captureSends(page);
  const modal = await reopen(page);

  await page.getByTestId("ask-option-other").click();
  const other = page.getByTestId("ask-other-input");
  await expect(other).toBeFocused();
  await other.pressSequentially("Node's built-in runner");
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowUp");

  await expect(page.getByTestId("ask-option-2")).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(page.getByTestId("ask-option-1")).toBeFocused();

  await modal.screenshot({ path: resolve(SCREENSHOT_DIR, "question-enter-arrows.png") });
});
