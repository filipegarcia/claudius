/**
 * Claude Code 2.1.290 parity (shipped in the 2.1.289 → 2.1.291 cycle):
 *
 *  - "Fixed skills not being found when asked for by the name in SKILL.md
 *    when their folder has a different name (for example a non-English
 *    name): the skill listing now shows both names." Claudius's Skills page
 *    skipped non-ASCII folders entirely and showed only folder names.
 *  - "Changed `CLAUDE_CODE_DISABLE_ATTACHMENTS` so a repository's
 *    `.claude/settings.json` or `.claude/settings.local.json` can no longer
 *    set it." The doctor now flags a project-scope value as ignored.
 *
 * Both run against the real routes, on a throwaway workspace in a temp dir
 * (the e2e HOME is already an isolated tempdir — see playwright.config.ts).
 *
 * Screenshot targets: docs/cc-parity/2.1.291/{skill-names,doctor-attachments-env}.png
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, expect, type APIRequestContext } from "../helpers/test";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.291");
mkdirSync(SHOTS_DIR, { recursive: true });

async function withWorkspace(
  request: APIRequestContext,
  baseURL: string | undefined,
  prefix: string,
  seed: (dir: string) => void,
  body: (ws: { id: string; dir: string }) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), `claudius-${prefix}-`));
  seed(dir);
  const created = await request.post(`${baseURL}/api/workspaces`, {
    data: { name: `${prefix}-${Date.now()}`, rootPath: dir },
  });
  expect(created.ok(), "creating the throwaway workspace").toBeTruthy();
  const ws = (await created.json()) as { id: string };
  try {
    await request.post(`${baseURL}/api/workspaces/${ws.id}/select`);
    await body({ id: ws.id, dir });
  } finally {
    await request.delete(`${baseURL}/api/workspaces/${ws.id}`).catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeSkill(dir: string, folder: string, name: string, description: string) {
  const skillDir = join(dir, ".claude", "skills", folder);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`);
}

test.describe("CC 2.1.290 — Skills page and doctor parity", () => {
  test("the Skills page lists a non-English skill folder and shows its SKILL.md name", async ({
    page,
    baseURL,
  }) => {
    test.setTimeout(60_000);
    await withWorkspace(
      page.request,
      baseURL,
      "skill-names",
      (dir) => {
        writeSkill(dir, "レビュー", "code-review", "Review a diff for bugs and style");
        writeSkill(dir, "release-notes", "release-notes", "Draft release notes from merged PRs");
      },
      async (ws) => {
        await page.goto(`/${ws.id}/skills`);

        const row = page.getByRole("button", { name: /レビュー/ });
        await expect(row).toBeVisible({ timeout: 20_000 });
        await expect(row.getByTestId("skill-md-name")).toHaveText(" · code-review");
        // Folder and SKILL.md name match → no second name.
        await expect(
          page.getByRole("button", { name: /release-notes/ }).getByTestId("skill-md-name"),
        ).toHaveCount(0);

        // Searching by the SKILL.md name finds the non-English folder.
        await page.getByPlaceholder("Search skills").fill("code-review");
        await expect(row).toBeVisible();
        await expect(page.getByRole("button", { name: /release-notes/ })).toHaveCount(0);
        await page.getByPlaceholder("Search skills").fill("");

        // Opening it works (read goes through the same name rule).
        await row.click();
        await expect(page.getByText("name: code-review", { exact: true })).toBeVisible();

        await page.waitForTimeout(200);
        await page.screenshot({ path: resolve(SHOTS_DIR, "skill-names.png"), fullPage: false });
      },
    );
  });

  test("the doctor flags CLAUDE_CODE_DISABLE_ATTACHMENTS set in project settings as ignored", async ({
    page,
    baseURL,
  }) => {
    test.setTimeout(90_000);
    await withWorkspace(
      page.request,
      baseURL,
      "attachments-env",
      (dir) => {
        mkdirSync(join(dir, ".claude"), { recursive: true });
        writeFileSync(
          join(dir, ".claude", "settings.json"),
          JSON.stringify({ env: { CLAUDE_CODE_DISABLE_ATTACHMENTS: "1" } }, null, 2),
        );
      },
      async (ws) => {
        const res = await page.request.get(`${baseURL}/api/doctor`);
        expect(res.ok()).toBeTruthy();
        const { checks } = (await res.json()) as { checks: { id: string; status: string; detail?: string }[] };
        const check = checks.find((c) => c.id === `attachments-env:${ws.id}`);
        expect(check, "attachments-env check for the throwaway workspace").toBeTruthy();
        expect(check!.status).toBe("warn");
        expect(check!.detail).toContain("CLAUDE_CODE_DISABLE_ATTACHMENTS");

        await page.goto("/doctor");
        const label = page.getByText(/^Ignored attachments env — attachments-env-/);
        await expect(label).toBeVisible({ timeout: 30_000 });
        await label.scrollIntoViewIfNeeded();
        await page.waitForTimeout(200);
        await page.screenshot({ path: resolve(SHOTS_DIR, "doctor-attachments-env.png"), fullPage: false });
      },
    );
  });
});
