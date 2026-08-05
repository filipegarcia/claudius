/**
 * `resolveTrustedCwd` is the barrier between a request-supplied `cwd` and the
 * ~27 route handlers that hand it to `fs.*` / `openDb` / the session spawner.
 *
 * Before it existed, `POST /api/settings/permissions` with
 * `{scope:"project", cwd:"/anywhere"}` wrote `/anywhere/.claude/settings.json`
 * — verified against a running instance, cross-origin, HTTP 200. settings.json
 * carries `hooks`, `env` and `apiKeyHelper`, so that was an arbitrary-directory
 * write with a path to code execution.
 *
 * The property under test is narrow and load-bearing: a cwd is accepted only
 * when it is exactly a directory the user registered, and the value handed
 * back is the *store's* string, never the caller's — that is what keeps the
 * request out of the path that reaches the filesystem.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { resolveTrustedCwd, __resetTrustedCwdCache } from "@/lib/server/trusted-cwd";
import { workspacesFile, type Workspace } from "@/lib/server/workspaces-store";
import { makeTempHome, type TmpHome } from "./helpers/tmp-home";

function gitEnv(): NodeJS.ProcessEnv {
  // Strip every GIT_* var before spawning. Git hooks (this repo runs unit
  // tests from pre-commit) export GIT_INDEX_FILE / GIT_DIR pointing at the
  // *outer* repo, which makes git operations inside these throwaway repos
  // fail with "index file open failed". Also pin config to /dev/null so a
  // developer's global `commit.gpgsign` or `core.hooksPath` can't break the
  // fixture locally while CI stays green.
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith("GIT_")) delete env[k];
  }
  return {
    ...env,
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: "test@example.com",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
}

let tmp: TmpHome;
let wsRoot: string;
let extraDir: string;

function writeWorkspaces(workspaces: Workspace[]): void {
  const file = workspacesFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({ version: 1, activeId: workspaces[0]?.id ?? null, workspaces }, null, 2),
    "utf8",
  );
}

function makeWorkspace(rootPath: string, additionalDirectories?: string[]): Workspace {
  return {
    id: "wks_" + randomUUID().replace(/-/g, "").slice(0, 12),
    name: "fixture",
    rootPath,
    icon: { kind: "letter", letter: "F", color: "#000000" },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    defaults: additionalDirectories ? { additionalDirectories } : {},
  };
}

beforeEach(() => {
  // The guard memoises the registered-root list; each test writes a fresh
  // workspaces.json, so a leaked cache would answer from the previous one.
  __resetTrustedCwdCache();
  tmp = makeTempHome();
  wsRoot = mkdtempSync(join(tmpdir(), "claudius-trusted-ws-"));
  extraDir = mkdtempSync(join(tmpdir(), "claudius-trusted-extra-"));
  writeWorkspaces([makeWorkspace(wsRoot, [extraDir])]);
});

afterEach(() => {
  __resetTrustedCwdCache();
  tmp.restore();
  rmSync(wsRoot, { recursive: true, force: true });
  rmSync(extraDir, { recursive: true, force: true });
});

describe("resolveTrustedCwd", () => {
  test("accepts a registered workspace root", async () => {
    expect(await resolveTrustedCwd(wsRoot)).toBe(resolve(wsRoot));
  });

  test("accepts a directory the user granted via additionalDirectories", async () => {
    expect(await resolveTrustedCwd(extraDir)).toBe(resolve(extraDir));
  });

  test("falls back to process.cwd() when no cwd is supplied", async () => {
    // Preserves what every route did before: `searchParams.get("cwd") || process.cwd()`.
    for (const empty of [null, undefined, "", "   "]) {
      expect(await resolveTrustedCwd(empty)).toBe(resolve(process.cwd()));
    }
  });

  test("rejects a directory that is not registered", async () => {
    const outsider = mkdtempSync(join(tmpdir(), "claudius-trusted-evil-"));
    try {
      expect(await resolveTrustedCwd(outsider)).toBeNull();
    } finally {
      rmSync(outsider, { recursive: true, force: true });
    }
  });

  test("rejects traversal out of a registered root", async () => {
    expect(await resolveTrustedCwd(join(wsRoot, "..", "..", "etc"))).toBeNull();
    expect(await resolveTrustedCwd("/")).toBeNull();
    expect(await resolveTrustedCwd("/etc")).toBeNull();
  });

  test("rejects a *descendant* of a registered root", async () => {
    // Exact-match is deliberate: it lets us return the store's own string, so
    // the value reaching fs.* never originates from the request. Loosening
    // this to a prefix check would quietly undo that.
    const child = join(wsRoot, "sub");
    mkdirSync(child, { recursive: true });
    expect(await resolveTrustedCwd(child)).toBeNull();
  });

  test("returns the store's string, not the caller's spelling of it", async () => {
    // `<root>/./` and `<root>/sub/..` resolve to the same directory. The
    // return value must be the canonical store entry either way.
    const dressed = join(wsRoot, ".", "sub", "..");
    expect(await resolveTrustedCwd(dressed)).toBe(resolve(wsRoot));
  });

  test("accepts a git worktree of a registered root", async () => {
    // EnterWorktree lets the SDK pick the location, so the guard asks git
    // rather than assuming the worktree lives under the workspace.
    const git = (args: string[], cwd: string) =>
      execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv() });

    git(["init", "-q", "-b", "main"], wsRoot);
    writeFileSync(join(wsRoot, "f.txt"), "x\n");
    git(["add", "."], wsRoot);
    git(["commit", "-qm", "base"], wsRoot);

    const wt = join(mkdtempSync(join(tmpdir(), "claudius-trusted-wt-")), "tree");
    try {
      git(["worktree", "add", "-q", wt, "-b", "side"], wsRoot);
      // Compare against git's own spelling of the path, which is what both
      // the SDK's session cwd and our `listWorktrees` report. (On macOS git
      // canonicalises the tmpdir's /var → /private/var symlink, so asserting
      // on the raw mkdtemp string would be testing the symlink, not the guard.)
      const reported = git(["rev-parse", "--show-toplevel"], wt).trim();
      expect(await resolveTrustedCwd(reported)).toBe(reported);
    } finally {
      rmSync(dirname(wt), { recursive: true, force: true });
    }
  });

  test("accepts a registered root spelled through a symlink", async () => {
    // The store and the caller can disagree on spelling when a symlink sits
    // in the path; trustedRoots() carries both forms so that isn't a rejection.
    const real = await realpath(wsRoot);
    expect(await resolveTrustedCwd(real)).toBe(real);
  });
});
