/**
 * CC 2.1.280 parity — `@` file-suggestion ranking
 *
 * Upstream: "Improved `@` file suggestions: a file whose name contains the
 * query now ranks above one that only matches across its folder names."
 *
 * Claudius's `@`-mention picker (`components/chat/AtMentionPicker.tsx`) is
 * backed by `lib/server/fs-list.ts`'s `listFs()`, which already scored
 * prefix > substring > subsequence matches against the full relative path
 * — but gave no weight to *where* the match landed, so a file whose match
 * only existed because of a parent folder's name could out-rank a file
 * whose own name matches. `listFs` now adds a ranking bonus for a basename
 * match — see the fix + unit coverage in
 * `tests/unit/fs-list-filename-ranking.test.ts`.
 *
 * Fixture note: the discriminating case needs a *shallow folder-prefix*
 * match (`config-utils/index.ts` — the pre-fix scorer's highest tier,
 * since the full relative path itself starts with the query) racing a
 * *deep filename* match (`deep/nested/dir/config.ts` — a lower pre-fix
 * tier, a plain substring match deep in the path) whose own basename
 * contains the query. Pre-fix, the shallow folder match wins; post-fix,
 * the filename match wins. The real repo checkout doesn't happen to
 * contain that shape, so — mirroring
 * `cc-parity-2.1.222-diff-raw-content.spec.ts`'s pattern — this spec
 * builds a disposable temp-dir workspace with exactly that fixture rather
 * than asserting against whatever the live repo tree happens to contain.
 *
 * Screenshot target: docs/cc-parity/2.1.280/at-mention-filename-ranking.png
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, expect } from "../helpers/test";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.280");
mkdirSync(SHOTS_DIR, { recursive: true });

const SESSION_RE = /[?&]session=([0-9a-f-]{36})/i;

test.describe("CC 2.1.280 — @-mention file suggestions rank filename matches above folder-only matches", () => {
  test("a filename match ranks above a shallower folder-only match, in the composer's @-mention picker", async ({
    page,
    baseURL,
  }) => {
    test.setTimeout(60_000);

    const dir = mkdtempSync(join(tmpdir(), "claudius-at-mention-ranking-"));
    mkdirSync(join(dir, "config-utils"), { recursive: true });
    writeFileSync(join(dir, "config-utils", "index.ts"), "");
    mkdirSync(join(dir, "deep", "nested", "dir"), { recursive: true });
    writeFileSync(join(dir, "deep", "nested", "dir", "config.ts"), "");

    const created = await page.request.post(`${baseURL}/api/workspaces`, {
      data: { name: `at-mention-ranking-${Date.now()}`, rootPath: dir },
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
      await page.waitForTimeout(500);
      await composer.fill("");
      await composer.click();
      await composer.pressSequentially("@config", { delay: 20 });

      // Wait for the fs/list fetch to resolve so the picker has real rows.
      await expect(page.getByText("loading…")).toHaveCount(0, { timeout: 10_000 });
      await expect(page.getByText("deep/nested/dir/config.ts")).toBeVisible({ timeout: 10_000 });
      await expect(page.getByText("config-utils/index.ts")).toBeVisible();

      const labels = await page.locator("span.truncate.font-mono").allTextContents();
      const filenameMatchIdx = labels.indexOf("deep/nested/dir/config.ts");
      const folderOnlyMatchIdx = labels.indexOf("config-utils/index.ts");

      expect(filenameMatchIdx).toBeGreaterThanOrEqual(0);
      expect(folderOnlyMatchIdx).toBeGreaterThanOrEqual(0);
      expect(filenameMatchIdx).toBeLessThan(folderOnlyMatchIdx);

      await page.waitForTimeout(200);
      await page.screenshot({
        path: resolve(SHOTS_DIR, "at-mention-filename-ranking.png"),
        fullPage: false,
      });
    } finally {
      await page.request.delete(`${baseURL}/api/workspaces/${ws.id}`).catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
