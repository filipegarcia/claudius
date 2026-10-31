/**
 * CC 2.1.316 parity — "Improved SSL certificate errors to name the likely
 * causes, among them a server that leaves out an intermediate certificate,
 * and the fix for each".
 *
 * `lib/shared/tls-cert-hint.ts` now tells chain-of-trust failures apart
 * (`certFailureCause`) instead of blaming a TLS-inspecting proxy for all of
 * them. This drives the cause the old copy got most wrong: OpenSSL's
 * UNABLE_TO_GET_ISSUER_CERT, where a CA certificate Claudius trusts is
 * missing its own issuer (a renewal leftover) — setting NODE_EXTRA_CA_CERTS
 * to a proxy CA can't fix that; adding the issuer to the NODE_EXTRA_CA_CERTS
 * file can. An incomplete chain (every caller talks to Anthropic, whose chain
 * the user can't change) keeps the proxy one-liner in the composer; the
 * missing-intermediate cause is only in the longer log form.
 *
 * Same harness as `cc-parity-2.1.309-voice-cert-hint.spec.ts`: the
 * voice-stream EventSource is a test-driven fake and Chromium's fake mic
 * feeds `getUserMedia`. The hint comes from the real `tlsCertFailureHint`, as
 * `lib/server/voice-stream.ts` forwards it.
 *
 * Screenshot target: docs/cc-parity/2.1.316/cert-cause-hint.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";
import { tlsCertFailureHint } from "../../lib/shared/tls-cert-hint";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.316");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-00000316cc01";

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
    { type: "sdk", message: { type: "system", subtype: "init", uuid: "sys-init-316cc", model: "claude-sonnet-4-6" } },
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
  Object.assign(new Error("unable to get issuer certificate"), { code: "UNABLE_TO_GET_ISSUER_CERT" }),
  { extraCaConfigured: false },
)!;

test("a trusted CA missing its issuer gets its own cause and fix, not the proxy advice", async ({ page }) => {
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
    message: "unable to get issuer certificate",
    hint: HINT,
  });

  const notice = page.getByTestId("prompt-voice-stop-notice");
  await expect(notice).toBeVisible();
  await expect(notice).toHaveAttribute("role", "status");
  await expect(notice).toContainText("missing its issuer");
  await expect(notice).toContainText("add its issuer");
  await expect(notice).toContainText("NODE_EXTRA_CA_CERTS");
  await expect(notice).not.toContainText(/proxy/i);
  await expect(notice).not.toContainText("Set NODE_EXTRA_CA_CERTS");
  await expect(mic).toHaveAttribute("title", `${HINT} Click to dictate again.`);
  // The draft is untouched.
  await expect(composer).toHaveValue("Draft the release notes for");

  await page.waitForTimeout(150);
  await page.screenshot({ path: resolve(SHOTS_DIR, "cert-cause-hint.png"), fullPage: false });
});

test("an incomplete chain keeps the proxy / NODE_EXTRA_CA_CERTS one-liner in the composer", async ({ page }) => {
  await mockVoice(page);
  await page.goto("/");
  const composer = page.getByTestId("prompt-input");
  await expect(composer).toBeEnabled({ timeout: 15_000 });
  const mic = page.getByTestId("prompt-mic");
  await mic.click();
  await expect(mic).toHaveClass(/bg-red-500/);

  const hint = tlsCertFailureHint(
    Object.assign(new Error("unable to get local issuer certificate"), { code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" }),
    { extraCaConfigured: false },
  )!;
  await emitVoice(page, "error", { kind: "upstream", message: "unable to get local issuer certificate", hint });

  const notice = page.getByTestId("prompt-voice-stop-notice");
  // Byte-identical to the untrusted-authority (proxy) hint.
  const proxyHint = tlsCertFailureHint(
    Object.assign(new Error("self-signed certificate in certificate chain"), { code: "SELF_SIGNED_CERT_IN_CHAIN" }),
    { extraCaConfigured: false },
  )!;
  expect(hint).toBe(proxyHint);
  await expect(notice).toContainText(proxyHint);
  await expect(notice).toContainText("Set NODE_EXTRA_CA_CERTS");
  await expect(notice).not.toContainText("intermediate");
});
