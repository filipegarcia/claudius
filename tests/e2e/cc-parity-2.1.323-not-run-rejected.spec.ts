/**
 * Claude Code 2.1.323 parity — "Fixed a collapsed tool call looking as if it
 * ran after you rejected it with a reason: it now shows 'Not run · rejected'".
 *
 * A call denied from Claudius's permission card ("Deny…" with a reason) used
 * to render as a failed run: red icon, an "error" header, and the reason in
 * red as if it were tool output. The engine stamps a host canUseTool deny
 * `permission-rule`, so Claudius's server re-stamps the calls the user denied
 * `user-rejected` (unit-tested in cc-parity-2.1.323-user-rejected.test.ts).
 * This spec streams results as the server broadcasts them: one the user
 * rejected and one a settings deny rule refused. Only the first is dimmed to
 * "Not run · rejected"; the rule denial keeps its red error.
 *
 * Screenshot target: docs/cc-parity/2.1.323/not-run-rejected.png
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.323");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-00000323rej1";
const REJECTED_ID = "toolu_323_rejected";
const RULE_ID = "toolu_323_rule";

type SdkEvent = Record<string, unknown>;
const sseBody = (events: SdkEvent[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");

async function mockChatBackend(page: Page, events: SdkEvent[]): Promise<void> {
  await page.route("**/api/sessions", async (route: Route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: FAKE_SESSION_ID }) });
  });
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/stream*`, async (route: Route) =>
    route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
      body: sseBody(events),
    }),
  );
  await page.route("**/api/sessions/open-tabs", async (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ activeId: null, tabs: [] }) }),
  );
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/pending-prompts`, async (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ asks: [], permissions: [] }) }),
  );
  await page.route("**/api/limits*", async (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ limits: { sessionUsd: 0, projectDailyUsd: 0 } }) }),
  );
}

const PRELUDE: SdkEvent[] = [
  { type: "ready", sessionId: FAKE_SESSION_ID },
  { type: "sdk", message: { type: "system", subtype: "init", uuid: "sys-init-323rej", model: "claude-sonnet-5-5" } },
  { type: "replay_done", hasMoreAbove: false },
];

const TOOL_USES: SdkEvent = {
  type: "sdk",
  message: {
    type: "assistant",
    uuid: "a-323rej",
    parent_tool_use_id: null,
    message: {
      id: "msg_323rej",
      model: "claude-sonnet-5-5",
      content: [
        { type: "text", text: "I'll reset the migration state, then push the branch." },
        { type: "tool_use", id: REJECTED_ID, name: "Bash", input: { command: "bun run db:reset", description: "Reset the dev database" } },
        { type: "tool_use", id: RULE_ID, name: "Bash", input: { command: "git push --force", description: "Push the branch" } },
      ],
      usage: { input_tokens: 50, output_tokens: 25 },
    },
  },
};

function toolResult(id: string, text: string, kind: string, uuid: string): SdkEvent {
  return {
    type: "sdk",
    message: {
      type: "user",
      uuid,
      parent_tool_use_id: null,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text, is_error: true }] },
      tool_result_meta: [{ id, non_execution_kind: kind }],
    },
  };
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test("a call the user rejected reads 'Not run · rejected', not as a failed run", async ({ page }) => {
  await mockChatBackend(page, [
    ...PRELUDE,
    TOOL_USES,
    toolResult(REJECTED_ID, "Not on my database — use the test fixtures instead.", "user-rejected", "tr-323rej-1"),
    toolResult(RULE_ID, "Permission to use Bash with command git push --force has been denied.", "permission-rule", "tr-323rej-2"),
  ]);
  await page.goto("/");

  const rows = page.getByTestId("tool-call");
  await expect(rows).toHaveCount(2, { timeout: 15_000 });
  const rejected = rows.nth(0);
  const ruleDenied = rows.nth(1);

  const badge = rejected.getByTestId("tool-call-not-run");
  await expect(badge).toHaveText("Not run · rejected");
  await expect(badge).toHaveAttribute("data-not-run-reason", "rejected");
  await expect(badge).toHaveAttribute("title", "Not run — you rejected this tool call");
  await expect(rejected).toHaveAttribute("data-not-run", "1");
  await expect(rejected.locator("svg.text-red-500")).toHaveCount(0);

  // A settings deny rule is not the user's rejection: still a red error.
  await expect(ruleDenied.getByTestId("tool-call-not-run")).toHaveCount(0);
  await expect(ruleDenied.locator("svg.text-red-500")).toHaveCount(1);

  // The Activity rail matches.
  const rail = page.locator('li[data-not-run="1"]');
  await expect(rail).toHaveCount(1);
  await expect(rail).toHaveAttribute("title", /^Not run · rejected · /);

  // Expanded: the reason is shown under a "rejected" header, muted.
  await rejected.getByRole("button").first().click();
  await expect(rejected.getByText("rejected", { exact: true })).toBeVisible();
  await expect(rejected.getByText("Not on my database — use the test fixtures instead.")).toBeVisible();
  await expect(rejected.getByText("error", { exact: true })).toHaveCount(0);

  await rejected.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await page.screenshot({ path: resolve(SHOTS_DIR, "not-run-rejected.png"), fullPage: false });
});
