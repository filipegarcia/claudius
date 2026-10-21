import { describe, expect, test, vi } from "vitest";

import {
  AUTO_MERGE_HOLD_LABEL,
  MERGE_DECISION_END,
  MERGE_DECISION_START,
  autoMergeWith,
  buildDecisionNeededAnnouncement,
  deterministicBlockers,
  packageJsonBlockers,
  parseAutoMergeMode,
  parseMergeReview,
  parsePrMergeFacts,
  renderDecisionBlock,
  sensitivePathBlockers,
  stripDecisionBlock,
  upsertDecisionBlock,
  type AutoMergeDeps,
  type MergeReview,
  type PrMergeFacts,
} from "../../scripts/sdk-update/merge-gate";
import { findBodyPlaceholders, renderMergeReviewPrompt } from "../../scripts/sdk-update/orchestrate";

/**
 * The merge gate decides whether an update PR merges unattended, and every
 * merge to main is a release. So the tests mostly pin the fail-closed
 * edges: anything unreadable, moved or uncertain escalates to a human.
 */

const SHA = "a".repeat(40);

function facts(over: Partial<PrMergeFacts> = {}): PrMergeFacts {
  return {
    number: 320,
    url: "https://github.com/o/r/pull/320",
    title: "chore(deps): bump claude-agent-sdk 0.3.306 → 0.3.307",
    state: "OPEN",
    isDraft: false,
    baseRefName: "main",
    headRefName: "sdk-update/0.3.307",
    headRefOid: SHA,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: "",
    labels: [],
    body: "# SDK bump\n\nNotes.",
    ...over,
  };
}

const CLEAN = {
  facts: facts(),
  headMatchesLocal: true,
  ciVerdict: "pass",
  bodyPlaceholders: [] as string[],
  files: ["package.json", "bun.lock", "docs/sdk-updates/0.3.307/notes.md"],
  packageJson: [] as string[],
};

const MERGE: MergeReview = {
  verdict: "merge",
  summary: "Dependency bump with an empty type-surface diff.",
  concerns: [],
  question: "",
  options: [],
  recommendation: "",
};

const NEEDS_HUMAN: MergeReview = {
  verdict: "needs_human",
  summary: "The notes claim a settings toggle that the diff never adds.",
  concerns: ["`lib/client/settings.tsx`: the claimed toggle is missing."],
  question: "Ship without the toggle the notes describe?",
  options: ["Merge as-is and fix the notes.", "Push the toggle first."],
  recommendation: "Push the toggle first: the notes would be wrong otherwise.",
};

describe("parseAutoMergeMode", () => {
  test("defaults to on; 0/off disable; review never merges", () => {
    expect(parseAutoMergeMode(undefined)).toBe("on");
    expect(parseAutoMergeMode("1")).toBe("on");
    expect(parseAutoMergeMode("0")).toBe("off");
    expect(parseAutoMergeMode(" OFF ")).toBe("off");
    expect(parseAutoMergeMode("review")).toBe("review");
    expect(parseAutoMergeMode("dry")).toBe("review");
  });
});

describe("parsePrMergeFacts", () => {
  test("flattens labels and defaults missing strings", () => {
    const f = parsePrMergeFacts(
      JSON.stringify({
        number: 7,
        headRefOid: SHA,
        isDraft: false,
        labels: [{ name: "needs-human" }, { name: AUTO_MERGE_HOLD_LABEL }],
      }),
    );
    expect(f.labels).toEqual(["needs-human", AUTO_MERGE_HOLD_LABEL]);
    expect(f.mergeable).toBe("");
    expect(f.body).toBe("");
  });
  test("throws without a number or head SHA", () => {
    expect(() => parsePrMergeFacts(JSON.stringify({ number: 7 }))).toThrow();
  });
});

describe("sensitivePathBlockers", () => {
  test("flags the pipeline, workflows, migrations and packaging", () => {
    const out = sensitivePathBlockers([
      "scripts/sdk-update/orchestrate.ts",
      ".github/workflows/ci.yml",
      "lib/server/db-migrations/031_x.sql",
      "electron/main.ts",
      "lib/server/session.ts",
    ]);
    expect(out).toHaveLength(4);
    expect(out.join("\n")).toContain("`scripts/sdk-update/orchestrate.ts`");
    expect(out.join("\n")).not.toContain("session.ts");
  });
  test("ordinary product code is not sensitive", () => {
    expect(sensitivePathBlockers(["app/page.tsx", "lib/server/session.ts", "tests/unit/x.test.ts"])).toEqual([]);
  });
});

