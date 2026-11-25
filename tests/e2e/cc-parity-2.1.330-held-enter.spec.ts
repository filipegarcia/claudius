/**
 * CC 2.1.330 parity — "[VSCode] Fixed a held-down Enter key sending a
 * half-written message or running a typed slash command".
 *
 * In Claudius the `@` and `/` pickers consumed only the keystroke that picked.
 * Holding Enter after `@lib/fo` inserted the mention, then the keyboard's
 * auto-repeat keydowns reached the composer with the picker closed and sent
 * the half-written message. Holding Enter on `/comp` completed `/compact` and
 * a repeat ran it. Auto-repeats now never pick, send or run; a fresh Enter
 * still sends.
 *
 * Playwright marks a second `keyboard.down` without an `up` as `repeat`.
 */

import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";
import { initEvent, mockChatBackend } from "./helpers/mock-chat";

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-00000330he01";

async function setup(page: Page): Promise<{ inputs: string[] }> {
  const inputs: string[] = [];
  await mockChatBackend(page, FAKE_SESSION_ID, [
    { type: "ready", sessionId: FAKE_SESSION_ID },
    initEvent("sys-init-330he"),
    { type: "replay_done", hasMoreAbove: false },
  ]);
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/prompt-draft`, (route: Route) =>
    route.request().method() === "GET"
      ? route.fulfill({ json: { text: "", images: [] } })
      : route.fulfill({ json: { ok: true } }),
  );
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/input`, (route: Route) => {
    const body = route.request().postDataJSON() as { text?: string };
    inputs.push(body?.text ?? "");
    return route.fulfill({ json: { ok: true, queued: false, uuid: `u-${inputs.length}` } });
  });
  await page.route("**/api/fs/list**", (route: Route) =>
    route.fulfill({
      json: { entries: [{ relPath: "lib/foo.ts", absPath: "/repo/lib/foo.ts", type: "file" }] },
    }),
  );
  return { inputs };
}

/** Press and hold Enter: one fresh keydown plus auto-repeats, then release. */
async function holdEnter(page: Page, repeats = 3): Promise<void> {
  await page.keyboard.down("Enter");
  for (let i = 0; i < repeats; i++) await page.keyboard.down("Enter");
  await page.keyboard.up("Enter");
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test("holding Enter on the @ picker inserts the file and sends nothing", async ({ page }) => {
  const { inputs } = await setup(page);
  await page.goto("/");

  const composer = page.getByTestId("prompt-input");
  await expect(composer).toBeEnabled({ timeout: 15_000 });
  await composer.focus();
  await composer.pressSequentially("look at @lib/fo");
  await expect(page.getByTestId("picker-selected-pointer")).toHaveCount(1);

  await holdEnter(page);
  await expect(composer).toHaveValue("look at @lib/foo.ts ");
  // Give a stray send time to happen.
  await page.waitForTimeout(400);
  expect(inputs).toEqual([]);

  // A fresh Enter still sends the finished message.
  await page.keyboard.press("Enter");
  await expect.poll(() => inputs.length).toBe(1);
  expect(inputs[0]).toBe("look at @lib/foo.ts");
});

test("holding Enter on the / picker completes the command without running it", async ({ page }) => {
  const { inputs } = await setup(page);
  await page.goto("/");

  const composer = page.getByTestId("prompt-input");
  await expect(composer).toBeEnabled({ timeout: 15_000 });
  await composer.focus();
  await composer.pressSequentially("/comp");
  await expect(page.getByTestId("picker-selected-pointer")).toHaveCount(1);

  await holdEnter(page);
  await expect(composer).toHaveValue("/compact ");
  await page.waitForTimeout(400);
  // Not run: the composer still holds it and nothing was sent.
  await expect(composer).toHaveValue("/compact ");
  expect(inputs).toEqual([]);
});
