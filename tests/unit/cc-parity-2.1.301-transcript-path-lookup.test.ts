import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeProjectDir } from "@/lib/server/auto-memory";
import { findResumedTranscriptPath } from "@/lib/server/session";

/**
 * CC 2.1.301 — the compaction row in a resumed session names the JSONL the
 * earlier turns are saved in. It must be the file that actually exists: a
 * `/fork` resumed in its git worktree keeps its JSONL under the SOURCE
 * project's dir, not `projectRoot(worktreeCwd)`.
 */
const ID = "0b0e2c1d-aaaa-bbbb-cccc-000000000001";
let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "claudius-projects-"));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function writeJsonl(projectDir: string, id = ID): string {
  const dir = join(base, projectDir);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.jsonl`);
  writeFileSync(file, "{}\n");
  return file;
}

describe("findResumedTranscriptPath", () => {
  test("an ordinary resume finds the file under the cwd's own project dir", async () => {
    const file = writeJsonl(encodeProjectDir("/Users/me/proj"));
    expect(await findResumedTranscriptPath(ID, "/Users/me/proj", base)).toBe(file);
  });

  test("a fork resumed in its worktree finds the file under the source project's dir", async () => {
    const file = writeJsonl(encodeProjectDir("/Users/me/proj"));
    writeJsonl(encodeProjectDir("/Users/me/unrelated"), "another-session");
    expect(await findResumedTranscriptPath(ID, "/Users/me/proj/.claude/worktrees/fork-1", base)).toBe(file);
  });

  test("the cwd's own dir wins when both exist", async () => {
    writeJsonl("-some-other-project");
    const own = writeJsonl(encodeProjectDir("/Users/me/wt"));
    expect(await findResumedTranscriptPath(ID, "/Users/me/wt", base)).toBe(own);
  });

  test("no candidate on disk: nothing (rather than a wrong path)", async () => {
    mkdirSync(join(base, encodeProjectDir("/Users/me/proj")), { recursive: true });
    expect(await findResumedTranscriptPath(ID, "/Users/me/proj", base)).toBeUndefined();
    expect(await findResumedTranscriptPath(ID, "/x", join(base, "missing"))).toBeUndefined();
  });

  test("an id that isn't a plain session id is refused", async () => {
    writeJsonl(encodeProjectDir("/Users/me/proj"));
    expect(await findResumedTranscriptPath(`../${ID}`, "/Users/me/proj", base)).toBeUndefined();
  });
});
