/**
 * CC 2.1.234 (H7) — a PR/MR badge for the current branch. Claude Code shows
 * the branch's pull/merge request (number, draft/open/merged/closed, and the
 * CI rollup) via `gh` / `glab`. This normalizes each host's CLI JSON into one
 * badge model; the server (`lib/server/pr-status.ts`) runs the CLI, this maps
 * the result. Pure + dependency-free so the (fiddly) status mapping is tested.
 */

export type PrState = "open" | "draft" | "merged" | "closed";
export type PrChecks = "passing" | "failing" | "pending" | "none";

export type PrBadge = {
  host: "github" | "gitlab";
  /** PR number (GitHub) or MR iid (GitLab). */
  number: number;
  url: string;
  title?: string;
  state: PrState;
  checks: PrChecks;
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * Normalize `gh pr view --json number,state,isDraft,statusCheckRollup,title,url`
 * output into a {@link PrBadge}. Returns `null` for an unusable shape (no number).
 * GitHub `state` is OPEN/MERGED/CLOSED; a draft OPEN PR reports `isDraft:true`.
 * The rollup is an array of check runs; failing beats pending beats passing.
 */
export function normalizeGithubPr(raw: unknown): PrBadge | null {
  const o = asRecord(raw);
  if (!o || typeof o.number !== "number") return null;
  const ghState = typeof o.state === "string" ? o.state.toUpperCase() : "";
  let state: PrState;
  if (ghState === "MERGED") state = "merged";
  else if (ghState === "CLOSED") state = "closed";
  else state = o.isDraft === true ? "draft" : "open";

  let checks: PrChecks = "none";
  const rollup = Array.isArray(o.statusCheckRollup) ? o.statusCheckRollup : [];
  let anyPending = false;
  let anyPassing = false;
  for (const c of rollup) {
    const cr = asRecord(c);
    if (!cr) continue;
    // Check runs use `status`+`conclusion`; commit statuses use `state`.
    const status = String(cr.status ?? "").toUpperCase();
    const conclusion = String(cr.conclusion ?? "").toUpperCase();
    const legacy = String(cr.state ?? "").toUpperCase();
    if (["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "FAILED"].includes(conclusion) || legacy === "FAILURE") {
      checks = "failing";
      break;
    }
    if (status === "IN_PROGRESS" || status === "QUEUED" || status === "PENDING" || legacy === "PENDING" || legacy === "EXPECTED") {
      anyPending = true;
    }
    if (conclusion === "SUCCESS" || legacy === "SUCCESS") anyPassing = true;
  }
  if (checks !== "failing") checks = anyPending ? "pending" : anyPassing ? "passing" : "none";

  return {
    host: "github",
    number: o.number,
    url: typeof o.url === "string" ? o.url : "",
    title: typeof o.title === "string" ? o.title : undefined,
    state,
    checks,
  };
}

/**
 * Normalize `glab mr view <branch> -F json` output into a {@link PrBadge}.
 * GitLab uses `iid` for the MR number, `draft`/`work_in_progress` for draft,
 * `state` = opened/merged/closed, and a `pipeline`/`head_pipeline` whose
 * `status` carries the CI rollup.
 */
export function normalizeGitlabMr(raw: unknown): PrBadge | null {
  const o = asRecord(raw);
  const iid = o && typeof o.iid === "number" ? o.iid : null;
  if (!o || iid == null) return null;
  const glState = typeof o.state === "string" ? o.state.toLowerCase() : "";
  let state: PrState;
  if (glState === "merged") state = "merged";
  else if (glState === "closed") state = "closed";
  else state = o.draft === true || o.work_in_progress === true ? "draft" : "open";

  const pipeline = asRecord(o.pipeline) ?? asRecord(o.head_pipeline);
  const pstatus = pipeline && typeof pipeline.status === "string" ? pipeline.status.toLowerCase() : "";
  let checks: PrChecks = "none";
  if (pstatus === "success") checks = "passing";
  else if (pstatus === "failed") checks = "failing";
  else if (["running", "pending", "created", "preparing", "scheduled", "waiting_for_resource"].includes(pstatus)) {
    checks = "pending";
  }

  return {
    host: "gitlab",
    number: iid,
    url: typeof o.web_url === "string" ? o.web_url : "",
    title: typeof o.title === "string" ? o.title : undefined,
    state,
    checks,
  };
}

/** Compact badge label, e.g. "PR #123" / "MR !45". */
export function prBadgeLabel(badge: PrBadge): string {
  const sigil = badge.host === "github" ? "#" : "!";
  const kind = badge.host === "github" ? "PR" : "MR";
  return `${kind} ${sigil}${badge.number}`;
}
