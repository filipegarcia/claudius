/**
 * Wire shape of `GET /api/cost/overview`: spend across every project and
 * every account on this machine (the Account page's overview), built by
 * `lib/server/cost-overview.ts` from the same transcript rows and pricing as
 * the per-workspace Cost page.
 */

/** Account key for spend in sessions that have no account profile pinned. */
export const UNPINNED_ACCOUNT_KEY = "_unpinned";

export type OverviewDay = {
  /** YYYY-MM-DD in the server's local timezone. */
  date: string;
  usd: number;
  /** That day's spend per `OverviewProject.key`. */
  byProject: Record<string, number>;
  /** That day's spend per `OverviewAccount.key`. */
  byAccount: Record<string, number>;
};

export type OverviewProject = {
  /** The `~/.claude/projects/<encoded-cwd>` dir name — stable identity. */
  key: string;
  /** Workspace name, else the cwd (`~`-relative), else the dir name. */
  label: string;
  /** Project root, when known (workspace root or a transcript's `cwd`). */
  cwd: string | null;
  /** Set when the project is a Claudius workspace (links to its Cost page). */
  workspaceId: string | null;
  usd: number;
  sessions: number;
  lastSeenMs: number;
};

export type OverviewAccount = {
  /** Profile id, or `UNPINNED_ACCOUNT_KEY`. */
  key: string;
  label: string;
  /** Null for the unpinned bucket. */
  accountId: string | null;
  /** The session pin names a profile that has since been deleted. */
  removed: boolean;
  usd: number;
  sessions: number;
  lastSeenMs: number;
};

export type CostOverview = {
  generatedAt: number;
  totalUsd: number;
  todayUsd: number;
  /** Rolling 7 days, today included. */
  weekUsd: number;
  /** Rolling 30 days, today included. */
  monthUsd: number;
  /** Days with spend, ascending. */
  days: OverviewDay[];
  /** Projects with spend, most expensive first. */
  projects: OverviewProject[];
  /** Accounts with spend, most expensive first. */
  accounts: OverviewAccount[];
  /** Account profiles configured system-wide. */
  accountsConfigured: number;
  /** Some project is priced with an org `modelPricing` override. */
  pricingOverrideActive: boolean;
};
