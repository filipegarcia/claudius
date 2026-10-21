/**
 * CC 2.1.307 parity — "[VSCode] Added a notice on the microphone button when
 * voice dictation stops by itself (15 seconds without recognized speech, or
 * the 2-minute limit), saying why and that the text so far is kept".
 *
 * Claudius reimplements dictation (`lib/client/useVoice.ts` →
 * `lib/server/voice-stream.ts`). When the transcription service ended the
 * session on its own, the red mic went grey with no explanation. Now a
 * self-stop (an SSE `close` the user didn't ask for) turns the mic amber and
 * shows a footer status saying why and that the text so far is kept. A stop
 * the user pressed shows no notice.
 *
 * The voice-stream `EventSource` is swapped for a fake the test drives
 * (`window.__voiceES.emit(...)`). A `page.route` body would deliver every
 * frame at once, so a fake is used instead. Chromium's fake mic feeds
 * `getUserMedia`, and the chunk/close routes are stubbed. The chat backend
 * is mocked the same way as the other composer specs.
 *
 * Screenshot target: docs/cc-parity/2.1.307/voice-stop-notice.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.307");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-00000307vn01";

// Fake mic for getUserMedia (no permission prompt, no real device). These
// flags must be file-level: `launchOptions` inside a describe forces a
// separate worker per group.
test.use({
  launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] },
});

type SdkEvent = Record<string, unknown>;

async function mockChatBackend(page: Page): Promise<void> {
  const events: SdkEvent[] = [
    { type: "ready", sessionId: FAKE_SESSION_ID },
    { type: "sdk", message: { type: "system", subtype: "init", uuid: "sys-init-307vn", model: "claude-sonnet-4-6" } },
    { type: "replay_done", hasMoreAbove: false },
  ];
  await page.route("**/api/sessions", async (route: Route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({ json: { id: FAKE_SESSION_ID } });
  });
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/stream*`, async (route: Route) =>
    route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
      body: events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""),
    }),
  );
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/input`, (route: Route) => route.fulfill({ json: { ok: true } }));
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
}

async function mockVoice(page: Page): Promise<{ closes: string[] }> {
  const closes: string[] = [];
  await page.route("**/api/voice/chunk**", (route: Route) => route.fulfill({ status: 200, json: { ok: true } }));
  await page.route("**/api/voice/close**", (route: Route) => {
    closes.push(route.request().url());
    return route.fulfill({ status: 200, json: { ok: true } });
  });
  // Swap only the voice-stream EventSource for a test-driven fake; the
  // session stream keeps the real (route-mocked) EventSource.
  await page.addInitScript(() => {
    const Real = window.EventSource;
    class FakeVoiceES extends EventTarget {
      url: string;
      readyState = 1;
      constructor(url: string) {
        super();
        this.url = url;
        (window as unknown as { __voiceES?: FakeVoiceES }).__voiceES = this;
      }
      close() {
        this.readyState = 2;
      }
      emit(name: string, data: string) {
        if (this.readyState === 2) return;
        this.dispatchEvent(new MessageEvent(name, { data }));
      }
    }
    function Wrapped(this: unknown, url: string | URL, init?: EventSourceInit) {
      const u = String(url);
      if (u.includes("/api/voice/stream")) return new FakeVoiceES(u);
      return new Real(url, init);
    }
    Object.assign(Wrapped, { CONNECTING: 0, OPEN: 1, CLOSED: 2 });
    Wrapped.prototype = Real.prototype;
    window.EventSource = Wrapped as unknown as typeof EventSource;
  });
  return { closes };
}

async function emitVoice(page: Page, name: string, data: unknown): Promise<void> {
  await page.waitForFunction(() => Boolean((window as unknown as { __voiceES?: unknown }).__voiceES));
  await page.evaluate(
    ([n, d]) =>
      (window as unknown as { __voiceES: { emit: (n: string, d: string) => void } }).__voiceES.emit(
        n as string,
        d as string,
      ),
    [name, JSON.stringify(data)],
  );
}

