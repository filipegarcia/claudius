/**
 * SDK 0.3.216 — `rewindFiles()` responses now carry an optional
 * `skippedLinks` count: tracked files the rewind safety guards refused to
 * restore or delete (a symlink/hard-link/other non-regular file at the
 * tracked path, a parent directory that no longer resolves where it did at
 * checkpoint time, or a backup that couldn't be safely read). Only ever
 * populated on a real (non-dryRun) rewind.
 *
 * Before this, a rewind that silently skipped files looked identical to one
 * that fully succeeded — the user had no signal that some tracked files were
 * left untouched. This spec drives the existing "Restore files" affordance
 * (`RewindFilesButton.tsx`, on every user message once a session is active)
 * through its real preview → confirm flow, with the mocked
 * `/api/sessions/[id]/rewind` POST reporting `skippedLinks: 2` on the real
 * (non-dryRun) call, and asserts the post-restore dialog renders a warning.
 *
 * Screenshot target: docs/sdk-updates/0.3.216/rewind-skipped-links.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SCREENSHOT_DIR = resolve(process.cwd(), "docs/sdk-updates/0.3.216");
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-000000216a1";

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

  // The SDK 0.3.216 surface under test: the dry-run preview reports the
  // blast radius without `skippedLinks` (the field is never set on a
  // dryRun response, per the SDK's own doc comment on RewindFilesResult),
  // and the real rewind reports 2 files the safety guard refused to touch.
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/rewind`, async (route: Route) => {
    const body = route.request().postDataJSON() as { dryRun?: boolean };
    const result = body.dryRun
      ? { canRewind: true, filesChanged: ["src/a.ts", "src/b.ts"], insertions: 12, deletions: 4 }
      : {
          canRewind: true,
          filesChanged: ["src/a.ts", "src/b.ts"],
          insertions: 12,
          deletions: 4,
          skippedLinks: 2,
        };
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ result }),
    });
  });
}

/** Minimal SSE prelude emitted before any real assistant content. */
const PRELUDE: SdkEvent[] = [
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
  { type: "replay_done", hasMoreAbove: false },
];

const USER_MESSAGE: SdkEvent = {
  type: "sdk",
  at: 1_774_000_000_000,
  message: {
    type: "user",
    uuid: "user-msg-1",
    parent_tool_use_id: null,
    isSynthetic: false,
    message: {
      role: "user",
      content: [{ type: "text", text: "Refactor the pricing module and add tests." }],
    },
  },
};

const ASSISTANT_REPLY: SdkEvent = {
  type: "sdk",
  at: 1_774_000_001_000,
  message: {
    type: "assistant",
    uuid: "a1",
    parent_tool_use_id: null,
    message: {
      id: "msg_1",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "Done — refactored the pricing module and added coverage." }],
      usage: { input_tokens: 50, output_tokens: 15 },
    },
  },
};

// A second, later user turn. MessageList pins the *last* user message to the
// top of the viewport with a `sticky` + `backdrop-blur` wrapper
// (`isPinnedUser` in MessageList.tsx) — and `backdrop-filter` establishes a
// containing block for `position: fixed` descendants, which would reposition
// RewindFilesButton's full-viewport confirm dialog inside that small pinned
// bar instead of centering it over the page. That's a pre-existing quirk of
// the dialog (not introduced by this change) that only bites the *pinned*
// message; the spec targets the earlier, unpinned "user-msg-1" bubble so the
// screenshot shows the dialog the way it renders for every other message.
const USER_MESSAGE_2: SdkEvent = {
  type: "sdk",
  at: 1_774_000_002_000,
  message: {
    type: "user",
    uuid: "user-msg-2",
    parent_tool_use_id: null,
    isSynthetic: false,
    message: {
      role: "user",
      content: [{ type: "text", text: "Also add a changelog entry." }],
    },
  },
};

const RESULT: SdkEvent = {
  type: "sdk",
  message: {
    type: "result",
    uuid: "result-1",
    subtype: "success",
    total_cost_usd: 0.02,
    num_turns: 2,
    duration_ms: 800,
    duration_api_ms: 650,
  },
};

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test.describe("rewindFiles skippedLinks warning (SDK 0.3.216)", () => {
  test("a real rewind that skips files shows a warning in the confirmation dialog", async ({
    page,
  }) => {
    await mockChatBackend(page, [
      ...PRELUDE,
      USER_MESSAGE,
      ASSISTANT_REPLY,
      USER_MESSAGE_2,
      RESULT,
    ]);
    await page.goto("/");

    await expect(page.getByText("Refactor the pricing module", { exact: false })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText("added coverage.", { exact: false })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText("Also add a changelog entry.", { exact: false })).toBeVisible({
      timeout: 15_000,
    });

    // The "Restore files" affordance is revealed on hover (group-hover
    // opacity toggle) — hover the bubble first so this exercises the real
    // interaction, not just a forced click on a hidden element. Target the
    // earlier ("user-msg-1") bubble, not the pinned last user message — see
    // the comment on USER_MESSAGE_2 above.
    const bubble = page.locator('[data-message-uuid="user-msg-1"]');
    await bubble.hover();
    const restoreButton = bubble.getByTestId("restore-files-button");
    await expect(restoreButton).toBeVisible();
    await restoreButton.click();

    // Dry-run preview first — no skippedLinks field on this leg.
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Restore files to this message?")).toBeVisible();
    await expect(page.getByTestId("rewind-skipped-links-warning")).not.toBeVisible();

    await dialog.getByRole("button", { name: "Restore files" }).click();

    // Real rewind — the mock reports skippedLinks: 2.
    await expect(dialog.getByText("Files restored")).toBeVisible({ timeout: 10_000 });
    const warning = page.getByTestId("rewind-skipped-links-warning");
    await expect(warning).toBeVisible();
    await expect(warning).toContainText("Skipped 2 files");
    await expect(warning).toContainText("safety guard refused to restore");

    await warning.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);

    await page.screenshot({
      path: resolve(SCREENSHOT_DIR, "rewind-skipped-links.png"),
      fullPage: false,
    });
  });
});