describe("packageJsonBlockers", () => {
  const base = JSON.stringify({
    version: "0.3.306",
    scripts: { build: "next build" },
    dependencies: { "@anthropic-ai/claude-agent-sdk": "^0.3.306", clsx: "^2.1.1" },
  });
  test("the version + SDK bump the pipelines make is fine", () => {
    const head = base.replace(/0\.3\.306/g, "0.3.307");
    expect(packageJsonBlockers(base, head)).toEqual([]);
  });
  test("a new or bumped third-party dependency blocks", () => {
    const head = JSON.stringify({
      version: "0.3.307",
      scripts: { build: "next build" },
      dependencies: { "@anthropic-ai/claude-agent-sdk": "^0.3.307", clsx: "^2.2.0", "left-pad": "1.0.0" },
    });
    const [msg] = packageJsonBlockers(base, head);
    expect(msg).toContain("`clsx` ^2.1.1 → ^2.2.0");
    expect(msg).toContain("`left-pad` (absent) → 1.0.0");
  });
  test("a scripts change blocks", () => {
    const head = base.replace("next build", "next build --no-lint");
    expect(packageJsonBlockers(base, head)[0]).toContain("`scripts` changed");
  });
  test("unreadable package.json fails closed", () => {
    expect(packageJsonBlockers(null, base)).toHaveLength(1);
    expect(packageJsonBlockers(base, "{nope")).toHaveLength(1);
  });
});

describe("deterministicBlockers", () => {
  test("a clean green SDK bump has none", () => {
    expect(deterministicBlockers(CLEAN)).toEqual([]);
  });
  test.each<[string, Partial<typeof CLEAN>]>([
    ["moved head", { headMatchesLocal: false }],
    ["CI not green", { ciVerdict: "pending" }],
    ["CI unreadable", { ciVerdict: "unknown" }],
    ["draft", { facts: facts({ isDraft: true }) }],
    ["conflicts", { facts: facts({ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }) }],
    ["mergeability unknown", { facts: facts({ mergeable: "UNKNOWN" }) }],
    ["unstable", { facts: facts({ mergeStateStatus: "UNSTABLE" }) }],
    ["changes requested", { facts: facts({ reviewDecision: "CHANGES_REQUESTED" }) }],
    ["hold label", { facts: facts({ labels: [AUTO_MERGE_HOLD_LABEL] }) }],
    ["needs-human label", { facts: facts({ labels: ["needs-human"] }) }],
    ["wrong base", { facts: facts({ baseRefName: "release" }) }],
    ["placeholders", { bodyPlaceholders: ["_(TODO fill me)_"] }],
    ["no files", { files: [] }],
    ["sensitive path", { files: [".github/workflows/ci.yml"] }],
    ["package.json", { packageJson: ["`package.json` changes beyond…"] }],
  ])("%s blocks", (_name, over) => {
    expect(deterministicBlockers({ ...CLEAN, ...over }).length).toBeGreaterThan(0);
  });
  test("a conflict is reported once, not again as a merge state", () => {
    const out = deterministicBlockers({
      ...CLEAN,
      facts: facts({ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }),
    });
    expect(out).toEqual(["The branch conflicts with `main`."]);
  });
});

describe("parseMergeReview", () => {
  test("accepts the schema shape, as an object or a JSON string", () => {
    expect(parseMergeReview(MERGE)).toEqual(MERGE);
    expect(parseMergeReview(JSON.stringify(NEEDS_HUMAN))).toEqual(NEEDS_HUMAN);
  });
  test("anything else is unusable (escalates)", () => {
    expect(parseMergeReview(undefined)).toBeNull();
    expect(parseMergeReview("not json")).toBeNull();
    expect(parseMergeReview({ ...MERGE, verdict: "yes" })).toBeNull();
    expect(parseMergeReview({ verdict: "merge" })).toBeNull();
  });
  test("drops blank list entries", () => {
    expect(parseMergeReview({ ...MERGE, concerns: ["", " ", "real"] })?.concerns).toEqual(["real"]);
  });
});

