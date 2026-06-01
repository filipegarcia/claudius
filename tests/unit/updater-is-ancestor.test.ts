/**
 * Regression coverage for the /api/updater/status reconcile path.
 *
 * The bug this catches:
 *
 *   `state.pending` is a cache written by `checkForUpdates()`. If the user
 *   does `git pull` outside Claudius (terminal, IDE, whatever), HEAD now
 *   contains the commit we recorded as `pending.remoteSha` — but the cached
 *   pending field stays put until the next scheduled check (24h default).
 *   The banner ("Pending update · 1 commit behind origin/main") keeps
 *   showing even though there's nothing to apply.
 *
 *   `app/api/updater/status/route.ts` now reconciles on read: if
 *   `isAncestor(pending.remoteSha, HEAD)` returns true, the field is dropped
 *   from the response. This test pins the underlying git helper that the
 *   reconcile relies on, since `git merge-base --is-ancestor` has two
 *   surprising contracts:
 *
 *     - exit 0 = yes, exit 1 = no — both are *normal* answers. The naive
 *       `git()` wrapper throws on any non-zero exit, so an "is not an
 *       ancestor" answer would surface as an error and the reconcile would
 *       fail-open (banner stays). The helper must catch exit 1 and return
 *       `false`.
 *
 *     - exit 128 = "unknown revision" (e.g. the SHA was gc'd, or the file
 *       was edited to garbage). The helper must fail-safe to `false` so a
 *       still-valid pending isn't silently hidden.
 *
 *   A unit test against a real temp git repo is the cheapest way to lock
 *   both — mocks can't reproduce the exit-code split.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { headSha, isAncestor, revParse } from "@/lib/server/updater/git";

function gitSync(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      // Keep commits deterministic and independent of the host config.
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
      GIT_TERMINAL_PROMPT: "0",
    },
  }).trim();
}

describe("isAncestor", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "claudius-isancestor-"));
    gitSync(["init", "--quiet", "-b", "main"], repo);
    gitSync(["commit", "--allow-empty", "-m", "A"], repo);
  });

  afterEach(() => {
    try {
      rmSync(repo, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  test("returns true when the ancestor is in HEAD's history (clean ff case)", async () => {
    const a = await headSha(repo);
    gitSync(["commit", "--allow-empty", "-m", "B"], repo);
    const b = await headSha(repo);

    // A is reachable from B: this is the "user pulled, banner should drop"
    // case. The reconcile sees true and strips state.pending.
    expect(await isAncestor(repo, a, b)).toBe(true);
    // Reflexive: A is an ancestor of itself. Covers the edge where the user
    // was already at remoteSha when the cache was written.
    expect(await isAncestor(repo, a, a)).toBe(true);
  });

  test("returns false (not throws) when not an ancestor — exit 1 from git", async () => {
    const a = await headSha(repo);
    gitSync(["commit", "--allow-empty", "-m", "B"], repo);
    const b = await headSha(repo);

    // B is NOT in A's history: the user hasn't pulled yet, the pending is
    // still real, the reconcile must leave it alone. Critically this case
    // hits `git merge-base --is-ancestor` exit 1, which the raw wrapper
    // surfaces as a thrown UpdaterGitError — the helper must swallow it.
    expect(await isAncestor(repo, b, a)).toBe(false);
  });

  test("fail-safe to false when the ancestor ref doesn't resolve (exit 128)", async () => {
    const head = await headSha(repo);
    // Garbage SHA that git can't resolve — simulates a remoteSha that was
    // gc'd or a hand-edited updater.json. Must return false so the caller
    // *keeps* the pending banner up rather than silently hiding what could
    // still be a real update.
    expect(await isAncestor(repo, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", head)).toBe(false);
  });

  test("handles short SHAs the same way git CLI does", async () => {
    const a = await headSha(repo);
    gitSync(["commit", "--allow-empty", "-m", "B"], repo);
    const b = await headSha(repo);

    // The updater stores full SHAs in `pending.remoteSha`, but the UI
    // displays a 7-char prefix. The reconcile uses the stored full SHA, but
    // belt-and-suspenders: short SHAs that git resolves should also work.
    expect(await isAncestor(repo, a.slice(0, 7), b)).toBe(true);
    // And revParse round-trips back to full SHA.
    expect(await revParse(repo, a.slice(0, 7))).toBe(a);
  });
});
