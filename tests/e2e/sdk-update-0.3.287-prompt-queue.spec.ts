import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";

/**
 * SDK 0.3.287 / Claude Code 2.1.286–2.1.287 follow-ups, driven by synthetic
 * SSE events (no real SDK):
 *
 *  1. Permission queue — several prompts can be pending at once (parallel
 *     subagents each ask). The client used to keep ONE slot, so a second
 *     request overwrote the first. Now the oldest shows first with a
 *     "1 of N" count, answering one brings up the next, and `prompt_settled`
 *     drops a prompt answered elsewhere.
 *  2. MCP elicitation — `onElicitation` requests (URL sign-in / form input)
 *     render a modal instead of being auto-declined by the SDK.
 *  3. A WebFetch that stepped aside for a "send now" message
 *     (`tool_use_result.detachedToolCall`) shows "Continuing in background".
 *
 * Screenshots: docs/sdk-updates/0.3.287/
 */

const SHOTS_DIR = resolve(process.cwd(), "docs/sdk-updates/0.3.287");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "00000000-1111-2222-3333-queue0000287";

type SdkEvent = Record<string, unknown>;

function sseBody(events: SdkEvent[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

const PRELUDE: SdkEvent[] = [
  { type: "ready", sessionId: FAKE_SESSION_ID },
  {
    type: "sdk",
    message: { type: "system", subtype: "init", uuid: "sys-287", model: "claude-sonnet-5-5" },
  },
  { type: "replay_done", hasMoreAbove: false },
];

function permission(requestId: string, command: string, agentId?: string): SdkEvent {
  return {
    type: "permission_request",
    requestId,
    toolName: "Bash",
    toolUseId: `tu-${requestId}`,
    input: { command },
    title: `Run \`${command}\``,
    ...(agentId ? { agentId } : {}),
  };
}

// Live-only events: the real server never replays these on reconnect (it
// re-emits still-pending prompts instead). `route.fulfill` ends the stream,
// so EventSource reconnects — serve these on the first connection only.
const EPHEMERAL = new Set(["permission_request", "mcp_elicitation_request", "prompt_settled"]);

type Posted = { url: string; body: unknown };

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
  for (const path of ["permission", "elicitation"]) {
    await page.route(`**/api/sessions/${FAKE_SESSION_ID}/${path}`, async (route: Route) => {
      if (route.request().method() !== "POST") return route.fallback();
      posted.push({ url: route.request().url(), body: route.request().postDataJSON() });
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    });
  }
  return posted;
}

test.describe("Permission queue (CC 2.1.286 '1 of N')", () => {
  test("stacked requests show oldest first with a count; answering advances the queue", async ({ page }) => {
    const posted = await mockChatBackend(page, [
      ...PRELUDE,
      permission("req-a", "ls -la", "agent-one"),
      permission("req-b", "git status", "agent-two"),
      permission("req-c", "npm test"),
    ]);
    await page.goto("/");

    const modal = page.locator("[data-permission-modal]");
    await expect(modal).toBeVisible({ timeout: 15_000 });
    await expect(modal).toContainText("ls -la");
    await expect(page.getByTestId("permission-queue-count")).toHaveText("1 of 3");

    await page.waitForTimeout(200);
    await page.screenshot({ path: resolve(SHOTS_DIR, "permission-queue-count.png"), fullPage: false });

    await page.getByRole("button", { name: "Allow once" }).click();
    await expect(modal).toContainText("git status");
    await expect(page.getByTestId("permission-queue-count")).toHaveText("1 of 2");

    await page.getByRole("button", { name: "Allow once" }).click();
    await expect(modal).toContainText("npm test");
    await expect(page.getByTestId("permission-queue-count")).toHaveCount(0);

    await page.getByRole("button", { name: "Allow once" }).click();
    await expect(modal).toHaveCount(0);

    // Each answer went to its own request, oldest first.
    expect(posted.map((p) => (p.body as { requestId: string }).requestId)).toEqual(["req-a", "req-b", "req-c"]);
  });

  test("a prompt settled elsewhere is dropped from the queue", async ({ page }) => {
    await mockChatBackend(page, [
      ...PRELUDE,
      permission("req-x", "rm -rf build"),
      permission("req-y", "make release"),
      { type: "prompt_settled", kind: "permission", requestId: "req-x" },
    ]);
    await page.goto("/");

    const modal = page.locator("[data-permission-modal]");
    await expect(modal).toBeVisible({ timeout: 15_000 });
    await expect(modal).toContainText("make release");
    await expect(modal).not.toContainText("rm -rf build");
    await expect(page.getByTestId("permission-queue-count")).toHaveCount(0);
  });
});

test.describe("MCP elicitation (SDK onElicitation)", () => {
  test("URL sign-in prompt shows the destination and opens it on accept", async ({ page }) => {
    const posted = await mockChatBackend(page, [
      ...PRELUDE,
      {
        type: "mcp_elicitation_request",
        requestId: "eli-url",
        serverName: "linear",
        message: "Sign in to Linear to let Claude read your issues.",
        mode: "url",
        url: "https://linear.app/oauth/authorize?client_id=abc",
        elicitationId: "e-1",
      },
    ]);
    await page.goto("/");

    const modal = page.getByTestId("mcp-elicitation-modal");
    await expect(modal).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("mcp-elicitation-server")).toHaveText("linear");
    await expect(page.getByTestId("mcp-elicitation-host")).toHaveText("linear.app");
    await expect(page.getByTestId("mcp-elicitation-message")).toContainText("Sign in to Linear");

    await page.waitForTimeout(200);
    await page.screenshot({ path: resolve(SHOTS_DIR, "mcp-elicitation-url.png"), fullPage: false });

    const popup = page.waitForEvent("popup");
    await page.getByTestId("mcp-elicitation-open").click();
    expect((await popup).url()).toContain("linear.app/oauth/authorize");
    await expect(modal).toHaveCount(0);
    expect(posted.map((p) => p.body)).toEqual([{ requestId: "eli-url", decision: { action: "accept" } }]);
  });

  // CC 2.1.288 — a URL elicitation with NO elicitationId can't be reported
  // complete by the server, so opening the link must NOT accept immediately;
  // the prompt waits for the user's "I'm done, continue".
  test("URL prompt with no elicitationId waits for 'I'm done, continue'", async ({ page }) => {
    const posted = await mockChatBackend(page, [
      ...PRELUDE,
      {
        type: "mcp_elicitation_request",
        requestId: "eli-nocomplete",
        serverName: "linear",
        message: "Finish signing in, then come back.",
        mode: "url",
        url: "https://linear.app/oauth/authorize?client_id=abc",
        // no elicitationId
      },
    ]);
    await page.goto("/");

    const modal = page.getByTestId("mcp-elicitation-modal");
    await expect(modal).toBeVisible({ timeout: 15_000 });

    const popup = page.waitForEvent("popup");
    await page.getByTestId("mcp-elicitation-open").click();
    await popup;
    // Opening the link must NOT have resolved the prompt yet.
    expect(posted.map((p) => p.body)).toEqual([]);
    await expect(modal).toBeVisible();

    // The "I'm done, continue" button is now shown; clicking it accepts.
    await page.getByTestId("mcp-elicitation-done").click();
    await expect(modal).toHaveCount(0);
    expect(posted.map((p) => p.body)).toEqual([
      { requestId: "eli-nocomplete", decision: { action: "accept" } },
    ]);
  });

  test("a non-http URL can't be opened — only declined", async ({ page }) => {
    const posted = await mockChatBackend(page, [
      ...PRELUDE,
      {
        type: "mcp_elicitation_request",
        requestId: "eli-bad",
        serverName: "sketchy",
        message: "Click to continue",
        mode: "url",
        url: "javascript:alert(document.cookie)",
      },
    ]);
    await page.goto("/");

    await expect(page.getByTestId("mcp-elicitation-modal")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("mcp-elicitation-unsafe-url")).toBeVisible();
    await expect(page.getByTestId("mcp-elicitation-open")).toBeDisabled();
    await page.getByTestId("mcp-elicitation-decline").click();
    expect(posted.map((p) => p.body)).toEqual([{ requestId: "eli-bad", decision: { action: "decline" } }]);
  });

  test("form prompt validates and sends typed content", async ({ page }) => {
    const posted = await mockChatBackend(page, [
      ...PRELUDE,
      {
        type: "mcp_elicitation_request",
        requestId: "eli-form",
        serverName: "deploy",
        message: "Which environment should I deploy to?",
        mode: "form",
        requestedSchema: {
          type: "object",
          properties: {
            env: { type: "string", title: "Environment", enum: ["staging", "production"] },
            replicas: { type: "integer", title: "Replicas", minimum: 1, maximum: 10 },
          },
          required: ["env"],
        },
      },
    ]);
    await page.goto("/");

    const modal = page.getByTestId("mcp-elicitation-modal");
    await expect(modal).toBeVisible({ timeout: 15_000 });

    // Required field missing → error, nothing sent.
    await page.getByTestId("mcp-elicitation-submit").click();
    await expect(page.getByTestId("mcp-elicitation-error-env")).toBeVisible();
    expect(posted).toHaveLength(0);

    await modal.getByLabel("Environment").selectOption("staging");
    await page.getByTestId("mcp-elicitation-field-replicas").fill("3");
    await page.waitForTimeout(200);
    await page.screenshot({ path: resolve(SHOTS_DIR, "mcp-elicitation-form.png"), fullPage: false });

    await page.getByTestId("mcp-elicitation-submit").click();
    await expect(modal).toHaveCount(0);
    expect(posted.map((p) => p.body)).toEqual([
      { requestId: "eli-form", decision: { action: "accept", content: { env: "staging", replicas: 3 } } },
    ]);
  });
});

