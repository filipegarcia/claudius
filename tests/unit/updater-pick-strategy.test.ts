import { describe, expect, test } from "vitest";
import { pickStrategy } from "@/lib/server/updater/apply";
import type { UpdaterPending } from "@/lib/server/updater/settings";

/**
 * Regression coverage for the updater's strategy picker — specifically
 * the new "stash-ff" branch that handles the common dirty-working-tree
 * case without spawning the Claude merge agent.
 *
 * Why this matters:
 *
 *   Before the stash-ff path, dirty + clean-ff would either skip (ff-only
 *   mode) or fire the LLM (cc-merge mode). The LLM path was the one that
 *   surfaced "Claude merge failed: working tree still dirty after merge
 *   attempt" errors on tiny customisation tweaks. Now we just stash, ff
 *   pull, pop — deterministic, no API spend, and conflicts on the pop
 *   trigger the interactive resolve-with-Claude flow instead of failing.
 *
 *   The contract pinned here:
 *     - clean ff (clean + behind > 0)               → "ff-only"
 *     - dirty + ahead === 0 + behind > 0            → "stash-ff" (in any
 *                                                      auto-apply mode, or
 *                                                      with manual override)
 *     - diverged (ahead > 0)                        → "cc-merge" when allowed,
 *                                                      otherwise "skip"
 *     - notify-only without override                → "skip"
 */

function makePending(over: Partial<UpdaterPending>): UpdaterPending {
  return {
    remoteSha: "remote".padEnd(40, "0"),
    ahead: 0,
    behind: 1,
    dirty: false,
    branch: "main",
    upstreamBranch: "origin/main",
    ...over,
  };
}

describe("pickStrategy", () => {
  test("clean fast-forward → ff-only in every mode", () => {
    const p = makePending({ dirty: false, ahead: 0, behind: 1 });
    expect(pickStrategy("cc-merge", p, false).kind).toBe("ff-only");
    expect(pickStrategy("ff-only", p, false).kind).toBe("ff-only");
    expect(pickStrategy("notify-only", p, false).kind).toBe("ff-only");
    // The override is for opting INTO cc-merge; a clean ff doesn't need it.
    expect(pickStrategy("ff-only", p, true).kind).toBe("ff-only");
  });

  test("dirty tree + clean ff → stash-ff in auto-apply modes", () => {
    const p = makePending({ dirty: true, ahead: 0, behind: 2 });
    expect(pickStrategy("cc-merge", p, false).kind).toBe("stash-ff");
    expect(pickStrategy("ff-only", p, false).kind).toBe("stash-ff");
  });

  test("dirty tree + clean ff → stash-ff when user opts in via override", () => {
    // notify-only mode + manual click triggers the same stash path. The
    // override is named `allowCcMerge` historically but in practice it just
    // means "user explicitly wants to apply".
    const p = makePending({ dirty: true, ahead: 0, behind: 2 });
    expect(pickStrategy("notify-only", p, true).kind).toBe("stash-ff");
  });

  test("dirty tree + clean ff in notify-only mode without override → skip", () => {
    const p = makePending({ dirty: true, ahead: 0, behind: 2 });
    const s = pickStrategy("notify-only", p, false);
    expect(s.kind).toBe("skip");
  });

  test("diverged (ahead > 0) + cc-merge mode → cc-merge", () => {
    const p = makePending({ dirty: false, ahead: 2, behind: 3 });
    expect(pickStrategy("cc-merge", p, false).kind).toBe("cc-merge");
  });

  test("diverged (ahead > 0) + ff-only mode → skip", () => {
    // Stash doesn't help a divergent branch — local commits aren't in the
    // stash. Without cc-merge, we have to bail.
    const p = makePending({ dirty: false, ahead: 2, behind: 3 });
    const s = pickStrategy("ff-only", p, false);
    expect(s.kind).toBe("skip");
  });

  test("diverged (ahead > 0) + manual override → cc-merge", () => {
    const p = makePending({ dirty: false, ahead: 2, behind: 3 });
    expect(pickStrategy("ff-only", p, true).kind).toBe("cc-merge");
    expect(pickStrategy("notify-only", p, true).kind).toBe("cc-merge");
  });

  test("dirty AND diverged → cc-merge when allowed (stash alone can't reconcile)", () => {
    const p = makePending({ dirty: true, ahead: 1, behind: 1 });
    expect(pickStrategy("cc-merge", p, false).kind).toBe("cc-merge");
    expect(pickStrategy("ff-only", p, true).kind).toBe("cc-merge");
  });
});
