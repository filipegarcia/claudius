"use client";

import { useMemo } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Database,
  GitBranch as GitBranchIcon,
  Layers,
  RefreshCw,
  Workflow,
  Zap,
} from "lucide-react";
import { SideNav } from "@/components/nav/SideNav";
import { cn } from "@/lib/utils/cn";

/**
 * Data pipeline observability — a customization page.
 *
 * Hardcoded fixture data so the page is fully self-contained and the
 * marketing screenshot is deterministic across runs. The shape of the data
 * is intentionally what a real pipeline orchestrator (Airflow / Prefect /
 * Dagster) would emit: a DAG of stages, a per-stage throughput stat, plus
 * a recent-runs strip per stage.
 *
 * Layout, top to bottom:
 *   1. Four aggregate cards (records, lag, latency, failed runs) — these
 *      use the radial-gauge pattern from the Docker customization so the
 *      two pages rhyme visually.
 *   2. The DAG itself, rendered in SVG. Curved edges with throughput
 *      labels; node cards positioned absolutely on top of the SVG so the
 *      cards stay styled HTML while the edges stay vector.
 *   3. A "recent runs" strip — each stage's last 24 runs as a row of
 *      coloured chips (green/amber/red).
 */

type StageStatus = "healthy" | "degraded" | "failed" | "idle";

type Stage = {
  id: string;
  label: string;
  sub: string;
  icon: typeof Database;
  /** Grid column (1..5). */
  col: number;
  /** Grid row (1..3). */
  row: number;
  status: StageStatus;
  /** Rows per second flowing through this stage. */
  throughput: number;
  /** p95 latency in ms. */
  p95Ms: number;
  /** Sparkline samples, last 16 minutes. 0..1 normalized. */
  spark: number[];
  /** Last 24 runs — true=ok, "warn"=retry, "fail"=red. */
  history: Array<true | "warn" | "fail">;
};

type Edge = {
  from: string;
  to: string;
  /** Edge label, e.g. "12k r/s" */
  label: string;
  /** Tone modulates the gradient. */
  tone: "primary" | "muted" | "warn";
};

