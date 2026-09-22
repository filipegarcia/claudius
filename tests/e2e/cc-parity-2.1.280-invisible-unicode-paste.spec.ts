/**
 * CC 2.1.280 parity — "[VSCode] Improved prompt handling in the chat box:
 * invisible Unicode formatting and tag characters are removed from pasted
 * text with a notice, and from anything else before it is sent."
 *
 * Claudius reimplements this in the composer itself
 * (`components/chat/PromptInput.tsx` + `lib/shared/invisible-unicode.ts`),
 * since prompt text is typed directly into the browser and never round-trips
 * through the bundled CLI before the user sees it. The composer now:
 *   - intercepts a plain-text paste, strips zero-width/tag/bidi-control
 *     characters, and hand-inserts the cleaned text at the caret, and
 *   - shows a transient footer notice ("Removed N hidden character(s)")
 *     when it actually stripped something.
 *
 * `lib/shared/invisible-unicode.ts` has its own focused unit coverage
 * (`tests/unit/invisible-unicode.test.ts`) for the character-range edge
 * cases (tag-block smuggling, bidi overrides, preserving ZWNJ). This spec
 * exercises the composer's real DOM paste path and the visible notice —
 * the pre-send strip in `submit()` reuses the same helper and isn't
 * separately driven end-to-end here (would require a full mocked SDK
 * session for no additional coverage of the actual stripping logic).
 *
 * Screenshot target: docs/cc-parity/2.1.280/invisible-unicode-paste-notice.png
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, expect } from "../helpers/test";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.280");
mkdirSync(SHOTS_DIR, { recursive: true });

const SESSION_RE = /[?&]session=([0-9a-f-]{36})/i;

// Zero-width space, zero-width joiner, and an RTL override — three
// invisible characters that have no visual footprint, interleaved with
// visible text so the "cleaned" assertion can't pass by accident.
const PASTE_TEXT = "hidden​message‍here‮test";
const EXPECTED_CLEANED = "hiddenmessageheretest";

test.describe("CC 2.1.280 — invisible Unicode formatting/tag characters stripped from pasted composer text", () => {
  test("pasting text with hidden characters cleans it and shows a footer notice", async ({ page, baseURL }) => {
    test.setTimeout(60_000);

    const dir = mkdtempSync(join(tmpdir(), "claudius-invisible-unicode-"));

    const created = await page.request.post(`${baseURL}/api/workspaces`, {
      data: { name: `invisible-unicode-${Date.now()}`, rootPath: dir },
    });
    expect(created.ok(), "creating the throwaway workspace").toBeTruthy();
    const ws = (await created.json()) as { id: string };

    try {
      await page.request.post(`${baseURL}/api/workspaces/${ws.id}/select`);

      await page.goto("/");
      await page.waitForURL((url) => SESSION_RE.test(String(url)), { timeout: 30_000 });

      const composer = page.getByTestId("prompt-input");
      await expect(composer).toBeVisible({ timeout: 30_000 });
      await expect(composer).toBeEnabled({ timeout: 30_000 });
      await composer.click();

      // Playwright's `fill`/`type` don't fire a native ClipboardEvent, so we
      // dispatch one directly — this is what a real Cmd/Ctrl+V delivers.
      await page.evaluate((text) => {
        const el = document.querySelector('[data-testid="prompt-input"]') as HTMLTextAreaElement;
        el.focus();
        const dt = new DataTransfer();
        dt.setData("text/plain", text);
        const evt = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
        el.dispatchEvent(evt);
      }, PASTE_TEXT);

      const notice = page.getByTestId("prompt-invisible-unicode-notice");
      await expect(notice).toBeVisible({ timeout: 5_000 });
      await expect(notice).toHaveText("Removed 3 hidden characters");
      await expect(composer).toHaveValue(EXPECTED_CLEANED);

      await page.waitForTimeout(200);
      await page.screenshot({
        path: resolve(SHOTS_DIR, "invisible-unicode-paste-notice.png"),
        fullPage: false,
      });

      // The notice is transient — confirm it clears on its own rather than
      // lingering forever as stale chrome.
      await expect(notice).toBeHidden({ timeout: 6_000 });
    } finally {
      await page.request.delete(`${baseURL}/api/workspaces/${ws.id}`).catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

