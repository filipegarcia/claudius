/**
 * Post-release smoke for the PACKAGED macOS desktop artifact.
 *
 * Sister of `appimage-smoke.spec.ts` (Linux) — the dev-server-backed
 * `chromium-electron` project never runs the real .app, so build regressions
 * in the standalone tree (e.g. an x64 better-sqlite3 packed into an arm64
 * Electron container, like the v0.3.168.x arm64 zip), broken signing, or a
 * missing native module sail past CI and only surface when a user
 * double-clicks the download. This catches them.
 *
 * Run by the release pipeline's `macos-arm64-smoke` + `macos-x64-smoke` jobs:
 * the zip is extracted under a temp dir, quarantine is stripped, and
 * `CLAUDIUS_PACKAGED_BINARY` points at `Claudius.app/Contents/MacOS/Claudius`.
 * The x64 job runs on the same arm64 macos-14 runner; macOS auto-uses Rosetta
 * to translate the x64 Electron container, so the whole process — including
 * `ELECTRON_RUN_AS_NODE`'s embedded server and its better-sqlite3 dlopen —
 * runs as x64. That's a partial-fidelity check (Rosetta ≠ native Intel) but
 * still catches gross packaging regressions.
 *
 * Three assertions, in order of severity:
 *  1. Main window renders the chat shell (titlebar visible)
 *     → embedded Next booted, native modules loaded, renderer hydrated.
 *  2. `/api/heartbeat` answers
 *     → the API surface works end-to-end.
 *  3. Bundled `claude` SDK binary is present, executable, and the right arch
 *     → the standalone tree's per-platform SDK package was staged correctly
 *       and matches the Electron container's arch (this is THE check that
 *       catches the v0.3.168.x mixed-arch regression).
 */
import { existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { expect, test } from "@playwright/test";

import {
  launchPackaged,
  teardownPackaged,
  waitForMainWindow,
  type LaunchedPackaged,
} from "./launch";

const BINARY = process.env.CLAUDIUS_PACKAGED_BINARY;
// `CLAUDIUS_PACKAGED_ARCH` is set by the release job to the arch of the
// artifact under test (`arm64` | `x64`). Used by the SDK-binary check to
// assert the bundled `claude` is the expected arch, not just *some* arch.
const EXPECTED_ARCH = process.env.CLAUDIUS_PACKAGED_ARCH;

// No-op locally / anywhere the artifact isn't provided. The release job is
// the only place this is meant to run.
test.skip(
  !BINARY,
  "CLAUDIUS_PACKAGED_BINARY not set — packaged-artifact smoke runs in the release pipeline only",
);
// Platform guard: `playwright test --config=…electron-packaged…` discovers
// both this spec and `appimage-smoke.spec.ts`. Without this guard, a macOS
// smoke job with a Mac binary in CLAUDIUS_PACKAGED_BINARY would also try
// to run the AppImage spec (and vice-versa). Skip on the wrong platform so
// each job runs exactly the spec it's meant to.
test.skip(
  process.platform !== "darwin",
  `mac-smoke runs on darwin only (got ${process.platform})`,
);

// Cold start = require("next") inside the asar + app.prepare() + first SSR.
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

test("packaged macOS app launches and renders the chat shell", async () => {
  const page = await waitForMainWindow(launched.app);
  await page.waitForLoadState("domcontentloaded");
  // <TitleBar /> only mounts in the Electron build, and only after the
  // embedded server SSR'd `/`. Its presence proves: process launched (no
  // Gatekeeper / signing abort) → embedded Next booted → native modules
  // loaded (better-sqlite3 dlopen succeeded with the right arch) →
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
  // Open the main window so the renderer is fully booted and any startup
  // errors have had a chance to flush to stdio (the embedded server prints
  // a lot during the first SSR; we want that window to settle before
  // scanning).
  const page = await waitForMainWindow(launched.app);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.locator('[data-testid="titlebar"]')).toBeVisible({
    timeout: 60_000,
  });
  // Give Next a beat to finish its post-render flushes — stdio is line-
  // buffered, so a fatal printed during the last SSR can lag the visible
  // DOM by hundreds of ms. 2s is plenty without dragging out the suite.
  await page.waitForTimeout(2000);

  const logs = launched.readLogs();

  // The patterns below are FATAL-class — none of them appear in a healthy
  // boot, and each one corresponds to a regression class the existing UI
  // assertions might still let pass:
  //
  //   • "exists but failed to launch" — the SDK's catch-all spawn error
  //     (covers ENOENT/EACCES/EPERM/ENOTDIR/ELOOP/EROFS; reproduced by
  //     a wrong-arch claude binary OR by spawning with a missing cwd).
  //   • "Cannot find module" — a node_modules path the bundler thought it
  //     could `require()` is missing from the packaged tree (asarUnpack
  //     rule drop, electron-builder excludes regression).
  //   • "dlopen" + "incompatible architecture" — a `.node` whose binary
  //     ABI doesn't match the running Electron (the v0.3.168.x mixed-arch
  //     bug). The renderer might still hydrate if the broken module is
  //     lazy-required and the boot path doesn't touch it, so the titlebar
  //     test alone can let this through.
  //   • "Uncaught Exception" / "UnhandledPromiseRejection" — anything the
  //     main process bubbled to the top-level handler.
  //   • "EADDRINUSE" — embedded server failed to bind, fell through to a
  //     random port; on a fresh runner this is genuinely fatal (no other
  //     Claudius is running).
  //
  // Each pattern is checked separately so a failure tells you WHICH
  // dimension regressed, not just "something in logs."
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

  // Attach BEFORE waitForMainWindow so we don't miss an early console
  // error that lands as the renderer hydrates.
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
  // Same settling delay as the stdio test — async rejections + microtask
  // errors can land a frame or two after first paint.
  await page.waitForTimeout(2000);

  // Filter known-noise patterns that fire on healthy boots but aren't
  // signal. Keep this list tight — every line here is a future trap door
  // for a real regression to hide behind.
  const NOISE = [
    // React-DevTools nag in production builds — informational, not an error.
    /Download the React DevTools/i,
    // ResizeObserver loop is a long-standing benign browser warning.
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

test("bundled Claude SDK binary is the expected arch and executable", () => {
  test.skip(
    !EXPECTED_ARCH,
    "CLAUDIUS_PACKAGED_ARCH not set — skipping SDK binary arch assertion",
  );
  // The macOS binary lives at
  //   Claudius.app/Contents/MacOS/Claudius
  // and the SDK binary lives at
  //   Claudius.app/Contents/Resources/standalone/node_modules/
  //     @anthropic-ai/claude-agent-sdk-darwin-<arch>/claude
  // Walk up two levels (MacOS → Contents) then into Resources/.
  const contentsDir = dirname(dirname(BINARY as string));
  const sdkBin = join(
    contentsDir,
    "Resources",
    "standalone",
    "node_modules",
    "@anthropic-ai",
    `claude-agent-sdk-darwin-${EXPECTED_ARCH}`,
    "claude",
  );

  expect(
    existsSync(sdkBin),
    `bundled claude SDK binary not found at ${sdkBin} — the standalone-staging script (scripts/electron-stage-standalone.mjs) didn't run, or this arch wasn't installed before staging`,
  ).toBe(true);

  // +x bit. extraResources copies preserve mode, but a future packaging
  // change could quietly drop it and the SDK's spawn would fail with EACCES.
  const mode = statSync(sdkBin).mode;
  expect(
    (mode & 0o111) !== 0,
    `${sdkBin} is not executable (mode=${mode.toString(8)})`,
  ).toBe(true);

  // `file` reports the Mach-O architecture. We expect a thin Mach-O that
  // matches `EXPECTED_ARCH` — anything else is the v0.3.168.x regression
  // (arm64 zip with x64 binary in the standalone tree, or vice versa).
  const fileOut = execFileSync("/usr/bin/file", [sdkBin], { encoding: "utf8" });
  const archToken = EXPECTED_ARCH === "x64" ? "x86_64" : "arm64";
  expect(
    fileOut,
    `bundled claude SDK binary is the wrong architecture — expected ${EXPECTED_ARCH} (${archToken}), got: ${fileOut.trim()}`,
  ).toMatch(new RegExp(`Mach-O.*${archToken}`));
});
