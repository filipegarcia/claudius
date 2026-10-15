/**
 * Claude Code 2.1.299 parity — "Changed skill and command loading: one whose
 * file or folder name has hidden, direction-changing or blank-like
 * characters, < or >, is no longer offered until renamed; such a name: is
 * ignored".
 *
 * Seeds a throwaway workspace with three project skills:
 *  - `deploy` + U+3164 (Hangul filler — invisible, so it *looks* like
 *    `deploy`), which the engine no longer offers;
 *  - `release-notes`, an ordinary skill;
 *  - `triage`, whose SKILL.md `name:` ends in a variation selector, so the
 *    engine ignores that name (the skill itself is still offered).
 * The Skills page must badge only the first, render its hidden character as
 * a visible token, say "ignored" for the third's name, and still delete the
 * badged skill. Runs against the real routes (the e2e HOME is an isolated
 * tempdir — see playwright.config.ts).
 *
 * Every non-ASCII character is written as a code-point escape so nothing
 * invisible sits literally in this file.
 *
 * Screenshot target: docs/cc-parity/2.1.299/skill-not-offered.png
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { test, expect, type APIRequestContext } from "../helpers/test";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.299");
mkdirSync(SHOTS_DIR, { recursive: true });

const NOT_OFFERED = "deploy\u{3164}";
const TOKEN = "\u{2039}U+3164\u{203A}";

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
  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---\nname: ${JSON.stringify(name)}\ndescription: ${description}\n---\n\n# ${folder}\n`,
  );
}

test.describe("CC 2.1.299 — skill names the engine won't offer", () => {
  test("the Skills page badges a not-offered skill, shows its hidden character, and can delete it", async ({
    page,
    baseURL,
  }) => {
    test.setTimeout(60_000);
    await withWorkspace(
      page.request,
      baseURL,
      "skill-not-offered",
      (dir) => {
        writeSkill(dir, NOT_OFFERED, "deploy", "Deploy the current branch to staging");
        writeSkill(dir, "release-notes", "release-notes", "Draft release notes from merged PRs");
        writeSkill(dir, "triage", "triage\u{FE0F}", "Triage new issues by label");
      },
      async (ws) => {
        // The page's own GET /api/skills carries the flag (read off the
        // response so the cwd is whatever the page resolved, not a guess at
        // the stored form of the temp dir path).
        const dirName = basename(ws.dir); // unique; survives /var → /private/var
        const listed = page.waitForResponse(
          (r) => {
            const u = new URL(r.url());
            return (
              u.pathname === "/api/skills" &&
              r.request().method() === "GET" &&
              r.ok() &&
              (u.searchParams.get("cwd") ?? "").endsWith(dirName)
            );
          },
          { timeout: 20_000 },
        );
        await page.goto(`/${ws.id}/skills`);
        const { scopes } = (await (await listed).json()) as {
          scopes: { scope: string; files: { name: string; notOffered: boolean }[] }[];
        };
        const project = scopes.find((s) => s.scope === "project")!.files;
        expect(Object.fromEntries(project.map((f) => [f.name, f.notOffered]))).toEqual({
          [NOT_OFFERED]: true,
          "release-notes": false,
          triage: false,
        });

        const badRow = page.locator(`[data-testid="skill-row"][data-skill-name="${NOT_OFFERED}"]`);
        const goodRow = page.locator('[data-testid="skill-row"][data-skill-name="release-notes"]');
        const triageRow = page.locator('[data-testid="skill-row"][data-skill-name="triage"]');
        await expect(badRow).toBeVisible({ timeout: 20_000 });
        await expect(goodRow).toBeVisible();

        // Badge on the not-offered skill only.
        await expect(badRow.getByTestId("skill-row-not-offered-badge")).toHaveText(
          "Not offered to Claude until renamed",
        );
        await expect(goodRow.getByTestId("skill-row-not-offered-badge")).toHaveCount(0);
        await expect(triageRow.getByTestId("skill-row-not-offered-badge")).toHaveCount(0);
        await expect(page.getByTestId("skill-row-not-offered-badge")).toHaveCount(1);

        // The invisible Hangul filler is rendered as a visible token.
        await expect(badRow.getByTestId("skill-row-name")).toHaveText(`deploy${TOKEN}`);
        await expect(goodRow.getByTestId("skill-row-name")).toHaveText("release-notes");
        // A not-offered skill can't be found by its SKILL.md name either — no alias shown.
        await expect(badRow.getByTestId("skill-md-name")).toHaveCount(0);

        // A SKILL.md name the engine refuses is "ignored", not shown as an alias.
        await expect(triageRow.getByTestId("skill-md-name-ignored")).toContainText("ignored");
        await expect(triageRow.getByTestId("skill-md-name-ignored")).toContainText("U+FE0F");
        await expect(triageRow.getByTestId("skill-md-name")).toHaveCount(0);

        // Opening it shows the badge in the editor header too.
        await badRow.click();
        await expect(page.getByTestId("skill-editor-name")).toHaveText(`deploy${TOKEN}`);
        await expect(page.getByTestId("skill-editor-not-offered-badge")).toBeVisible();

        await page.waitForTimeout(200);
        await page.screenshot({ path: resolve(SHOTS_DIR, "skill-not-offered.png"), fullPage: false });

        // Delete still works for a folder the engine won't offer.
        page.once("dialog", (d) => void d.accept());
        await page.getByTestId("skill-delete-button").click();
        await expect(badRow).toHaveCount(0, { timeout: 10_000 });
        await expect(goodRow).toBeVisible();
        expect(existsSync(join(ws.dir, ".claude", "skills", NOT_OFFERED))).toBe(false);
        expect(existsSync(join(ws.dir, ".claude", "skills", "release-notes"))).toBe(true);
      },
    );
  });
});