test.describe("Detached WebFetch (SDK 0.3.287 detachedToolCall)", () => {
  test("a fetch moved to the background shows 'Continuing in background'", async ({ page }) => {
    await mockChatBackend(page, [
      ...PRELUDE,
      {
        type: "sdk",
        message: {
          type: "assistant",
          uuid: "a-287",
          parent_tool_use_id: null,
          message: {
            id: "msg_287",
            model: "claude-sonnet-5-5",
            content: [
              { type: "text", text: "Fetching the changelog." },
              { type: "tool_use", id: "toolu_fetch_287", name: "WebFetch", input: { url: "https://example.com/changelog" } },
            ],
            usage: { input_tokens: 10, output_tokens: 5 },
          },
        },
      },
      {
        type: "sdk",
        message: {
          type: "user",
          uuid: "tr-287",
          parent_tool_use_id: null,
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_fetch_287",
                content: "This fetch is continuing in the background; its result will follow.",
              },
            ],
          },
          tool_use_result: { detachedToolCall: true },
        },
      },
    ]);
    await page.goto("/");

    const toolCall = page.getByTestId("tool-call").filter({ hasText: "WebFetch" });
    await expect(toolCall).toBeVisible({ timeout: 15_000 });
    await expect(toolCall.getByTestId("tool-call-detached-badge")).toHaveText(/Continuing in background/);
  });
});
