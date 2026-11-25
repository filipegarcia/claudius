/**
 * CC 2.1.329 parity — "[VSCode] Fixed keys pressed while an input method
 * (IME) is composing moving focus on or declining a permission prompt,
 * running menu rows and closing dialogs".
 *
 * On macOS (Electron and Chrome), the keydown for the Esc that cancels a
 * Japanese/Chinese/Korean conversion carries the real `key` plus
 * `isComposing: true`. A permission prompt leaves focus in the composer
 * (CC 2.1.299), so cancelling a conversion there denied the prompt, and the
 * same Esc closed an overlay such as /rename mid-composition. The window key
 * listeners now return on `isImeComposing(e)` (fixed in 937687ea, helper
 * unit-tested with `lib/client/key-match.ts`). This spec is the in-browser
 * check: Playwright can't drive a real IME, so it dispatches the composing
 * keydown a browser sends.
 *
 * No screenshot: the visible outcome is the prompt or dialog staying open.
 */

import { test, expect, type Locator, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";
import { initEvent, mockChatBackend, type SdkEvent } from "./helpers/mock-chat";

const PERMISSION_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-000002329b03";
const RENAME_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-000002329b3r";

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
// rather than replaying them, and `route.fulfill` ends the stream.
const EPHEMERAL = new Set(["permission_request", "prompt_settled"]);

type Posted = { requestId: string; decision: { kind: string } };

/** A chat backend that serves `events` once, then without the live prompts, and records permission answers. */
async function mockPermissionBackend(page: Page, events: SdkEvent[]): Promise<Posted[]> {
  const posted: Posted[] = [];
  await mockChatBackend(page, PERMISSION_SESSION_ID, events);
  let connections = 0;
  await page.route(`**/api/sessions/${PERMISSION_SESSION_ID}/stream*`, async (route: Route) => {
    connections += 1;
    const body = connections > 1 ? events.filter((e) => !EPHEMERAL.has(String(e.type))) : events;
    return route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
      body: body.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""),
    });
  });
  await page.route(`**/api/sessions/${PERMISSION_SESSION_ID}/permission`, async (route: Route) => {
    if (route.request().method() !== "POST") return route.fallback();
    posted.push(route.request().postDataJSON() as Posted);
    return route.fulfill({ status: 200, json: { ok: true } });
  });
  return posted;
}

/**
 * Dispatch the keydown a browser sends for Esc while an IME is composing,
 * then wait two frames so anything the key set off has rendered before the
 * caller checks that nothing happened.
 */
async function composingEscape(target: Locator) {
  await target.evaluate(async (el) => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", isComposing: true, bubbles: true, cancelable: true }));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test("a composing Esc in the composer leaves the permission prompt open; a plain Esc still denies", async ({ page }) => {
  // Two queued prompts: if the composing Esc denied the first, the plain Esc
  // would land on the second and the card would close.
  const posted = await mockPermissionBackend(page, [
    { type: "ready", sessionId: PERMISSION_SESSION_ID },
    initEvent("sys-329-ime"),
    { type: "replay_done", hasMoreAbove: false },
    permission("req-first", "ls -la"),
    permission("req-second", "git status"),
  ]);
  await page.goto("/");

  const modal = page.locator("[data-permission-modal]");
  await expect(modal).toBeVisible({ timeout: 15_000 });
  await expect(modal).toContainText("ls -la");
  await expect(page.getByTestId("permission-queue-count")).toHaveText("1 of 2");
  // Past the prompt's 400ms arm window (lib/client/prompt-arm.ts), so the
  // plain Esc below is answered on its own merits.
  const shownAt = await page.evaluate(() => performance.now());
  await page.waitForFunction((t) => performance.now() - t >= 450, shownAt);

  const composer = page.getByTestId("prompt-input");
  await composer.focus();
  await composingEscape(composer);
  await expect(modal).toContainText("ls -la");
  await expect(page.getByTestId("permission-queue-count")).toHaveText("1 of 2");
  expect(posted).toEqual([]);

  await page.keyboard.press("Escape");
  await expect(modal).toContainText("git status");
  await expect.poll(() => posted.length).toBe(1);
  expect(posted[0]).toMatchObject({ requestId: "req-first", decision: { kind: "deny" } });
});

test("/rename stays open on a composing Esc, and a plain Esc closes it", async ({ page }) => {
  await mockChatBackend(page, RENAME_SESSION_ID, [
    { type: "ready", sessionId: RENAME_SESSION_ID },
    initEvent("sys-329-ime-rn"),
    { type: "replay_done", hasMoreAbove: false },
    // An ended turn: the session is idle, so the composer can run /rename.
    {
      type: "sdk",
      message: { type: "result", uuid: "r-329-ime", subtype: "success", num_turns: 1, duration_ms: 500, total_cost_usd: 0 },
    },
  ]);
  await page.goto("/");

  const composer = page.getByTestId("prompt-input");
  await expect(composer).toBeEnabled({ timeout: 30_000 });
  await composer.fill("/rename");
  await page.getByTestId("prompt-send").click();

  const input = page.getByPlaceholder("New title");
  await expect(input).toBeVisible();
  await input.fill("リリースノート");

  await composingEscape(input);
  await expect(input).toBeVisible();
  await expect(input).toHaveValue("リリースノート");

  await page.keyboard.press("Escape");
  await expect(input).toHaveCount(0);
});
