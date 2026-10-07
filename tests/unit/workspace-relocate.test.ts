import { mkdirSync, realpathSync } from "node:fs";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { getSessionInfo, listSessions } from "@anthropic-ai/claude-agent-sdk";

import { encodeProjectDir } from "@/lib/server/auto-memory";
import { closeAll, openDb } from "@/lib/server/db";
import {
  listWorkspaceSessionIds,
  relocateWorkspaceSessions,
} from "@/lib/server/workspace-relocate";

import { makeTempHome, type TmpHome } from "./helpers/tmp-home";

/**
 * Moving a workspace root must carry its sessions along: transcripts +
 * sidecars + assets on disk (stamped with the SDK's `relocated` entry so
 * resume spawns in the new root), and the per-workspace `.claudius.db` rows.
 */

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
const S_DB_ONLY = "33333333-3333-4333-8333-333333333333";

let tmp: TmpHome;
let oldRoot: string;
let newRoot: string;
let prevConfigDir: string | undefined;

function projectDir(root: string): string {
  return join(tmp.home, ".claude", "projects", encodeProjectDir(root));
}

function transcript(sessionId: string, cwd: string, prompt: string): string {
  const lines = [
    {
      parentUuid: null,
      isSidechain: false,
      type: "user",
      message: { role: "user", content: prompt },
      uuid: `${sessionId.slice(0, 8)}-0000-4000-8000-000000000001`,
      timestamp: "2026-10-01T10:00:00.000Z",
      cwd,
      sessionId,
    },
    {
      parentUuid: `${sessionId.slice(0, 8)}-0000-4000-8000-000000000001`,
      isSidechain: false,
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
      uuid: `${sessionId.slice(0, 8)}-0000-4000-8000-000000000002`,
      timestamp: "2026-10-01T10:00:01.000Z",
      cwd,
      sessionId,
    },
  ];
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

beforeEach(async () => {
  tmp = makeTempHome();
  // The SDK resolves its projects dir from CLAUDE_CONFIG_DIR when set (it is,
  // inside a Claudius-spawned shell); unset it so it follows the tmp HOME.
  prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;
  // realpath: macOS tmpdirs live behind the /var → /private/var symlink and
  // the SDK canonicalizes `dir` before encoding it.
  oldRoot = join(realpathSync(tmp.home), "old-root");
  newRoot = join(realpathSync(tmp.home), "new-root");
  mkdirSync(oldRoot);
  mkdirSync(newRoot);

  const oldDir = projectDir(oldRoot);
  mkdirSync(join(oldDir, S1, "subagents"), { recursive: true });
  await fs.writeFile(join(oldDir, `${S1}.jsonl`), transcript(S1, oldRoot, "first chat"));
  await fs.writeFile(join(oldDir, S1, "subagents", "agent-a.jsonl"), "{}\n");
  // No trailing newline — the stamp must still land on its own line.
  await fs.writeFile(join(oldDir, `${S2}.jsonl`), transcript(S2, oldRoot, "second chat").trimEnd());
  mkdirSync(join(oldDir, "assets", "ab"), { recursive: true });
  await fs.writeFile(join(oldDir, "assets", "ab", "abcd.png"), "png");
  mkdirSync(join(oldDir, "memory"), { recursive: true });
  await fs.writeFile(join(oldDir, "memory", "MEMORY.md"), "- note\n");

  const db = await openDb(oldRoot);
  const ins = db.prepare(
    "INSERT INTO sessions(id, cwd, title, model, created_at, updated_at, last_seen_at) VALUES (?, ?, ?, NULL, 1, 1, 1)",
  );
  ins.run(S1, oldRoot, "Renamed first");
  ins.run(S_DB_ONLY, oldRoot, "Renamed before first turn");
  db.prepare("INSERT INTO prompt_drafts(session_id, text, updated_at) VALUES (?, ?, 1)").run(S1, "half a thought");
  db.prepare("INSERT INTO commit_drafts(cwd, message, updated_at) VALUES (?, ?, 1)").run(oldRoot, "old draft");
  db.prepare("INSERT INTO ui_state(key, value) VALUES ('open_tabs', ?)").run(JSON.stringify([S1, S2]));
  db.prepare(
    "INSERT INTO loop_ticks(session_id, tool_use_id, prompt, fired_at, created_at) VALUES (?, 't1', 'p', 1, 1)",
  ).run(S1);
});

afterEach(() => {
  closeAll();
  if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
  tmp.restore();
});

describe("listWorkspaceSessionIds", () => {
  test("counts transcripts plus DB-only sessions", async () => {
    const ids = await listWorkspaceSessionIds(oldRoot);
    expect(ids.sort()).toEqual([S1, S2, S_DB_ONLY].sort());
    expect(await listWorkspaceSessionIds(newRoot)).toEqual([]);
  });
});

describe("relocateWorkspaceSessions", () => {
  test("moves transcripts, sidecars and assets, and stamps the new cwd", async () => {
    const result = await relocateWorkspaceSessions(oldRoot, newRoot);
    expect(result).toEqual({ moved: 2, failed: [] });

    const oldDir = projectDir(oldRoot);
    const newDir = projectDir(newRoot);
    await expect(fs.access(join(oldDir, `${S1}.jsonl`))).rejects.toThrow();
    expect(await fs.readFile(join(newDir, S1, "subagents", "agent-a.jsonl"), "utf8")).toBe("{}\n");
    expect(await fs.readFile(join(newDir, "assets", "ab", "abcd.png"), "utf8")).toBe("png");
    // Auto-memory isn't part of the move; it keeps the old dir alive.
    expect(await fs.readFile(join(oldDir, "memory", "MEMORY.md"), "utf8")).toBe("- note\n");

    for (const id of [S1, S2]) {
      const lines = (await fs.readFile(join(newDir, `${id}.jsonl`), "utf8")).trimEnd().split("\n");
      expect(lines).toHaveLength(3);
      expect(JSON.parse(lines[2])).toEqual({ type: "relocated", sessionId: id, relocatedCwd: newRoot });
    }

    // The SDK — which resolves resume cwd and the per-workspace list — agrees.
    const info = await getSessionInfo(S1);
    expect(info?.cwd).toBe(newRoot);
    const listed = await listSessions({ dir: newRoot, includeWorktrees: false });
    expect(listed.map((s) => s.sessionId).sort()).toEqual([S1, S2].sort());
  });

  test("merges the Claudius DB into the new root and drops the old file", async () => {
    // The new root already has some Claudius state — destination wins on
    // key conflicts, everything else is carried over.
    const dst = await openDb(newRoot);
    dst.prepare("INSERT INTO commit_drafts(cwd, message, updated_at) VALUES (?, ?, 2)").run(newRoot, "new draft");
    dst.prepare("INSERT INTO ui_state(key, value) VALUES ('open_tabs', '[]')").run();
    dst.prepare(
      "INSERT INTO loop_ticks(session_id, tool_use_id, prompt, fired_at, created_at) VALUES ('other', 't0', 'p', 1, 1)",
    ).run();

    const result = await relocateWorkspaceSessions(oldRoot, newRoot);
    expect(result.dataError).toBeUndefined();

    const db = await openDb(newRoot);
    const sessions = db.prepare("SELECT id, cwd, title FROM sessions ORDER BY id").all();
    expect(sessions).toEqual([
      { id: S1, cwd: newRoot, title: "Renamed first" },
      { id: S_DB_ONLY, cwd: newRoot, title: "Renamed before first turn" },
    ]);
    expect(db.prepare("SELECT text FROM prompt_drafts WHERE session_id = ?").get(S1)).toEqual({
      text: "half a thought",
    });
    expect(db.prepare("SELECT cwd, message FROM commit_drafts").all()).toEqual([
      { cwd: newRoot, message: "new draft" },
    ]);
    expect(db.prepare("SELECT value FROM ui_state WHERE key = 'open_tabs'").get()).toEqual({ value: "[]" });
    // Autoincrement ids re-assigned instead of colliding.
    expect(db.prepare("SELECT session_id FROM loop_ticks ORDER BY id").all()).toEqual([
      { session_id: "other" },
      { session_id: S1 },
    ]);

    await expect(fs.access(join(projectDir(oldRoot), ".claudius.db"))).rejects.toThrow();
    expect(await listWorkspaceSessionIds(newRoot)).toHaveLength(3);
    expect(await listWorkspaceSessionIds(oldRoot)).toEqual([]);
  });

  test("leaves a session behind when the new root already has that id", async () => {
    const newDir = projectDir(newRoot);
    mkdirSync(newDir, { recursive: true });
    await fs.writeFile(join(newDir, `${S2}.jsonl`), transcript(S2, newRoot, "already here"));

    const result = await relocateWorkspaceSessions(oldRoot, newRoot);
    expect(result.moved).toBe(1);
    expect(result.failed).toEqual([{ sessionId: S2, error: expect.stringContaining("already exists") }]);
    // Neither copy was touched.
    expect(await fs.readFile(join(projectDir(oldRoot), `${S2}.jsonl`), "utf8")).toBe(
      transcript(S2, oldRoot, "second chat").trimEnd(),
    );
    expect(await fs.readFile(join(newDir, `${S2}.jsonl`), "utf8")).toBe(
      transcript(S2, newRoot, "already here"),
    );
  });
});
