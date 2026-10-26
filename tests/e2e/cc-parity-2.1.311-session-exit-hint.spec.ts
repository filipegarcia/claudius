/**
 * CC 2.1.311 parity — "Improved the messages shown when a background
 * session's process exits: they no longer promise a restart that isn't
 * coming, and they say how to resume the session" (paired with "Fixed a
 * background session that crashed between turns not being restarted").
 *
 * When the SDK process behind a Claudius session dies between turns, the
 * server now flags its `error` event with `sessionEnded`, and the next send
 * rebuilds the session from its transcript (`SessionManager.restartIfDead`).
 * The error banner used to show only the raw "process exited" text; it now
 * says to send a message to restart and that the conversation is kept. This
 * spec injects the flagged event, asserts the hint, then sends a message and
 * asserts the message went to the server and the banner cleared.
 *
 * Screenshot target: docs/cc-parity/2.1.311/session-exit-hint.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.311");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-00000311ex01";

type SdkEvent = Record<string, unknown>;

const BASE: SdkEvent[] = [
  { type: "ready", sessionId: FAKE_SESSION_ID },
  { type: "sdk", message: { type: "system", subtype: "init", uuid: "sys-init-311ex", model: "claude-sonnet-4-6" } },
  { type: "replay_done", hasMoreAbove: false },
  {
    type: "sdk",
    at: 1_774_000_000_000,
    message: {
      type: "user",
      uuid: "user-ex-1",
      parent_tool_use_id: null,
      isSynthetic: false,
      message: { role: "user", content: [{ type: "text", text: "Add retries to the upload client." }] },
    },
  },
  {
    type: "sdk",
    at: 1_774_000_001_000,
    message: {
      type: "assistant",
      uuid: "assistant-ex-1",
      parent_tool_use_id: null,
      message: {
        id: "msg_ex_1",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "Added exponential backoff with three retries to the upload client." }],
        usage: { input_tokens: 40, output_tokens: 20 },
      },
    },
  },
  {
    type: "sdk",
    message: {
      type: "result",
      uuid: "result-ex-1",
      subtype: "success",
      total_cost_usd: 0.01,
      num_turns: 1,
      duration_ms: 500,
      duration_api_ms: 400,
    },
  },
];

async function mockChatBackend(page: Page, extra: SdkEvent[]): Promise<{ inputs: string[] }> {
  const inputs: string[] = [];
  await page.route("**/api/sessions", async (route: Route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({ json: { id: FAKE_SESSION_ID } });
  });
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/stream*`, async (route: Route) =>
    route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
      body: [...BASE, ...extra].map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""),
    }),
  );
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/input`, (route: Route) => {
    const body = route.request().postDataJSON() as { text?: string };
    inputs.push(body.text ?? "");
    return route.fulfill({ json: { ok: true, queued: false, uuid: `u-${inputs.length}` } });
  });
  await page.route("**/api/sessions/open-tabs", (route: Route) =>
    route.fulfill({ json: { activeId: null, tabs: [] } }),
  );
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/pending-prompts`, (route: Route) =>
    route.fulfill({ json: { asks: [], permissions: [] } }),
  );
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/prompt-draft`, (route: Route) =>
    route.request().method() === "GET"
      ? route.fulfill({ json: { text: "", images: [] } })
      : route.fulfill({ json: { ok: true } }),
  );
  await page.route("**/api/limits*", (route: Route) =>
    route.fulfill({ json: { limits: { sessionUsd: 0, projectDailyUsd: 0 } } }),
  );
  return { inputs };
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test("a process exit says how to resume, and sending clears it", async ({ page }) => {
  const backend = await mockChatBackend(page, [
    { type: "error", message: "Claude Code process exited with code 1", sessionEnded: true },
  ]);
  await page.goto("/");
  await expect(page.getByText("Added exponential backoff", { exact: false })).toBeVisible({ timeout: 15_000 });

  const error = page.getByTestId("session-error");
  await expect(error).toHaveText("Claude Code process exited with code 1");
  const hint = page.getByTestId("session-ended-hint");
  await expect(hint).toHaveText(
    "The session's process exited. Send a message to restart it — the conversation so far is kept.",
  );
  // It doesn't promise an automatic restart.
  await expect(hint).not.toContainText("will restart");

  await page.waitForTimeout(150);
  await page.screenshot({ path: resolve(SHOTS_DIR, "session-exit-hint.png"), fullPage: false });

  const composer = page.getByTestId("prompt-input");
  await composer.fill("Also add a timeout.");
  await composer.press("Enter");
  await expect.poll(() => backend.inputs).toEqual(["Also add a timeout."]);
  await expect(hint).toHaveCount(0);
  await expect(error).toHaveCount(0);
});

test("an ordinary error shows no restart hint", async ({ page }) => {
  await mockChatBackend(page, [{ type: "error", message: "Failed to load session history: EACCES" }]);
  await page.goto("/");
  await expect(page.getByTestId("session-error")).toHaveText("Failed to load session history: EACCES", {
    timeout: 15_000,
  });
  await expect(page.getByTestId("session-ended-hint")).toHaveCount(0);
});
