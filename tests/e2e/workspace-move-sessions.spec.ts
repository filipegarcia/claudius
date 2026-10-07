import { test, expect } from "../helpers/test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Sessions are stored per root folder (`~/.claude/projects/<encoded-root>/`),
 * so re-pointing a workspace at a new root used to make every session vanish.
 * Saving a root change now asks whether to move them along; "Move" carries
 * the transcript over (stamped so the SDK resolves the new cwd) and the
 * session lists under the new root.
 *
 * Uses a scratch workspace + tmpdirs and cleans all of it up in `finally` so
 * the shared e2e HOME doesn't accumulate workspaces across runs.
 */

const encodeProjectDir = (p: string) => p.replace(/[^A-Za-z0-9]/g, "-");

type WorkspaceSummary = { id: string; name: string; rootPath: string };
type SessionsAll = { sessions: { sessionId: string; cwd?: string }[] };

test.describe("Workspace root change — move sessions prompt", () => {
  test("offers to move sessions and carries them to the new root", async ({ page, baseURL }) => {
    test.setTimeout(60_000);
    const home = process.env.CLAUDIUS_E2E_HOME;
    test.skip(!home, "needs the isolated e2e HOME from playwright.config.ts");

    // realpath: macOS tmpdirs sit behind /var → /private/var, and the SDK
    // canonicalizes `dir` before encoding it.
    const oldRoot = realpathSync(mkdtempSync(join(tmpdir(), "claudius-move-old-")));
    const newRoot = realpathSync(mkdtempSync(join(tmpdir(), "claudius-move-new-")));
    const projectsDir = join(home!, ".claude", "projects");
    const oldProjectDir = join(projectsDir, encodeProjectDir(oldRoot));
    const newProjectDir = join(projectsDir, encodeProjectDir(newRoot));

    // One finished session recorded under the old root.
    const sessionId = randomUUID();
    mkdirSync(oldProjectDir, { recursive: true });
    const userUuid = randomUUID();
    writeFileSync(
      join(oldProjectDir, `${sessionId}.jsonl`),
      [
        {
          parentUuid: null,
          isSidechain: false,
          type: "user",
          message: { role: "user", content: "move-sessions e2e prompt" },
          uuid: userUuid,
          timestamp: new Date().toISOString(),
          cwd: oldRoot,
          sessionId,
        },
        {
          parentUuid: userUuid,
          isSidechain: false,
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
          uuid: randomUUID(),
          timestamp: new Date().toISOString(),
          cwd: oldRoot,
          sessionId,
        },
      ]
        .map((l) => JSON.stringify(l))
        .join("\n") + "\n",
    );

    const created = await page.request.post(`${baseURL}/api/workspaces`, {
      data: { name: `move-sessions-${Date.now()}`, rootPath: oldRoot },
    });
    expect(created.ok(), "creating scratch workspace").toBeTruthy();
    const ws = (await created.json()) as WorkspaceSummary;

    const listedUnder = async (root: string) => {
      const r = await page.request.get(
        `${baseURL}/api/sessions/all?dir=${encodeURIComponent(root)}`,
      );
      return ((await r.json()) as SessionsAll).sessions.map((s) => s.sessionId);
    };

    try {
      await page.request.post(`${baseURL}/api/workspaces/${ws.id}/select`);
      expect(await listedUnder(oldRoot)).toContain(sessionId);

      await page.goto(`/${ws.id}/workspace`);
      const rootInput = page.getByTestId("workspace-root-input");
      await expect(rootInput).toHaveValue(oldRoot);
      await rootInput.fill(newRoot);
      await page.getByTestId("workspace-save").click();

      const prompt = page.getByTestId("move-sessions-prompt");
      await expect(prompt).toBeVisible();
      const confirm = page.getByTestId("move-sessions-confirm");
      await expect(confirm).toContainText("1 session");
      await confirm.click();
      await expect(prompt).toBeHidden();

      await expect
        .poll(async () => {
          const r = await page.request.get(`${baseURL}/api/workspaces/${ws.id}`);
          return ((await r.json()) as WorkspaceSummary).rootPath;
        })
        .toBe(newRoot);
      expect(await listedUnder(newRoot)).toContain(sessionId);
      expect(await listedUnder(oldRoot)).not.toContain(sessionId);

      // Resume resolves the session's cwd from the transcript — it must now
      // point at the new root, or the agent would respawn in the old folder.
      const info = await page.request.get(`${baseURL}/api/sessions/info/${sessionId}`);
      expect(((await info.json()) as { cwd?: string }).cwd).toBe(newRoot);
    } finally {
      await page.request.delete(`${baseURL}/api/workspaces/${ws.id}`);
      for (const dir of [oldRoot, newRoot, oldProjectDir, newProjectDir]) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});
