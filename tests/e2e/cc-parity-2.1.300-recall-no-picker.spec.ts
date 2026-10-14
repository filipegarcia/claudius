/**
 * CC 2.1.300 parity —
 *   "[VSCode] Fixed ↑ then Enter on a recalled slash command running it
 *    without its arguments; the command and file menus no longer open over a
 *    recalled prompt until you edit it", and
 *   "[VSCode] Fixed "Edit prompt" on a flagged message opening the file or
 *    command menu over the restored prompt; Enter now sends it as written".
 *
 * Claudius's composer (`components/chat/PromptInput.tsx`) re-ran its picker
 * detection on every recalled or restored prompt. A recalled `/compact`
 * reopened the slash menu, and `explain @lib/foo.ts` reopened the @-file
 * menu, so Enter picked the highlighted item instead of sending the text.
 * The affected paths were Cmd/Ctrl+↑ history, the failed-send restore, the
 * refusal pill's "Edit & retry", and the queued-message Edit lift. Now those
 * paths close the menus, and the first real edit brings them back.
 *
 * Screenshot target: docs/cc-parity/2.1.300/recall-no-picker.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.300");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-00000300rc01";
// The @-token must end the prompt: that is where the caret lands on recall,
// and where the file menu used to reopen.
const MENTION_PROMPT = "explain what this file exports: @lib/foo.ts";
// Replayed transcript entries that start with a known command become command
// pills, not history entries — so the slash case seeds a partial command
// (`/comp`) the way a user would have typed and sent it.
const SLASH_PROMPT = "/comp";

type SdkEvent = Record<string, unknown>;

function sseBody(events: SdkEvent[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

function userEvent(uuid: string, text: string): SdkEvent {
  return {
    type: "sdk",
    message: { type: "user", uuid, message: { role: "user", content: [{ type: "text", text }] } },
  };
}

function assistantEvent(uuid: string, text: string): SdkEvent {
  return {
    type: "sdk",
    message: {
      type: "assistant",
      uuid,
      message: { role: "assistant", content: [{ type: "text", text }] },
    },
  };
}

async function mockChatBackend(page: Page, events: SdkEvent[]): Promise<{ inputs: string[] }> {
  const inputs: string[] = [];
  await page.route("**/api/sessions", async (route: Route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ id: FAKE_SESSION_ID }),
    });
  });
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/stream*`, async (route: Route) => {
    return route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
      body: sseBody(events),
    });
  });
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/input`, async (route: Route) => {
    const body = route.request().postDataJSON() as { text?: string };
    inputs.push(body?.text ?? "");
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  // The @-file menu would have plenty to offer — so if it opened, Enter would
  // swap a different file in.
  await page.route("**/api/fs/list**", async (route: Route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        entries: [
          { relPath: "lib/foo-bar.ts", absPath: "/repo/lib/foo-bar.ts", type: "file" },
          { relPath: "lib/foo.ts", absPath: "/repo/lib/foo.ts", type: "file" },
        ],
      }),
    });
  });
  await page.route("**/api/sessions/open-tabs", async (route: Route) => {
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ activeId: null, tabs: [] }) });
  });
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/pending-prompts`, async (route: Route) => {
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ asks: [], permissions: [] }) });
  });
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/prompt-draft`, async (route: Route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ text: "", images: [] }) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await page.route("**/api/limits*", async (route: Route) => {
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ limits: { sessionUsd: 0, projectDailyUsd: 0 } }) });
  });
  return { inputs };
}

const PRELUDE: SdkEvent[] = [
  { type: "ready", sessionId: FAKE_SESSION_ID },
  { type: "sdk", message: { type: "system", subtype: "init", uuid: "sys-init-300rc", model: "claude-sonnet-4-6" } },
];

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test("a recalled prompt opens no menu, and Enter sends it as written", async ({ page }) => {
  const { inputs } = await mockChatBackend(page, [
    ...PRELUDE,
    userEvent("u-1", MENTION_PROMPT),
    assistantEvent("a-1", "`lib/foo.ts` exports `loadFoo` and the `Foo` type."),
    { type: "replay_done", hasMoreAbove: false },
  ]);
  await page.goto("/");

  const composer = page.getByTestId("prompt-input");
  await expect(composer).toBeEnabled({ timeout: 15_000 });
  await expect(page.getByText("exports `loadFoo`", { exact: false }).or(page.getByText("exports loadFoo", { exact: false }))).toBeVisible();
  const pointer = page.getByTestId("picker-selected-pointer");

  // The recalled prompt carries an @-mention right before the caret's word —
  // no file menu opens over it.
  await composer.focus();
  await page.keyboard.press("ControlOrMeta+ArrowUp");
  await expect(composer).toHaveValue(MENTION_PROMPT);
  // Give the (mocked) file search a moment, so a menu that was going to open
  // has had time to.
  await page.waitForTimeout(400);
  await expect(pointer).toHaveCount(0);

  await page.waitForTimeout(100);
  await page.screenshot({ path: resolve(SHOTS_DIR, "recall-no-picker.png"), fullPage: false });

  // Enter sends the recalled text verbatim: no file swapped in, no newline.
  await page.keyboard.press("Enter");
  await expect.poll(() => inputs.length).toBeGreaterThan(0);
  expect(inputs[0]).toBe(MENTION_PROMPT);
});

test("a recalled slash command opens no menu until you edit it", async ({ page }) => {
  await mockChatBackend(page, [
    ...PRELUDE,
    userEvent("u-1", SLASH_PROMPT),
    { type: "replay_done", hasMoreAbove: false },
  ]);
  await page.goto("/");

  const composer = page.getByTestId("prompt-input");
  await expect(composer).toBeEnabled({ timeout: 15_000 });
  await composer.focus();
  await page.keyboard.press("ControlOrMeta+ArrowUp");
  await expect(composer).toHaveValue(SLASH_PROMPT);
  // A recalled bare slash command: no slash menu over it, so Enter would send
  // it as written rather than complete it to the highlighted command.
  await expect(page.getByTestId("picker-selected-pointer")).toHaveCount(0);

  await composer.press("End");
  await composer.pressSequentially("a");
  await expect(composer).toHaveValue("/compa");
  await expect(page.getByTestId("picker-selected-pointer")).toHaveCount(1);
});

test("Edit & retry on a refused prompt restores it with no menu open", async ({ page }) => {
  const { inputs } = await mockChatBackend(page, [
    ...PRELUDE,
    userEvent("u-refused", MENTION_PROMPT),
    {
      type: "sdk",
      message: {
        type: "system",
        subtype: "model_refusal_no_fallback",
        uuid: "sys-refusal-300rc",
        content: "The model declined this request.",
        api_refusal_explanation: null,
        refused_user_message_uuid: "u-refused",
      },
    },
    { type: "replay_done", hasMoreAbove: false },
  ]);
  await page.goto("/");

  const composer = page.getByTestId("prompt-input");
  await expect(composer).toBeEnabled({ timeout: 15_000 });
  await page.getByTestId("model-refusal-edit-retry").click();
  await expect(composer).toHaveValue(MENTION_PROMPT);
  await page.waitForTimeout(400);
  await expect(page.getByTestId("picker-selected-pointer")).toHaveCount(0);

  await composer.focus();
  await composer.press("End");
  await composer.press("Enter");
  await expect.poll(() => inputs.length).toBeGreaterThan(0);
  expect(inputs[0]).toBe(MENTION_PROMPT);
});
