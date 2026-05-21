/**
 * Electron e2e — Chat composer accepts keystrokes.
 *
 * Coverage row: COVERAGE.md §6 "App features — chat surface".
 *
 * Scope
 * -----
 * The renderer reportedly had cases where "no buttons work" — keyboard
 * events seemed to be swallowed somewhere on the boot path. This is
 * the minimum-viable repro: type into the prompt composer, assert the
 * characters land in the value, and assert no unexpected console
 * errors fired while we did it.
 *
 * Why this is a meaningful test (not redundant with the browser
 * suite): the Electron renderer is configured with `sandbox: true`
 * and a preload bridge, both of which can subtly break event
 * propagation if a future change misconfigures them. Running this
 * under chromium-electron is the canary.
 *
 * Driven by the autonomous e2e Ralph loop — see
 * docs/electron-conversion/E2E_LOOP_PROMPT.md.
 */
import { expect, test, type ConsoleMessage } from "@playwright/test";

import { launchElectron, teardownElectron, type LaunchedElectron } from "./launch";

let launched: LaunchedElectron;

test.beforeEach(async () => {
  launched = await launchElectron();
});

test.afterEach(async () => {
  await teardownElectron(launched);
});

test("chat-surface: prompt-input accepts typed keystrokes", async () => {
  const page = await launched.app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  // Capture console errors so we can fail loudly if the composer's
  // controlled-input wiring throws on each keystroke.
  const consoleErrors: string[] = [];
  page.on("console", (msg: ConsoleMessage) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  const composer = page.getByTestId("prompt-input");
  await expect(composer).toBeVisible({ timeout: 30_000 });

  // Click into the composer first so the typed event lands on the
  // textarea — without focus, `page.keyboard.type` would just float
  // into the body and we'd think the textarea was broken.
  await composer.click();

  const sample = "the quick brown fox jumps over the lazy dog";
  await page.keyboard.type(sample, { delay: 10 });

  await expect(composer).toHaveValue(sample);

  // Char counter (lower-right of the composer) reflects the typed
  // length. If the controlled-input pipeline were broken on a single
  // keystroke we'd see "0 chars" here.
  const charCounter = page.getByText(`${sample.length} chars`);
  await expect(charCounter).toBeVisible({ timeout: 5_000 });

  expect(
    consoleErrors,
    `composer typing produced ${consoleErrors.length} console error(s):\n${consoleErrors.join("\n")}`,
  ).toEqual([]);
});