test.beforeEach(async ({ page, context }, testInfo) => {
  if (testInfo.project.name === "chromium") await context.grantPermissions(["microphone"]);
  await activateClaudiusWorkspace(page);
  await mockChatBackend(page);
});

test("dictation that stops by itself says why and keeps the text", async ({ page }) => {
  await mockVoice(page);
  await page.goto("/");

  const composer = page.getByTestId("prompt-input");
  await expect(composer).toBeEnabled({ timeout: 15_000 });
  await composer.fill("Fix the flaky");

  const mic = page.getByTestId("prompt-mic");
  await expect(mic).toBeVisible();
  await mic.click();
  await expect(mic).toHaveClass(/bg-red-500/);

  await emitVoice(page, "ready", { id: "x" });
  await emitVoice(page, "message", { type: "TranscriptText", data: "login test before the release" });
  await expect(composer).toHaveValue("Fix the flaky login test before the release");

  // The service ends the session on its own — no stop click.
  await emitVoice(page, "close", { code: 1000, reason: "" });

  const notice = page.getByTestId("prompt-voice-stop-notice");
  await expect(notice).toBeVisible();
  await expect(notice).toHaveAttribute("role", "status");
  await expect(notice).toContainText("Dictation stopped — the transcription service ended the session.");
  await expect(notice).toContainText("The text so far is kept.");
  // The mic is idle again, amber, and carries the same reason on hover.
  await expect(mic).not.toHaveClass(/bg-red-500/);
  await expect(mic).toHaveClass(/text-amber-500/);
  await expect(mic).toHaveAttribute("title", /transcription service ended the session/);
  await expect(mic).toHaveAttribute("aria-describedby", "prompt-voice-stop-notice");
  // The dictated text survives.
  await expect(composer).toHaveValue("Fix the flaky login test before the release");

  await page.waitForTimeout(150);
  await page.screenshot({ path: resolve(SHOTS_DIR, "voice-stop-notice.png"), fullPage: false });

  await page.getByTestId("prompt-voice-stop-notice-dismiss").click();
  await expect(notice).toHaveCount(0);
  await expect(mic).not.toHaveClass(/text-amber-500/);
});

test("the proxy's idle timeout is explained, and starting again clears the notice", async ({ page }) => {
  await mockVoice(page);
  await page.goto("/");

  const composer = page.getByTestId("prompt-input");
  await expect(composer).toBeEnabled({ timeout: 15_000 });
  const mic = page.getByTestId("prompt-mic");
  await mic.click();
  await emitVoice(page, "ready", { id: "x" });
  await emitVoice(page, "close", { code: null, reason: "idle-timeout" });

  const notice = page.getByTestId("prompt-voice-stop-notice");
  await expect(notice).toContainText("no audio reached the transcription service for 30 seconds");

  await mic.click();
  await expect(mic).toHaveClass(/bg-red-500/);
  await expect(notice).toHaveCount(0);
});

test("a stop the user pressed shows no notice", async ({ page }) => {
  const { closes } = await mockVoice(page);
  await page.goto("/");

  const composer = page.getByTestId("prompt-input");
  await expect(composer).toBeEnabled({ timeout: 15_000 });
  const mic = page.getByTestId("prompt-mic");
  await mic.click();
  await expect(mic).toHaveClass(/bg-red-500/);
  await emitVoice(page, "ready", { id: "x" });
  await emitVoice(page, "message", { type: "TranscriptText", data: "ship it" });
  await expect(composer).toHaveValue("ship it");

  // User presses stop → the client asks the server to finalize, and the
  // upstream then closes normally.
  await mic.click();
  await expect.poll(() => closes.length).toBeGreaterThan(0);
  await emitVoice(page, "close", { code: 1000, reason: "" });

  await expect(mic).not.toHaveClass(/bg-red-500/);
  await expect(page.getByTestId("prompt-voice-stop-notice")).toHaveCount(0);
  await expect(mic).toHaveAttribute("title", "Voice dictation");
  await expect(composer).toHaveValue("ship it");
});
