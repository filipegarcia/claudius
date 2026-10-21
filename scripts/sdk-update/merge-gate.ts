/**
 * scripts/sdk-update/merge-gate.ts
 *
 * The last step of a green update run: decide whether the PR can merge
 * without a human, and merge it if so. When it can't, write the question
 * the human has to answer at the TOP of the PR body, so the reviewer
 * opens the PR and sees the decision first instead of digging through
 * run-notes for it.
 *
 * Merging here is a release, not just a merge: every push to main fires
 * auto-tag.yml → release.yml, which builds and publishes the desktop app
 * that installs auto-update to. So the bar is "a reviewer would merge
 * this without asking anything", checked in two layers that BOTH have to
 * pass:
 *
 *   1. Deterministic blockers: cheap facts from gh/git that no amount of
 *      judgment overrides (head moved, conflicts, CI not green, a
 *      `needs-human`/`no-automerge` label, placeholder text in the body,
 *      paths a bot must never approve on its own, dependency changes
 *      beyond the SDK bump).
 *   2. A read-only Claude review of the diff against the PR body. It
 *      cross-checks the run-notes' claims against the code, because a
 *      "shipped" claim with no code behind it, or an empty PR, gets past
 *      every existing gate (cc-parity 2.1.248, 2.1.293).
 *
 * Fail closed throughout: an unreadable fact, a crashed or unparseable
 * review, or a failed merge call all escalate to the human.
 *
 * Pure logic plus `autoMergeWith`, whose IO is injected (same pattern as
 * `watchCiWith`). The gh/git/Claude wiring is `autoMergeOrEscalate` in
 * orchestrate.ts, which both pipelines call. This file imports nothing
 * from orchestrate.ts, so there is no import cycle.
 */

/** A human puts this on a PR to keep the bot from ever merging it. The pipeline never removes it. */
export const AUTO_MERGE_HOLD_LABEL = "no-automerge";
const NEEDS_HUMAN_LABEL = "needs-human";

/**
 * The decision block is fenced by these markers so a re-run can replace
 * it instead of stacking a second one. Plain HTML comments: they render
 * as nothing, and `findBodyPlaceholders` doesn't match them.
 */
export const MERGE_DECISION_START = "<!-- merge-decision:start -->";
export const MERGE_DECISION_END = "<!-- merge-decision:end -->";

/**
 * `UPDATE_AUTO_MERGE`:
 *   unset / "1" → "on": review, then merge when safe
 *   "review"    → review and write the decision block, never merge
 *   "0" / "off" → skip the step entirely (the PR is left ready for review, as before)
 */
export type AutoMergeMode = "on" | "review" | "off";

export function parseAutoMergeMode(raw: string | undefined): AutoMergeMode {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "0" || v === "off" || v === "false" || v === "no") return "off";
  if (v === "review" || v === "dry" || v === "dry-run") return "review";
  return "on";
}

// ── PR facts ──────────────────────────────────────────────────────────

export const PR_MERGE_FACT_FIELDS =
  "number,url,title,state,isDraft,baseRefName,headRefName,headRefOid,mergeable,mergeStateStatus,reviewDecision,labels,body";

export type PrMergeFacts = {
  number: number;
  url: string;
  title: string;
  /** OPEN / CLOSED / MERGED */
  state: string;
  isDraft: boolean;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  /** MERGEABLE / CONFLICTING / UNKNOWN (GitHub computes it lazily) */
  mergeable: string;
  /** CLEAN / HAS_HOOKS / UNSTABLE / BLOCKED / BEHIND / DIRTY / DRAFT / UNKNOWN */
  mergeStateStatus: string;
  /** "" / APPROVED / CHANGES_REQUESTED / REVIEW_REQUIRED */
  reviewDecision: string;
  labels: string[];
  body: string;
};

/** Parse `gh pr view <n> --json ${PR_MERGE_FACT_FIELDS}`. Throws on a malformed answer. */
export function parsePrMergeFacts(raw: string): PrMergeFacts {
  const j = JSON.parse(raw) as Record<string, unknown>;
  const str = (k: string) => (typeof j[k] === "string" ? (j[k] as string) : "");
  if (typeof j.number !== "number" || !str("headRefOid")) {
    throw new Error(`gh pr view returned no number/headRefOid: ${raw.slice(0, 200)}`);
  }
  const labels = Array.isArray(j.labels)
    ? (j.labels as Array<{ name?: unknown }>)
        .map((l) => (typeof l?.name === "string" ? l.name : ""))
        .filter(Boolean)
    : [];
  return {
    number: j.number,
    url: str("url"),
    title: str("title"),
    state: str("state"),
    isDraft: j.isDraft === true,
    baseRefName: str("baseRefName"),
    headRefName: str("headRefName"),
    headRefOid: str("headRefOid"),
    mergeable: str("mergeable"),
    mergeStateStatus: str("mergeStateStatus"),
    reviewDecision: str("reviewDecision"),
    labels,
    body: str("body"),
  };
}

