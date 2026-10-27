/**
 * CC 2.1.312 parity — "Improved the prompt's effort indicator: a change made
 * mid-task now says it may wait for your next message, and the note clears
 * when it no longer applies" (with "Fixed the spinner … naming a newly picked
 * effort level during a task before the model applied it").
 *
 * Claudius's effort pill (session card in the right rail) switches to a new
 * pick right away, even mid-turn, although the running request keeps the
 * level it was sent with. While that is so, the pill now adds Claude Code's
 * "may wait for your next message", and the `/effort` toast says so too. The
 * note clears at the next main-thread request (`message_start`), on a switch
 * back, or when the turn ends.
 *
 * The session stream is a fake `EventSource` the test drives
 * (`window.__sessionES.emit(...)`), so events can arrive after the change.
 *
 * Screenshot target: docs/cc-parity/2.1.312/effort-wait-note.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.312");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-00000312ef01";
const NOW = Date.now();

type SdkEvent = Record<string, unknown>;

const EVENTS: SdkEvent[] = [
  { type: "ready", sessionId: FAKE_SESSION_ID },
  { type: "sdk", message: { type: "system", subtype: "init", uuid: "sys-init-312ef", model: "claude-opus-5-5" } },
  { type: "replay_done", hasMoreAbove: false },
  { type: "effort_applied", effort: "high" },
  {
    type: "sdk",
    at: NOW - 6_000,
    message: {
      type: "user",
      uuid: "user-ef-1",
      parent_tool_use_id: null,
      isSynthetic: false,
      message: { role: "user", content: [{ type: "text", text: "Find out why the nightly export job times out." }] },
    },
  },
  {
    type: "sdk",
    at: NOW - 4_000,
    message: {
      type: "assistant",
      uuid: "assistant-ef-1",
      parent_tool_use_id: null,
      message: {
        id: "msg_ef_1",
        model: "claude-opus-5-5",
        content: [{ type: "text", text: "Reading the export worker and its retry settings first." }],
        usage: { input_tokens: 40, output_tokens: 20 },
      },
    },
  },
  { type: "turn_status", status: "running" },
];

async function installFakeSessionStream(page: Page): Promise<void> {
  await page.addInitScript(
    ({ id, initial }: { id: string; initial: SdkEvent[] }) => {
      const Real = window.EventSource;
      class FakeSessionES {
        url: string;
        readyState = 0;
        onopen: ((e: Event) => void) | null = null;
        onmessage: ((e: MessageEvent) => void) | null = null;
        onerror: ((e: Event) => void) | null = null;
        constructor(url: string) {
          this.url = url;
          (window as unknown as { __sessionES?: FakeSessionES }).__sessionES = this;
          setTimeout(() => {
            this.readyState = 1;
            this.onopen?.(new Event("open"));
            for (const ev of initial) this.emit(ev);
          }, 0);
        }
        emit(ev: unknown) {
          if (this.readyState === 2) return;
          this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(ev) }));
        }
        close() {
          this.readyState = 2;
        }
        addEventListener() {}
        removeEventListener() {}
      }
      function Wrapped(this: unknown, url: string | URL, init?: EventSourceInit) {
        const u = String(url);
        if (u.includes(`/api/sessions/${id}/stream`)) return new FakeSessionES(u);
        return new Real(url, init);
      }
      Object.assign(Wrapped, { CONNECTING: 0, OPEN: 1, CLOSED: 2 });
      Wrapped.prototype = Real.prototype;
      window.EventSource = Wrapped as unknown as typeof EventSource;
    },
    { id: FAKE_SESSION_ID, initial: EVENTS },
  );
}

async function emit(page: Page, ev: SdkEvent): Promise<void> {
  await page.evaluate((e) => {
    (window as unknown as { __sessionES: { emit: (x: unknown) => void } }).__sessionES.emit(e);
  }, ev);
}

async function mockChatBackend(page: Page): Promise<{ effortPosts: string[] }> {
  const effortPosts: string[] = [];
  await installFakeSessionStream(page);
  await page.route("**/api/sessions", async (route: Route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({ json: { id: FAKE_SESSION_ID } });
  });
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/effort`, (route: Route) => {
    const body = route.request().postDataJSON() as { level?: string };
    effortPosts.push(body.level ?? "");
    return route.fulfill({ json: { ok: true } });
  });
  await page.route("**/api/sessions/open-tabs", (route: Route) =>
    route.fulfill({ json: { activeId: null, tabs: [] } }),
  );
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/pending-prompts`, (route: Route) =>
    route.fulfill({ json: { asks: [], permissions: [] } }),
  );
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/prompt-draft`, (route: Route) =>
    route.request().method() === "GET"
      ? route.fulfill({ json: { text: "", images: [] } })
      : route.fulfill({ json: { ok: true } }),
  );
  await page.route("**/api/limits*", (route: Route) =>
    route.fulfill({ json: { limits: { sessionUsd: 0, projectDailyUsd: 0 } } }),
  );
  return { effortPosts };
}

async function pickEffortMidTurn(page: Page, level: string): Promise<void> {
  const composer = page.getByTestId("prompt-input");
  await composer.click();
  await composer.fill(`/effort ${level}`);
  await page.keyboard.press("Escape"); // close the slash picker so Enter sends
  await composer.press("Enter");
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test("a mid-task effort change says it may wait, until the next request picks it up", async ({ page }) => {
  const { effortPosts } = await mockChatBackend(page);
  await page.goto("/");

  const pill = page.getByTestId("session-card-effort-pill");
  await expect(pill).toHaveAttribute("data-effort", "high", { timeout: 15_000 });
  await expect(page.getByTestId("session-card-effort-wait-note")).toHaveCount(0);

  await pickEffortMidTurn(page, "max");
  await expect.poll(() => effortPosts).toEqual(["max"]);
  // The server reports the level the next request will use.
  await emit(page, { type: "effort_applied", effort: "max" });

  await expect(pill).toHaveAttribute("data-effort", "max");
  const note = page.getByTestId("session-card-effort-wait-note");
  await expect(note).toHaveText("· may wait for your next message");
  await expect(pill).toHaveAttribute("title", /may wait for your next message/);
  await expect(page.getByTestId("chat-toast")).toContainText(
    "Effort set to max · may wait for your next message",
  );

  await pill.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await page.screenshot({ path: resolve(SHOTS_DIR, "effort-wait-note.png"), fullPage: false });

  // The next main-thread request goes out at the new level: the note clears.
  await emit(page, {
    type: "sdk",
    message: {
      type: "stream_event",
      uuid: "se-ef-2",
      parent_tool_use_id: null,
      event: { type: "message_start", message: { id: "msg_ef_2" } },
    },
  });
  await expect(note).toHaveCount(0);
  await expect(pill).toHaveAttribute("data-effort", "max");
});

test("switching back to the level in force, or the turn ending, clears the note", async ({ page }) => {
  await mockChatBackend(page);
  await page.goto("/");
  const pill = page.getByTestId("session-card-effort-pill");
  await expect(pill).toHaveAttribute("data-effort", "high", { timeout: 15_000 });
  const note = page.getByTestId("session-card-effort-wait-note");

  await pickEffortMidTurn(page, "low");
  await emit(page, { type: "effort_applied", effort: "low" });
  await expect(note).toBeVisible();

  // Back to the level the running request already uses: nothing to wait for.
  await pickEffortMidTurn(page, "high");
  await emit(page, { type: "effort_applied", effort: "high" });
  await expect(note).toHaveCount(0);

  await pickEffortMidTurn(page, "medium");
  await emit(page, { type: "effort_applied", effort: "medium" });
  await expect(note).toBeVisible();

  // A subagent's request doesn't count: it runs at its own effort.
  await emit(page, {
    type: "sdk",
    message: {
      type: "stream_event",
      uuid: "se-ef-sub",
      parent_tool_use_id: "toolu_sub_1",
      event: { type: "message_start", message: { id: "msg_ef_sub" } },
    },
  });
  await expect(note).toBeVisible();

  await emit(page, { type: "turn_status", status: "idle" });
  await expect(note).toHaveCount(0);
});

test("an effort change while idle shows no note", async ({ page }) => {
  await mockChatBackend(page);
  await page.goto("/");
  const pill = page.getByTestId("session-card-effort-pill");
  await expect(pill).toHaveAttribute("data-effort", "high", { timeout: 15_000 });
  await emit(page, { type: "turn_status", status: "idle" });

  await pickEffortMidTurn(page, "max");
  await emit(page, { type: "effort_applied", effort: "max" });
  await expect(pill).toHaveAttribute("data-effort", "max");
  await expect(page.getByTestId("session-card-effort-wait-note")).toHaveCount(0);
  await expect(page.getByTestId("chat-toast")).toHaveText(/^Effort set to max$/);
});
