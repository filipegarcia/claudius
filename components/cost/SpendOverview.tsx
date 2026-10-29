"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { BarChart3, ExternalLink } from "lucide-react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useCostOverview } from "@/lib/client/useCostOverview";
import { cn } from "@/lib/utils/cn";
import {
  UNPINNED_ACCOUNT_KEY,
  type CostOverview,
  type OverviewAccount,
  type OverviewProject,
} from "@/lib/shared/cost-overview";

/**
 * Account page: spend across every project and every account on this
 * machine. A stacked daily bar chart (by project or by account — the six
 * biggest get a categorical hue, the rest fold into a neutral "other"), a
 * KPI row, and a table per dimension that doubles as the chart's table view.
 *
 * Colors follow the entity, not the range: a project's hue comes from its
 * all-time rank, so switching 30 → 90 days never repaints anything.
 */

type Mode = "project" | "account";
const RANGES = [30, 60, 90] as const;
type Range = (typeof RANGES)[number];
const MAX_NAMED = 6;
const ACCOUNT_USAGE_URL = "https://claude.ai/settings/usage";

type Entity = { key: string; label: string; usd: number; sessions: number };
type Group = { id: string; label: string; color: string; members: string[] };

const usdFmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
function fmtUsd(n: number): string {
  if (n === 0) return "$0.00";
  if (n < 0.01) return "<$0.01";
  return usdFmt.format(n);
}
function fmtAxisUsd(n: number): string {
  if (n === 0) return "$0";
  if (n >= 1000) return `$${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return n < 10 ? `$${n.toFixed(n < 1 ? 2 : 1)}` : `$${Math.round(n)}`;
}

function localDayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
/** The trailing `n` calendar days ending today (DST-safe: steps dates, not ms). */
function trailingDays(todayMs: number, n: number): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(todayMs);
    d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() - i);
    out.push(localDayKey(d));
  }
  return out;
}
function fmtDay(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/**
 * The top six entities by all-time spend get series slots 1–6 in order; the
 * rest share one gray group. In account mode the unpinned bucket is never a
 * named series — it's the gray group ("No profile").
 */
function buildGroups(entities: Entity[], mode: Mode): Group[] {
  const named = mode === "account" ? entities.filter((e) => e.key !== UNPINNED_ACCOUNT_KEY) : entities;
  const top = named.slice(0, MAX_NAMED);
  const topKeys = new Set(top.map((e) => e.key));
  const groups: Group[] = top.map((e, i) => ({
    id: `g${i}`,
    label: e.label,
    color: `var(--series-${i + 1})`,
    members: [e.key],
  }));
  const rest = entities.filter((e) => !topKeys.has(e.key));
  if (rest.length > 0) {
    const onlyUnpinned = rest.length === 1 && rest[0].key === UNPINNED_ACCOUNT_KEY;
    groups.push({
      id: "rest",
      label: onlyUnpinned
        ? rest[0].label
        : `Other (${rest.length} ${mode === "project" ? "project" : "account"}${rest.length === 1 ? "" : "s"})`,
      color: "var(--series-other)",
      members: rest.map((e) => e.key),
    });
  }
  return groups;
}

export function SpendOverview({ refreshKey }: { refreshKey: number }) {
  const { data, loading, error } = useCostOverview(refreshKey);
  const [mode, setMode] = useState<Mode>("project");
  const [range, setRange] = useState<Range>(30);

  return (
    <section
      data-testid="spend-overview"
      className="rounded-lg border border-[var(--border)] bg-[var(--panel)]/40 p-4"
    >
      <h2 className="mb-1 flex items-center gap-2 text-sm font-medium">
        <BarChart3 className="h-4 w-4 text-[var(--accent)]" /> Spend across all projects
      </h2>
      <p className="mb-3 text-[11px] text-[var(--muted)]">
        Every project on this machine — Claudius workspaces or not — split by project or by the
        account each session ran under.
      </p>

      {/* One filter row, above everything it scopes. */}
      <div className="mb-3 flex flex-wrap items-center gap-2 text-[10px]">
        <Segmented
          label="Range"
          options={RANGES.map((r) => ({ value: r, label: `${r}d` }))}
          value={range}
          onChange={setRange}
          testId="spend-overview-range"
        />
        <Segmented
          label="Group by"
          options={[
            { value: "project" as const, label: "Project" },
            { value: "account" as const, label: "Account" },
          ]}
          value={mode}
          onChange={setMode}
          testId="spend-overview-mode"
        />
        {loading && data && <span className="text-[var(--muted)]">refreshing…</span>}
        {error && <span className="text-red-400">{error}</span>}
      </div>

      {data ? (
        <div className={cn("space-y-4 transition-opacity", loading && "opacity-60")}>
          <Overview data={data} mode={mode} range={range} />
        </div>
      ) : (
        <div className="flex h-[260px] items-center justify-center rounded-lg border border-[var(--border)] px-6 text-center text-[11px] text-[var(--muted)]">
          {error
            ? "Couldn't load the overview."
            : "Scanning transcripts across all projects… The first scan reads every transcript once; later loads are fast."}
        </div>
      )}

      <footer className="mt-4 space-y-1 border-t border-[var(--border)] pt-3 text-[11px] text-[var(--muted)]">
        <p>
          Covers every project in <code className="font-mono">~/.claude/projects</code> on this
          machine, subagents included, priced like the Cost page. Accounts come from the profile
          each session was pinned to; <span className="text-[var(--foreground)]">No profile</span>{" "}
          is sessions run without one (the plain CLI, or before profiles existed).
        </p>
        <p>
          Claude Code deletes transcripts after <code className="font-mono">cleanupPeriodDays</code>{" "}
          (30 days without activity by default), and their spend drops out of these totals. For
          billing-level totals see{" "}
          <a
            href={ACCOUNT_USAGE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-0.5 text-[var(--accent)] hover:underline"
          >
            your Anthropic usage dashboard <ExternalLink className="h-3 w-3" />
          </a>
          .
        </p>
      </footer>
    </section>
  );
}

function Overview({ data, mode, range }: { data: CostOverview; mode: Mode; range: Range }) {
  // "Today" is pinned at first render (Date.now() is impure during render).
  const [today] = useState(() => Date.now());

  const entities: Entity[] = mode === "project" ? data.projects : data.accounts;
  const groups = useMemo(() => buildGroups(entities, mode), [entities, mode]);
  const groupOf = useMemo(() => {
    const m = new Map<string, Group>();
    for (const g of groups) for (const k of g.members) m.set(k, g);
    return m;
  }, [groups]);

  const { series, rangeTotals, rangeUsd } = useMemo(() => {
    const byDate = new Map(data.days.map((d) => [d.date, d]));
    const totals = new Map<string, number>();
    const rows = trailingDays(today, range).map((date) => {
      const row: Record<string, number | string> = { date, total: 0 };
      for (const g of groups) row[g.id] = 0;
      const day = byDate.get(date);
      const split = day ? (mode === "project" ? day.byProject : day.byAccount) : {};
      for (const [key, usd] of Object.entries(split)) {
        const g = groupOf.get(key);
        if (g) row[g.id] = (row[g.id] as number) + usd;
        row.total = (row.total as number) + usd;
        totals.set(key, (totals.get(key) ?? 0) + usd);
      }
      return row;
    });
    const sum = [...totals.values()].reduce((a, v) => a + v, 0);
    return { series: rows, rangeTotals: totals, rangeUsd: sum };
  }, [data.days, today, range, mode, groups, groupOf]);

  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="Total" value={fmtUsd(data.totalUsd)} />
        <Tile label="Today" value={fmtUsd(data.todayUsd)} accent />
        <Tile label="Last 7d" value={fmtUsd(data.weekUsd)} />
        <Tile label="Last 30d" value={fmtUsd(data.monthUsd)} />
      </div>

      <div>
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-[11px] font-medium uppercase tracking-wide text-[var(--muted)]">
            Daily spend by {mode} · last {range} days
          </h3>
          <span className="text-[11px] text-[var(--muted)]">
            {fmtUsd(rangeUsd)} in range
          </span>
        </div>
        {groups.length >= 2 && <Legend groups={groups} />}
        <StackedChart series={series} groups={groups} range={range} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <BreakdownTable
          testId="spend-overview-projects"
          title="By project"
          rows={data.projects}
          rangeTotals={mode === "project" ? rangeTotals : projectRangeTotals(data, today, range)}
          range={range}
          colorOf={(key) => (mode === "project" ? (groupOf.get(key)?.color ?? null) : null)}
          renderLabel={(p) => <ProjectLabel project={p as OverviewProject} />}
        />
        <BreakdownTable
          testId="spend-overview-accounts"
          title="By account"
          rows={data.accounts}
          rangeTotals={mode === "account" ? rangeTotals : accountRangeTotals(data, today, range)}
          range={range}
          colorOf={(key) => (mode === "account" ? (groupOf.get(key)?.color ?? null) : null)}
          renderLabel={(a) => <AccountLabel account={a as OverviewAccount} />}
        />
      </div>
    </>
  );
}

function rangeTotalsFor(data: CostOverview, todayMs: number, range: Range, mode: Mode): Map<string, number> {
  const inRange = new Set(trailingDays(todayMs, range));
  const out = new Map<string, number>();
  for (const d of data.days) {
    if (!inRange.has(d.date)) continue;
    for (const [k, v] of Object.entries(mode === "project" ? d.byProject : d.byAccount)) {
      out.set(k, (out.get(k) ?? 0) + v);
    }
  }
  return out;
}
const projectRangeTotals = (d: CostOverview, t: number, r: Range) => rangeTotalsFor(d, t, r, "project");
const accountRangeTotals = (d: CostOverview, t: number, r: Range) => rangeTotalsFor(d, t, r, "account");

function Legend({ groups }: { groups: Group[] }) {
  return (
    <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[var(--foreground)]" aria-label="Legend">
      {groups.map((g) => (
        <li key={g.id} className="flex min-w-0 items-center gap-1.5">
          <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-[2px]" style={{ background: g.color }} />
          <span className="max-w-[16rem] truncate" title={g.label}>
            {g.label}
          </span>
        </li>
      ))}
    </ul>
  );
}

type SegmentProps = {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  fill?: string;
  payload?: Record<string, number | string>;
};

/**
 * A stacked segment: the topmost non-empty segment of a day gets the 4px
 * rounded data-end, and every segment with a non-empty one below it gives
 * up its bottom 2px so the surface shows through as the gap.
 */
function segmentShape(groups: Group[], index: number) {
  function Segment({ x = 0, y = 0, width = 0, height = 0, fill, payload }: SegmentProps) {
    if (height <= 0 || width <= 0 || !payload) return <g />;
    const val = (g: Group) => Number(payload[g.id] ?? 0);
    const isTop = groups.slice(index + 1).every((g) => val(g) <= 0);
    const hasBelow = groups.slice(0, index).some((g) => val(g) > 0);
    const h = hasBelow ? height - 2 : height;
    if (h <= 0) return <g />;
    const r = isTop ? Math.min(4, width / 2, h) : 0;
    const bottom = y + h;
    const d =
      r > 0
        ? `M${x},${bottom} V${y + r} Q${x},${y} ${x + r},${y} H${x + width - r} Q${x + width},${y} ${x + width},${y + r} V${bottom} Z`
        : `M${x},${bottom} V${y} H${x + width} V${bottom} Z`;
    return <path d={d} fill={fill} />;
  }
  return Segment;
}

type TooltipRow = { dataKey?: unknown; value?: unknown; color?: string; fill?: string };

function ChartTooltip({
  active,
  payload,
  label,
  groups,
}: {
  active?: boolean;
  payload?: TooltipRow[];
  label?: unknown;
  groups: Group[];
}) {
  if (!active || !payload || payload.length === 0) return null;
  const byId = new Map(groups.map((g) => [g.id, g]));
  const rows = payload
    .map((p) => ({ group: byId.get(String(p.dataKey)), usd: Number(p.value ?? 0) }))
    .filter((r): r is { group: Group; usd: number } => !!r.group && r.usd > 0)
    .sort((a, b) => b.usd - a.usd);
  const total = rows.reduce((a, r) => a + r.usd, 0);
  return (
    <div className="min-w-[12rem] rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[11px] shadow-lg">
      <div className="mb-1 flex items-baseline justify-between gap-4">
        <span className="text-[var(--muted)]">{fmtDay(String(label))}</span>
        <span className="font-semibold text-[var(--foreground)]">{fmtUsd(total)}</span>
      </div>
      {rows.length === 0 ? (
        <div className="text-[var(--muted)]">No spend</div>
      ) : (
        <ul className="space-y-0.5">
          {rows.map((r) => (
            <li key={r.group.id} className="flex items-center gap-2">
              <span aria-hidden className="h-0.5 w-2.5 shrink-0 rounded-full" style={{ background: r.group.color }} />
              <span className="font-medium tabular-nums text-[var(--foreground)]">{fmtUsd(r.usd)}</span>
              <span className="min-w-0 truncate text-[var(--muted)]">{r.group.label}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function StackedChart({
  series,
  groups,
  range,
}: {
  series: Array<Record<string, number | string>>;
  groups: Group[];
  range: Range;
}) {
  return (
    <div
      data-testid="spend-overview-chart"
      className="h-[260px] w-full rounded-lg border border-[var(--border)] bg-[var(--panel)]/40 p-3"
      role="img"
      aria-label={`Daily spend over the last ${range} days, stacked by ${groups.map((g) => g.label).join(", ")}. The tables below list the same values.`}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={series} margin={{ top: 4, right: 4, bottom: 0, left: 0 }} barCategoryGap="20%">
          <CartesianGrid vertical={false} stroke="var(--border)" strokeOpacity={0.6} />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 10, fill: "var(--muted)" }}
            tickFormatter={(v: string) => v.slice(5)}
            interval={Math.max(0, Math.ceil(series.length / 8) - 1)}
            axisLine={{ stroke: "var(--border)" }}
            tickLine={false}
          />
          <YAxis
            tickFormatter={fmtAxisUsd}
            tick={{ fontSize: 10, fill: "var(--muted)" }}
            axisLine={false}
            tickLine={false}
            width={52}
            allowDecimals
          />
          <Tooltip
            cursor={{ fill: "var(--foreground)", fillOpacity: 0.05 }}
            content={(props) => (
              <ChartTooltip
                active={props.active}
                payload={props.payload as unknown as TooltipRow[] | undefined}
                label={props.label}
                groups={groups}
              />
            )}
          />
          {groups.map((g, i) => (
            <Bar
              key={g.id}
              dataKey={g.id}
              name={g.label}
              stackId="spend"
              fill={g.color}
              maxBarSize={24}
              isAnimationActive={false}
              shape={segmentShape(groups, i)}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function BreakdownTable<T extends Entity>({
  testId,
  title,
  rows,
  rangeTotals,
  range,
  colorOf,
  renderLabel,
}: {
  testId: string;
  title: string;
  rows: T[];
  rangeTotals: Map<string, number>;
  range: Range;
  /** The row's chart color; null when the chart isn't grouped by this dimension. */
  colorOf: (key: string) => string | null;
  renderLabel: (row: T) => React.ReactNode;
}) {
  const [showAll, setShowAll] = useState(false);
  const sorted = [...rows].sort(
    (a, b) => (rangeTotals.get(b.key) ?? 0) - (rangeTotals.get(a.key) ?? 0) || b.usd - a.usd,
  );
  const max = Math.max(0, ...sorted.map((r) => rangeTotals.get(r.key) ?? 0));
  const visible = showAll ? sorted : sorted.slice(0, 8);
  return (
    <div data-testid={testId}>
      <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-[var(--muted)]">{title}</h3>
      <div className="overflow-hidden rounded-lg border border-[var(--border)]">
        <table className="w-full text-[11px]">
          <thead className="bg-[var(--panel-2)]/60 text-[10px] uppercase tracking-wide text-[var(--muted)]">
            <tr>
              <th className="w-full px-3 py-1.5 text-left font-medium">Name</th>
              <th className="w-px whitespace-nowrap px-3 py-1.5 text-right font-medium">{range}d</th>
              <th className="w-px whitespace-nowrap px-3 py-1.5 text-right font-medium">All time</th>
              <th className="w-px whitespace-nowrap px-3 py-1.5 text-right font-medium" title="Sessions">
                Sess.
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => {
              const inRange = rangeTotals.get(r.key) ?? 0;
              const color = colorOf(r.key);
              return (
                <tr key={r.key} className="border-t border-[var(--border)]">
                  <td className="w-full max-w-0 px-3 py-1.5">
                    <div className="flex min-w-0 items-center gap-2">
                      {color && (
                        <span
                          aria-hidden
                          className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
                          style={{ background: color }}
                        />
                      )}
                      <div className="min-w-0 flex-1">
                        {renderLabel(r)}
                        <div className="mt-0.5 h-1 rounded-full bg-[var(--panel-2)]">
                          <div
                            className="h-1 rounded-full"
                            style={{
                              width: max > 0 ? `${(inRange / max) * 100}%` : 0,
                              background: color ?? "var(--muted)",
                              opacity: color ? 1 : 0.5,
                            }}
                          />
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums">{fmtUsd(inRange)}</td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-[var(--muted)]">
                    {fmtUsd(r.usd)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-[var(--muted)]">{r.sessions}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {sorted.length > 8 && (
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            className="w-full border-t border-[var(--border)] px-3 py-1.5 text-left text-[11px] text-[var(--muted)] hover:bg-[var(--panel-2)]/40 hover:text-[var(--foreground)]"
          >
            {showAll ? "Show fewer" : `Show all ${sorted.length}`}
          </button>
        )}
      </div>
    </div>
  );
}

function ProjectLabel({ project }: { project: OverviewProject }) {
  const text = (
    <span className="block truncate" title={project.cwd ?? project.label}>
      {project.label}
    </span>
  );
  if (!project.workspaceId) return text;
  return (
    <Link
      href={`/${project.workspaceId}/cost`}
      className="block truncate hover:underline"
      title={`${project.cwd ?? project.label} — open its Cost page`}
    >
      {project.label}
    </Link>
  );
}

function AccountLabel({ account }: { account: OverviewAccount }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="truncate">{account.label}</span>
      {account.removed && (
        <span className="shrink-0 rounded border border-[var(--border)] px-1 text-[9px] uppercase tracking-wide text-[var(--muted)]">
          removed
        </span>
      )}
    </span>
  );
}

function Tile({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div
      className={cn(
        "rounded-lg border p-3",
        accent ? "border-[var(--accent)]/40 bg-[var(--accent)]/5" : "border-[var(--border)] bg-[var(--panel)]/40",
      )}
    >
      <div className="text-[10px] uppercase tracking-wide text-[var(--muted)]">{label}</div>
      <div className="mt-1 text-xl font-semibold">{value}</div>
    </div>
  );
}

function Segmented<T extends string | number>({
  label,
  options,
  value,
  onChange,
  testId,
}: {
  label: string;
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (v: T) => void;
  testId: string;
}) {
  return (
    <div className="flex items-center gap-1.5" data-testid={testId}>
      <span className="text-[var(--muted)]">{label}</span>
      <div className="inline-flex items-center rounded-md border border-[var(--border)] bg-[var(--panel-2)] p-0.5" role="group" aria-label={label}>
        {options.map((o) => (
          <button
            key={String(o.value)}
            type="button"
            aria-pressed={o.value === value}
            onClick={() => onChange(o.value)}
            className={cn(
              "rounded px-2 py-0.5 font-medium",
              o.value === value
                ? "bg-[var(--panel)] text-[var(--foreground)] shadow-sm"
                : "text-[var(--muted)] hover:text-[var(--foreground)]",
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