// ── Deterministic blockers ────────────────────────────────────────────

/**
 * Paths an update PR may touch only with a human's sign-off, whatever
 * the review says. Each one either can't be undone by a revert or would
 * let the bot change its own rules.
 */
export const SENSITIVE_PATH_RULES: ReadonlyArray<{
  label: string;
  why: string;
  match: (p: string) => boolean;
}> = [
  {
    label: "CI / release workflows",
    why: "every merge to main cuts a release through these",
    match: (p) => p.startsWith(".github/"),
  },
  {
    label: "the update pipeline itself",
    why: "the bot must not approve changes to its own merge rules",
    match: (p) =>
      p.startsWith("scripts/sdk-update/") ||
      p.startsWith("scripts/cc-parity/") ||
      p.startsWith("scripts/lib/") ||
      p === "scripts/update-pipeline.sh",
  },
  {
    label: "a SQLite migration",
    why: "it runs against every user's database on upgrade, and reverting the PR does not undo it",
    match: (p) => p.startsWith("lib/server/db-migrations/"),
  },
  {
    label: "desktop main process / packaging",
    why: "a boot or signing regression reaches every auto-updating install",
    match: (p) =>
      p.startsWith("electron/") ||
      p === "electron-builder.yml" ||
      p.startsWith("scripts/electron-"),
  },
];

export function sensitivePathBlockers(files: readonly string[]): string[] {
  const out: string[] = [];
  for (const rule of SENSITIVE_PATH_RULES) {
    const hits = files.filter(rule.match);
    if (hits.length === 0) continue;
    const shown = hits.slice(0, 3).map((p) => `\`${p}\``).join(", ");
    const more = hits.length > 3 ? ` and ${hits.length - 3} more` : "";
    out.push(`Touches ${rule.label} (${shown}${more}). ${capitalize(rule.why)}.`);
  }
  return out;
}

/** The dependency the pipelines bump on purpose. Any other dependency change needs a human. */
export const PIPELINE_OWNED_DEPS: ReadonlySet<string> = new Set(["@anthropic-ai/claude-agent-sdk"]);
const DEP_SECTIONS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

/**
 * package.json changes beyond the two the pipelines make (the `version`
 * field and the SDK dependency). A new or bumped third-party package
 * pulls code nobody looked at into a release, and a `scripts` change
 * alters what CI and the release build run. `null` means a side couldn't
 * be read, which blocks (fail closed).
 */
export function packageJsonBlockers(baseText: string | null, headText: string | null): string[] {
  let base: Record<string, unknown>;
  let head: Record<string, unknown>;
  try {
    if (baseText === null || headText === null) throw new Error("missing");
    base = JSON.parse(baseText) as Record<string, unknown>;
    head = JSON.parse(headText) as Record<string, unknown>;
  } catch {
    return ["Could not compare `package.json` with main, so dependency changes can't be ruled out."];
  }
  const changes: string[] = [];
  for (const key of new Set([...Object.keys(base), ...Object.keys(head)])) {
    if (key === "version") continue;
    if (DEP_SECTIONS.includes(key)) {
      const b = (base[key] ?? {}) as Record<string, unknown>;
      const h = (head[key] ?? {}) as Record<string, unknown>;
      for (const dep of new Set([...Object.keys(b), ...Object.keys(h)])) {
        if (PIPELINE_OWNED_DEPS.has(dep) || b[dep] === h[dep]) continue;
        changes.push(`\`${dep}\` ${String(b[dep] ?? "(absent)")} → ${String(h[dep] ?? "(removed)")}`);
      }
    } else if (JSON.stringify(base[key]) !== JSON.stringify(head[key])) {
      changes.push(`\`${key}\` changed`);
    }
  }
  if (changes.length === 0) return [];
  const shown = changes.slice(0, 5).join("; ");
  const more = changes.length > 5 ? `; and ${changes.length - 5} more` : "";
  return [
    `\`package.json\` changes beyond the version and SDK bump: ${shown}${more}. ` +
      `New or changed dependencies and scripts need a human look before they ship in a release.`,
  ];
}

