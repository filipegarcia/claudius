/**
 * End-to-end voice dictation against the LIVE Anthropic endpoint.
 *
 * This spec drives the renderer code path that no other test exercises:
 *
 *   • `getUserMedia()` (fed by Chromium's fake-audio file flag)
 *   • the AudioWorklet PCM downsampler in
 *     `public/voice-recorder-worklet.js`
 *   • `EventSource` + chunked `POST /api/voice/chunk`
 *   • the server-side proxy in `lib/server/voice-stream.ts`
 *   • the upstream WS to `wss://api.anthropic.com/api/ws/...`
 *   • the composer callback that stitches interim text into the textarea
 *
 * It is **opt-in** because:
 *
 *   1) It hits the real upstream — quota counts against the user's
 *      Claude.ai account.
 *   2) It needs an OAuth token to actually exist on disk, which is true
 *      only on a logged-in developer's machine, not in CI.
 *
 * Enable with `CLAUDIUS_E2E_VOICE=1 bun run test:e2e -- voice-dictation`.
 * The first time you run it locally, make sure `~/.claude/.claudius/
 * accounts.json` has an active oauth-token profile — that's where the
 * upstream Bearer comes from.
 */
import { copyFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";

import { test, expect } from "../helpers/test";

const VOICE_ENABLED = process.env.CLAUDIUS_E2E_VOICE === "1";
const FIXTURE_WAV = resolvePath(
  __dirname,
  "..",
  "fixtures",
  "voice-dictation-sample.wav",
);
const REAL_ACCOUNTS = join(homedir(), ".claude", ".claudius", "accounts.json");

// Chromium fake-audio plumbing. Three flags work together:
//
//   --use-fake-ui-for-media-stream
//     Skip the permission prompt; the renderer's getUserMedia() resolves
//     immediately (we ALSO grantPermissions on the context as a belt-and-
//     suspenders for builds that ignore this UI flag).
//
//   --use-fake-device-for-media-stream
//     Use Chromium's built-in fake mic instead of a real one. Required for
//     headless / sandboxed CI runs that don't expose any input devices.
//
//   --use-file-for-fake-audio-capture=<abs path .wav>
//     Replace the fake mic's output with this WAV file. Chromium plays it
//     once then loops to silence (NOT continuous loop — confirmed by
//     watching the upstream finalize after one pass). We send long enough
//     audio (~4 s) that one pass produces transcribable speech.
function launchArgs(): string[] {
  return [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${FIXTURE_WAV}`,
  ];
}

// `launchOptions` can only be passed at the file's top level — putting
// it inside a describe forces Playwright to spin up a separate worker
// per group, which the runner refuses. The fake-audio flags are scoped
// to this whole file, which is fine because the only spec here needs
// them and they're harmless to other suites (each spec file is its own
// browser-launch boundary).
test.use({ launchOptions: { args: launchArgs() } });

test.describe("Voice dictation (live)", () => {
  test.beforeAll(async () => {
    if (!VOICE_ENABLED) {
      test.skip(true, "set CLAUDIUS_E2E_VOICE=1 to enable (hits live Anthropic)");
      return;
    }
    if (!existsSync(REAL_ACCOUNTS)) {
      test.skip(true, `~/.claude/.claudius/accounts.json missing — sign in first`);
      return;
    }
    if (!existsSync(FIXTURE_WAV)) {
      test.skip(true, `fixture WAV missing at ${FIXTURE_WAV}`);
      return;
    }
    // The dev server's HOME is the per-run tempdir set by
    // playwright.config.ts. Copy the user's accounts.json in so the
    // voice-stream proxy can resolve an OAuth token. Sandbox isolation
    // is preserved everywhere else — only this one file leaks across.
    const home = process.env.CLAUDIUS_E2E_HOME;
    if (!home) {
      test.skip(true, "CLAUDIUS_E2E_HOME not set — playwright.config wiring broken?");
      return;
    }
    const dst = join(home, ".claude", ".claudius", "accounts.json");
    mkdirSync(join(home, ".claude", ".claudius"), { recursive: true });
    copyFileSync(REAL_ACCOUNTS, dst);

    // Sanity-check: the file we just dropped in has an active OAuth
    // profile. If it's only api-key profiles the voice route returns
    // "no-auth" and the spec would fail with a confusing assertion.
    const accounts = JSON.parse(readFileSync(dst, "utf8")) as {
      profiles: { kind: string }[];
      activeProfileId?: string;
    };
    const active = accounts.profiles.find(
      (p) => "id" in p && (p as { id: string }).id === accounts.activeProfileId,
    );
    if (!active || active.kind !== "oauth-token") {
      test.skip(
        true,
        "active profile is not oauth-token — voice dictation requires Claude.ai login",
      );
    }
  });

  test("mic button transcribes injected audio into the composer", async ({
    page,
    context,
  }, testInfo) => {
    if (!VOICE_ENABLED) test.skip();

    // Belt-and-suspenders permission grant — the `--use-fake-ui-for-
    // media-stream` flag already implicit-grants, but explicit grant
    // also covers any future Chromium release that re-prompts.
    if (testInfo.project.name === "chromium") {
      await context.grantPermissions(["microphone"]);
    }

    // Diagnostic trace — every page console + every voice-route
    // request/response/error, captured BEFORE navigation so we don't
    // miss anything emitted during initial load. Dumped to test output
    // when the spec fails so the failure mode is debuggable.
    const traceLog: string[] = [];
    page.on("console", (msg) => {
      traceLog.push(`[page:${msg.type()}] ${msg.text()}`);
    });
    page.on("pageerror", (err) => {
      traceLog.push(`[page:error] ${err.message}`);
    });
    page.on("requestfailed", (req) => {
      if (req.url().includes("/api/voice")) {
        traceLog.push(
          `[net:fail] ${req.method()} ${req.url()} — ${req.failure()?.errorText}`,
        );
      }
    });
    page.on("response", (res) => {
      const url = res.url();
      if (url.includes("/api/voice")) {
        traceLog.push(`[net] ${res.request().method()} ${url} → ${res.status()}`);
      }
    });

    // Tap the renderer's EventSource at construction so every voice-
    // stream event is logged. addInitScript MUST run before page.goto
    // or the script doesn't take effect for the initial document.
    await page.addInitScript(() => {
      const Real = window.EventSource;
      window.EventSource = new Proxy(Real, {
        construct(target, args) {
          const url = String(args[0]);
          const es = Reflect.construct(target, args) as EventSource;
          if (url.includes("/api/voice/stream")) {
            ["open", "ready", "error", "close", "message"].forEach((name) => {
              es.addEventListener(name, (ev: Event) => {
                const data = (ev as MessageEvent).data;
                console.log(
                  `[voice-trace] ${name} ${typeof data === "string" ? data : ""}`.slice(0, 200),
                );
              });
            });
          }
          return es;
        },
      }) as unknown as typeof EventSource;
    });

    await page.goto("/");

    // The chat shell renders the composer once the workspace activates.
    // Reuse the same testid the rest of the suite uses.
    const composer = page.getByTestId("prompt-input");
    await expect(composer).toBeVisible({ timeout: 30_000 });

    const mic = page.getByTestId("prompt-mic");
    await expect(mic).toBeVisible();

    // Start dictation. The button becomes red (`bg-red-500/90`) once
    // listening — that's the same UI signal the user sees.
    await mic.click();
    await expect(mic).toHaveClass(/bg-red-500/, { timeout: 5_000 });

    // The injected WAV says "hello world this is a quick test of voice
    // dictation can you hear me clearly". The upstream emits interim
    // chunks roughly every 100-200 ms; we wait for "hello" to appear
    // in the textarea — that's the cheapest signal the full path
    // (capture → worklet → SSE → composer stitch) is live.
    try {
      await expect(composer).toHaveValue(/hello/i, { timeout: 20_000 });
    } catch (err) {
      // Dump the trace synchronously before letting Playwright finish
      // the failure — otherwise the artifact directory only carries
      // the screenshot/video and you have to dig into the trace.zip
      // to see what came back from the upstream.
      console.error(
        `[voice-dictation.spec] textarea never received "hello"; trace:\n  ${traceLog.join("\n  ")}`,
      );
      throw err;
    }

    // Let the upstream collect a few more interim updates so the final
    // transcript covers more of the sentence. The `say` output is
    // robotic and transcription quality varies — we only require
    // "hello" and "voice" to be present in the final value.
    await expect(composer).toHaveValue(/voice/i, { timeout: 15_000 });

    // Stop dictation. This POSTs /api/voice/close, the upstream sends a
    // final TranscriptText, the server emits `event: close`, the
    // EventSource closes, the button reverts to idle.
    await mic.click();
    await expect(mic).not.toHaveClass(/bg-red-500/, { timeout: 10_000 });

    // The final transcript landed in the textarea. We don't assert the
    // entire sentence — STT for `say`-generated speech sometimes mis-
    // hears a word (the live probe captured "ticketing" before
    // self-correcting to "dictation"). Cover the high-signal words.
    const final = await composer.inputValue();
    expect(final.toLowerCase()).toContain("hello");
    expect(final.toLowerCase()).toContain("voice");

    if (final.length < 20) {
      // Surface the captured trace when the assertion would otherwise
      // be opaque. Helpful when the audio-capture flag silently fails.
      console.warn(
        `[voice-dictation.spec] final value short (${final.length} chars): "${final}"\n` +
          `trace:\n  ${traceLog.join("\n  ")}`,
      );
    }
  });
});
