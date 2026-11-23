import { test, expect, type Page } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

/**
 * The workspace redirects (rust/parity/server-components.md § 3, N03b).
 * Next alone makes them in the browser (`components/nav/WorkspaceRedirects`);
 * behind the Rust front door, its page rules (R1, R2, R4, R5) answer with a
 * 307 first. Both must land on the same URL, so every test here runs
 * unchanged on both backends.
 *
 * Not covered: a zero-workspace install (`/` → `/welcome`, and the splash
 * itself), because global-setup seeds `workspaces.json` and the Rust rules
 * read that file, not `/api/workspaces`.
 */

const COOKIE = "claudius.workspace";

/** The workspace `/` resolves to: the server's `activeId`. */
async function activeId(page: Page): Promise<string> {
  const r = await page.request.get("/api/workspaces");
  expect(r.ok()).toBeTruthy();
  const { activeId } = (await r.json()) as { activeId: string | null };
  expect(activeId, "a seeded workspace is active").toBeTruthy();
  return activeId!;
}

function exactUrl(baseURL: string | undefined, path: string): string {
  return new URL(path, baseURL).toString();
}

test.describe("Workspace redirects", () => {
  test.beforeEach(async ({ page }) => {
    await activateClaudiusWorkspace(page);
  });

  test("the chat root goes to the active workspace and keeps the query", async ({ page, baseURL }) => {
    const id = await activeId(page);
    await page.goto("/?probe=1");
    await page.waitForURL(exactUrl(baseURL, `/${id}?probe=1`));
  });

  test("a bare path with no workspace cookie goes under the active workspace", async ({
    page,
    context,
    baseURL,
  }) => {
    const id = await activeId(page);
    // No cookie: proxy.ts (and Rust's R2) can't use one, so the store's
    // hint decides, which `select` above set.
    await context.clearCookies({ name: COOKIE });
    await page.goto("/git?probe=1");
    await page.waitForURL(exactUrl(baseURL, `/${id}/git?probe=1`));
  });

  test("a bare catch-all path keeps its tail", async ({ page, context, baseURL }) => {
    const id = await activeId(page);
    await context.clearCookies({ name: COOKIE });
    await page.goto("/dev/chat-empty?probe=1");
    await page.waitForURL(exactUrl(baseURL, `/${id}/dev/chat-empty?probe=1`));
  });

  test("/welcome goes to the active workspace once one exists, without showing the splash", async ({
    page,
    baseURL,
  }) => {
    const id = await activeId(page);
    await page.addInitScript(() => {
      const w = window as unknown as { __splashSeen?: boolean };
      new MutationObserver(() => {
        if (document.querySelector('[data-testid="welcome-splash"]')) w.__splashSeen = true;
      }).observe(document, { childList: true, subtree: true });
    });
    await page.goto("/welcome");
    await page.waitForURL(exactUrl(baseURL, `/${id}`));
    expect(await page.evaluate(() => (window as unknown as { __splashSeen?: boolean }).__splashSeen ?? false)).toBe(
      false,
    );
  });

  test("an unknown workspace id goes to the active workspace, starting no session on the way", async ({
    page,
    baseURL,
  }) => {
    const id = await activeId(page);
    const stale = "wks_000000000000";
    expect(stale).not.toBe(id);
    const staleSessionPosts: string[] = [];
    page.on("request", (req) => {
      if (req.method() !== "POST" || new URL(req.url()).pathname !== "/api/sessions") return;
      if (req.frame().url().includes(stale)) staleSessionPosts.push(req.frame().url());
    });
    await page.goto(`/${stale}`);
    // The stale id lands in the cookie on the way (proxy.ts / R3); the root
    // then falls back to the store's hint, the workspace `select` set.
    await page.waitForURL(exactUrl(baseURL, `/${id}`));
    await expect(page.getByTestId("prompt-input")).toBeVisible({ timeout: 30_000 });
    expect(staleSessionPosts).toEqual([]);
  });
});