export function deterministicBlockers(args: {
  facts: PrMergeFacts;
  /** Whether the PR head commit carries the exact tree this run gated and reviewed locally. */
  headMatchesLocal: boolean;
  /** `ciVerdict` over the PR head's checks, or "unknown" when gh couldn't be read. */
  ciVerdict: string;
  bodyPlaceholders: readonly string[];
  files: readonly string[];
  packageJson: readonly string[];
}): string[] {
  const { facts } = args;
  const out: string[] = [];
  if (facts.state !== "OPEN") out.push(`The PR is ${facts.state || "not open"}.`);
  if (facts.baseRefName !== "main") out.push(`The PR targets \`${facts.baseRefName}\`, not \`main\`.`);
  if (facts.isDraft) out.push("The PR is still a draft.");
  if (!args.headMatchesLocal) {
    out.push(
      `The PR head (\`${facts.headRefOid.slice(0, 7)}\`) is not the commit this run gated and reviewed. ` +
        `Someone pushed to the branch since.`,
    );
  }
  if (args.ciVerdict !== "pass") out.push(`CI on the PR head is \`${args.ciVerdict}\`, not green.`);
  if (facts.mergeable === "CONFLICTING") {
    out.push("The branch conflicts with `main`.");
  } else if (facts.mergeable !== "MERGEABLE") {
    out.push(`GitHub reports mergeable=\`${facts.mergeable || "UNKNOWN"}\`.`);
  }
  if (
    facts.mergeable !== "CONFLICTING" &&
    facts.mergeStateStatus !== "CLEAN" &&
    facts.mergeStateStatus !== "HAS_HOOKS"
  ) {
    out.push(`GitHub reports merge state \`${facts.mergeStateStatus || "UNKNOWN"}\`, not \`CLEAN\`.`);
  }
  if (facts.reviewDecision === "CHANGES_REQUESTED") out.push("A reviewer requested changes.");
  if (facts.labels.includes(AUTO_MERGE_HOLD_LABEL)) {
    out.push(`The PR has the \`${AUTO_MERGE_HOLD_LABEL}\` label.`);
  }
  if (facts.labels.includes(NEEDS_HUMAN_LABEL)) out.push(`The PR has the \`${NEEDS_HUMAN_LABEL}\` label.`);
  if (args.bodyPlaceholders.length > 0) {
    out.push(
      `The PR body still has ${args.bodyPlaceholders.length} unfilled placeholder(s), so the run-notes are incomplete.`,
    );
  }
  if (args.files.length === 0) out.push("The PR changes no files.");
  out.push(...sensitivePathBlockers(args.files));
  out.push(...args.packageJson);
  return out;
}

// ── Claude review ─────────────────────────────────────────────────────

export type MergeReview = {
  verdict: "merge" | "needs_human";
  /** Two or three sentences: what the PR does and why it is or isn't safe. */
  summary: string;
  concerns: string[];
  /** The one question for the human. Empty when verdict is "merge". */
  question: string;
  options: string[];
  recommendation: string;
};

/** JSON schema handed to the SDK's `outputFormat`. Flat on purpose: no nullable objects. */
export const MERGE_REVIEW_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "summary", "concerns", "question", "options", "recommendation"],
  properties: {
    verdict: { type: "string", enum: ["merge", "needs_human"] },
    summary: { type: "string" },
    concerns: { type: "array", items: { type: "string" } },
    question: { type: "string" },
    options: { type: "array", items: { type: "string" } },
    recommendation: { type: "string" },
  },
};

/** Validate the review's structured output. `null` = unusable, which escalates. */
export function parseMergeReview(raw: unknown): MergeReview | null {
  let v = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (o.verdict !== "merge" && o.verdict !== "needs_human") return null;
  if (typeof o.summary !== "string") return null;
  const strings = (x: unknown) =>
    Array.isArray(x) ? x.filter((s): s is string => typeof s === "string" && s.trim() !== "") : [];
  return {
    verdict: o.verdict,
    summary: o.summary.trim(),
    concerns: strings(o.concerns),
    question: typeof o.question === "string" ? o.question.trim() : "",
    options: strings(o.options),
    recommendation: typeof o.recommendation === "string" ? o.recommendation.trim() : "",
  };
}

/** Largest diff inlined into the review prompt. Past this the reviewer Reads files itself. */
export const MAX_REVIEW_DIFF_CHARS = 150_000;