describe("decision block", () => {
  const block = renderDecisionBlock({
    blockers: ["Touches the update pipeline itself (`scripts/sdk-update/x.ts`)."],
    review: NEEDS_HUMAN,
    reviewError: null,
    reviewOnly: false,
    headSha: SHA,
  });

  test("leads with the question, then the options and the recommendation", () => {
    expect(block.startsWith(MERGE_DECISION_START)).toBe(true);
    expect(block.endsWith(MERGE_DECISION_END)).toBe(true);
    const q = block.indexOf(NEEDS_HUMAN.question);
    expect(q).toBeGreaterThan(-1);
    expect(block.indexOf("1. Merge as-is")).toBeGreaterThan(q);
    expect(block).toContain(NEEDS_HUMAN.recommendation);
    expect(block).toContain("update pipeline itself");
    expect(block).toContain(NEEDS_HUMAN.concerns[0]);
  });

  test("never trips the placeholder backstop on the next firing", () => {
    expect(findBodyPlaceholders(block)).toEqual([]);
  });

  test("without a usable review it still asks a question and says why", () => {
    const b = renderDecisionBlock({
      blockers: [],
      review: null,
      reviewError: "idle timeout",
      reviewOnly: false,
      headSha: SHA,
    });
    expect(b).toContain("Is this PR safe to merge as-is?");
    expect(b).toContain("idle timeout");
  });

  test("upsert puts it on top and replaces an earlier one instead of stacking", () => {
    const once = upsertDecisionBlock("# Title\n\nbody", block);
    expect(once.startsWith(MERGE_DECISION_START)).toBe(true);
    expect(once.endsWith("# Title\n\nbody")).toBe(true);
    const twice = upsertDecisionBlock(once, block.replace(NEEDS_HUMAN.question, "Second question?"));
    expect(twice.split(MERGE_DECISION_START)).toHaveLength(2);
    expect(twice).toContain("Second question?");
    expect(twice).not.toContain(NEEDS_HUMAN.question);
    expect(stripDecisionBlock(twice)).toBe("# Title\n\nbody");
  });

  test("a body without a block is left alone", () => {
    expect(stripDecisionBlock("plain")).toBe("plain");
    expect(stripDecisionBlock(`${MERGE_DECISION_START} unterminated`)).toBe(`${MERGE_DECISION_START} unterminated`);
  });
});

describe("buildDecisionNeededAnnouncement", () => {
  test("question first, at most three reasons, no doubled blank lines", () => {
    const msg = buildDecisionNeededAnnouncement({
      prUrl: "https://x/pull/1",
      title: "t",
      question: "Merge?",
      reasons: ["a", "b", "c", "d"],
    });
    expect(msg).toContain("**Merge?**");
    expect(msg).toContain("…and 1 more");
    expect(msg).not.toContain("\n\n\n");
  });
});

describe("renderMergeReviewPrompt", () => {
  test("fills every placeholder in merge-review-prompt.md", () => {
    const prompt = renderMergeReviewPrompt({
      facts: facts({ body: "run notes here" }),
      blockers: [],
      diffStat: " package.json | 2 +-",
      diff: "diff --git a/package.json b/package.json",
    });
    expect(prompt).not.toMatch(/\{\{[A-Z0-9_]+\}\}/);
    expect(prompt).toContain("run notes here");
    expect(prompt).toContain("None. The deterministic checks all passed.");
  });
  test("strips an earlier decision block from the body it shows the reviewer", () => {
    const body = upsertDecisionBlock(
      "run notes here",
      `${MERGE_DECISION_START}\nstale question\n${MERGE_DECISION_END}`,
    );
    const prompt = renderMergeReviewPrompt({ facts: facts({ body }), blockers: [], diffStat: "", diff: "" });
    expect(prompt).not.toContain("stale question");
  });
});