const STAGES: Stage[] = [
  {
    id: "events",
    label: "App events",
    sub: "Kafka · 14 topics",
    icon: Zap,
    col: 1,
    row: 1,
    status: "healthy",
    throughput: 12480,
    p95Ms: 42,
    spark: [0.4, 0.55, 0.62, 0.48, 0.7, 0.66, 0.81, 0.74, 0.69, 0.78, 0.82, 0.71, 0.76, 0.84, 0.79, 0.86],
    history: hist("ok", 24),
  },
  {
    id: "cdc",
    label: "Postgres CDC",
    sub: "Debezium · 8 tables",
    icon: Database,
    col: 1,
    row: 2,
    status: "healthy",
    throughput: 3870,
    p95Ms: 67,
    spark: [0.3, 0.32, 0.34, 0.31, 0.36, 0.38, 0.4, 0.42, 0.45, 0.43, 0.46, 0.44, 0.48, 0.47, 0.49, 0.51],
    history: hist("ok", 24),
  },
  {
    id: "files",
    label: "S3 dropfiles",
    sub: "Hourly · parquet",
    icon: Layers,
    col: 1,
    row: 3,
    status: "degraded",
    throughput: 218,
    p95Ms: 1840,
    spark: [0.6, 0.4, 0.3, 0.55, 0.25, 0.5, 0.2, 0.35, 0.45, 0.28, 0.5, 0.32, 0.42, 0.3, 0.38, 0.26],
    history: hist("warn-tail", 24),
  },
  {
    id: "ingest",
    label: "Stream ingest",
    sub: "Flink · 6 jobs",
    icon: Workflow,
    col: 2,
    row: 1,
    status: "healthy",
    throughput: 16350,
    p95Ms: 88,
    spark: [0.5, 0.6, 0.58, 0.62, 0.7, 0.66, 0.74, 0.78, 0.72, 0.81, 0.77, 0.85, 0.82, 0.88, 0.84, 0.9],
    history: hist("ok", 24),
  },
  {
    id: "stage",
    label: "Bronze · raw",
    sub: "Iceberg · S3",
    icon: Database,
    col: 3,
    row: 2,
    status: "healthy",
    throughput: 16124,
    p95Ms: 124,
    spark: [0.45, 0.5, 0.52, 0.58, 0.6, 0.63, 0.65, 0.7, 0.68, 0.72, 0.74, 0.78, 0.77, 0.8, 0.82, 0.85],
    history: hist("ok", 24),
  },
  {
    id: "dbt",
    label: "dbt transform",
    sub: "162 models · 5m cadence",
    icon: GitBranchIcon,
    col: 4,
    row: 1,
    status: "healthy",
    throughput: 9410,
    p95Ms: 312,
    spark: [0.5, 0.55, 0.58, 0.62, 0.6, 0.68, 0.7, 0.72, 0.75, 0.74, 0.78, 0.8, 0.79, 0.83, 0.85, 0.88],
    history: hist("ok", 24),
  },
  {
    id: "warehouse",
    label: "Silver · curated",
    sub: "Snowflake · LARGE",
    icon: Database,
    col: 4,
    row: 3,
    status: "healthy",
    throughput: 7820,
    p95Ms: 540,
    spark: [0.4, 0.42, 0.48, 0.5, 0.55, 0.58, 0.6, 0.65, 0.66, 0.7, 0.72, 0.75, 0.77, 0.78, 0.81, 0.84],
    history: hist("ok", 24),
  },
  {
    id: "marts",
    label: "Gold · marts",
    sub: "44 marts · serving",
    icon: Layers,
    col: 5,
    row: 1,
    status: "healthy",
    throughput: 4320,
    p95Ms: 92,
    spark: [0.6, 0.58, 0.62, 0.66, 0.7, 0.68, 0.72, 0.75, 0.74, 0.78, 0.8, 0.83, 0.82, 0.86, 0.88, 0.9],
    history: hist("ok", 24),
  },
  {
    id: "ml",
    label: "Feature store",
    sub: "Feast · 28 features",
    icon: Activity,
    col: 5,
    row: 3,
    status: "failed",
    throughput: 0,
    p95Ms: 0,
    spark: [0.5, 0.52, 0.55, 0.48, 0.3, 0.15, 0.05, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    history: hist("fail-tail", 24),
  },
];

const EDGES: Edge[] = [
  { from: "events", to: "ingest", label: "12.5k r/s", tone: "primary" },
  { from: "cdc", to: "ingest", label: "3.9k r/s", tone: "primary" },
  { from: "files", to: "stage", label: "218 r/s", tone: "warn" },
  { from: "ingest", to: "stage", label: "16.3k r/s", tone: "primary" },
  { from: "stage", to: "dbt", label: "9.4k r/s", tone: "primary" },
  { from: "stage", to: "warehouse", label: "7.8k r/s", tone: "primary" },
  { from: "dbt", to: "marts", label: "4.3k r/s", tone: "primary" },
  { from: "dbt", to: "warehouse", label: "merge", tone: "muted" },
  { from: "warehouse", to: "ml", label: "stalled", tone: "warn" },
  { from: "marts", to: "ml", label: "feature push", tone: "muted" },
];

/** Build a deterministic run-history array. */
function hist(mode: "ok" | "warn-tail" | "fail-tail", n: number): Array<true | "warn" | "fail"> {
  const out: Array<true | "warn" | "fail"> = [];
  for (let i = 0; i < n; i++) {
    if (mode === "ok") {
      // One warn every ~10 runs to feel real, not perfect.
      out.push(i % 11 === 4 ? "warn" : true);
    } else if (mode === "warn-tail") {
      // Mostly ok, with the last few warns.
      out.push(i >= n - 5 ? (i === n - 2 ? "fail" : "warn") : true);
    } else {
      // fail-tail: ok early, then degrades to red.
      if (i < n - 8) out.push(true);
      else if (i < n - 4) out.push("warn");
      else out.push("fail");
    }
  }
  return out;
}

export default function PipelinePage() {
  return (
    <div className="flex h-full">
      <SideNav running={false} />
      <main data-pane-name="pipeline-main" className="flex h-full flex-1 flex-col overflow-hidden">
        <header className="flex h-9 shrink-0 items-center gap-3 border-b border-[var(--border)] bg-[var(--panel)] px-4 text-xs">
          <Link
            href="/"
            className="flex items-center gap-1 text-[var(--muted)] hover:text-[var(--foreground)]"
          >
            <ArrowLeft className="h-3 w-3" />
            Back
          </Link>
          <div className="flex items-center gap-2 text-[var(--foreground)]">
            <Workflow className="h-3.5 w-3.5" />
            <span className="font-medium">Data Pipeline</span>
          </div>
          <span className="text-[var(--muted)]">
            {STAGES.length} stages · 1 failing
          </span>
          <div className="ml-auto flex items-center gap-3">
            <span className="text-[10px] text-[var(--muted)]">
              sampled 14:08:42 · auto-refresh 5s
            </span>
            <button
              className="flex items-center gap-1 rounded border border-[var(--border)] px-2 py-0.5 text-[11px] text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)]"
              title="Refresh"
            >
              <RefreshCw className="h-3 w-3" />
              Refresh
            </button>
          </div>
        </header>

        <div data-testid="pipeline-page" className="flex-1 overflow-auto">
          <div className="space-y-6 px-6 py-5">
            <AggregateCards />
            <PipelineGraph />
            <RunHistory />
          </div>
        </div>
      </main>
    </div>
  );
}

/* ----------------------------------------------------------------------- */
/* Aggregate cards                                                          */
/* ----------------------------------------------------------------------- */

function AggregateCards() {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4" data-testid="pipeline-cards">
      <Card
        title="Records today"
        value="84.2M"
        sub="+12% vs yesterday"
        icon={<Database className="h-4 w-4" />}
        accent="emerald"
        gauge={<MiniLine values={[0.3, 0.4, 0.42, 0.55, 0.6, 0.66, 0.7, 0.78, 0.82, 0.85, 0.88, 0.93]} color="emerald" />}
      />
      <Card
        title="End-to-end lag"
        value="3m 41s"
        sub="SLO 5m · within budget"
        icon={<Clock className="h-4 w-4" />}
        accent="sky"
        gauge={<RadialGauge percent={72} color="sky" label="72%" />}
      />
      <Card
        title="p95 latency"
        value="312 ms"
        sub="dbt transform stage"
        icon={<Activity className="h-4 w-4" />}
        accent="violet"
        gauge={<RadialGauge percent={48} color="violet" label="0.31s" />}
      />
      <Card
        title="Failed runs · 24h"
        value="3"
        sub="feature-store retry exhausted"
        icon={<AlertTriangle className="h-4 w-4" />}
        accent="amber"
        gauge={<MiniLine values={[0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 2, 3]} color="amber" />}
      />
    </div>
  );
}

