/**
 * CC 2.1.332 parity —
 *   "Changed tap-mode voice dictation to stop when you send the prompt, and to
 *    stop and say why when you edit it, a panel covers it, or the connection
 *    or a separate recorder program is lost", and
 *   "[VSCode] Changed voice dictation to stop, and say why, when the
 *    microphone stops sending audio or the panel stays hidden".
 *
 * In Claudius every transcript rewrote the composer as `baseRef + text`, so a
 * word typed or deleted while dictating was lost on the next one. And when
 * the microphone track ended (device unplugged, another program took it) the
 * mic stayed red until the server's 30-second idle reaper closed the stream.
 * Now an edit stops dictation and keeps the text as it is, and a lost
 * microphone stops it at once; each says why in the footer. (Stop-on-send was
 * already done, CC 2.1.311; the hidden-for-30-seconds stop is unit-tested.)
 *
 * Same harness as the 2.1.311 voice spec: the voice-stream `EventSource` is
 * a fake the test drives, Chromium's fake mic feeds `getUserMedia`, and the
 * chat backend is mocked.
 *
 * Screenshot target: docs/cc-parity/2.1.332/dictation-stops-on-edit.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";
import { initEvent, mockChatBackend } from "./helpers/mock-chat";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.332");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-00000332vd01";

test.use({
  launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] },
});

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
    // Keep the mic stream reachable so a test can end its track.
    const md = navigator.mediaDevices;
    const realGum = md.getUserMedia.bind(md);
    md.getUserMedia = async (c?: MediaStreamConstraints) => {
      const s = await realGum(c);
      (window as unknown as { __voiceStream?: MediaStream }).__voiceStream = s;
      return s;
    };
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
  await mockChatBackend(page, FAKE_SESSION_ID, [
    { type: "ready", sessionId: FAKE_SESSION_ID },
    initEvent("sys-init-332vd"),
    { type: "replay_done", hasMoreAbove: false },
  ]);
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/prompt-draft`, (route: Route) =>
    route.request().method() === "GET"
      ? route.fulfill({ json: { text: "", images: [] } })
      : route.fulfill({ json: { ok: true } }),
  );
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

test("typing while dictating stops it, keeps the edit, and says why", async ({ page }) => {
  const { closes } = await mockVoice(page);
  await page.goto("/");

  const { composer, mic } = await startDictating(page, "Rename the billing helper");
  await emitVoice(page, "message", { type: "TranscriptInterim", data: "to" });
  await expect(composer).toHaveValue("Rename the billing helper to");

  // The user fixes a word by hand while the mic is still on.
  await composer.press("End");
  await composer.pressSequentially(" formatInvoice");
  await expect(composer).toHaveValue("Rename the billing helper to formatInvoice");

  await expect(mic).not.toHaveClass(/bg-red-500/);
  await expect.poll(() => closes.length).toBeGreaterThan(0);
  const notice = page.getByTestId("prompt-voice-stop-notice");
  await expect(notice).toContainText("Dictation stopped because you edited the message");
  await expect(notice).toContainText("The text so far is kept.");

  // A transcript still in flight no longer overwrites the edit.
  await emitVoice(page, "message", { type: "TranscriptText", data: "to format invoice" });
  await page.waitForTimeout(150);
  await expect(composer).toHaveValue("Rename the billing helper to formatInvoice");

  await page.waitForTimeout(100);
  await page.screenshot({ path: resolve(SHOTS_DIR, "dictation-stops-on-edit.png"), fullPage: false });
});

test("a microphone that stops sending audio ends dictation and says why", async ({ page }) => {
  const { closes } = await mockVoice(page);
  await page.goto("/");

  const { composer, mic } = await startDictating(page, "Check the deploy logs");
  await page.waitForFunction(() => Boolean((window as unknown as { __voiceStream?: MediaStream }).__voiceStream));
  // The device goes away (unplugged, or another program took it).
  await page.evaluate(() => {
    const s = (window as unknown as { __voiceStream: MediaStream }).__voiceStream;
    for (const t of s.getAudioTracks()) t.dispatchEvent(new Event("ended"));
  });

  await expect(mic).not.toHaveClass(/bg-red-500/);
  await expect.poll(() => closes.length).toBeGreaterThan(0);
  await expect(page.getByTestId("prompt-voice-stop-notice")).toContainText(
    "Dictation stopped — the microphone stopped sending audio.",
  );
  await expect(composer).toHaveValue("Check the deploy logs");
});
