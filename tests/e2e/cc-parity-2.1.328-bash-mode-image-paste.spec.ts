/**
 * CC 2.1.328 parity — "Fixed an image path pasted into a `!` command becoming
 * an attachment".
 *
 * Claudius never turns pasted *text* into an attachment, but an image *file*
 * pasted (copied in Finder) or dropped while the composer was in `!` (shell)
 * mode was attached anyway, and an `[Image #N] ` token landed in the command.
 * The bash route sends only the text, so the image was dropped and
 * `!ls [Image #1]` ran `ls [Image`. In `!` mode the file now goes in as its
 * shell-quoted path (in a browser tab, the file name — all the File API
 * gives), with no attachment. Outside `!` mode an image still attaches.
 *
 * Screenshot target: docs/cc-parity/2.1.328/bash-mode-image-paste.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";
import { initEvent, mockChatBackend } from "./helpers/mock-chat";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.328");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-00000328bm01";

// A 1×1 transparent PNG, so the non-`!` control really attaches an image.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

async function setup(page: Page): Promise<{ commands: string[] }> {
  const commands: string[] = [];
  await mockChatBackend(page, FAKE_SESSION_ID, [
    { type: "ready", sessionId: FAKE_SESSION_ID },
    initEvent("sys-init-328bm"),
    { type: "replay_done", hasMoreAbove: false },
  ]);
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/prompt-draft`, (route: Route) =>
    route.request().method() === "GET"
      ? route.fulfill({ json: { text: "", images: [] } })
      : route.fulfill({ json: { ok: true } }),
  );
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/bash`, (route: Route) => {
    const body = route.request().postDataJSON() as { command?: string };
    commands.push(body.command ?? "");
    return route.fulfill({ json: { ok: true, exitCode: 0, stdout: "", stderr: "" } });
  });
  return { commands };
}

/** Paste an image File at the end of the composer, as a Finder copy would. */
async function pasteImage(page: Page, name: string): Promise<void> {
  await page.evaluate(
    ({ name, b64 }) => {
      const ta = document.querySelector<HTMLTextAreaElement>('[data-testid="prompt-input"]')!;
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], name, { type: "image/png" }));
      ta.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    },
    { name, b64: PNG_BASE64 },
  );
}

/** Drop an image File onto the chat area (the composer's wide drop zone). */
async function dropImage(page: Page, name: string): Promise<void> {
  await page.evaluate(
    ({ name, b64 }) => {
      const area = document.querySelector<HTMLElement>('[data-pane-name="chat-area"]')!;
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], name, { type: "image/png" }));
      for (const type of ["dragenter", "dragover", "drop"]) {
        area.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
      }
    },
    { name, b64: PNG_BASE64 },
  );
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test("an image pasted into a `!` command goes in as its path, not an attachment", async ({ page }) => {
  const { commands } = await setup(page);
  await page.goto("/");

  const composer = page.getByTestId("prompt-input");
  await expect(composer).toBeEnabled({ timeout: 15_000 });
  await composer.fill("!ls -l ");
  await expect(page.getByTestId("prompt-bash-chip")).toBeVisible();

  await pasteImage(page, "Screen Shot.png");
  await expect(composer).toHaveValue("!ls -l 'Screen Shot.png' ");
  await expect(page.getByTestId("prompt-attachments")).toHaveCount(0);

  await page.waitForTimeout(100);
  await page.screenshot({ path: resolve(SHOTS_DIR, "bash-mode-image-paste.png"), fullPage: false });

  // Enter runs the command with the path, not with an `[Image #1]` token.
  await composer.press("Enter");
  await expect.poll(() => commands.length).toBe(1);
  expect(commands[0]).toBe("ls -l 'Screen Shot.png'");
});

test("an image dropped on the chat in `!` mode goes in as its path", async ({ page }) => {
  await setup(page);
  await page.goto("/");

  const composer = page.getByTestId("prompt-input");
  await expect(composer).toBeEnabled({ timeout: 15_000 });
  await composer.fill("!open ");
  await dropImage(page, "diagram.png");
  await expect(composer).toHaveValue("!open diagram.png ");
  await expect(page.getByTestId("prompt-attachments")).toHaveCount(0);
});

test("outside `!` mode a pasted image still attaches", async ({ page }) => {
  await setup(page);
  await page.goto("/");

  const composer = page.getByTestId("prompt-input");
  await expect(composer).toBeEnabled({ timeout: 15_000 });
  await composer.fill("what is in ");
  await pasteImage(page, "diagram.png");
  await expect(page.getByTestId("prompt-attachments")).toBeVisible();
  await expect(composer).toHaveValue("what is in [Image #1] ");
});