const ACCENT_STYLES: Record<string, { glow: string; rule: string }> = {
  emerald: {
    glow: "from-emerald-400/30 via-emerald-400/10 to-transparent",
    rule:
      "before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-gradient-to-r before:from-transparent before:via-emerald-400/60 before:to-transparent",
  },
  sky: {
    glow: "from-sky-400/30 via-sky-400/10 to-transparent",
    rule:
      "before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-gradient-to-r before:from-transparent before:via-sky-400/60 before:to-transparent",
  },
  violet: {
    glow: "from-violet-400/30 via-violet-400/10 to-transparent",
    rule:
      "before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-gradient-to-r before:from-transparent before:via-violet-400/60 before:to-transparent",
  },
  amber: {
    glow: "from-amber-400/30 via-amber-400/10 to-transparent",
    rule:
      "before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-gradient-to-r before:from-transparent before:via-amber-400/60 before:to-transparent",
  },
};

function Card({
  title,
  value,
  sub,
  icon,
  accent,
  gauge,
}: {
  title: string;
  value: string;
  sub: string;
  icon: React.ReactNode;
  accent: keyof typeof ACCENT_STYLES;
  gauge: React.ReactNode;
}) {
  const tone = ACCENT_STYLES[accent];
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4",
        tone.rule,
      )}
    >
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute -right-10 -top-10 h-32 w-32 rounded-full bg-gradient-to-br blur-2xl",
          tone.glow,
        )}
      />
      <div className="relative flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-[var(--muted)]">
            {icon}
            {title}
          </div>
          <div className="mt-2 text-3xl font-semibold tracking-tight text-[var(--foreground)]">
            {value}
          </div>
          <div className="mt-1 text-[11px] text-[var(--muted)]">{sub}</div>
        </div>
        <div className="shrink-0">{gauge}</div>
      </div>
    </div>
  );
}

