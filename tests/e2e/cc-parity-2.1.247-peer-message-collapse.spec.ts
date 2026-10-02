import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

/**
 * Claude Code 2.1.247 — "Changed cross-session peer messages to collapse by
 * default to a one-line `Message from @<sender>: <first line>` preview;
 * Ctrl+O expands the full body."
 *
 * Claudius has no per-message keybinding surface analogous to the CLI's
 * Ctrl+O (its keybindings apply session-wide, not to one historic transcript
 * row — see `lib/server/keybindings.ts`), so the reimplementation uses a
 * click-to-expand row instead, matching the existing `BashIOBlock`
 * collapse/expand convention already used for `!`-mode shell echoes in the
 * same file (`UserMessage.tsx`).
 *
 * Screenshot target: docs/cc-parity/2.1.247/peer-message-collapsed.png
 */

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.247");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-0000002147a1";

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
      uuid: "sys-init-2147",
      model: "claude-sonnet-4-6",
    },
  },
  { type: "replay_done", hasMoreAbove: false },
];

const PEER_MESSAGE: SdkEvent = {
  type: "sdk",
  at: 1_772_000_000_000,
  message: {
    type: "user",
    uuid: "peer-msg-2147",
    parent_tool_use_id: null,
    isSynthetic: false,
    message: {
      role: "user",
      content: [
        {
          type: "text",
          text: "[[peer-envelope from=session-release-bot]] Deploy finished successfully.\nAll 412 checks passed.",
        },
      ],
    },
    origin: {
      kind: "peer",
      from: "session-release-bot",
      name: "Release Bot",
      body: "Deploy finished successfully.\nAll 412 checks passed.",
    },
  },
};

const ASSISTANT_REPLY: SdkEvent = {
  type: "sdk",
  at: 1_772_000_001_000,
  message: {
    type: "assistant",
    uuid: "a-2147",
    parent_tool_use_id: null,
    message: {
      id: "msg_2147",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "Nice — thanks for the update." }],
      usage: { input_tokens: 40, output_tokens: 10 },
    },
  },
};

const RESULT: SdkEvent = {
  type: "sdk",
  message: {
    type: "result",
    uuid: "result-2147",
    subtype: "success",
    total_cost_usd: 0.01,
    num_turns: 1,
    duration_ms: 400,
    duration_api_ms: 300,
  },
};

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test.describe("Claude Code 2.1.247 — peer message collapse", () => {
  test("collapses to a one-line preview by default and expands on click", async ({ page }) => {
    await mockChatBackend(page, [...PRELUDE, PEER_MESSAGE, ASSISTANT_REPLY, RESULT]);
    await page.goto("/");

    await expect(
      page.getByText("Nice — thanks for the update.", { exact: false }),
    ).toBeVisible({ timeout: 15_000 });

    const row = page.getByTestId("user-message-peer-badge");
    await expect(row).toBeVisible();
    await expect(row).toContainText("Message from Release Bot: Deploy finished successfully.");

    // The full body (second line) is hidden while collapsed.
    await expect(page.getByText("All 412 checks passed.")).not.toBeVisible();

    await row.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await page.screenshot({
      path: resolve(SHOTS_DIR, "peer-message-collapsed.png"),
      fullPage: false,
    });

    await row.click();
    await expect(page.getByText("All 412 checks passed.")).toBeVisible();

    await row.click();
    await expect(page.getByText("All 412 checks passed.")).not.toBeVisible();
  });

  test("hover explains the peer message; ↗ opens the sender session", async ({ page }, testInfo) => {
    const SENDER_ID = "d7cd522c-97aa-4af7-8e30-8cecd23aa78e";
    const QUEUED_PEER: SdkEvent = {
      ...PEER_MESSAGE,
      message: {
        ...(PEER_MESSAGE.message as Record<string, unknown>),
        // Queued (mid-turn) delivery shape: no verifiedPeerPid / msg_id —
        // the sender is found by its socket address and body instead.
        origin: {
          kind: "peer",
          from: "uds:/tmp/cc-socks/99549.sock",
          name: "afrexim-99",
          fromMode: "bypass",
          body: "Deploy finished successfully.\nAll 412 checks passed.",
        },
      },
    };
    await mockChatBackend(page, [...PRELUDE, QUEUED_PEER, ASSISTANT_REPLY, RESULT]);
    const lookups: URL[] = [];
    await page.route("**/api/sessions/peer-source*", async (route: Route) => {
      lookups.push(new URL(route.request().url()));
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          source: {
            sessionId: SENDER_ID,
            cwd: "/work/afrexim",
            name: "afrexim-99",
            // Running in another process → the link must open the read-only
            // transcript rather than resume a second writer in chat.
            live: true,
            hostedHere: false,
            workspaceId: null,
          },
        }),
      });
    });
    await page.goto("/");

    const row = page.getByTestId("user-message-peer-badge");
    await expect(row).toContainText("Message from afrexim-99: Deploy finished successfully.");

    const tooltip = page.getByTestId("user-message-peer-tooltip");
    await expect(tooltip).toHaveCount(0);
    // Side panels are still mounting at this point, which can slide the chat
    // column out from under Playwright's stationary pointer — Chrome then
    // fires mouseleave and the tip (correctly) closes. Re-hover until it's up.
    await expect(async () => {
      await row.hover();
      await expect(tooltip).toBeVisible({ timeout: 1_500 });
      await expect(tooltip).toContainText("Message from another session");
      await expect(tooltip).toContainText("afrexim-99");
      await expect(tooltip).toContainText("Running in another process");
    }).toPass({ timeout: 15_000 });
    await page.screenshot({ path: testInfo.outputPath("peer-message-tooltip.png") });

    expect(lookups).toHaveLength(1);
    expect(lookups[0].searchParams.get("from")).toBe("uds:/tmp/cc-socks/99549.sock");
    expect(lookups[0].searchParams.get("snippet")).toBe(
      "Deploy finished successfully.\nAll 412 checks passed.",
    );

    await page.getByTestId("user-message-peer-open").click();
    await expect(page).toHaveURL(
      new RegExp(`/wks_[a-f0-9]{12}/sessions/${SENDER_ID}\\?dir=%2Fwork%2Fafrexim$`),
    );
  });
});
