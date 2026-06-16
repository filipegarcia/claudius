/**
 * End-to-end coverage of the deterministic stash-ff update strategy against a
 * REAL git remote — the path that handles the common "user has uncommitted
 * customizations + upstream moved" case without spawning Claude.
 *
 * These exercise the exact helper sequence `runStashFastForward` uses
 * (`stashPushIncludeUntracked` → `pullFastForward` → `stashPop`) across the
 * three outcomes that matter, plus the conflict-detection chokepoint that gates
 * `bun install`:
 *
 *   1. changes-local + changes-remote, NO overlap  → clean pop, tree carries
 *      both, nothing to resolve.
 *   2. changes-local + changes-remote, SAME lines  → pop conflict, markers in
 *      the tree, `hasConflicts` true (so the updater diverts to resolution
 *      instead of feeding markers to `bun install`).
 *   3. untracked-local file that upstream also added → "file already exists, no
 *      checkout" FALSE conflict — recovered automatically, tree ends clean at
 *      upstream + the user's tracked edits, `hasConflicts` false.
 *
 * A real bare remote + two clones is the only faithful way to reproduce
 * `git pull --ff-only` semantics and the stash-pop edge cases; mocks can't.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  conflictedFiles,
  hasConflicts,
  pullFastForward,
  stashPop,
  stashPushIncludeUntracked,
} from "@/lib/server/updater/git";

const OPEN = "<".repeat(7);

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

/** Run the stash-ff sequence exactly as `runStashFastForward` does. */
async function stashFastForward(local: string): Promise<{ kind: "applied" } | { kind: "conflicts" }> {
  const { stashed } = await stashPushIncludeUntracked(local, "claudius-updater-stash");
  await pullFastForward(local, "origin", "main");
  if (!stashed) return { kind: "applied" };
  const pop = await stashPop(local);
  return pop.ok ? { kind: "applied" } : { kind: "conflicts" };
}

describe("stash-ff update flow (real remote)", () => {
  let remote: string;
  let upstream: string;
  let local: string;

  beforeEach(() => {
    remote = mkdtempSync(join(tmpdir(), "claudius-remote-"));
    upstream = mkdtempSync(join(tmpdir(), "claudius-upstream-"));

    gitSync(["init", "--bare", "-b", "main", "--quiet", remote], process.cwd());

    // Seed the remote from the "upstream" clone with a base commit.
    gitSync(["init", "--quiet", "-b", "main"], upstream);
    writeFileSync(join(upstream, "shared.txt"), "base\n");
    writeFileSync(join(upstream, "other.txt"), "base\n");
    writeFileSync(join(upstream, "pkg.json"), '{\n  "v": 1\n}\n');
    gitSync(["add", "."], upstream);
    gitSync(["commit", "--quiet", "-m", "base"], upstream);
    gitSync(["remote", "add", "origin", remote], upstream);
    gitSync(["push", "--quiet", "-u", "origin", "main"], upstream);

    // The Claudius install checkout: a clone that will go "behind" upstream.
    local = mkdtempSync(join(tmpdir(), "claudius-local-"));
    gitSync(["clone", "--quiet", "-b", "main", remote, local], process.cwd());
  });

  afterEach(() => {
    for (const d of [remote, upstream, local]) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  });

  /** Make an upstream commit and push it so `local` is one behind. */
  function pushUpstream(file: string, content: string, message: string): void {
    writeFileSync(join(upstream, file), content);
    gitSync(["add", "."], upstream);
    gitSync(["commit", "--quiet", "-m", message], upstream);
    gitSync(["push", "--quiet", "origin", "main"], upstream);
  }

  test("local + remote changes, no overlap → clean pop, both preserved", async () => {
    pushUpstream("other.txt", "upstream change\n", "bump other");
    // Local uncommitted customization to a DIFFERENT file.
    writeFileSync(join(local, "shared.txt"), "my customization\n");

    const result = await stashFastForward(local);

    expect(result.kind).toBe("applied");
    expect(await hasConflicts(local)).toBe(false);
    // Both the upstream change and the local edit survived.
    expect(readFileSync(join(local, "other.txt"), "utf8")).toBe("upstream change\n");
    expect(readFileSync(join(local, "shared.txt"), "utf8")).toBe("my customization\n");
  });

  test("local + remote changes to the SAME lines → pop conflict, markers caught", async () => {
    pushUpstream("pkg.json", '{\n  "v": 2\n}\n', "bump v to 2");
    // Local uncommitted edit to the same key.
    writeFileSync(join(local, "pkg.json"), '{\n  "v": 15\n}\n');

    const result = await stashFastForward(local);

    expect(result.kind).toBe("conflicts");
    // The chokepoint that prevents marker-laden JSON reaching `bun install`.
    expect(await hasConflicts(local)).toBe(true);
    expect(await conflictedFiles(local)).toContain("pkg.json");
    expect(readFileSync(join(local, "pkg.json"), "utf8")).toContain(`${OPEN} `);
  });

  test("untracked local file upstream also added → false conflict recovered clean", async () => {
    pushUpstream("generated.txt", "upstream generated\n", "add generated");
    // Local has an UNTRACKED file at the same path (e.g. a build artifact).
    writeFileSync(join(local, "generated.txt"), "local generated\n");
    // Plus a tracked customization that must survive the recovery.
    writeFileSync(join(local, "shared.txt"), "kept customization\n");

    const result = await stashFastForward(local);

    // "file already exists, no checkout" is recovered, not surfaced as a conflict.
    expect(result.kind).toBe("applied");
    expect(await hasConflicts(local)).toBe(false);
    // HEAD advanced to upstream; the tracked customization is preserved.
    expect(readFileSync(join(local, "shared.txt"), "utf8")).toBe("kept customization\n");
    expect(gitSync(["rev-parse", "HEAD"], local)).toBe(gitSync(["rev-parse", "origin/main"], local));
  });
});