const RADIAL_COLORS: Record<string, { stroke: string; track: string; label: string }> = {
  sky: { stroke: "#38bdf8", track: "rgba(56,189,248,0.12)", label: "#7dd3fc" },
  violet: { stroke: "#a78bfa", track: "rgba(167,139,250,0.12)", label: "#c4b5fd" },
  emerald: { stroke: "#34d399", track: "rgba(52,211,153,0.12)", label: "#6ee7b7" },
  amber: { stroke: "#fbbf24", track: "rgba(251,191,36,0.12)", label: "#fcd34d" },
};

function RadialGauge({
  percent,
  color,
  label,
}: {
  percent: number;
  color: keyof typeof RADIAL_COLORS;
  label: string;
}) {
  const size = 64;
  const stroke = 6;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(100, percent));
  const dash = (clamped / 100) * circ;
  const tone = RADIAL_COLORS[color];
  return (
    <svg width={size} height={size} className="-rotate-90">
      <circle cx={size / 2} cy={size / 2} r={r} stroke={tone.track} strokeWidth={stroke} fill="none" />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        stroke={tone.stroke}
        strokeWidth={stroke}
        strokeLinecap="round"
        fill="none"
        strokeDasharray={`${dash} ${circ - dash}`}
        style={{ filter: `drop-shadow(0 0 6px ${tone.stroke}88)` }}
      />
      <text
        x={size / 2}
        y={size / 2}
        textAnchor="middle"
        dominantBaseline="central"
        transform={`rotate(90 ${size / 2} ${size / 2})`}
        fill={tone.label}
        fontSize="11"
        fontWeight={600}
        fontFamily="ui-sans-serif, system-ui"
      >
        {label}
      </text>
    </svg>
  );
}

const LINE_COLORS: Record<string, { stroke: string; fill: string }> = {
  emerald: { stroke: "#34d399", fill: "rgba(52,211,153,0.18)" },
  amber: { stroke: "#fbbf24", fill: "rgba(251,191,36,0.18)" },
  sky: { stroke: "#38bdf8", fill: "rgba(56,189,248,0.18)" },
  violet: { stroke: "#a78bfa", fill: "rgba(167,139,250,0.18)" },
};

function MiniLine({ values, color }: { values: number[]; color: keyof typeof LINE_COLORS }) {
  const w = 78;
  const h = 36;
  const max = Math.max(0.5, ...values);
  const step = w / Math.max(1, values.length - 1);
  const pts = values.map((v, i) => [i * step, h - (v / max) * (h - 4) - 2] as const);
  const path = pts.map((p, i) => (i === 0 ? `M${p[0]},${p[1]}` : `L${p[0]},${p[1]}`)).join(" ");
  const area = `${path} L${w},${h} L0,${h} Z`;
  const tone = LINE_COLORS[color];
  return (
    <svg width={w} height={h}>
      <path d={area} fill={tone.fill} />
      <path d={path} fill="none" stroke={tone.stroke} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" style={{ filter: `drop-shadow(0 0 4px ${tone.stroke}88)` }} />
    </svg>
  );
}

/* ----------------------------------------------------------------------- */
/* DAG                                                                       */
/* ----------------------------------------------------------------------- */

const GRID_COLS = 5;
const GRID_ROWS = 3;
const NODE_W = 220;
const NODE_H = 96;
const COL_GAP = 60;
const ROW_GAP = 36;
const PAD_X = 24;
const PAD_Y = 24;

