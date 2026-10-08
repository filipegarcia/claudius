/**
 * Claude Code 2.1.295 parity — "[VSCode] Fixed 'Fork conversation from here'
 * and Rewind's conversation restore failing with 'Message not found in
 * session' after a background agent's activity or one of the panel's own
 * status lines".
 *
 * Claudius's analogue: a user record that leads with a CLI wrapper tag
 * (`<local-command-stdout>…`) and then real prose renders the prose as a
 * CC 2.1.285 trailing-text bubble under the display-only id `${uuid}:trailing`.
 * "Rewind here" used to POST that synthetic id as `upToMessageId`, which the
 * SDK can't find in the JSONL. Now:
 *   - the fork (and "Restore files" rewind) targets the backing record uuid
 *     (`forkableUuid`);
 *   - a failed fork surfaces the server's reason in the chat toast instead of
 *     only reaching the console.
 *
 * Mocks the chat backend with a fixed SSE fixture (same shape as the
 * 2.1.295 queue-lift spec) and intercepts POST /api/sessions/fork and
 * POST /api/sessions/<id>/rewind.
 *
 * Screenshot target: docs/cc-parity/2.1.295/fork-trailing-bubble.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SCREENSHOT_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.295");
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-00000029501f";
/** The JSONL record that carries both the wrapper tag and the trailing prose. */
const WRAPPER_UUID = "u-wrapper-29501";
const TRAILING_TEXT = "now fix the flaky retry test in auth.spec.ts";

type SdkEvent = Record<string, unknown>;

function sseBody(events: SdkEvent[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

function userEvent(uuid: string, text: string): SdkEvent {
  return {
    type: "sdk",
    message: {
      type: "user",
      uuid,
      message: { content: [{ type: "text", text }] },
    },
  };
}

function assistantEvent(uuid: string, text: string): SdkEvent {
  return {
    type: "sdk",
    message: {
      type: "assistant",
      uuid,
      parent_tool_use_id: null,
      message: {
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text }],
        usage: { input_tokens: 10, output_tokens: 10 },
      },
    },
  };
}

const EVENTS: SdkEvent[] = [
  { type: "ready", sessionId: FAKE_SESSION_ID },
  {
    type: "sdk",
    message: {
      type: "system",
      subtype: "init",
      uuid: "sys-init-0",
      model: "claude-sonnet-4-6",
    },
  },
  userEvent("u-plain-29501", "run the linter on the auth module"),
  assistantEvent("a-29501-1", "Lint is clean — 0 problems in `lib/auth/`."),
  userEvent(
    WRAPPER_UUID,
    `<local-command-stdout>Ran /lint: 0 problems</local-command-stdout>\n\n${TRAILING_TEXT}`,
  ),
  assistantEvent("a-29501-2", "Looking at `auth.spec.ts` — the retry test races the token refresh."),
  { type: "replay_done", hasMoreAbove: false },
];

async function mockChatBackend(
  page: Page,
  fork: { status: number; body: Record<string, unknown> },
): Promise<{ forkBodies: Array<Record<string, unknown>> }> {
  const forkBodies: Array<Record<string, unknown>> = [];

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
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
      body: sseBody(EVENTS),
    });
  });

  await page.route("**/api/sessions/fork", async (route: Route) => {
    if (route.request().method() !== "POST") return route.fallback();
    forkBodies.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({
      status: fork.status,
      contentType: "application/json",
      body: JSON.stringify(fork.body),
    });
  });

  await page.route("**/api/sessions/open-tabs", async (route: Route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ activeId: null, tabs: [] }),
    });
  });

  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/pending-prompts`, async (route: Route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ asks: [], permissions: [] }),
    });
  });

  await page.route("**/api/limits*", async (route: Route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ limits: { sessionUsd: 0, projectDailyUsd: 0 } }),
    });
  });

  return { forkBodies };
}

/** Hover the trailing-text bubble and click its "Rewind here". */
async function rewindTrailingBubble(page: Page) {
  const bubble = page.locator(`[data-message-uuid="${WRAPPER_UUID}:trailing"]`);
  await expect(bubble).toBeVisible({ timeout: 15_000 });
  await expect(bubble).toContainText(TRAILING_TEXT);
  await bubble.hover();
  const rewind = bubble.getByTestId("user-message-rewind");
  await expect(rewind).toBeVisible();
  await rewind.click();
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test.describe("Fork from a trailing-text bubble (CC 2.1.295)", () => {
  test("Rewind here forks at the backing JSONL record, not the :trailing display id", async ({ page }) => {
    // 200 without a sessionId → no navigation, so the page stays put.
    const { forkBodies } = await mockChatBackend(page, { status: 200, body: {} });
    await page.goto("/");

    await rewindTrailingBubble(page);

    await expect.poll(() => forkBodies.length).toBe(1);
    expect(forkBodies[0].sessionId).toBe(FAKE_SESSION_ID);
    expect(forkBodies[0].upToMessageId).toBe(WRAPPER_UUID);
    await expect(page.getByTestId("chat-toast")).toHaveCount(0);
  });

  test("Restore files rewinds at the backing JSONL record, not the :trailing display id", async ({ page }) => {
    await mockChatBackend(page, { status: 200, body: {} });
    const rewindBodies: Array<Record<string, unknown>> = [];
    await page.route(`**/api/sessions/${FAKE_SESSION_ID}/rewind`, async (route: Route) => {
      if (route.request().method() !== "POST") return route.fallback();
      rewindBodies.push(route.request().postDataJSON() as Record<string, unknown>);
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ result: { canRewind: false, error: "No file checkpoint at this message." } }),
      });
    });
    await page.goto("/");

    const bubble = page.locator(`[data-message-uuid="${WRAPPER_UUID}:trailing"]`);
    await expect(bubble).toBeVisible({ timeout: 15_000 });
    await bubble.hover();
    const restore = bubble.getByTestId("restore-files-button");
    await expect(restore).toBeVisible();
    await restore.click();

    await expect.poll(() => rewindBodies.length).toBe(1);
    expect(rewindBodies[0].userMessageId).toBe(WRAPPER_UUID);
    expect(rewindBodies[0].dryRun).toBe(true);
  });

  test("a failed fork surfaces the server's reason in the chat toast", async ({ page }) => {
    const { forkBodies } = await mockChatBackend(page, {
      status: 500,
      body: { error: "Message not found in session" },
    });
    await page.goto("/");

    await rewindTrailingBubble(page);

    const toast = page.getByTestId("chat-toast");
    await expect(toast).toBeVisible();
    await expect(toast).toHaveText("Couldn't fork from here: Message not found in session");
    expect(forkBodies[0]?.upToMessageId).toBe(WRAPPER_UUID);

    await page.screenshot({
      path: resolve(SCREENSHOT_DIR, "fork-trailing-bubble.png"),
      fullPage: false,
    });
  });
});
