import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { isRuntimeStatePath, runtimeStateInRange, trackedRuntimeStatePaths } from "../../scripts/lib/runtime-state.mjs";
import {
  assertMainCarriesNoRuntimeState,
  assertNoRuntimeStateToPush,
  rescueUncommittedWork,
  retirePoisonedBranch,
  runtimeStateOnBranch,
  snapshotDirtyTree,
  uncommittedWorkPaths,
  untrackRuntimeState,
} from "../../scripts/sdk-update/orchestrate";

/**
 * Issue #383: the 0.3.327 agent ran `git add -f .claudius` and the rescue
 * commit committed the whole index, so HEAD tracked the updaters'
 * credentials, state.json and an 11 GB log. Every hourly firing then
 * rewrote state.json and died on `git checkout --detach origin/main`.
 */

const GUARD = resolve(__dirname, "../../scripts/lib/runtime-state.mjs");

describe("isRuntimeStatePath", () => {
  test("run-notes Markdown is the only tracked thing under .claudius/", () => {
    expect(isRuntimeStatePath(".claudius/sdk-updater/run-notes/0.3.327.md")).toBe(false);
    expect(isRuntimeStatePath(".claudius/cc-parity/run-notes/2.1.327.md")).toBe(false);
    expect(isRuntimeStatePath(".claudius/cc-parity/run-notes/2.1.327.prompt.md")).toBe(false);
  });

  test("credentials, state, locks, logs and transcripts are runtime state", () => {
    for (const p of [
      ".claudius/sdk-updater/env",
      ".claudius/sdk-updater/state.json",
      ".claudius/cc-parity/state.json",
      ".claudius/run.lock",
      ".claudius/run.lock.d/holder.pid",
      ".claudius/logs/update-pipeline.log",
      ".claudius/cc-parity/logs/e2e-webserver.log",
      ".claudius/sdk-updater/run-notes/0.3.327.transcript.jsonl",
      ".claudius/sdk-updater/run-notes/nested/0.3.327.md",
      ".claudius.db",
      ".claudius.db-wal",
    ]) {
      expect(isRuntimeStatePath(p), p).toBe(true);
    }
  });

  test("everything else is left alone", () => {
    for (const p of ["lib/server/session.ts", "claudius/x", ".claudiusrc", "docs/.claudius/x", ".claudius.dbx"]) {
      expect(isRuntimeStatePath(p), p).toBe(false);
    }
  });

  test("uncommittedWorkPaths drops force-staged runtime state", () => {
    const after = new Map([
      ["lib/a.ts", " M:1"],
      [".claudius/sdk-updater/env", "A :2"],
      [".claudius/logs/update-pipeline.log", "A :3"],
    ]);
    expect(uncommittedWorkPaths(new Map(), after, "docs/sdk-updates/0.3.327/")).toEqual(["lib/a.ts"]);
  });
});