const SVG_W = PAD_X * 2 + GRID_COLS * NODE_W + (GRID_COLS - 1) * COL_GAP;
const SVG_H = PAD_Y * 2 + GRID_ROWS * NODE_H + (GRID_ROWS - 1) * ROW_GAP;

function nodePos(col: number, row: number) {
  const x = PAD_X + (col - 1) * (NODE_W + COL_GAP);
  const y = PAD_Y + (row - 1) * (NODE_H + ROW_GAP);
  return { x, y, cx: x + NODE_W / 2, cy: y + NODE_H / 2 };
}

function PipelineGraph() {
  const byId = useMemo(() => new Map(STAGES.map((s) => [s.id, s])), []);

  return (
    <div
      className="relative overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--panel)]"
      data-testid="pipeline-graph"
    >
      {/* Header strip */}
      <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-2.5">
        <div className="flex items-center gap-2">
          <Workflow className="h-3.5 w-3.5 text-[var(--accent)]" />
          <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--foreground)]">
            DAG · prod-analytics
          </span>
          <span className="text-[10px] text-[var(--muted)]">commit 4f1a2b · deployed 6h ago</span>
        </div>
        <div className="flex items-center gap-3 text-[10px] text-[var(--muted)]">
          <LegendDot tone="healthy" label="healthy" />
          <LegendDot tone="degraded" label="degraded" />
          <LegendDot tone="failed" label="failed" />
        </div>
      </div>

      <div className="relative" style={{ width: SVG_W, minHeight: SVG_H }}>
        {/* Background grid */}
        <svg
          width={SVG_W}
          height={SVG_H}
          className="absolute inset-0"
          style={{ pointerEvents: "none" }}
        >
          <defs>
            <pattern id="dotgrid" x="0" y="0" width="22" height="22" patternUnits="userSpaceOnUse">
              <circle cx="1" cy="1" r="1" fill="rgba(154,154,163,0.10)" />
            </pattern>
            <linearGradient id="edgePrimary" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#34d399" stopOpacity="0.2" />
              <stop offset="50%" stopColor="#38bdf8" stopOpacity="0.9" />
              <stop offset="100%" stopColor="#a78bfa" stopOpacity="0.9" />
            </linearGradient>
            <linearGradient id="edgeWarn" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#fbbf24" stopOpacity="0.3" />
              <stop offset="100%" stopColor="#f87171" stopOpacity="0.9" />
            </linearGradient>
            <linearGradient id="edgeMuted" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#6b7280" stopOpacity="0.2" />
              <stop offset="100%" stopColor="#9ca3af" stopOpacity="0.6" />
            </linearGradient>
            <marker
              id="arrowPrimary"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M0,0 L10,5 L0,10 z" fill="#a78bfa" />
            </marker>
            <marker
              id="arrowWarn"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M0,0 L10,5 L0,10 z" fill="#f87171" />
            </marker>
            <marker
              id="arrowMuted"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M0,0 L10,5 L0,10 z" fill="#9ca3af" />
            </marker>
          </defs>
          <rect width={SVG_W} height={SVG_H} fill="url(#dotgrid)" />

          {EDGES.map((e) => {
            const from = byId.get(e.from);
            const to = byId.get(e.to);
            if (!from || !to) return null;
            const a = nodePos(from.col, from.row);
            const b = nodePos(to.col, to.row);
            const startX = a.x + NODE_W;
            const startY = a.cy;
            const endX = b.x;
            const endY = b.cy;
            // Cubic bezier: outward horizontal handles for nice curves.
            const dx = Math.max(60, (endX - startX) * 0.55);
            const path = `M ${startX} ${startY} C ${startX + dx} ${startY}, ${endX - dx} ${endY}, ${endX - 6} ${endY}`;

            const stroke =
              e.tone === "primary"
                ? "url(#edgePrimary)"
                : e.tone === "warn"
                  ? "url(#edgeWarn)"
                  : "url(#edgeMuted)";
            const marker =
              e.tone === "primary"
                ? "url(#arrowPrimary)"
                : e.tone === "warn"
                  ? "url(#arrowWarn)"
                  : "url(#arrowMuted)";

            const midX = (startX + endX) / 2;
            const midY = (startY + endY) / 2 - 8;

            return (
              <g key={`${e.from}->${e.to}`}>
                <path
                  d={path}
                  fill="none"
                  stroke={stroke}
                  strokeWidth={2}
                  strokeLinecap="round"
                  markerEnd={marker}
                  style={{
                    filter:
                      e.tone === "warn"
                        ? "drop-shadow(0 0 6px rgba(248,113,113,0.45))"
                        : e.tone === "primary"
                          ? "drop-shadow(0 0 4px rgba(56,189,248,0.35))"
                          : undefined,
                  }}
                />
                <g>
                  <rect
                    x={midX - 30}
                    y={midY - 10}
                    width={60}
                    height={18}
                    rx={9}
                    fill="rgba(19,19,22,0.92)"
                    stroke={
                      e.tone === "warn"
                        ? "rgba(248,113,113,0.6)"
                        : e.tone === "primary"
                          ? "rgba(56,189,248,0.5)"
                          : "rgba(154,154,163,0.35)"
                    }
                    strokeWidth={1}
                  />
                  <text
                    x={midX}
                    y={midY + 2}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fontSize="10"
                    fontFamily="ui-monospace, SFMono-Regular, Menlo"
                    fill={
                      e.tone === "warn"
                        ? "#fca5a5"
                        : e.tone === "primary"
                          ? "#7dd3fc"
                          : "#cbd5e1"
                    }
                  >
                    {e.label}
                  </text>
                </g>
              </g>
            );
          })}
        </svg>

        {/* Node cards */}
        {STAGES.map((s) => {
          const p = nodePos(s.col, s.row);
          return (
            <div
              key={s.id}
              className="absolute"
              style={{ left: p.x, top: p.y, width: NODE_W, height: NODE_H }}
            >
              <StageCard stage={s} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

const STAGE_TONE: Record<StageStatus, { ring: string; dot: string; chip: string; glow: string }> = {
  healthy: {
    ring: "border-emerald-500/40",
    dot: "bg-emerald-300",
    chip: "text-emerald-300 bg-emerald-500/10 border-emerald-500/30",
    glow: "shadow-[0_0_24px_-6px_rgba(52,211,153,0.45)]",
  },
  degraded: {
    ring: "border-amber-500/40",
    dot: "bg-amber-300",
    chip: "text-amber-300 bg-amber-500/10 border-amber-500/30",
    glow: "shadow-[0_0_24px_-6px_rgba(251,191,36,0.5)]",
  },
  failed: {
    ring: "border-red-500/50",
    dot: "bg-red-300",
    chip: "text-red-300 bg-red-500/10 border-red-500/40",
    glow: "shadow-[0_0_28px_-6px_rgba(248,113,113,0.55)]",
  },
  idle: {
    ring: "border-[var(--border)]",
    dot: "bg-[var(--muted)]",
    chip: "text-[var(--muted)] bg-[var(--panel-2)] border-[var(--border)]",
    glow: "",
  },
};

function StageCard({ stage }: { stage: Stage }) {
  const Icon = stage.icon;
  const tone = STAGE_TONE[stage.status];
  return (
    <div
      className={cn(
        "group h-full w-full rounded-lg border bg-[var(--panel-2)] backdrop-blur-sm",
        "transition-colors hover:bg-[var(--panel)]",
        tone.ring,
        tone.glow,
      )}
    >
      <div className="flex items-start justify-between gap-2 px-3 pt-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-[var(--border)] bg-[var(--panel)]">
            <Icon className="h-3.5 w-3.5 text-[var(--foreground)]/80" />
          </span>
          <div className="min-w-0">
            <div className="truncate text-[12px] font-semibold tracking-tight text-[var(--foreground)]">
              {stage.label}
            </div>
            <div className="truncate text-[10px] text-[var(--muted)]">{stage.sub}</div>
          </div>
        </div>
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide",
            tone.chip,
          )}
        >
          <span className={cn("h-1.5 w-1.5 rounded-full", tone.dot)} />
          {stage.status}
        </span>
      </div>

      <div className="mt-1.5 flex items-end justify-between gap-2 px-3 pb-2.5">
        <div>
          <div className="text-[15px] font-semibold tabular-nums tracking-tight text-[var(--foreground)]">
            {fmtRows(stage.throughput)}
            <span className="ml-1 text-[10px] font-normal text-[var(--muted)]">r/s</span>
          </div>
          <div className="text-[10px] text-[var(--muted)]">
            p95 {stage.p95Ms === 0 ? "—" : `${stage.p95Ms}ms`}
          </div>
        </div>
        <NodeSparkline values={stage.spark} status={stage.status} />
      </div>
    </div>
  );
}

function NodeSparkline({ values, status }: { values: number[]; status: StageStatus }) {
  const w = 78;
  const h = 28;
  const stroke =
    status === "failed" ? "#f87171" : status === "degraded" ? "#fbbf24" : "#34d399";
  const fill =
    status === "failed"
      ? "rgba(248,113,113,0.18)"
      : status === "degraded"
        ? "rgba(251,191,36,0.18)"
        : "rgba(52,211,153,0.18)";
  const max = Math.max(0.4, ...values);
  const step = w / Math.max(1, values.length - 1);
  const pts = values.map((v, i) => [i * step, h - (v / max) * (h - 4) - 2] as const);
  const path = pts.map((p, i) => (i === 0 ? `M${p[0]},${p[1]}` : `L${p[0]},${p[1]}`)).join(" ");
  const area = `${path} L${w},${h} L0,${h} Z`;
  return (
    <svg width={w} height={h} className="shrink-0">
      <path d={area} fill={fill} />
      <path
        d={path}
        fill="none"
        stroke={stroke}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ filter: `drop-shadow(0 0 4px ${stroke}88)` }}
      />
    </svg>
  );
}

