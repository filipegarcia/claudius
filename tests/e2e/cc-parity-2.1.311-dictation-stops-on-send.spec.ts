/**
 * CC 2.1.311 parity — "[VSCode] Fixed voice dictation continuing to record
 * after a message was sent with the Send button; sending now stops dictation
 * first, as pressing Enter already did".
 *
 * In Claudius neither Send nor Enter stopped dictation. The mic stayed red
 * after the message left, and since `useVoice.stop()` waits for the
 * upstream's final transcript, a late `TranscriptText` was written back into
 * the composer the send had just cleared (the sent text plus whatever came
 * after it). Now every send path stops dictation and drops the transcript
 * still in flight for the message that already left.
 *
 * Uses the same harness as the 2.1.307 voice specs: the voice-stream
 * `EventSource` is a fake the test drives (`window.__voiceES.emit(...)`),
 * Chromium's fake mic feeds `getUserMedia`, and the chat backend is mocked.
 *
 * Screenshot target: docs/cc-parity/2.1.311/dictation-stops-on-send.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.311");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-00000311vd01";

test.use({
  launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] },
});

type SdkEvent = Record<string, unknown>;

async function mockChatBackend(page: Page): Promise<{ inputs: string[] }> {
  const inputs: string[] = [];
  const events: SdkEvent[] = [
    { type: "ready", sessionId: FAKE_SESSION_ID },
    { type: "sdk", message: { type: "system", subtype: "init", uuid: "sys-init-311vd", model: "claude-sonnet-4-6" } },
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
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/input`, (route: Route) => {
    const body = route.request().postDataJSON() as { text?: string };
    inputs.push(body.text ?? "");
    return route.fulfill({ json: { ok: true, queued: false, uuid: `u-${inputs.length}` } });
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
  return { inputs };
}

async function mockVoice(page: Page): Promise<{ closes: string[] }> {
  const closes: string[] = [];
  await page.route("**/api/voice/chunk**", (route: Route) => route.fulfill({ status: 200, json: { ok: true } }));
  await page.route("**/api/voice/close**", (route: Route) => {
    closes.push(route.request().url());
    return route.fulfill({ status: 200, json: { ok: true } });
  });
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

let backend: { inputs: string[] };

test.beforeEach(async ({ page, context }, testInfo) => {
  if (testInfo.project.name === "chromium") await context.grantPermissions(["microphone"]);
  await activateClaudiusWorkspace(page);
  backend = await mockChatBackend(page);
});

async function startDictating(page: Page, text: string) {
  const composer = page.getByTestId("prompt-input");
  await expect(composer).toBeEnabled({ timeout: 15_000 });
  const mic = page.getByTestId("prompt-mic");
  await mic.click();
  await expect(mic).toHaveClass(/bg-red-500/);
  await emitVoice(page, "ready", { id: "x" });
  await emitVoice(page, "message", { type: "TranscriptText", data: text });
  await expect(composer).toHaveValue(text);
  return { composer, mic };
}

test("clicking Send stops dictation and the late transcript doesn't refill the composer", async ({ page }) => {
  const { closes } = await mockVoice(page);
  await page.goto("/");

  const { composer, mic } = await startDictating(page, "Rename the billing helper");
  // A trailing interim (the next utterance, appended to the finalized text)
  // the user said just before clicking Send.
  await emitVoice(page, "message", { type: "TranscriptInterim", data: "to" });
  await expect(composer).toHaveValue("Rename the billing helper to");

  await page.getByTestId("prompt-send").click();

  // The message left with what was in the box…
  await expect.poll(() => backend.inputs).toEqual(["Rename the billing helper to"]);
  await expect(composer).toHaveValue("");
  // …and dictation stopped: the mic is idle and the upstream was asked to close.
  await expect(mic).not.toHaveClass(/bg-red-500/);
  await expect.poll(() => closes.length).toBeGreaterThan(0);

  // The upstream's final transcript for that utterance arrives after the
  // send. Before the fix it was written back as the whole dictated text.
  await emitVoice(page, "message", { type: "TranscriptText", data: "to formatInvoice" });
  await emitVoice(page, "message", { type: "TranscriptInterim", data: "and" });
  await page.waitForTimeout(150);
  await expect(composer).toHaveValue("");

  await emitVoice(page, "close", { code: 1000, reason: "" });
  await expect(mic).toHaveAttribute("title", "Voice dictation");
  // A send-stop is a stop the user asked for: no "stopped by itself" notice.
  await expect(page.getByTestId("prompt-voice-stop-notice")).toHaveCount(0);

  await expect(page.getByText("Rename the billing helper to").first()).toBeVisible();
  await page.waitForTimeout(150);
  await page.screenshot({ path: resolve(SHOTS_DIR, "dictation-stops-on-send.png"), fullPage: false });
});

test("pressing Enter stops dictation too", async ({ page }) => {
  const { closes } = await mockVoice(page);
  await page.goto("/");

  const { composer, mic } = await startDictating(page, "Run the unit tests");
  await composer.press("Enter");

  await expect.poll(() => backend.inputs).toEqual(["Run the unit tests"]);
  await expect(mic).not.toHaveClass(/bg-red-500/);
  await expect.poll(() => closes.length).toBeGreaterThan(0);
  await emitVoice(page, "message", { type: "TranscriptText", data: "Run the unit tests please" });
  await page.waitForTimeout(150);
  await expect(composer).toHaveValue("");
});

test("dictating again after a send fills the composer normally", async ({ page }) => {
  await mockVoice(page);
  await page.goto("/");

  const { composer, mic } = await startDictating(page, "First message");
  await page.getByTestId("prompt-send").click();
  await expect.poll(() => backend.inputs).toEqual(["First message"]);
  await emitVoice(page, "close", { code: 1000, reason: "" });
  await expect(mic).not.toHaveClass(/bg-red-500/);

  // A fresh dictation session isn't affected by the previous discard.
  await mic.click();
  await expect(mic).toHaveClass(/bg-red-500/);
  await emitVoice(page, "ready", { id: "y" });
  await emitVoice(page, "message", { type: "TranscriptText", data: "Second message" });
  await expect(composer).toHaveValue("Second message");
});

test("a send that bounces keeps dictating", async ({ page }) => {
  await mockVoice(page);
  await page.goto("/");

  const { composer, mic } = await startDictating(page, "hello");
  // A bidi control makes the composer put the cleaned text back for review
  // instead of sending — dictation should carry on. (CC 2.1.316: a plain
  // prompt with only a zero-width space now sends cleaned, so the hold is
  // driven by a bidi override instead.)
  await composer.fill("hel\u{202E}lo");
  await page.getByTestId("prompt-send").click();
  await expect(composer).toHaveValue("hello");
  expect(backend.inputs).toEqual([]);
  await expect(mic).toHaveClass(/bg-red-500/);
});
