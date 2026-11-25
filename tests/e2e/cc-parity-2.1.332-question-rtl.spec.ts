/**
 * CC 2.1.332 parity — "[VSCode] Fixed … Hebrew and Arabic questions reading
 * out of order".
 *
 * The AskUserQuestion card rendered the model's question, header and options
 * in the page's LTR direction, so right-to-left text had its punctuation on
 * the wrong side. Those elements now carry `dir="auto"` and take their
 * direction from their own text, while English options stay LTR. (The
 * notification half of this bullet is unit-tested in
 * tests/unit/cc-parity-2.1.332-rtl-and-session-notices.test.ts.)
 *
 * Screenshot target: docs/cc-parity/2.1.332/question-rtl.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Locator } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";
import { assistantText, initEvent, mockChatBackend, userText, type SdkEvent } from "./helpers/mock-chat";

const SCREENSHOT_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.332");
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-000002332b10";

const EVENTS: SdkEvent[] = [
  { type: "ready", sessionId: FAKE_SESSION_ID },
  initEvent("sys-332-rtl"),
  { type: "replay_done", hasMoreAbove: false },
  userText("u-332-rtl", "תגדיר לי מסד נתונים לפרויקט."),
  assistantText("a-332-rtl", "לפני שאתחיל, שאלה אחת."),
  {
    type: "ask_user_question",
    requestId: "req-332-rtl",
    toolUseId: "toolu_332_rtl",
    questions: [
      {
        question: "באיזה מסד נתונים להשתמש?",
        header: "מסד נתונים",
        multiSelect: false,
        options: [
          { label: "פוסטגרס (מומלץ)", description: "יציב, מוכר, ותומך בכל מה שצריך." },
          { label: "SQLite", description: "A single file, no server." },
        ],
      },
    ],
  },
];

const direction = (el: Locator) => el.evaluate((node) => getComputedStyle(node).direction);

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
  await mockChatBackend(page, FAKE_SESSION_ID, EVENTS);
});

test("a Hebrew question reads right to left; an English option stays left to right", async ({ page }) => {
  await page.goto("/");
  const card = page.getByTestId("ask-user-question");
  await expect(card).toBeVisible({ timeout: 15_000 });

  const question = card.getByTestId("ask-question-text");
  await expect(question).toHaveText("באיזה מסד נתונים להשתמש?");
  await expect(question).toHaveAttribute("dir", "auto");
  expect(await direction(question)).toBe("rtl");

  const hebrewLabel = card.getByTestId("ask-option-0").getByText("פוסטגרס (מומלץ)");
  expect(await direction(hebrewLabel)).toBe("rtl");
  // Aligned to its own start (the right), not the option row's `text-left`.
  expect(await hebrewLabel.evaluate((node) => getComputedStyle(node).textAlign)).toBe("start");
  const englishDescription = card.getByTestId("ask-option-1").getByText("A single file, no server.");
  expect(await direction(englishDescription)).toBe("ltr");

  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(SCREENSHOT_DIR, "question-rtl.png"), fullPage: false });
});
