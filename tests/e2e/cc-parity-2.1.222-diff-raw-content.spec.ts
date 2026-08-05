/**
 * CC 2.1.222 parity — "Improved the `/diff` view, the Remote Control
 * workspace diff, and file-edit diffs in Claude Code on the web sessions to
 * use raw git blob content, ignoring workspace-configured diff drivers and
 * textconv."
 *
 * A repo Claudius opens is not one we wrote — a `.gitattributes` file can
 * declare a `diff=<name>` driver whose `diff.<name>.textconv` command git
 * runs *instead of* the real file content in a diff. Without a guard, a
 * workspace (accidentally, or adversarially) configuring one of these would
 * make Claudius's own Git tab lie about what actually changed. This mirrors
 * the fix in `lib/server/git.ts` (`--no-textconv` added to every raw-content
 * diff invocation — see `tests/unit/git-diff-no-textconv.test.ts` for the
 * server-level coverage).
 *
 * This spec drives the real UI: a throwaway workspace backed by a temp git
 * repo with a textconv driver configured, a tracked file deleted (so the Git
 * tab falls back to the read-only `DiffViewer`, which renders the unified
 * diff text directly — the clearest place to see whether the driver's fixed
 * "REDACTED" string leaked into the rendered diff instead of the real
 * deleted line).
 *
 * Screenshot target: docs/cc-parity/2.1.222/diff-raw-content.png
 */

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, expect } from "../helpers/test";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.222");
mkdirSync(SHOTS_DIR, { recursive: true });

const REDACTED = "REDACTED BY TEXTCONV DRIVER";
const SECRET_LINE = "the actual secret line that changed";

function gitSync(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
      GIT_TERMINAL_PROMPT: "0",
    },
  }).trim();
}

test.describe("Git diff view ignores workspace textconv drivers (CC 2.1.222 parity)", () => {
  test("a deleted file's diff shows the real removed line, not the textconv driver's output", async ({
    page,
    baseURL,
  }) => {
    test.setTimeout(60_000);

    const dir = mkdtempSync(join(tmpdir(), "claudius-diff-textconv-"));
    gitSync(["init", "-q", "-b", "main"], dir);

    // A textconv driver that always reports a fixed string regardless of
    // real file content — the sharpest possible signal of whether the diff
    // view actually bypassed it.
    const driver = join(dir, "textconv-driver.sh");
    writeFileSync(driver, `#!/bin/sh\necho "${REDACTED}"\n`);
    chmodSync(driver, 0o755);
    gitSync(["config", "diff.redact.textconv", driver], dir);
    writeFileSync(join(dir, ".gitattributes"), "*.txt diff=redact\n");

    writeFileSync(join(dir, "file.txt"), `base content\n${SECRET_LINE}\n`);
    gitSync(["add", "."], dir);
    gitSync(["commit", "-qm", "base"], dir);

    // Delete the tracked file — worktree status `D`. selectedCanEdit is
    // false for `D`, so the Git tab falls back to the read-only DiffViewer,
    // which renders the unified diff text verbatim (the clearest surface
    // for this check — an editable file's content comes from disk, not
    // from the diff, so it wouldn't prove anything about textconv).
    unlinkSync(join(dir, "file.txt"));

    const created = await page.request.post(`${baseURL}/api/workspaces`, {
      data: { name: `diff-textconv-${Date.now()}`, rootPath: dir },
    });
    expect(created.ok(), "creating the throwaway workspace").toBeTruthy();
    const ws = (await created.json()) as { id: string };

    try {
      await page.request.post(`${baseURL}/api/workspaces/${ws.id}/select`);

      const statusLoaded = page.waitForResponse(
        (r) => r.url().includes(`/api/workspaces/${ws.id}/git/status`) && r.request().method() === "GET",
      );
      await page.goto(`/${ws.id}/git`);
      await statusLoaded;

      const fileRow = page.getByRole("button", { name: /file\.txt/ });
      await expect(fileRow).toBeVisible({ timeout: 10_000 });

      const diffLoaded = page.waitForResponse(
        (r) => r.url().includes(`/api/workspaces/${ws.id}/git/diff`) && r.request().method() === "GET",
      );
      await fileRow.click();
      await diffLoaded;

      // The real deleted line must be visible (git computed it from the
      // real blob) and the driver's fixed string must never appear.
      await expect(page.getByText(SECRET_LINE)).toBeVisible({ timeout: 10_000 });
      await expect(page.getByText(REDACTED)).toHaveCount(0);

      await page.waitForTimeout(200);
      await page.screenshot({ path: resolve(SHOTS_DIR, "diff-raw-content.png"), fullPage: false });
    } finally {
      await page.request.delete(`${baseURL}/api/workspaces/${ws.id}`).catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
