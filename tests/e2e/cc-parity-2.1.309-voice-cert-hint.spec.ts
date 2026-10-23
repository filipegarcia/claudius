/**
 * CC 2.1.309 parity — "[VSCode] Added a log warning that says what to do when
 * dictation or the extension's own requests fail certificate verification,
 * such as behind a TLS-inspecting proxy."
 *
 * Claudius proxies dictation (`lib/server/voice-stream.ts`). A certificate-
 * verification failure on the upstream socket used to surface only as Node's
 * raw "unable to verify the first certificate" on the mic tooltip, and the
 * hook kept the dead session id after any upstream error, so the mic
 * couldn't restart. Now the proxy
 * logs an actionable warning and forwards it as `hint`; the composer shows it
 * in the footer status slot (amber mic, same idiom as the 2.1.307 self-stop
 * notice) and the mic is free to try again.
 *
 * Same harness as `cc-parity-2.1.307-voice-stop-notice.spec.ts`: the
 * voice-stream EventSource is a test-driven fake and Chromium's fake mic
 * feeds `getUserMedia`. The hint text comes from the real
 * `tlsCertFailureHint` so the server/renderer contract is pinned.
 *
 * Screenshot target: docs/cc-parity/2.1.309/voice-cert-hint.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";
import { tlsCertFailureHint } from "../../lib/shared/tls-cert-hint";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.309");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-00000309vc01";

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
    { type: "sdk", message: { type: "system", subtype: "init", uuid: "sys-init-309vc", model: "claude-sonnet-4-6" } },
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

const HINT = tlsCertFailureHint(
  Object.assign(new Error("unable to verify the first certificate"), { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }),
  { extraCaConfigured: false },
)!;

test("a certificate failure tells the user to set NODE_EXTRA_CA_CERTS", async ({ page }) => {
  await mockVoice(page);
  await page.goto("/");

  const composer = page.getByTestId("prompt-input");
  await expect(composer).toBeEnabled({ timeout: 15_000 });
  await composer.fill("Draft the release notes for");

  const mic = page.getByTestId("prompt-mic");
  await expect(mic).toBeVisible();
  await mic.click();
  await expect(mic).toHaveClass(/bg-red-500/);

  // The upstream TLS handshake fails before `ready` (proxy-side error frame).
  await emitVoice(page, "error", {
    kind: "upstream",
    message: "unable to verify the first certificate",
    hint: HINT,
  });

  const notice = page.getByTestId("prompt-voice-stop-notice");
  await expect(notice).toBeVisible();
  await expect(notice).toHaveAttribute("role", "status");
  await expect(notice).toContainText("certificate not trusted");
  await expect(notice).toContainText("NODE_EXTRA_CA_CERTS");
  await expect(mic).not.toHaveClass(/bg-red-500/);
  await expect(mic).toHaveClass(/text-amber-500/);
  await expect(mic).toHaveAttribute("title", `${HINT} Click to dictate again.`);
  // The draft is untouched.
  await expect(composer).toHaveValue("Draft the release notes for");

  await page.waitForTimeout(150);
  await page.screenshot({ path: resolve(SHOTS_DIR, "voice-cert-hint.png"), fullPage: false });

  // The session was torn down, so the mic can start again (pre-fix the stale
  // session id kept `start()` a no-op) and the hint clears on that start.
  await mic.click();
  await expect(mic).toHaveClass(/bg-red-500/);
  await expect(notice).toHaveCount(0);
});

test("a non-certificate upstream error keeps the plain message and shows no hint", async ({ page }) => {
  await mockVoice(page);
  await page.goto("/");
  const composer = page.getByTestId("prompt-input");
  await expect(composer).toBeEnabled({ timeout: 15_000 });
  const mic = page.getByTestId("prompt-mic");
  await mic.click();
  await expect(mic).toHaveClass(/bg-red-500/);
  await emitVoice(page, "error", { kind: "upstream", message: "socket hang up" });
  await expect(page.getByTestId("prompt-voice-stop-notice")).toHaveCount(0);
  await expect(mic).toHaveAttribute("title", "Voice: socket hang up");
  // The proxy ended the session, so the mic is released and can start again.
  await expect(mic).not.toHaveClass(/bg-red-500/);
  await mic.click();
  await expect(mic).toHaveClass(/bg-red-500/);
});