export function clipReviewDiff(diff: string): string {
  if (diff.length <= MAX_REVIEW_DIFF_CHARS) return diff;
  return (
    diff.slice(0, MAX_REVIEW_DIFF_CHARS) +
    `\n\n[diff clipped at ${MAX_REVIEW_DIFF_CHARS} chars of ${diff.length}. Read the remaining files from the working tree.]`
  );
}

export function renderBlockersForPrompt(blockers: readonly string[]): string {
  if (blockers.length === 0) return "None. The deterministic checks all passed.";
  return blockers.map((b) => `- ${b}`).join("\n");
}

// ── Decision block (top of the PR body) ───────────────────────────────

const FALLBACK_QUESTION = "Is this PR safe to merge as-is?";
const FALLBACK_OPTIONS = [
  "Merge it as-is.",
  "Push a fix to the branch first. The next pipeline run re-checks it.",
  "Close it and handle this release by hand.",
];

export function renderDecisionBlock(args: {
  blockers: readonly string[];
  review: MergeReview | null;
  reviewError: string | null;
  /** UPDATE_AUTO_MERGE=review: the bot never merges, even when everything passed. */
  reviewOnly: boolean;
  headSha: string;
}): string {
  const { review } = args;
  const question = review?.question || FALLBACK_QUESTION;
  const options = review && review.options.length > 0 ? review.options : FALLBACK_OPTIONS;

  const why: string[] = [...args.blockers];
  if (args.reviewError) {
    why.push(`The automated review didn't produce a usable verdict (${args.reviewError}).`);
  } else if (review?.verdict === "needs_human") {
    why.push(...(review.concerns.length > 0 ? review.concerns : ["The automated review asked for a human."]));
  }
  if (why.length === 0 && args.reviewOnly) {
    why.push(
      "Every check passed, but auto-merge is in review-only mode (`UPDATE_AUTO_MERGE=review`), so the bot does not merge.",
    );
  }

  const lines = [
    MERGE_DECISION_START,
    "## 🧑‍⚖️ Decision needed before merging",
    "",
    `**${question}**`,
    "",
    ...options.map((o, i) => `${i + 1}. ${o}`),
  ];
  if (review?.recommendation) lines.push("", `**Bot's recommendation:** ${review.recommendation}`);
  lines.push("", "**Why the bot didn't merge this itself:**", ...why.map((w) => `- ${w}`));
  if (review?.summary) {
    lines.push("", `**Automated review of \`${args.headSha.slice(0, 7)}\`:** ${review.summary}`);
    if (review.verdict === "merge" && review.concerns.length > 0) {
      lines.push(...review.concerns.map((c) => `- ${c}`));
    }
  }
  lines.push(
    "",
    `<sub>Merge or close this PR yourself. Add the \`${AUTO_MERGE_HOLD_LABEL}\` label to keep the pipeline from ever merging it. The next pipeline run that touches this PR replaces this block.</sub>`,
    "",
    "---",
    MERGE_DECISION_END,
  );
  return lines.join("\n");
}

/** Remove a previous decision block, wherever it sits. */
export function stripDecisionBlock(body: string): string {
  const start = body.indexOf(MERGE_DECISION_START);
  if (start === -1) return body;
  const end = body.indexOf(MERGE_DECISION_END, start);
  if (end === -1) return body;
  return body.slice(0, start) + body.slice(end + MERGE_DECISION_END.length).replace(/^\s*\n/, "");
}

/** Put `block` at the very top of `body`, replacing any earlier one. */
export function upsertDecisionBlock(body: string, block: string): string {
  return `${block}\n\n${stripDecisionBlock(body)}`;
}

// ── Announcements ─────────────────────────────────────────────────────

export function buildAutoMergedAnnouncement(args: { prUrl: string; title: string; summary: string }): string {
  return [
    `🔀 **Auto-merged:** ${args.title}`,
    "",
    args.summary ? `Review: ${oneLine(args.summary, 600)}` : "",
    `PR: ${args.prUrl}`,
    "Release build starting from main.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildDecisionNeededAnnouncement(args: {
  prUrl: string;
  title: string;
  question: string;
  reasons: readonly string[];
}): string {
  return [
    `🧑‍⚖️ **Needs your decision before merging:** ${args.title}`,
    "",
    `**${oneLine(args.question, 300)}**`,
    ...args.reasons.slice(0, 3).map((r) => `- ${oneLine(r, 240)}`),
    args.reasons.length > 3 ? `- …and ${args.reasons.length - 3} more (see the PR)` : "",
    "",
    `PR: ${args.prUrl}`,
  ]
    .filter((l, i, all) => l !== "" || all[i - 1] !== "")
    .join("\n");
}

