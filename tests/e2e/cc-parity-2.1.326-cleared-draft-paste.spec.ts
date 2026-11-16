/**
 * CC 2.1.326 — "Fixed pasted text and images being dropped when ↑ recalls a
 * draft cleared with Esc Esc".
 *
 * Double-Esc stashes the draft and a plain ↑ on the empty composer brings it
 * back (CC 2.1.288). The stash held only text + images: the paste came back as
 * typed text (no `inline_pastes` on send), and the image-ordinal counter the
 * clear zeroed wasn't raised, so the next attach reused `#1`. This spec pastes
 * a large block and an image, clears with Esc Esc, restores with ↑, attaches a
 * second image, and asserts both badges, the thumbnails, and that the paste is
 * still sent as pasted.
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-000002326c01";
const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.326");
mkdirSync(SHOTS_DIR, { recursive: true });

// 1×1 PNG so the thumbnail actually renders in the screenshot.
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

type SdkEvent = Record<string, unknown>;

async function mockChatBackend(page: Page, onInput: (body: Record<string, unknown>) => void): Promise<void> {
  await page.route("**/api/sessions", async (route: Route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: FAKE_SESSION_ID }) });
  });
  const events: SdkEvent[] = [
    { type: "ready", sessionId: FAKE_SESSION_ID },
    { type: "sdk", message: { type: "system", subtype: "init", uuid: "sys-init-0", model: "claude-opus-5-5" } },
    { type: "replay_done", hasMoreAbove: false },
  ];
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/stream*`, async (route: Route) =>
    route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
      body: events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""),
    }),
  );
  await page.route("**/api/sessions/open-tabs", async (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ activeId: null, tabs: [] }) }),
  );
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/pending-prompts`, async (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ asks: [], permissions: [] }) }),
  );
  await page.route("**/api/limits*", (route: Route) =>
    route.fulfill({ json: { limits: { sessionUsd: 0, projectDailyUsd: 0 } } }),
  );
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/input`, async (route: Route) => {
    onInput(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
}

/**
 * Fire a real `paste` event (the composer records it), then perform the
 * browser's default insertion — a synthetic ClipboardEvent doesn't insert.
 */
async function pasteTextAtEnd(page: Page, text: string): Promise<void> {
  await page.evaluate((text) => {
    const ta = document.querySelector<HTMLTextAreaElement>('[data-testid="prompt-input"]')!;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    if (ta.dispatchEvent(ev)) document.execCommand("insertText", false, text);
  }, text);
}

/** Paste a PNG file into the composer at the end of its text. */
async function pasteImageAtEnd(page: Page, name: string): Promise<void> {
  await page.evaluate(
    ({ b64, name }) => {
      const ta = document.querySelector<HTMLTextAreaElement>('[data-testid="prompt-input"]')!;
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], name, { type: "image/png" }));
      ta.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    },
    { b64: PNG_1X1, name },
  );
}

/**
 * The app-wide updater banner reflects the dev machine's real updater state
 * (not mocked here) and has nothing to do with this feature — dismiss it so
 * the screenshot shows the page chrome without unrelated noise.
 */
async function dismissUpdaterBanner(page: Page): Promise<void> {
  const dismiss = page.getByRole("button", { name: /^Dismiss (updater error|update-feed notice|for this session|for 24 hours|until a newer version is available)$/ });
  for (let i = 0; i < 3 && (await dismiss.count()) > 0; i++) {
    await dismiss.first().click().catch(() => {});
  }
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test.describe("Cleared-draft restore keeps pastes and images (CC 2.1.326)", () => {
  test("↑ after Esc Esc brings back the paste as pasted and the image without an ordinal clash", async ({ page }) => {
    let sent: Record<string, unknown> | null = null;
    await mockChatBackend(page, (body) => {
      sent = body;
    });
    await page.goto("/");

    const composer = page.getByTestId("prompt-input");
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await composer.fill("Review these logs: ");

    // >2 line breaks — a large paste the composer marks as `inline_pastes`.
    const PASTE = [
      "2026-11-16T09:00:01Z INFO  worker started",
      "2026-11-16T09:00:02Z WARN  queue depth 412",
      "2026-11-16T09:00:03Z ERROR job 7731 timed out",
      "2026-11-16T09:00:04Z INFO  retrying job 7731",
    ].join("\n");
    await pasteTextAtEnd(page, PASTE);
    await expect(composer).toHaveValue("Review these logs: " + PASTE);

    await pasteImageAtEnd(page, "screenshot.png");
    const drafted = "Review these logs: " + PASTE + "[Image #1] ";
    await expect(composer).toHaveValue(drafted);
    await expect(page.getByTitle("Remove [Image #1]")).toBeVisible();

    // Esc Esc wipes the composer (both presses well inside the 500 ms window).
    await composer.press("Escape");
    await composer.press("Escape");
    await expect(composer).toHaveValue("");
    await expect(page.getByTitle("Remove [Image #1]")).toHaveCount(0);

    // ↑ on the empty composer restores text and image.
    await composer.press("ArrowUp");
    await expect(composer).toHaveValue(drafted);
    await expect(page.getByTitle("Remove [Image #1]")).toBeVisible();
    await expect(page.getByText("1 image attached")).toBeVisible();

    // A fresh attach after the restore gets #2, not a second #1.
    await pasteImageAtEnd(page, "second.png");
    await expect(composer).toHaveValue(drafted + "[Image #2] ");
    await expect(page.getByTitle("Remove [Image #1]")).toHaveCount(1);
    await expect(page.getByTitle("Remove [Image #2]")).toHaveCount(1);
    await expect(page.getByText("2 images attached")).toBeVisible();

    await dismissUpdaterBanner(page);
    await page.screenshot({ path: resolve(SHOTS_DIR, "cleared-draft-paste.png"), fullPage: false });

    // The restored paste still goes out marked as pasted.
    await composer.press("Enter");
    await expect.poll(() => sent, { timeout: 10_000 }).not.toBeNull();
    const body = sent as unknown as { inlinePastes?: string[]; images?: unknown[] };
    expect(body.inlinePastes).toEqual([PASTE]);
    expect(body.images).toHaveLength(2);
  });
});
