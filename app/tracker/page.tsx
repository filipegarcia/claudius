"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  CircleDot,
  CheckCircle2,
  MessageSquare,
  GitPullRequest,
  Tag as TagIcon,
  Search,
  Filter,
} from "lucide-react";
import { SideNav } from "@/components/nav/SideNav";
import { cn } from "@/lib/utils/cn";

/**
 * Tracker — a faked GitHub-issues list rendered fully in the browser.
 *
 * This is a demo customization: no network calls, no API route, no auth.
 * The issues below are static fixtures designed to look like a real repo
 * dashboard (state pill, labels, author, age, comment count). Drop a real
 * fetcher in {@link ISSUES} when you want to wire it up to the GitHub API.
 */

type IssueState = "open" | "closed";
type IssueKind = "issue" | "pr";

type Label = { name: string; tone: keyof typeof LABEL_TONES };

type Issue = {
  number: number;
  title: string;
  state: IssueState;
  kind: IssueKind;
  author: string;
  openedAt: string; // ISO
  closedAt?: string;
  comments: number;
  labels: Label[];
};

// Tailwind-friendly tone presets. Picked to read on both light + dark themes
// the existing app already supports.
const LABEL_TONES = {
  bug: "bg-red-500/15 text-red-300 border-red-500/30",
  feature: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  docs: "bg-sky-500/15 text-sky-300 border-sky-500/30",
  enhancement: "bg-violet-500/15 text-violet-300 border-violet-500/30",
  question: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  chore: "bg-zinc-500/15 text-zinc-300 border-zinc-500/30",
  good: "bg-teal-500/15 text-teal-300 border-teal-500/30",
} as const;

// Fixed "now" so the "opened N days ago" labels render deterministically and
// don't drift while you're staring at the page. Pinned a couple of days ahead
// of the most recent openedAt below.
const NOW = new Date("2026-05-12T12:00:00Z").getTime();

const ISSUES: Issue[] = [
  {
    number: 482,
    title: "Tracker view should remember the last selected filter across reloads",
    state: "open",
    kind: "issue",
    author: "fgarcia",
    openedAt: "2026-05-11T15:20:00Z",
    comments: 2,
    labels: [
      { name: "enhancement", tone: "enhancement" },
      { name: "good first issue", tone: "good" },
    ],
  },
  {
    number: 481,
    title: "Crash when opening a customization while a publish is in-flight",
    state: "open",
    kind: "issue",
    author: "rkimura",
    openedAt: "2026-05-10T09:48:00Z",
    comments: 7,
    labels: [
      { name: "bug", tone: "bug" },
      { name: "priority:high", tone: "bug" },
    ],
  },
  {
    number: 479,
    title: "Add /tracker page with a faked GitHub issues list",
    state: "open",
    kind: "pr",
    author: "claudius-bot",
    openedAt: "2026-05-09T18:10:00Z",
    comments: 1,
    labels: [
      { name: "feature", tone: "feature" },
      { name: "ui", tone: "enhancement" },
    ],
  },
  {
    number: 477,
    title: "Document the customize → publish → revert flow in README",
    state: "open",
    kind: "issue",
    author: "amelina",
    openedAt: "2026-05-07T11:02:00Z",
    comments: 0,
    labels: [{ name: "docs", tone: "docs" }],
  },
  {
    number: 471,
    title: "Workspace switcher: ⌥1..9 should focus the Nth workspace, not the Nth tab",
    state: "open",
    kind: "issue",
    author: "tprice",
    openedAt: "2026-05-05T07:31:00Z",
    comments: 4,
    labels: [
      { name: "bug", tone: "bug" },
      { name: "keyboard", tone: "chore" },
    ],
  },
  {
    number: 468,
    title: "Auto-pause preview server when its customization is deleted",
    state: "closed",
    kind: "pr",
    author: "rkimura",
    openedAt: "2026-05-02T13:45:00Z",
    closedAt: "2026-05-04T10:14:00Z",
    comments: 3,
    labels: [{ name: "chore", tone: "chore" }],
  },
  {
    number: 465,
    title: "Question: can hooks fire on workspace switch?",
    state: "closed",
    kind: "issue",
    author: "nfowler",
    openedAt: "2026-04-29T20:08:00Z",
    closedAt: "2026-05-01T08:00:00Z",
    comments: 5,
    labels: [{ name: "question", tone: "question" }],
  },
  {
    number: 460,
    title: "Cost page shows NaN when the SQLite cache is empty",
    state: "open",
    kind: "issue",
    author: "mlanger",
    openedAt: "2026-04-25T17:22:00Z",
    comments: 1,
    labels: [{ name: "bug", tone: "bug" }],
  },
  {
    number: 457,
    title: "Surface plugin install errors in the /plugins page instead of toast",
    state: "open",
    kind: "issue",
    author: "amelina",
    openedAt: "2026-04-22T09:11:00Z",
    comments: 0,
    labels: [{ name: "enhancement", tone: "enhancement" }],
  },
  {
    number: 452,
    title: "Sync from base: detect manual edits to ignored files and warn",
    state: "closed",
    kind: "pr",
    author: "claudius-bot",
    openedAt: "2026-04-19T14:00:00Z",
    closedAt: "2026-04-21T16:35:00Z",
    comments: 9,
    labels: [
      { name: "feature", tone: "feature" },
      { name: "customize", tone: "enhancement" },
    ],
  },
];