// ── The step itself, with IO injected ─────────────────────────────────

export type ReviewResult = { review: MergeReview } | { error: string };
export type MergeCallResult = { ok: true } | { ok: false; error: string };

export type AutoMergeDeps = {
  mode: AutoMergeMode;
  readFacts: () => PrMergeFacts;
  /** Does commit `sha` carry the same tree as the locally checked-out HEAD? */
  headMatchesLocal: (facts: PrMergeFacts) => boolean;
  ciVerdict: () => string;
  changedFiles: () => string[];
  packageJsonBlockers: (files: readonly string[]) => string[];
  bodyPlaceholders: (body: string) => string[];
  review: (facts: PrMergeFacts, blockers: readonly string[]) => Promise<ReviewResult>;
  /** `gh pr merge --merge --match-head-commit <sha>`: GitHub refuses if the head moved. */
  merge: (headSha: string) => MergeCallResult;
  writeBody: (body: string) => void;
  markNeedsHuman: () => void;
  log: (line: string) => void;
};

export type AutoMergeOutcome =
  | { kind: "off" }
  | { kind: "not-open"; state: string }
  | { kind: "merged"; facts: PrMergeFacts; review: MergeReview }
  | {
      kind: "escalated";
      facts: PrMergeFacts;
      question: string;
      reasons: string[];
      block: string;
    };

export async function autoMergeWith(deps: AutoMergeDeps): Promise<AutoMergeOutcome> {
  if (deps.mode === "off") {
    deps.log("auto-merge off (UPDATE_AUTO_MERGE=0) — leaving the PR ready for review");
    return { kind: "off" };
  }

  const gather = () => {
    const facts = deps.readFacts();
    const files = deps.changedFiles();
    const blockers = deterministicBlockers({
      facts,
      headMatchesLocal: deps.headMatchesLocal(facts),
      ciVerdict: deps.ciVerdict(),
      bodyPlaceholders: deps.bodyPlaceholders(stripDecisionBlock(facts.body)),
      files,
      packageJson: files.includes("package.json") ? deps.packageJsonBlockers(files) : [],
    });
    return { facts, blockers };
  };

  let { facts, blockers } = gather();
  if (facts.state !== "OPEN") {
    deps.log(`PR #${facts.number} is ${facts.state} — nothing to merge or escalate`);
    return { kind: "not-open", state: facts.state };
  }
  for (const b of blockers) deps.log(`merge blocker: ${b}`);

  // The review runs even with blockers present: it can't override them,
  // but its analysis is what turns "touches .github/" into a question a
  // human can answer in one read.
  let review: MergeReview | null = null;
  let reviewError: string | null = null;
  try {
    const r = await deps.review(facts, blockers);
    if ("review" in r) review = r.review;
    else reviewError = r.error;
  } catch (err) {
    reviewError = err instanceof Error ? err.message : String(err);
  }
  deps.log(
    review
      ? `merge review verdict: ${review.verdict} — ${oneLine(review.summary, 300)}`
      : `merge review failed: ${reviewError}`,
  );

  if (deps.mode === "on" && blockers.length === 0 && review?.verdict === "merge") {
    // Re-check: the review takes minutes and the bot (or a human) may
    // have pushed, labelled or merged in the meantime.
    ({ facts, blockers } = gather());
    if (blockers.length === 0) {
      const res = deps.merge(facts.headRefOid);
      if (res.ok) {
        deps.log(`auto-merged PR #${facts.number} at ${facts.headRefOid.slice(0, 7)}`);
        return { kind: "merged", facts, review };
      }
      blockers = [`\`gh pr merge\` failed: ${oneLine(res.error, 300)}`];
    }
    for (const b of blockers) deps.log(`merge blocker (re-check): ${b}`);
  }

  const block = renderDecisionBlock({
    blockers,
    review,
    reviewError,
    reviewOnly: deps.mode === "review",
    headSha: facts.headRefOid,
  });
  deps.writeBody(upsertDecisionBlock(facts.body, block));
  deps.markNeedsHuman();
  const reasons = [
    ...blockers,
    ...(reviewError ? [`automated review failed: ${reviewError}`] : []),
    ...(review?.verdict === "needs_human" ? review.concerns : []),
  ];
  return {
    kind: "escalated",
    facts,
    question: review?.question || FALLBACK_QUESTION,
    reasons,
    block,
  };
}

function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

function oneLine(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}
