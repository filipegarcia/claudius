/**
 * CC 2.1.327 parity — "Fixed Esc being ignored on a permission prompt that
 * had just appeared."
 *
 * The 2.1.318 arm window (`lib/client/prompt-arm.ts`) dropped every Escape in
 * the first 400ms after a permission prompt mounted. Answering a queued
 * prompt mounts the next one at once, so "Esc, Esc" through two queued
 * prompts denied only the first; a quick deliberate Esc on a single fresh
 * prompt was ignored too. Now the grace only holds back an Escape when the
 * user was typing in a text field as the prompt appeared (unit-tested in
 * tests/unit/cc-parity-2.1.327-prompt-esc.test.ts).
 *
 * No screenshot: nothing visible changed.
 */

import { test, expect, type Page, type Route } from "../helpers/test";

const FAKE_SESSION_ID = "00000000-1111-2222-3333-promptesc327";

type SdkEvent = Record<string, unknown>;

function sseBody(events: SdkEvent[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

const PRELUDE: SdkEvent[] = [
  { type: "ready", sessionId: FAKE_SESSION_ID },
  {
    type: "sdk",
    message: { type: "system", subtype: "init", uuid: "sys-327", model: "claude-sonnet-5-5" },
  },
  { type: "replay_done", hasMoreAbove: false },
];

function permission(requestId: string, command: string): SdkEvent {
  return {
    type: "permission_request",
    requestId,
    toolName: "Bash",
    toolUseId: `tu-${requestId}`,
    input: { command },
    title: `Run \`${command}\``,
  };
}

// Live-only: the real server re-emits still-pending prompts on reconnect
// rather than replaying these, and `route.fulfill` ends the stream.
const EPHEMERAL = new Set(["permission_request", "prompt_settled"]);

type Posted = { requestId: string; decision: { kind: string } };

async function mockChatBackend(page: Page, events: SdkEvent[]): Promise<Posted[]> {
  const posted: Posted[] = [];
  await page.route("**/api/sessions", async (route: Route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: FAKE_SESSION_ID }) });
  });

  let connections = 0;
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/stream*`, async (route: Route) => {
    connections += 1;
    const body = connections > 1 ? events.filter((e) => !EPHEMERAL.has(String(e.type))) : events;
    return route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
      body: sseBody(body),
    });
  });

  await page.route("**/api/sessions/open-tabs", async (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ activeId: null, tabs: [] }) }),
  );
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/pending-prompts`, async (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ asks: [], permissions: [], elicitations: [] }),
    }),
  );
  await page.route("**/api/limits*", async (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ limits: { sessionUsd: 0, projectDailyUsd: 0 } }) }),
  );
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/permission`, async (route: Route) => {
    if (route.request().method() !== "POST") return route.fallback();
    posted.push(route.request().postDataJSON() as Posted);
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  return posted;
}

test.describe("Esc on a just-shown permission prompt (CC 2.1.327)", () => {
  test("two queued prompts, Esc twice quickly: both are denied", async ({ page }) => {
    const posted = await mockChatBackend(page, [
      ...PRELUDE,
      permission("req-first", "ls -la"),
      permission("req-second", "git status"),
    ]);
    await page.goto("/");

    const modal = page.locator("[data-permission-modal]");
    await expect(modal).toBeVisible({ timeout: 15_000 });
    await expect(modal).toContainText("ls -la");
    await expect(page.getByTestId("permission-queue-count")).toHaveText("1 of 2");

    // Answer the first with Esc; the queued second mounts at once. The next
    // Esc lands well inside its 400ms arm window and must still deny it.
    await page.keyboard.press("Escape");
    await expect(modal).toContainText("git status");
    await page.keyboard.press("Escape");
    await expect(modal).toHaveCount(0);

    await expect.poll(() => posted.length).toBe(2);
    expect(posted.map((p) => [p.requestId, p.decision.kind])).toEqual([
      ["req-first", "deny"],
      ["req-second", "deny"],
    ]);
  });
});