describe("runtime state in a real git repo", () => {
  let repo: string;
  let savedEnv: NodeJS.ProcessEnv;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  const write = (rel: string, body: string) => {
    mkdirSync(join(repo, rel, ".."), { recursive: true });
    writeFileSync(join(repo, rel), body);
  };
  const read = (rel: string) => readFileSync(join(repo, rel), "utf8");
  const RUNTIME = [
    ".claudius/sdk-updater/env",
    ".claudius/sdk-updater/state.json",
    ".claudius/logs/update-pipeline.log",
  ];
  const NOTES = ".claudius/sdk-updater/run-notes/0.3.327.md";

  /** origin/main = a clean commit; `branch` = the agent's `git add -f .claudius` on top. */
  function poisonedBranch(branch = "cc-parity/2.1.326-detached-from-sdk-0.3.326"): string {
    git("checkout", "-q", "-b", branch);
    write(".claudius/sdk-updater/env", "CLAUDE_CODE_OAUTH_TOKEN=committed\n");
    write(".claudius/sdk-updater/state.json", '{"v":"committed"}\n');
    write(".claudius/logs/update-pipeline.log", "committed log\n");
    write(NOTES, "# notes\n");
    git("add", "-f", ".claudius");
    git("commit", "-q", "-m", "docs(sdk-update): notes for 0.3.327");
    return branch;
  }

  beforeEach(() => {
    // Same isolation as orchestrator-uncommitted-work.test.ts: the helpers
    // spawn git themselves, and pre-commit exports GIT_DIR / GIT_INDEX_FILE.
    savedEnv = { ...process.env };
    for (const k of Object.keys(process.env)) {
      if (k.startsWith("GIT_")) delete process.env[k];
    }
    Object.assign(process.env, {
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    });
    expect(["GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE", "GIT_COMMON_DIR"].filter((k) => k in process.env)).toEqual([]);

    repo = realpathSync(mkdtempSync(join(tmpdir(), "claudius-runtime-state-")));
    git("init", "-q", "-b", "main");
    expect(realpathSync(git("rev-parse", "--show-toplevel"))).toBe(repo);
    write(".gitignore", "/.claudius/\n/.claudius.db*\n");
    write("lib/a.ts", "export const a = 1;\n");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    for (const k of Object.keys(process.env)) {
      if (!(k in savedEnv)) delete process.env[k];
    }
    Object.assign(process.env, savedEnv);
  });

  test("reproduces #383, then preflight's untrack lets stash + checkout run without touching the live files", () => {
    const branch = poisonedBranch();
    const branchTip = git("rev-parse", branch);
    // The firing rewrites its state and the run left real work dirty.
    write(".claudius/sdk-updater/state.json", '{"v":"live"}\n');
    write(".claudius/logs/update-pipeline.log", "live log\n");
    write("lib/a.ts", "export const a = 2;\n");

    // The bug: exactly the error in the issue.
    const blocked = spawnSync("git", ["checkout", "--detach", "origin/main"], { cwd: repo, encoding: "utf8" });
    expect(blocked.status).not.toBe(0);
    expect(blocked.stderr).toContain(".claudius/sdk-updater/state.json");

    expect(untrackRuntimeState(repo)).toEqual([...RUNTIME].sort());
    // No branch moved: HEAD is detached on a local-only commit without the files.
    expect(git("rev-parse", branch)).toBe(branchTip);
    expect(git("rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");
    expect(trackedRuntimeStatePaths(repo, "HEAD")).toEqual([]);
    expect(trackedRuntimeStatePaths(repo)).toEqual([]);
    expect(git("ls-tree", "-r", "--name-only", "HEAD")).toContain(NOTES);

    // What preflight + checkoutFreshBranch do next.
    git("stash", "push", "--include-untracked", "-q", "-m", "sdk-update-autostash test");
    expect(read("lib/a.ts")).toBe("export const a = 1;\n");
    git("checkout", "-q", "--detach", "origin/main");

    // The live runtime files survived both, content and all.
    expect(read(".claudius/sdk-updater/env")).toBe("CLAUDE_CODE_OAUTH_TOKEN=committed\n");
    expect(read(".claudius/sdk-updater/state.json")).toBe('{"v":"live"}\n');
    expect(read(".claudius/logs/update-pipeline.log")).toBe("live log\n");
    git("stash", "pop", "-q");
    expect(read("lib/a.ts")).toBe("export const a = 2;\n");
  });

  test("a clean checkout is a no-op", () => {
    write(".claudius/sdk-updater/state.json", "{}\n");
    const head = git("rev-parse", "HEAD");
    expect(untrackRuntimeState(repo)).toEqual([]);
    expect(git("rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(git("rev-parse", "HEAD")).toBe(head);
  });

  test("runtime state that is only staged is unstaged and HEAD stays put", () => {
    write(".claudius/sdk-updater/env", "secret\n");
    write(NOTES, "# notes\n");
    git("add", "-f", ".claudius");
    expect(untrackRuntimeState(repo)).toEqual([".claudius/sdk-updater/env"]);
    expect(git("rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(git("diff", "--cached", "--name-only")).toBe(NOTES);
    expect(read(".claudius/sdk-updater/env")).toBe("secret\n");
  });

  test("a branch stays poisoned after an untrack commit: the secret is still in its history", () => {
    const branch = poisonedBranch();
    expect(runtimeStateOnBranch(branch, "origin/main", repo)).toEqual([...RUNTIME].sort());
    git("rm", "-r", "-q", "--cached", "--", ...RUNTIME);
    git("commit", "-q", "-m", "untrack");
    expect(trackedRuntimeStatePaths(repo, "HEAD")).toEqual([]);
    expect(runtimeStateInRange("origin/main", "HEAD", repo)).toEqual([...RUNTIME].sort());
    expect(() => assertNoRuntimeStateToPush(branch, repo)).toThrow(/refusing to push/);
    // Notes alone are fine.
    git("checkout", "-q", "-b", "sdk-update/0.3.332", "origin/main");
    write(NOTES, "# notes\n");
    git("add", "-f", NOTES);
    git("commit", "-q", "-m", "docs: notes");
    expect(runtimeStateOnBranch("HEAD", "origin/main", repo)).toEqual([]);
    expect(() => assertNoRuntimeStateToPush("sdk-update/0.3.332", repo)).not.toThrow();
  });

  test("a poisoned branch is retired under a backup name instead of resumed", () => {
    const branch = poisonedBranch("sdk-update/0.3.327");
    const tip = git("rev-parse", "HEAD");
    git("checkout", "-q", "--detach", "origin/main");
    const backup = retirePoisonedBranch(branch, RUNTIME, repo);
    expect(backup).toMatch(/^backup\/sdk-update\/0\.3\.327-runtime-state-\d{8}T\d{6}$/);
    expect(git("branch", "--list", branch)).toBe("");
    expect(git("rev-parse", backup!)).toBe(tip);
  });

  test("origin/main carrying runtime state stops the run before any checkout", () => {
    expect(() => assertMainCarriesNoRuntimeState(repo)).not.toThrow();
    poisonedBranch();
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    expect(() => assertMainCarriesNoRuntimeState(repo)).toThrow(/origin\/main tracks 3 pipeline runtime file/);
  });

  test("the rescue commits never sweep up a force-staged .claudius", () => {
    git("checkout", "-q", "-b", "sdk-update/0.3.332");
    const before = snapshotDirtyTree(repo);
    // The 0.3.327 agent: notes written, real work left, then `git add -f .claudius`.
    write(NOTES, "# notes\n");
    write(".claudius/sdk-updater/env", "secret\n");
    write(".claudius/sdk-updater/state.json", "{}\n");
    write("lib/a.ts", "export const a = 3;\n");
    git("add", "-f", ".claudius");

    const issue = rescueUncommittedWork({
      before,
      ownDocsDir: "docs/sdk-updates/0.3.332/",
      notesRel: NOTES,
      scope: "sdk-update",
      version: "0.3.332",
      cwd: repo,
    });
    expect(issue).toContain("Claude left 1 file(s) uncommitted (lib/a.ts)");
    expect(git("show", "--name-only", "--format=", "HEAD~1")).toBe(NOTES);
    expect(git("show", "--name-only", "--format=", "HEAD")).toBe("lib/a.ts");
    expect(runtimeStateOnBranch("HEAD", "origin/main", repo)).toEqual([]);
    expect(existsSync(join(repo, ".claudius/sdk-updater/env"))).toBe(true);
    expect(git("status", "--porcelain")).toBe("");
  });

  describe("hook guard CLI", () => {
    const guard = (mode: string, input?: string) =>
      spawnSync(process.execPath, [GUARD, mode], { cwd: repo, encoding: "utf8", input: input ?? "" });

    test("pre-commit refuses staged runtime state but allows notes and untracking", () => {
      write(NOTES, "# notes\n");
      git("add", "-f", NOTES);
      expect(guard("staged").status).toBe(0);

      write(".claudius/sdk-updater/env", "secret\n");
      git("add", "-f", ".claudius/sdk-updater/env");
      const refused = guard("staged");
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain(".claudius/sdk-updater/env");
      expect(refused.stderr).toContain("git add -f .claudius/sdk-updater/run-notes/<version>.md");

      git("commit", "-q", "--no-verify", "-m", "oops");
      git("rm", "-q", "--cached", ".claudius/sdk-updater/env");
      expect(guard("staged").status).toBe(0);
    });

    test("pre-push refuses commits that add runtime state, even if a later commit untracks it", () => {
      const ZERO = "0".repeat(40);
      const clean = git("rev-parse", "HEAD");
      expect(guard("push", `refs/heads/main ${clean} refs/heads/main ${ZERO}\n`).status).toBe(0);

      poisonedBranch("sdk-update/0.3.327");
      git("rm", "-r", "-q", "--cached", "--", ...RUNTIME);
      git("commit", "-q", "-m", "untrack");
      const tip = git("rev-parse", "HEAD");
      const refused = guard("push", `refs/heads/sdk-update/0.3.327 ${tip} refs/heads/sdk-update/0.3.327 ${ZERO}\n`);
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain(".claudius/sdk-updater/env");

      // Deleting a remote branch pushes nothing.
      expect(guard("push", `(delete) ${ZERO} refs/heads/x ${tip}\n`).status).toBe(0);
    });
  });
});
