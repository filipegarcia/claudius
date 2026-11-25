/**
 * CC 2.1.331 parity — "[VSCode] Fixed shortcuts such as Ctrl+1, Alt+1 or
 * Ctrl+Space answering an open dialog".
 *
 * The reopened-question modal picked option N on any keydown whose key was
 * the digit N, so an app chord (Ctrl+Alt+N "Go to workspace N", Ctrl+1)
 * changed the answer. Only a bare digit picks now (unit-tested in
 * tests/unit/cc-parity-2.1.331-question-digit-chords.test.ts).
 *
 * No screenshot: the visible outcome is nothing changing.
 */

import { test, expect } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";
import { initEvent, mockChatBackend, userText, type SdkEvent } from "./helpers/mock-chat";

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-000002331b08";

const EVENTS: SdkEvent[] = [
  { type: "ready", sessionId: FAKE_SESSION_ID },
  initEvent("sys-331-dg"),
  { type: "replay_done", hasMoreAbove: false },
  userText("u-331", "Pick a test runner."),
  {
    type: "sdk",
    message: {
      type: "assistant",
      uuid: "a-ask-331",
      message: {
        id: "msg_ask_331",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_331_ask",
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
    message: { type: "result", uuid: "r-331", subtype: "success", num_turns: 1, duration_ms: 500, total_cost_usd: 0 },
  },
];

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
  await mockChatBackend(page, FAKE_SESSION_ID, EVENTS);
});

test("Ctrl+1 and Alt+2 don't pick an answer; a bare 2 does", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("tool-call-answer-pill").click();
  await expect(page.getByTestId("ask-user-question")).toBeVisible({ timeout: 15_000 });

  const first = page.getByTestId("ask-option-0");
  const second = page.getByTestId("ask-option-1");
  await page.keyboard.press("Control+1");
  await page.keyboard.press("Alt+2");
  await expect(first).toHaveAttribute("data-selected", "false");
  await expect(second).toHaveAttribute("data-selected", "false");

  await page.keyboard.press("2");
  await expect(second).toHaveAttribute("data-selected", "true");
  await expect(first).toHaveAttribute("data-selected", "false");
});
