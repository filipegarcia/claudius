import { test, expect, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const SESSION_RE = /[?&]session=([0-9a-f-]{36})/i;

/**
 * Mirrors lib/server/auto-memory.ts:encodeProjectDir — every non-alphanumeric
 * character becomes "-" with no consolidation. Keep in sync with the server.
 */
function encodeProjectDir(absPath: string): string {
  return absPath.replace(/[^A-Za-z0-9]/g, "-");
}

function projectStoreDir(cwd: string): string {
  return join(homedir(), ".claude", "projects", encodeProjectDir(cwd));
}

async function captureBoundSessionId(page: Page): Promise<string> {
  await page.waitForURL(SESSION_RE, { timeout: 30_000 });
  const m = page.url().match(SESSION_RE);
  expect(m, "URL should carry ?session=<uuid>").toBeTruthy();
  return m![1];
}

test.describe("Session storage — TUI compatibility + internal DB", () => {
  test("session id from URL matches the SDK's JSONL filename and is indexed in the DB", async ({
    page,
    baseURL,
  }) => {
    test.setTimeout(180_000); // hits the real Anthropic API

    // 1. Open a fresh chat. The boot effect creates a session and writes
    //    its id back to the URL via replaceState.
    await page.goto("/");
    const id = await captureBoundSessionId(page);
    test.info().annotations.push({ type: "session-id", description: id });

    // 2. Resolve the cwd the dev server bound the session to. The /api/sessions
    //    list endpoint exposes that, and using it makes this test independent
    //    of which workspace happens to be active.
    const list = await page.request
      .get(`${baseURL}/api/sessions`)
      .then((r) => r.json() as Promise<Array<{ id: string; cwd: string; model?: string }>>);
    const ourSession = list.find((s) => s.id === id);
    expect(ourSession, "session should appear in /api/sessions").toBeTruthy();
    const cwd = ourSession!.cwd;
    test.info().annotations.push({ type: "session-cwd", description: cwd });

    // 3. Bypass permissions and fire one tiny prompt so the SDK actually
    //    writes the JSONL to disk (the file isn't created until a turn
    //    runs).
    const modeRes = await page.request.post(`${baseURL}/api/sessions/${id}/mode`, {
      data: { mode: "bypassPermissions" },
    });
    expect(modeRes.ok()).toBeTruthy();

    const textarea = page.getByTestId("prompt-input");
    await expect(textarea).toBeEnabled({ timeout: 30_000 });
    await textarea.fill("Reply with the single word: ack");
    await page.getByTestId("prompt-send").click();
    // Wait for the agent's turn to complete (Send button reappears).
    await expect(page.getByTestId("prompt-send")).toBeVisible({ timeout: 90_000 });

    // 4. The SDK persists at `~/.claude/projects/<encoded-cwd>/<id>.jsonl`.
    //    If our id matches the SDK's id (the TUI-compatibility property),
    //    that exact path exists. If it doesn't, the SDK would have used
    //    its own auto-generated id and the file would be elsewhere.
    const jsonlPath = join(projectStoreDir(cwd), `${id}.jsonl`);
    expect(
      existsSync(jsonlPath),
      `expected SDK to write JSONL at ${jsonlPath} — TUI's \`claude --resume ${id}\` would otherwise not find the conversation`,
    ).toBeTruthy();

    // 5. Internal sessions index: the same id should be a row in the
    //    project's SQLite store with our cwd populated.
    const dbPath = join(projectStoreDir(cwd), ".claudius.db");
    expect(existsSync(dbPath), `expected sessions index DB at ${dbPath}`).toBeTruthy();
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const row = db
        .prepare(
          "SELECT id, cwd, title, created_at, updated_at FROM sessions WHERE id = ?",
        )
        .get(id) as
        | { id: string; cwd: string; title: string | null; created_at: number; updated_at: number }
        | undefined;
      expect(row, `expected sessions row for ${id} in ${dbPath}`).toBeTruthy();
      expect(row!.cwd).toBe(cwd);
      expect(row!.created_at).toBeGreaterThan(0);
      // updated_at should have moved forward after the turn we just ran.
      expect(row!.updated_at).toBeGreaterThanOrEqual(row!.created_at);
    } finally {
      db.close();
    }

    // 6. Rename the session via the RecapBanner — the title persists into
    //    the same row. The banner is always rendered (with an "Untitled
    //    session" placeholder until the SDK surfaces a title), so the
    //    rename surface is always reachable via single click.
    const recapButton = page.getByTestId("recap-banner-button");
    await expect(recapButton).toBeVisible();
    await recapButton.click();
    const input = page.getByTestId("recap-title-input");
    await expect(input).toBeVisible();
    const desiredTitle = `Storage Test ${Date.now().toString(36)}`;
    await input.fill(desiredTitle);
    await input.press("Enter");
    await expect(page.getByTestId("recap-banner-title")).toHaveText(desiredTitle, {
      timeout: 10_000,
    });

    const db2 = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const row = db2
        .prepare("SELECT title FROM sessions WHERE id = ?")
        .get(id) as { title: string | null } | undefined;
      expect(row?.title).toBe(desiredTitle);
    } finally {
      db2.close();
    }
  });
});
