/**
 * SDK 0.3.272 — `FileEditOutput` and `FileWriteOutput` (sdk-tools.d.ts)
 * gained `staged?: boolean`: "True when the edit/write was held for the
 * machine owner to review instead of written; the file is unchanged." Not
 * mentioned in the prose changelog — found by diffing `sdk-tools.d.ts`.
 *
 * `ToolCall.tsx` renders every tool generically: status comes from
 * `result.isError` alone, and a successful Edit/Write with a previewable
 * extension triggers the inline `FilePreview` unconditionally. Without
 * reading `staged`, a held-for-review edit would render exactly like an
 * applied one — green checkmark, inline preview attempting to load a file
 * that was never actually written.
 *
 * `staged` lives on the SDK message's `tool_use_result` field (`sdk.d.ts`'s
 * `SDKUserMessage.tool_use_result`: "Structured tool output — the tool's
 * full Output object, not the string content sent to the model") — a
 * sibling of the model-facing `tool_result.content` block, NOT inside it.
 * Real Edit/Write `tool_result.content` is plain prose ("The file ... has
 * been updated successfully."), never JSON, so `use-session.ts` reads
 * `staged` off `tool_use_result` and threads it through as its own field.
 *
 * This spec drives a `Write` tool call whose result carries
 * `tool_use_result: { staged: true, ... }` and asserts:
 *   1. The collapsed card shows an explicit "Staged" badge.
 *   2. The inline file preview (which would otherwise fire for a `.html`
 *      result) does NOT render — nothing implies the file is on disk.
 *
 * Screenshot target: docs/sdk-updates/0.3.272/staged-write-badge.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/sdk-updates/0.3.272");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-000000272s1";
const TOOL_USE_ID = "toolu_write_staged_272_1";
const REL_PATH = "staged-report.html";

type SdkEvent = Record<string, unknown>;

function sseBody(events: SdkEvent[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

async function mockChatBackend(page: Page, events: SdkEvent[]): Promise<void> {
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
      body: sseBody(events),
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
}

const PRELUDE: SdkEvent[] = [
  { type: "ready", sessionId: FAKE_SESSION_ID },
  {
    type: "sdk",
    message: {
      type: "system",
      subtype: "init",
      uuid: "sys-init-272s",
      model: "claude-sonnet-4-6",
    },
  },
  { type: "replay_done", hasMoreAbove: false },
];

const WRITE_TOOL_USE: SdkEvent = {
  type: "sdk",
  message: {
    type: "assistant",
    uuid: "a-272s",
    parent_tool_use_id: null,
    message: {
      id: "msg_272s",
      model: "claude-sonnet-4-6",
      content: [
        { type: "text", text: "Drafting the report page." },
        {
          type: "tool_use",
          id: TOOL_USE_ID,
          name: "Write",
          input: { file_path: `${process.cwd()}/${REL_PATH}`, content: "<html><body>Report</body></html>" },
        },
      ],
      usage: { input_tokens: 50, output_tokens: 25 },
    },
  },
};

/**
 * The write was held for the machine owner to review — nothing was written.
 * `content` mirrors real Claude Code output: plain prose, NEVER JSON — the
 * structured `staged` flag lives on the message's sibling `tool_use_result`
 * field (`FileWriteOutput`, sdk.d.ts's `SDKUserMessage.tool_use_result`),
 * not inside `content`. An earlier version of this fixture (and the
 * `ToolCall.tsx` code it was validating) wrongly JSON-encoded `staged` into
 * `content` — verified wrong against this run's own transcript log, which
 * shows real Write results as prose with the structured object elsewhere.
 */
const WRITE_TOOL_RESULT_STAGED: SdkEvent = {
  type: "sdk",
  at: 1_773_100_000_000,
  message: {
    type: "user",
    uuid: "tool-result-272s",
    parent_tool_use_id: null,
    isSynthetic: false,
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: TOOL_USE_ID,
          content: `The file ${process.cwd()}/${REL_PATH} has been held for review and was not written.`,
          is_error: false,
        },
      ],
    },
    tool_use_result: { staged: true, filePath: `${process.cwd()}/${REL_PATH}` },
  },
};

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test.describe("Staged file write (SDK 0.3.272 FileWriteOutput.staged)", () => {
  test("a staged Write result shows a Staged badge and no inline preview", async ({ page }) => {
    await mockChatBackend(page, [...PRELUDE, WRITE_TOOL_USE, WRITE_TOOL_RESULT_STAGED]);
    await page.goto("/");

    const toolCall = page.getByTestId("tool-call").filter({ hasText: "Write" });
    await expect(toolCall).toBeVisible({ timeout: 15_000 });

    const badge = toolCall.getByTestId("tool-call-staged-badge");
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText(/Staged/);

    // The result is a successful (non-error) Write on a previewable `.html`
    // path — without the `staged` gate, FilePreview's collapsed HTML label
    // ("render") would appear. It must not: the file was never written.
    await expect(toolCall.getByText("render", { exact: true })).toHaveCount(0);

    await toolCall.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await page.screenshot({
      path: resolve(SHOTS_DIR, "staged-write-badge.png"),
      fullPage: false,
    });
  });
});