function LegendDot({ tone, label }: { tone: StageStatus; label: string }) {
  const t = STAGE_TONE[tone];
  return (
    <span className="inline-flex items-center gap-1">
      <span className={cn("h-1.5 w-1.5 rounded-full", t.dot)} />
      {label}
    </span>
  );
}

/* ----------------------------------------------------------------------- */
/* Recent runs                                                              */
/* ----------------------------------------------------------------------- */

function RunHistory() {
  return (
    <div className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--panel)]">
      <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-2.5">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-300" />
          <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--foreground)]">
            Recent runs · last 24
          </span>
        </div>
        <span className="text-[10px] text-[var(--muted)]">most recent on the right →</span>
      </div>
      <div className="divide-y divide-[var(--border)]/60">
        {STAGES.map((s) => (
          <div key={s.id} className="grid grid-cols-[200px_1fr_auto] items-center gap-3 px-4 py-2.5">
            <div className="flex items-center gap-2 min-w-0">
              <s.icon className="h-3 w-3 shrink-0 text-[var(--muted)]" />
              <span className="truncate text-[12px] font-medium text-[var(--foreground)]">
                {s.label}
              </span>
            </div>
            <div className="flex gap-[3px]">
              {s.history.map((r, i) => (
                <span
                  key={i}
                  className={cn(
                    "h-4 flex-1 rounded-[2px]",
                    r === true && "bg-emerald-400/80",
                    r === "warn" && "bg-amber-400/80",
                    r === "fail" && "bg-red-500/85",
                  )}
                  style={{
                    boxShadow:
                      r === "fail"
                        ? "0 0 6px rgba(248,113,113,0.6)"
                        : r === "warn"
                          ? "0 0 6px rgba(251,191,36,0.5)"
                          : undefined,
                  }}
                  title={`run ${i + 1}: ${r === true ? "ok" : r}`}
                />
              ))}
            </div>
            <span className="font-mono text-[10px] text-[var(--muted)]">
              {s.history.filter((x) => x === true).length}/{s.history.length}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------- */
/* Formatters                                                                */
/* ----------------------------------------------------------------------- */

function fmtRows(n: number): string {
  if (n === 0) return "0";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
