/**
 * CC 2.1.326 parity — "Fixed /memory opening a read-only file with no
 * warning that changes may not save".
 *
 * Claudius's Memory page edits CLAUDE.md natively. `GET /api/claudemd` now
 * reports `writable` per scope; when the active file isn't writable the page
 * shows an amber read-only notice above the editor, and when the PUT fails
 * the error (file + errno) is shown and the draft stays dirty instead of
 * being silently marked saved.
 *
 * This spec mocks the claudemd API so the Project scope is read-only and the
 * save fails with EACCES, then asserts the notice, the error, and that the
 * edit is kept (Save still enabled, textarea still holds the typed text).
 *
 * Screenshot target: docs/cc-parity/2.1.326/memory-readonly.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";
import { MEMORY_READONLY_NOTICE } from "../../lib/shared/claudemd-writable";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.326");
mkdirSync(SHOTS_DIR, { recursive: true });

const CWD = process.cwd();
const PROJECT_PATH = `${CWD}/CLAUDE.md`;
const PROJECT_CONTENT = "# Project instructions\n\nRun `bun run lint` before committing.\n";
const SAVE_ERROR = `Couldn't save ${PROJECT_PATH}: EACCES (permission denied)`;

async function mockClaudeMdBackend(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname === "/api/claudemd",
    async (route: Route) => {
      const req = route.request();
      if (req.method() === "PUT") {
        return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: SAVE_ERROR }) });
      }
      if (req.method() !== "GET") return route.fallback();
      const url = new URL(req.url());
      if (url.searchParams.get("resolved") === "1") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            cwd: CWD,
            scopes: [
              { scope: "user", path: "~/.claude/CLAUDE.md", exists: false, segments: [] },
              {
                scope: "project",
                path: PROJECT_PATH,
                exists: true,
                segments: [{ scope: "import", source: "(inline)", content: PROJECT_CONTENT, depth: 0 }],
              },
              { scope: "project-claude", path: `${CWD}/.claude/CLAUDE.md`, exists: false, segments: [] },
              { scope: "local", path: `${CWD}/CLAUDE.local.md`, exists: false, segments: [] },
            ],
            totalChars: PROJECT_CONTENT.length,
          }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          cwd: CWD,
          scopes: [
            { scope: "user", path: "~/.claude/CLAUDE.md", exists: false, content: "", writable: true },
            { scope: "project", path: PROJECT_PATH, exists: true, content: PROJECT_CONTENT, writable: false },
            { scope: "project-claude", path: `${CWD}/.claude/CLAUDE.md`, exists: false, content: "", writable: true },
            { scope: "local", path: `${CWD}/CLAUDE.local.md`, exists: false, content: "", writable: true },
          ],
        }),
      });
    },
  );

  await page.route("**/api/sessions", async (route: Route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([]) });
  });
}

/**
 * The app-wide updater banner reflects the dev machine's real updater state
 * (not mocked here) and has nothing to do with this feature — dismiss it so
 * the screenshot shows the page chrome without unrelated noise.
 */
async function dismissUpdaterBanner(page: Page): Promise<void> {
  const dismiss = page.getByRole("button", { name: /^Dismiss (updater error|update-feed notice|for this session|for 24 hours|until a newer version is available)$/ });
  for (let i = 0; i < 3 && (await dismiss.count()) > 0; i++) {
    await dismiss.first().click().catch(() => {});
  }
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test.describe("Memory page read-only warning (CC 2.1.326)", () => {
  test("read-only CLAUDE.md shows a notice and a failed save keeps the draft", async ({ page }) => {
    test.setTimeout(60_000);
    await mockClaudeMdBackend(page);

    const { activeId } = (await page.request.get("/api/workspaces").then((r) => r.json())) as {
      activeId: string | null;
    };
    expect(activeId, "an active workspace").toBeTruthy();

    const claudemdLoaded = page.waitForResponse(
      (r) => new URL(r.url()).pathname === "/api/claudemd" && !r.url().includes("resolved=1"),
    );
    await page.goto(`/${activeId}/memory`);
    await claudemdLoaded;

    const editor = page.getByTestId("claudemd-editor");
    await expect(editor).toHaveValue(PROJECT_CONTENT, { timeout: 15_000 });

    const notice = page.getByTestId("claudemd-readonly-notice");
    await expect(notice).toBeVisible();
    await expect(notice).toHaveText(MEMORY_READONLY_NOTICE);
    await expect(notice).toHaveCount(1);

    // The notice warns, it doesn't block — editing and Save stay available.
    const save = page.getByTestId("claudemd-save");
    await expect(save).toBeDisabled();
    await editor.fill(`${PROJECT_CONTENT}\nNever push to main.\n`);
    await expect(save).toBeEnabled();

    const putDone = page.waitForResponse(
      (r) => new URL(r.url()).pathname === "/api/claudemd" && r.request().method() === "PUT",
    );
    await save.click();
    await putDone;

    const saveError = page.getByTestId("claudemd-save-error");
    await expect(saveError).toBeVisible();
    await expect(saveError).toHaveText(SAVE_ERROR);
    // The failed write isn't marked saved: draft kept, Save still enabled.
    await expect(editor).toHaveValue(/Never push to main\./);
    await expect(save).toBeEnabled();
    await expect(save).toHaveText("Save");

    await dismissUpdaterBanner(page);
    await page.waitForTimeout(300);
    await page.screenshot({ path: resolve(SHOTS_DIR, "memory-readonly.png"), fullPage: false });
  });
});
