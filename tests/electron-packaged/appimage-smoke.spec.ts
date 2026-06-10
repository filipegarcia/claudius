/**
 * Post-release smoke for the PACKAGED Linux desktop artifact.
 *
 * This is the test that would have caught the AppImage launch crash: the
 * dev-server-backed `chromium-electron` project never runs the real
 * artifact, so a packaging/sandbox regression sails through CI and only
 * surfaces when a user double-clicks the download.
 *
 * Driven by the release pipeline (`.github/workflows/release.yml` →
 * `linux-smoke` job): it downloads the just-built `*.AppImage`, self-extracts
 * it (`--appimage-extract`, no FUSE), points `CLAUDIUS_PACKAGED_BINARY` at the
 * unpacked Electron binary and exports `APPIMAGE`/`APPDIR` so the binary takes
 * the same launch path as a real double-clicked AppImage. The job restricts
 * unprivileged user namespaces first, forcing Chromium onto the setuid-sandbox
 * path the AppImage can't satisfy, then runs this spec under xvfb. Without
 * electron/main.ts's AppImage `--no-sandbox` guard the app aborts at launch and
 * `launchPackaged` / `waitForMainWindow` fail; with it, the window comes up and
 * the embedded server answers.
 */
import { existsSync } from "node:fs";
import { expect, test } from "@playwright/test";

import {
  launchPackaged,
  teardownPackaged,
  waitForMainWindow,
  type LaunchedPackaged,
} from "./launch";

const BINARY = process.env.CLAUDIUS_PACKAGED_BINARY;

// No-op locally / anywhere the artifact isn't provided. The release job is
// the only place this is meant to run.
test.skip(
  !BINARY,
  "CLAUDIUS_PACKAGED_BINARY not set — packaged-artifact smoke runs in the release pipeline only",
);
// Platform guard: `playwright test --config=…electron-packaged…` discovers
// this spec alongside `mac-smoke.spec.ts`. Without this guard, a macOS
// smoke job's CLAUDIUS_PACKAGED_BINARY would un-skip this AppImage spec
// too and it'd fail trying to launch a Mach-O via the AppRun helper. Skip
// on the wrong platform so each job runs exactly the spec it's meant to.
test.skip(
  process.platform !== "linux",
  `appimage-smoke runs on linux only (got ${process.platform})`,
);

// One window cold-start per test is expensive; give the file room.
test.describe.configure({ timeout: 150_000 });

let launched: LaunchedPackaged;

test.beforeEach(async () => {
  expect(
    existsSync(BINARY as string),
    `packaged binary not found at ${BINARY}`,
  ).toBe(true);
  launched = await launchPackaged(BINARY as string);
});

test.afterEach(async () => {
  if (launched) await teardownPackaged(launched);
});

test("packaged Linux app launches and renders the chat shell", async () => {
  const page = await waitForMainWindow(launched.app);
  await page.waitForLoadState("domcontentloaded");
  // <TitleBar /> only mounts in the Electron build, and only after the
  // embedded server SSR'd `/`. Its presence proves: process launched (no
  // sandbox abort) → embedded Next booted → native modules loaded →
  // renderer hydrated.
  await expect(page.locator('[data-testid="titlebar"]')).toBeVisible({
    timeout: 60_000,
  });
});

test("embedded server answers /api/heartbeat", async () => {
  const page = await waitForMainWindow(launched.app);
  await page.waitForLoadState("domcontentloaded");
  // Fetch from the renderer's own loopback origin so we don't have to know
  // the embedded server's randomly-assigned port.
  const result = await page.evaluate(async () => {
    const res = await fetch("/api/heartbeat");
    return { ok: res.ok, status: res.status };
  });
  expect(result.ok, `heartbeat returned ${result.status}`).toBe(true);
});

test("main process emits no fatal markers to stdout/stderr", async () => {
  // See `mac-smoke.spec.ts` for the full rationale of the patterns below
  // and why this complements the UI-level assertions. Same list — these
  // are platform-agnostic regression classes. The release job's shell
  // greps cover the Linux-specific ones (libfuse2, sandbox abort); this
  // covers the embedded-server / SDK / native-module class.
  const page = await waitForMainWindow(launched.app);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.locator('[data-testid="titlebar"]')).toBeVisible({
    timeout: 60_000,
  });
  await page.waitForTimeout(2000);

  const logs = launched.readLogs();
  const fatals = [
    { name: "SDK spawn failure", pattern: /exists but failed to launch/i },
    { name: "Missing module", pattern: /Cannot find module/i },
    {
      name: "Wrong-arch native module",
      pattern: /dlopen[^\n]*incompatible architecture/i,
    },
    { name: "Uncaught exception", pattern: /Uncaught Exception/i },
    { name: "Unhandled promise rejection", pattern: /UnhandledPromiseRejection/i },
    { name: "Port collision", pattern: /EADDRINUSE/i },
  ];
  const hits = fatals.filter((f) => f.pattern.test(logs));
  expect(
    hits,
    `Main process emitted fatal-class log lines: ${hits.map((h) => h.name).join(", ")}.\n\n--- captured stdio (first 4 KB) ---\n${logs.slice(0, 4096)}\n--- captured stdio (last 2 KB) ---\n${logs.slice(-2048)}`,
  ).toEqual([]);
});

test("renderer console emits no error-level messages during boot", async () => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  launched.app.on("window", (w) => {
    w.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    w.on("pageerror", (err) => {
      pageErrors.push(err.message);
    });
  });

  const page = await waitForMainWindow(launched.app);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.locator('[data-testid="titlebar"]')).toBeVisible({
    timeout: 60_000,
  });
  await page.waitForTimeout(2000);

  const NOISE = [
    /Download the React DevTools/i,
    /ResizeObserver loop/i,
  ];
  const isNoise = (s: string) => NOISE.some((re) => re.test(s));
  const realConsoleErrors = consoleErrors.filter((s) => !isNoise(s));

  expect(
    pageErrors,
    `Renderer hit uncaught page errors: ${pageErrors.join(" | ")}`,
  ).toEqual([]);
  expect(
    realConsoleErrors,
    `Renderer logged console.error during boot: ${realConsoleErrors.join(" | ")}`,
  ).toEqual([]);
});
