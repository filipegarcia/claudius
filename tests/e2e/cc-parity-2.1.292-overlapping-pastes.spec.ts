/**
 * CC 2.1.292 — "Fixed some pasted text reaching Claude as typed text when
 * several pastes overlapped in one prompt".
 *
 * Large pastes go out as the SDK's `inline_pastes` so the model can tell
 * pasted spans from typed text (CC 2.1.280). The composer matched each paste
 * as a contiguous string, so a second paste dropped into the middle of the
 * first split it, and the first paste's halves were sent as typed text. This
 * spec pastes B inside A and asserts the whole A1+B+A2 block is marked.
 */

import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-000002292f02";

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
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/input`, async (route: Route) => {
    onInput(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
}

/**
 * Fire a real `paste` event (the composer records it), then perform the
 * browser's default insertion — a synthetic ClipboardEvent doesn't insert.
 */
async function pasteAt(page: Page, text: string, caret: number): Promise<void> {
  await page.evaluate(
    ({ text, caret }) => {
      const ta = document.querySelector<HTMLTextAreaElement>("textarea")!;
      ta.focus();
      ta.setSelectionRange(caret, caret);
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
      if (ta.dispatchEvent(ev)) document.execCommand("insertText", false, text);
    },
    { text, caret },
  );
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test.describe("Overlapping pastes (CC 2.1.292)", () => {
  test("a paste dropped inside an earlier paste is sent as one pasted block", async ({ page }) => {
    let sent: Record<string, unknown> | null = null;
    await mockChatBackend(page, (body) => {
      sent = body;
    });
    await page.goto("/");

    const composer = page.locator("textarea").first();
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await composer.fill("Compare these logs: ");

    const A = "log A line 1\nlog A line 2\nlog A line 3\nlog A line 4";
    const B = "log B line 1\nlog B line 2\nlog B line 3\nlog B line 4";
    await pasteAt(page, A, "Compare these logs: ".length);
    await expect(composer).toHaveValue("Compare these logs: " + A);

    const mid = "Compare these logs: ".length + A.indexOf("log A line 3");
    await pasteAt(page, B, mid);
    const full = await composer.inputValue();
    expect(full).toBe("Compare these logs: " + A.slice(0, A.indexOf("log A line 3")) + B + A.slice(A.indexOf("log A line 3")));

    await composer.press("Enter");
    await expect.poll(() => sent, { timeout: 10_000 }).not.toBeNull();
    const pastes = (sent as unknown as { inlinePastes?: string[] }).inlinePastes;
    // One block covering A1 + B + A2 — not B alone with A's halves as typed text.
    expect(pastes).toEqual([full.slice("Compare these logs: ".length)]);
  });
});