describe("autoMergeWith", () => {
  function deps(over: Partial<AutoMergeDeps> = {}): AutoMergeDeps & {
    merge: ReturnType<typeof vi.fn>;
    writeBody: ReturnType<typeof vi.fn>;
    markNeedsHuman: ReturnType<typeof vi.fn>;
  } {
    return {
      mode: "on",
      readFacts: () => facts(),
      headMatchesLocal: () => true,
      ciVerdict: () => "pass",
      changedFiles: () => ["package.json", "bun.lock"],
      packageJsonBlockers: () => [],
      bodyPlaceholders: () => [],
      review: async () => ({ review: MERGE }),
      merge: vi.fn(() => ({ ok: true as const })),
      writeBody: vi.fn(),
      markNeedsHuman: vi.fn(),
      log: () => {},
      ...over,
    } as never;
  }

  test("all clear → merges at the re-read head, writes nothing", async () => {
    const d = deps();
    const out = await autoMergeWith(d);
    expect(out.kind).toBe("merged");
    expect(d.merge).toHaveBeenCalledWith(SHA);
    expect(d.writeBody).not.toHaveBeenCalled();
    expect(d.markNeedsHuman).not.toHaveBeenCalled();
  });

  test("a deterministic blocker escalates even when the review says merge", async () => {
    const d = deps({ changedFiles: () => [".github/workflows/ci.yml"] });
    const out = await autoMergeWith(d);
    expect(out.kind).toBe("escalated");
    expect(d.merge).not.toHaveBeenCalled();
    expect(d.markNeedsHuman).toHaveBeenCalled();
    const body = d.writeBody.mock.calls[0]![0] as string;
    expect(body.startsWith(MERGE_DECISION_START)).toBe(true);
    expect(body).toContain("CI / release workflows");
  });

  test("the review still runs with blockers present, to frame the question", async () => {
    const review = vi.fn(async () => ({ review: NEEDS_HUMAN }));
    const d = deps({ ciVerdict: () => "unknown", review });
    const out = await autoMergeWith(d);
    expect(review).toHaveBeenCalledTimes(1);
    expect(out.kind === "escalated" && out.question).toBe(NEEDS_HUMAN.question);
  });

  test("review says needs_human → escalates with its question", async () => {
    const d = deps({ review: async () => ({ review: NEEDS_HUMAN }) });
    const out = await autoMergeWith(d);
    expect(out.kind).toBe("escalated");
    expect(d.merge).not.toHaveBeenCalled();
    expect((d.writeBody.mock.calls[0]![0] as string).indexOf(NEEDS_HUMAN.question)).toBeLessThan(200);
  });

  test("a failed or crashed review fails closed", async () => {
    for (const review of [
      async () => ({ error: "wall-clock budget exhausted (30 min)" }),
      async () => {
        throw new Error("boom");
      },
    ]) {
      const d = deps({ review });
      expect((await autoMergeWith(d)).kind).toBe("escalated");
      expect(d.merge).not.toHaveBeenCalled();
    }
  });

  test("a push during the review stops the merge (re-checked after it)", async () => {
    let reads = 0;
    const d = deps({
      readFacts: () => facts({ headRefOid: reads++ === 0 ? SHA : "b".repeat(40) }),
      headMatchesLocal: (f) => f.headRefOid === SHA,
    });
    const out = await autoMergeWith(d);
    expect(out.kind).toBe("escalated");
    expect(d.merge).not.toHaveBeenCalled();
  });

  test("a human adding the hold label during the review stops the merge", async () => {
    let reads = 0;
    const d = deps({ readFacts: () => facts({ labels: reads++ === 0 ? [] : [AUTO_MERGE_HOLD_LABEL] }) });
    expect((await autoMergeWith(d)).kind).toBe("escalated");
    expect(d.merge).not.toHaveBeenCalled();
  });

  test("gh pr merge failing escalates with its error", async () => {
    const d = deps({ merge: vi.fn(() => ({ ok: false as const, error: "Head branch was modified" })) });
    const out = await autoMergeWith(d);
    expect(out.kind).toBe("escalated");
    expect(d.writeBody.mock.calls[0]![0]).toContain("Head branch was modified");
  });

  test("review mode writes the block but never merges", async () => {
    const d = deps({ mode: "review" });
    const out = await autoMergeWith(d);
    expect(out.kind).toBe("escalated");
    expect(d.merge).not.toHaveBeenCalled();
    expect(d.writeBody.mock.calls[0]![0]).toContain("UPDATE_AUTO_MERGE=review");
  });

  test("off does nothing at all", async () => {
    const readFacts = vi.fn(() => facts());
    const d = deps({ mode: "off", readFacts });
    expect((await autoMergeWith(d)).kind).toBe("off");
    expect(readFacts).not.toHaveBeenCalled();
    expect(d.writeBody).not.toHaveBeenCalled();
  });

  test("a PR a human already merged or closed is left alone", async () => {
    const review = vi.fn();
    const d = deps({ readFacts: () => facts({ state: "MERGED" }), review: review as never });
    expect((await autoMergeWith(d)).kind).toBe("not-open");
    expect(review).not.toHaveBeenCalled();
    expect(d.writeBody).not.toHaveBeenCalled();
  });

  test("placeholders are judged on the body without the decision block", async () => {
    const seen: string[] = [];
    const d = deps({
      readFacts: () =>
        facts({ body: upsertDecisionBlock("notes", `${MERGE_DECISION_START}\n_(TODO x)_\n${MERGE_DECISION_END}`) }),
      bodyPlaceholders: (b) => {
        seen.push(b);
        return [];
      },
    });
    await autoMergeWith(d);
    expect(seen.every((b) => b === "notes")).toBe(true);
  });
});