function relativeTime(iso: string, now = NOW): string {
  const t = new Date(iso).getTime();
  const diff = Math.max(0, now - t);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < hour) return `${Math.max(1, Math.round(diff / minute))} min ago`;
  if (diff < day) return `${Math.round(diff / hour)} hr ago`;
  if (diff < 30 * day) return `${Math.round(diff / day)} days ago`;
  return new Date(iso).toLocaleDateString();
}

type StateFilter = "open" | "closed" | "all";

export default function TrackerPage() {
  const [stateFilter, setStateFilter] = useState<StateFilter>("open");
  const [query, setQuery] = useState("");
  const [labelFilter, setLabelFilter] = useState<string | null>(null);

  const allLabels = useMemo(() => {
    const set = new Set<string>();
    for (const i of ISSUES) for (const l of i.labels) set.add(l.name);
    return Array.from(set).sort();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return ISSUES.filter((i) => {
      if (stateFilter !== "all" && i.state !== stateFilter) return false;
      if (labelFilter && !i.labels.some((l) => l.name === labelFilter)) return false;
      if (q && !i.title.toLowerCase().includes(q) && !String(i.number).includes(q)) return false;
      return true;
    });
  }, [stateFilter, labelFilter, query]);

  const openCount = ISSUES.filter((i) => i.state === "open").length;
  const closedCount = ISSUES.length - openCount;

  return (
    <div className="flex h-full">
      <SideNav />
      <main data-pane-name="tracker-main" className="flex h-full flex-1 flex-col overflow-hidden">
        <header className="flex h-9 shrink-0 items-center gap-3 border-b border-[var(--border)] bg-[var(--panel)] px-4 text-xs">
          <Link
            href="/"
            className="flex items-center gap-1 text-[var(--muted)] hover:text-[var(--foreground)]"
          >
            <ArrowLeft className="h-3 w-3" />
            Back
          </Link>
          <div className="flex items-center gap-2 text-[var(--foreground)]">
            <CircleDot className="h-3.5 w-3.5 text-emerald-400" />
            <span className="font-medium">Tracker</span>
          </div>
          <span className="text-[var(--muted)]">
            {openCount} open · {closedCount} closed
          </span>
          <div className="ml-auto flex items-center gap-3 text-[10px] text-[var(--muted)]">
            <span>demo data — no network</span>
          </div>
        </header>

        <div data-testid="tracker-page" className="flex-1 overflow-auto">
          <div className="mx-auto max-w-5xl px-6 py-5">
            <div className="mb-4 flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--panel)] p-0.5 text-xs">
                <FilterPill
                  active={stateFilter === "open"}
                  onClick={() => setStateFilter("open")}
                  icon={<CircleDot className="h-3.5 w-3.5 text-emerald-400" />}
                  label={`${openCount} Open`}
                />
                <FilterPill
                  active={stateFilter === "closed"}
                  onClick={() => setStateFilter("closed")}
                  icon={<CheckCircle2 className="h-3.5 w-3.5 text-violet-300" />}
                  label={`${closedCount} Closed`}
                />
                <FilterPill
                  active={stateFilter === "all"}
                  onClick={() => setStateFilter("all")}
                  icon={<Filter className="h-3.5 w-3.5" />}
                  label={`All ${ISSUES.length}`}
                />
              </div>

              <div className="relative ml-auto w-72">
                <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--muted)]" />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Filter by title or #number…"
                  className="w-full rounded-md border border-[var(--border)] bg-[var(--panel)] py-1.5 pl-7 pr-2 text-xs text-[var(--foreground)] placeholder:text-[var(--muted)] focus:border-[var(--accent)]/40 focus:outline-none"
                />
              </div>
            </div>

            <div className="mb-4 flex flex-wrap items-center gap-1.5 text-[10px]">
              <span className="mr-1 text-[var(--muted)]">Labels:</span>
              <button
                onClick={() => setLabelFilter(null)}
                className={cn(
                  "rounded-full border px-2 py-0.5",
                  labelFilter == null
                    ? "border-[var(--accent)]/50 bg-[var(--accent)]/10 text-[var(--foreground)]"
                    : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--foreground)]",
                )}
              >
                any
              </button>
              {allLabels.map((name) => {
                const tone = ISSUES.flatMap((i) => i.labels).find((l) => l.name === name)?.tone ?? "chore";
                return (
                  <button
                    key={name}
                    onClick={() => setLabelFilter(labelFilter === name ? null : name)}
                    className={cn(
                      "rounded-full border px-2 py-0.5",
                      LABEL_TONES[tone],
                      labelFilter === name ? "ring-1 ring-[var(--accent)]" : "opacity-80 hover:opacity-100",
                    )}
                  >
                    <span className="inline-flex items-center gap-1">
                      <TagIcon className="h-2.5 w-2.5" />
                      {name}
                    </span>
                  </button>
                );
              })}
            </div>

            <ul className="overflow-hidden rounded-md border border-[var(--border)] bg-[var(--panel)]">
              {filtered.length === 0 ? (
                <li className="px-4 py-10 text-center text-xs text-[var(--muted)]">
                  No issues match the current filters.
                </li>
              ) : (
                filtered.map((issue, idx) => (
                  <li
                    key={issue.number}
                    className={cn(
                      "flex items-start gap-3 px-4 py-3 hover:bg-[var(--panel-2)]",
                      idx > 0 && "border-t border-[var(--border)]",
                    )}
                  >
                    <div className="mt-0.5 shrink-0">
                      {issue.kind === "pr" ? (
                        <GitPullRequest
                          className={cn(
                            "h-4 w-4",
                            issue.state === "open" ? "text-emerald-400" : "text-violet-300",
                          )}
                        />
                      ) : issue.state === "open" ? (
                        <CircleDot className="h-4 w-4 text-emerald-400" />
                      ) : (
                        <CheckCircle2 className="h-4 w-4 text-violet-300" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <a
                          href="#"
                          className="truncate text-sm font-medium text-[var(--foreground)] hover:text-[var(--accent)]"
                          onClick={(e) => e.preventDefault()}
                        >
                          {issue.title}
                        </a>
                        {issue.labels.map((l) => (
                          <span
                            key={l.name}
                            className={cn(
                              "rounded-full border px-1.5 py-0.5 text-[10px] leading-none",
                              LABEL_TONES[l.tone],
                            )}
                          >
                            {l.name}
                          </span>
                        ))}
                      </div>
                      <div className="mt-1 text-[11px] text-[var(--muted)]">
                        #{issue.number}{" "}
                        {issue.state === "open"
                          ? `opened ${relativeTime(issue.openedAt)} by ${issue.author}`
                          : `closed ${relativeTime(issue.closedAt ?? issue.openedAt)} by ${issue.author}`}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1 text-[11px] text-[var(--muted)]">
                      <MessageSquare className="h-3 w-3" />
                      {issue.comments}
                    </div>
                  </li>
                ))
              )}
            </ul>

            <p className="mt-4 text-[10px] text-[var(--muted)]">
              This is a demo customization. All issues, authors, and dates are fabricated — no GitHub
              API is contacted.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}

function FilterPill({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded-sm px-2 py-1",
        active
          ? "bg-[var(--accent)]/15 text-[var(--foreground)] ring-1 ring-[var(--accent)]/40"
          : "text-[var(--muted)] hover:text-[var(--foreground)]",
      )}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}
