/**
 * CC 2.1.321 parity — "Fixed skill and command names holding a Bamum letter
 * that some fonts draw as blank: they are now refused".
 *
 * The engine's name rule gained exactly one code point, U+16910 (BAMUM LETTER
 * PHASE-D NGKEURI). Claudius's copy of that rule (`BLANK_LIKE_RE`) lacked it,
 * so the Skills page listed such a folder as an ordinary, offered skill whose
 * name looked like `ship` — and the skills route would create one. Now:
 *  - an existing folder named `ship` + U+16910 is badged "Not offered to
 *    Claude until renamed", with the character shown as a `‹U+16910›` token
 *    (`HIDDEN_NAME_CHAR_RE` gained it too);
 *  - the real `PUT /api/skills` refuses to create one.
 *
 * Runs against the real routes on a throwaway workspace in a temp dir (the
 * e2e HOME is an isolated tempdir — see playwright.config.ts), so a regression
 * writes into the temp dir, never a real `.claude/skills`.
 *
 * Every non-ASCII character is a code-point escape so nothing blank-looking
 * sits literally in this file.
 *
 * Screenshot target: docs/cc-parity/2.1.321/bamum-skill-names.png
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { test, expect, type APIRequestContext } from "../helpers/test";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.321");
mkdirSync(SHOTS_DIR, { recursive: true });

const BAMUM_BLANK = "\u{16910}";
const NOT_OFFERED = `ship${BAMUM_BLANK}`;
const TOKEN = "\u{2039}U+16910\u{203A}";
// A neighbouring Bamum letter the engine still allows.
const BAMUM_OK = "\u{16911}";

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
    `---\nname: ${JSON.stringify(name)}\ndescription: ${description}\n---\n\n# ${name}\n`,
  );
}

test.describe("CC 2.1.321 — Bamum U+16910 in skill names", () => {
  test("the Skills page badges a U+16910 folder and the route refuses to create one", async ({ page, baseURL }) => {
    test.setTimeout(60_000);
    await withWorkspace(
      page.request,
      baseURL,
      "bamum-skill",
      (dir) => {
        writeSkill(dir, NOT_OFFERED, "ship", "Ship the current branch to production");
        writeSkill(dir, `deploy${BAMUM_OK}`, "deploy", "Deploy the current branch to staging");
      },
      async (ws) => {
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
        const listedRes = await listed;
        const resolvedCwd = new URL(listedRes.url()).searchParams.get("cwd")!;
        const { scopes } = (await listedRes.json()) as {
          scopes: { scope: string; files: { name: string; notOffered: boolean }[] }[];
        };
        const project = scopes.find((s) => s.scope === "project")!.files;
        expect(Object.fromEntries(project.map((f) => [f.name, f.notOffered]))).toEqual({
          [NOT_OFFERED]: true,
          [`deploy${BAMUM_OK}`]: false,
        });

        const badRow = page.locator(`[data-testid="skill-row"][data-skill-name="${NOT_OFFERED}"]`);
        const okRow = page.locator(`[data-testid="skill-row"][data-skill-name="deploy${BAMUM_OK}"]`);
        await expect(badRow).toBeVisible({ timeout: 20_000 });
        await expect(badRow.getByTestId("skill-row-not-offered-badge")).toHaveText(
          "Not offered to Claude until renamed",
        );
        // The blank-drawn letter is shown as a token, so the name doesn't read as plain "ship".
        await expect(badRow.getByTestId("skill-row-name")).toHaveText(`ship${TOKEN}`);
        // The neighbouring Bamum letter is an ordinary letter: no badge, no token.
        await expect(okRow.getByTestId("skill-row-not-offered-badge")).toHaveCount(0);
        await expect(okRow.getByTestId("skill-row-name")).toHaveText(`deploy${BAMUM_OK}`);

        await badRow.click();
        await expect(page.getByTestId("skill-editor-name")).toHaveText(`ship${TOKEN}`);
        await expect(page.getByTestId("skill-editor-not-offered-badge")).toBeVisible();
        await page.waitForTimeout(200);
        await page.screenshot({ path: resolve(SHOTS_DIR, "bamum-skill-names.png"), fullPage: false });

        // The real skills route refuses to create a folder whose name holds U+16910.
        const refused = await page.request.put(`${baseURL}/api/skills`, {
          data: { scope: "project", cwd: resolvedCwd, name: `release${BAMUM_BLANK}`, raw: "---\nname: release\n---\n" },
        });
        expect(refused.ok()).toBe(false);
        expect(existsSync(join(ws.dir, ".claude", "skills", `release${BAMUM_BLANK}`))).toBe(false);
      },
    );
  });
});
