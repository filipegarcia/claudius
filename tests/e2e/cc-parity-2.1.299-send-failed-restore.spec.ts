/**
 * CC 2.1.299 parity — "[Remote Control] Fixed Remote Control sessions whose
 * computer can't be reached still appearing to send your messages; your text
 * now stays in the box and Send is off until it reconnects".
 *
 * Claudius's composer (`components/chat/PromptInput.tsx`) clears the moment
 * Send is pressed and `session.send()` (`lib/client/use-session.ts`) adds an
 * optimistic, dimmed user bubble before POSTing `/api/sessions/:id/input`.
 * When that POST couldn't reach the server, the fetch rejection escaped the
 * fire-and-forget caller: the bubble sat there as "Sending…" forever and the
 * typed text was gone. Now `send()` rolls the bubble back and reports
 * `ok: false`, and the composer puts the text back with an inline hint.
 *
 * This spec mocks the chat backend (fixed SSE fixture), makes the `/input`
 * POST fail at the network layer (`route.abort("connectionrefused")`), types
 * a message, presses Enter, and asserts: the POST was attempted, the text is
 * back in the composer, the hint is visible (and not duplicated by a session
 * error banner), no user bubble is left in the transcript, and the draft was
 * re-saved for the session.
 *
 * Send-gating on stream reconnect was deliberately NOT shipped: the
 * "reconnecting" status arms 4s after ANY EventSource `onerror`, and finite
 * mocked SSE bodies like this spec's error on every end-of-body — gating
 * would disable Send across the mocked e2e suite. This spec only covers the
 * "text stays in the box" half.
 *
 * Screenshot target: docs/cc-parity/2.1.299/send-failed-restore.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.299");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-00000299sf01";
const MESSAGE = "Summarise the failing tests and propose a fix";

type SdkEvent = Record<string, unknown>;

function sseBody(events: SdkEvent[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

async function mockChatBackend(
  page: Page,
  events: SdkEvent[],
): Promise<{ inputAttempts: string[]; draftPuts: string[] }> {
  const inputAttempts: string[] = [];
  const draftPuts: string[] = [];

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

  // The machine "can't be reached": the user-turn POST never gets an answer.
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/input`, async (route: Route) => {
    const body = route.request().postDataJSON() as { text?: string };
    inputAttempts.push(body?.text ?? "");
    return route.abort("connectionrefused");
  });

  // Per-session draft store: seed empty, record PUTs so the test can see the
  // restored message being re-saved.
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/prompt-draft`, async (route: Route) => {
    const method = route.request().method();
    if (method === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ text: "", images: [] }),
      });
    }
    if (method === "PUT") {
      const body = route.request().postDataJSON() as { text?: string };
      draftPuts.push(body?.text ?? "");
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
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

  return { inputAttempts, draftPuts };
}

const PRELUDE: SdkEvent[] = [
  { type: "ready", sessionId: FAKE_SESSION_ID },
  {
    type: "sdk",
    message: {
      type: "system",
      subtype: "init",
      uuid: "sys-init-299sf",
      model: "claude-sonnet-4-6",
    },
  },
  { type: "replay_done", hasMoreAbove: false },
];

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test("a send that can't reach the server keeps the text in the box", async ({ page }) => {
  const { inputAttempts, draftPuts } = await mockChatBackend(page, PRELUDE);
  await page.goto("/");

  const composer = page.getByTestId("prompt-input");
  await expect(composer).toBeEnabled({ timeout: 15_000 });

  await composer.fill(MESSAGE);
  // The pre-submit debounced save may already have PUT this text; only PUTs
  // after Enter prove the restore re-saved it.
  const putsBeforeSend = draftPuts.length;
  await composer.press("Enter");

  // The send really was attempted (and refused at the network layer) — so
  // the assertions below aren't passing just because nothing happened.
  await expect.poll(() => inputAttempts.length).toBeGreaterThan(0);
  expect(inputAttempts[0]).toBe(MESSAGE);

  // The hint only renders once the failure has resolved, so wait on it
  // before checking the transcript and the composer.
  const hint = page.getByTestId("prompt-send-failed-notice");
  await expect(hint).toBeVisible();
  await expect(hint).toContainText("Couldn't reach Claudius");
  await expect(hint).toContainText("back in the box");
  // The hint is the only report of the network failure — the session error
  // banner doesn't repeat it.
  await expect(
    page.getByTestId("session-error").filter({ hasText: /send failed|couldn't reach/i }),
  ).toHaveCount(0);

  // The text is back where the user typed it…
  await expect(composer).toHaveValue(MESSAGE);
  // …and the optimistic bubble was rolled back, not left dimmed as "Sending…".
  await expect(page.getByTestId("user-message")).toHaveCount(0);
  await expect(page.locator('[data-pending="true"]')).toHaveCount(0);

  // The restored message is re-saved as the session's draft (the submit had
  // already DELETEd it), so it survives a tab switch or reload.
  await expect
    .poll(() => draftPuts.slice(putsBeforeSend).includes(MESSAGE), { timeout: 5_000 })
    .toBe(true);

  await page.waitForTimeout(200);
  await page.screenshot({ path: resolve(SHOTS_DIR, "send-failed-restore.png"), fullPage: false });

  // Editing the restored message dismisses the hint.
  await composer.press("End");
  await composer.pressSequentially(" please");
  await expect(hint).toHaveCount(0);
});
