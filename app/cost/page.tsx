"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, BarChart3, ExternalLink, RefreshCw } from "lucide-react";
import { SideNav } from "@/components/nav/SideNav";
import { ScopeToggle, type Scope } from "@/components/nav/ScopeToggle";
import { CostChart } from "@/components/cost/CostChart";
import { LimitsPanel } from "@/components/cost/LimitsPanel";
import { cn } from "@/lib/utils/cn";
import { SessionCostTable } from "@/components/cost/SessionCostTable";
import { ModelBreakdown } from "@/components/cost/ModelBreakdown";
import { useActiveCwd } from "@/lib/client/useActiveCwd";
import { useCost } from "@/lib/client/useCost";

function fmtUsd(n: number): string {
  if (n === 0) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

const ACCOUNT_USAGE_URL = "https://claude.ai/settings/usage";

export default function CostPage() {
  const cwd = useActiveCwd();
  const [scope, setScope] = useState<Scope>("workspace");
  const [view, setView] = useState<"spend" | "limits">("spend");

  const { data, loading, error, refresh } = useCost(cwd);

  return (
    <div className="flex h-full">
      <SideNav running={false} />
      <main data-pane-name="cost-main" className="flex h-full flex-1 flex-col overflow-hidden">
        <header className="flex h-9 shrink-0 items-center gap-3 border-b border-[var(--border)] bg-[var(--panel)] px-4 text-xs">
          <Link href="/" className="flex items-center gap-1 text-[var(--muted)] hover:text-[var(--foreground)]">
            <ArrowLeft className="h-3.5 w-3.5" /> Chat
          </Link>
          <span className="opacity-50">·</span>
          <BarChart3 className="h-3.5 w-3.5 text-[var(--muted)]" />
          <span className="font-medium">Cost</span>
          <div className="ml-2 inline-flex items-center rounded-md border border-[var(--border)] bg-[var(--panel-2)] p-0.5 text-[10px]">
            <button
              type="button"
              onClick={() => setView("spend")}
              className={cn(
                "rounded px-2 py-0.5 font-medium",
                view === "spend"
                  ? "bg-[var(--panel)] text-[var(--foreground)] shadow-sm"
                  : "text-[var(--muted)] hover:text-[var(--foreground)]",
              )}
            >
              Spend
            </button>
            <button
              type="button"
              onClick={() => setView("limits")}
              className={cn(
                "rounded px-2 py-0.5 font-medium",
                view === "limits"
                  ? "bg-[var(--panel)] text-[var(--foreground)] shadow-sm"
                  : "text-[var(--muted)] hover:text-[var(--foreground)]",
              )}
            >
              Limits
            </button>
          </div>
          {view === "spend" && <ScopeToggle value={scope} onChange={setScope} />}
          {loading && <span className="text-[var(--muted)]">refreshing…</span>}
          {error && <span className="text-red-400">{error}</span>}
          <a
            href={ACCOUNT_USAGE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-0.5 hover:bg-[var(--panel)]"
            title="Open Anthropic account usage in a new tab"
          >
            View account usage <ExternalLink className="h-3 w-3" />
          </a>
          <button
            onClick={refresh}
            className="flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-0.5 hover:bg-[var(--panel)]"
          >
            <RefreshCw className="h-3 w-3" /> Refresh
          </button>
        </header>

        <div className="flex-1 overflow-y-auto scroll-thin">
          {view === "limits" ? (
            <LimitsPanel cwd={cwd} todaySpendUsd={data?.todayUsd ?? 0} />
          ) : scope === "account" ? (
            <div className="mx-auto max-w-2xl px-6 py-12 text-center">
              <h2 className="mb-2 text-lg font-semibold">Account-wide usage</h2>
              <p className="mb-6 text-sm text-[var(--muted)]">
                Account-wide totals (across all projects, machines, and sessions) live on the
                Anthropic usage dashboard. Open it in a new tab.
              </p>
              <a
                href={ACCOUNT_USAGE_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 rounded-md bg-[var(--accent)] px-3 py-2 text-sm text-white hover:opacity-90"
              >
                Open Anthropic usage dashboard <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          ) : (
          <div className="mx-auto max-w-6xl space-y-5 px-6 py-6">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Tile label="Total" value={data ? fmtUsd(data.totalUsd) : "—"} />
              <Tile label="Today" value={data ? fmtUsd(data.todayUsd) : "—"} accent />
              <Tile label="Last 7d" value={data ? fmtUsd(data.weekUsd) : "—"} />
              <Tile label="Last 30d" value={data ? fmtUsd(data.monthUsd) : "—"} />
            </div>

            <section>
              <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-[var(--muted)]">
                Daily spend (last 60 days)
              </h2>
              {data ? (
                data.byDay.length === 0 ? (
                  <div className="rounded-md border border-[var(--border)] bg-[var(--panel)]/40 px-4 py-8 text-center text-sm text-[var(--muted)]">
                    No spend recorded yet — your first turn will appear here.
                  </div>
                ) : (
                  <CostChart data={data.byDay} days={60} />
                )
              ) : (
                <div className="h-[280px] rounded-lg border border-[var(--border)] bg-[var(--panel)]/40" />
              )}
            </section>

            <section>
              <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-[var(--muted)]">
                Per session
              </h2>
              <SessionCostTable sessions={data?.bySession ?? []} />
            </section>

            <section>
              <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-[var(--muted)]">
                Per model
              </h2>
              <ModelBreakdown data={data?.byModel ?? []} />
            </section>

            <footer className="border-t border-[var(--border)] pt-3 text-[11px] text-[var(--muted)]">
              {data?.note ?? "—"} Numbers above are this project, on this machine. For account-wide
              totals, see{" "}
              <a
                href={ACCOUNT_USAGE_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[var(--accent)] hover:underline"
              >
                your Anthropic usage dashboard ↗
              </a>
              .
            </footer>
          </div>
          )}
        </div>
      </main>
    </div>
  );
}

function Tile({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div
      className={`rounded-lg border p-4 ${
        accent
          ? "border-[var(--accent)]/40 bg-[var(--accent)]/5"
          : "border-[var(--border)] bg-[var(--panel)]/40"
      }`}
    >
      <div className="text-[10px] uppercase tracking-wide text-[var(--muted)]">{label}</div>
      <div className="mt-1 font-mono text-2xl">{value}</div>
    </div>
  );
}
