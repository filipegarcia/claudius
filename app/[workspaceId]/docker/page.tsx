"use client";

import { useMemo } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Container as ContainerIcon,
  Cpu,
  HardDrive,
  MemoryStick,
  Network as NetworkIcon,
  RefreshCw,
  ServerCrash,
  ShieldAlert,
} from "lucide-react";
import { SideNav } from "@/components/nav/SideNav";
import { useDocker } from "@/lib/client/useDocker";
import type { Container } from "@/app/api/docker/containers/route";
import { cn } from "@/lib/utils/cn";

/**
 * Docker container monitor.
 *
 * Read-only view over the local Docker daemon. Renders:
 *   - Four aggregate cards (containers / CPU / memory / disk I/O) at the
 *     top — those are the "fancy graphics" that read at a glance.
 *   - Per-container CPU and memory bars in a styled table — each container
 *     gets a horizontal gauge so spikes are visible without reading the
 *     number.
 *
 * Polls every 5s via {@link useDocker}; pauses when the tab is hidden.
 * Degrades gracefully when docker isn't installed / daemon isn't running
 * (see UnavailableState).
 */

const HEALTH_TONES: Record<NonNullable<Container["health"]> | "none", string> = {
  healthy: "text-emerald-300 bg-emerald-500/10 border-emerald-500/30",
  unhealthy: "text-red-300 bg-red-500/10 border-red-500/30",
  starting: "text-amber-300 bg-amber-500/10 border-amber-500/30",
  none: "text-[var(--muted)] bg-[var(--panel-2)] border-[var(--border)]",
};

export default function DockerPage() {
  const { status, reason, detail, containers, loading, error, refresh, sampledAt } = useDocker();

  return (
    <div className="flex h-full">
      <SideNav running={false} />
      <main data-pane-name="docker-main" className="flex h-full flex-1 flex-col overflow-hidden">
        <header className="flex h-9 shrink-0 items-center gap-3 border-b border-[var(--border)] bg-[var(--panel)] px-4 text-xs">
          <Link href="/" className="flex items-center gap-1 text-[var(--muted)] hover:text-[var(--foreground)]">
            <ArrowLeft className="h-3 w-3" />
            Back
          </Link>
          <div className="flex items-center gap-2 text-[var(--foreground)]">
            <ContainerIcon className="h-3.5 w-3.5" />
            <span className="font-medium">Docker</span>
          </div>
          <span className="text-[var(--muted)]">
            {status === "ok" ? `${containers.length} running` : "unavailable"}
          </span>
          <div className="ml-auto flex items-center gap-3">
            {status === "ok" && sampledAt != null && (
              <span className="text-[10px] text-[var(--muted)]">
                sampled {new Date(sampledAt).toLocaleTimeString()}
              </span>
            )}
            <button
              onClick={() => void refresh()}
              className="flex items-center gap-1 rounded border border-[var(--border)] px-2 py-0.5 text-[11px] text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)]"
              title="Refresh"
            >
              <RefreshCw className="h-3 w-3" />
              Refresh
            </button>
          </div>
        </header>

        <div data-testid="docker-page" className="flex-1 overflow-auto">
          {status === "unavailable" ? (
            <UnavailableState reason={reason} detail={detail} />
          ) : containers.length === 0 ? (
            <EmptyState loading={loading} />
          ) : (
            <DashboardBody containers={containers} />
          )}

          {error && (
            <div className="mx-6 mt-4 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">
              {error}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

function DashboardBody({ containers }: { containers: Container[] }) {
  const agg = useMemo(() => aggregate(containers), [containers]);
  return (
    <div className="space-y-6 px-6 py-5" data-testid="docker-dashboard">
      <AggregateCards agg={agg} containerCount={containers.length} />
      <ContainersGrid containers={containers} agg={agg} />
    </div>
  );
}

/* ----------------------------------------------------------------------- */
/* Aggregate cards                                                          */
/* ----------------------------------------------------------------------- */

type Aggregate = {
  totalCpuPct: number;
  totalMemUsage: number;
  totalMemLimit: number;
  totalBlockIO: number;
  totalNetIO: number;
  cpuByName: Map<string, number>;
};

function aggregate(containers: Container[]): Aggregate {
  let totalCpuPct = 0;
  let totalMemUsage = 0;
  let totalMemLimit = 0;
  let totalBlockIO = 0;
  let totalNetIO = 0;
  const cpuByName = new Map<string, number>();
  for (const c of containers) {
    totalCpuPct += c.cpuPct ?? 0;
    totalMemUsage += c.memUsageBytes ?? 0;
    totalMemLimit += c.memLimitBytes ?? 0;
    totalBlockIO += c.blockIOBytes ?? 0;
    totalNetIO += c.netIOBytes ?? 0;
    cpuByName.set(c.name, c.cpuPct ?? 0);
  }
  return { totalCpuPct, totalMemUsage, totalMemLimit, totalBlockIO, totalNetIO, cpuByName };
}

function AggregateCards({ agg, containerCount }: { agg: Aggregate; containerCount: number }) {
  const memPct =
    agg.totalMemLimit > 0 ? Math.min(100, (agg.totalMemUsage / agg.totalMemLimit) * 100) : 0;
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4" data-testid="docker-cards">
      <Card
        title="Containers"
        value={String(containerCount)}
        sub={`${containerCount === 1 ? "service" : "services"} running`}
        icon={<ContainerIcon className="h-4 w-4" />}
        accent="emerald"
        gauge={<ContainerSparkles cpus={[...agg.cpuByName.values()]} />}
      />
      <Card
        title="CPU"
        value={`${agg.totalCpuPct.toFixed(1)}%`}
        sub="aggregate across containers"
        icon={<Cpu className="h-4 w-4" />}
        accent="sky"
        gauge={<RadialGauge percent={Math.min(100, agg.totalCpuPct)} color="sky" label={`${Math.round(Math.min(100, agg.totalCpuPct))}%`} />}
      />
      <Card
        title="Memory"
        value={formatBytes(agg.totalMemUsage)}
        sub={agg.totalMemLimit > 0 ? `of ${formatBytes(agg.totalMemLimit)} limit` : "—"}
        icon={<MemoryStick className="h-4 w-4" />}
        accent="violet"
        gauge={<RadialGauge percent={memPct} color="violet" label={`${Math.round(memPct)}%`} />}
      />
      <Card
        title="Disk I/O"
        value={formatBytes(agg.totalBlockIO)}
        sub={`net ${formatBytes(agg.totalNetIO)} on the wire`}
        icon={<HardDrive className="h-4 w-4" />}
        accent="amber"
        gauge={<DualBar primary={agg.totalBlockIO} secondary={agg.totalNetIO} />}
      />
    </div>
  );
}

// Tailwind only generates classes it sees as full string literals; building
// `before:${color}` at runtime would silently strip the gradient. Each
// accent gets a hand-spelled class string so the JIT compiler picks them up.
const ACCENT_STYLES: Record<string, { glow: string; rule: string }> = {
  emerald: {
    glow: "from-emerald-400/30 via-emerald-400/10 to-transparent",
    rule: "before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-gradient-to-r before:from-transparent before:via-emerald-400/60 before:to-transparent",
  },
  sky: {
    glow: "from-sky-400/30 via-sky-400/10 to-transparent",
    rule: "before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-gradient-to-r before:from-transparent before:via-sky-400/60 before:to-transparent",
  },
  violet: {
    glow: "from-violet-400/30 via-violet-400/10 to-transparent",
    rule: "before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-gradient-to-r before:from-transparent before:via-violet-400/60 before:to-transparent",
  },
  amber: {
    glow: "from-amber-400/30 via-amber-400/10 to-transparent",
    rule: "before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-gradient-to-r before:from-transparent before:via-amber-400/60 before:to-transparent",
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

/* ----------------------------------------------------------------------- */
/* Radial gauge — SVG donut with a percent label                            */
/* ----------------------------------------------------------------------- */

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

function DualBar({ primary, secondary }: { primary: number; secondary: number }) {
  const total = Math.max(1, primary + secondary);
  const a = (primary / total) * 100;
  const b = (secondary / total) * 100;
  return (
    <div className="flex h-16 w-16 flex-col justify-end gap-1">
      <div className="flex h-2 overflow-hidden rounded-sm bg-[var(--panel-2)]">
        <div className="bg-amber-400/80" style={{ width: `${a}%` }} />
      </div>
      <div className="flex h-2 overflow-hidden rounded-sm bg-[var(--panel-2)]">
        <div className="bg-sky-400/70" style={{ width: `${b}%` }} />
      </div>
      <div className="flex items-center gap-1 text-[9px] uppercase tracking-wide text-[var(--muted)]">
        <NetworkIcon className="h-2.5 w-2.5" />
        net
      </div>
    </div>
  );
}

/** Tiny vertical-bar sparkline of per-container CPU%. */
function ContainerSparkles({ cpus }: { cpus: number[] }) {
  if (cpus.length === 0) return <div className="h-16 w-16" />;
  const max = Math.max(2, ...cpus);
  return (
    <div className="flex h-16 w-16 items-end gap-[2px]">
      {cpus.slice(0, 8).map((v, i) => {
        const h = Math.max(2, (v / max) * 100);
        return (
          <div
            key={i}
            className="flex-1 rounded-sm bg-gradient-to-t from-emerald-500/30 via-emerald-400/70 to-emerald-300"
            style={{ height: `${h}%` }}
          />
        );
      })}
    </div>
  );
}

/* ----------------------------------------------------------------------- */
/* Containers table — each row gets CPU/MEM gauges                          */
/* ----------------------------------------------------------------------- */

function ContainersGrid({ containers, agg }: { containers: Container[]; agg: Aggregate }) {
  // Peak across the visible set so bar widths are comparable, with a floor
  // so a quiet fleet doesn't make every bar full-width.
  const cpuPeak = Math.max(
    5,
    ...containers.map((c) => c.cpuPct ?? 0),
  );
  const memPeak = Math.max(
    5,
    ...containers.map((c) => c.memPct ?? 0),
  );
  void agg; // reserved for future per-container sparkline history
  return (
    <div className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--panel)]">
      <table className="w-full border-collapse text-sm" data-testid="docker-containers-table">
        <thead>
          <tr className="border-b border-[var(--border)] text-left text-[10px] uppercase tracking-wide text-[var(--muted)]">
            <th className="px-4 py-2.5 font-medium">Container</th>
            <th className="px-4 py-2.5 font-medium">Status</th>
            <th className="px-4 py-2.5 font-medium">CPU</th>
            <th className="px-4 py-2.5 font-medium">Memory</th>
            <th className="px-4 py-2.5 font-medium">Disk I/O</th>
            <th className="px-4 py-2.5 font-medium">Network</th>
            <th className="px-4 py-2.5 font-medium">Ports</th>
          </tr>
        </thead>
        <tbody>
          {containers.map((c) => (
            <tr key={c.id} className="border-b border-[var(--border)]/50 last:border-b-0 hover:bg-[var(--panel-2)]/40">
              <td className="px-4 py-3">
                <div className="flex flex-col">
                  <span className="font-medium text-[var(--foreground)]">{c.name}</span>
                  <span className="font-mono text-[10px] text-[var(--muted)]">
                    {c.image} · {c.id}
                  </span>
                </div>
              </td>
              <td className="px-4 py-3">
                <div className="flex flex-col gap-1">
                  <HealthBadge health={c.health} />
                  <span className="text-[10px] text-[var(--muted)]">{c.runningFor}</span>
                </div>
              </td>
              <td className="px-4 py-3">
                <UsageBar
                  pct={c.cpuPct == null ? null : (c.cpuPct / cpuPeak) * 100}
                  label={c.cpuPct == null ? "—" : `${c.cpuPct.toFixed(1)}%`}
                  color="sky"
                />
              </td>
              <td className="px-4 py-3">
                <UsageBar
                  pct={c.memPct == null ? null : (c.memPct / memPeak) * 100}
                  label={
                    c.memUsageBytes != null
                      ? `${formatBytes(c.memUsageBytes)}${c.memLimitBytes ? ` / ${formatBytes(c.memLimitBytes)}` : ""}`
                      : "—"
                  }
                  color="violet"
                />
              </td>
              <td className="px-4 py-3 font-mono text-xs text-[var(--muted)]">
                {c.blockIOBytes != null ? formatBytes(c.blockIOBytes) : "—"}
              </td>
              <td className="px-4 py-3 font-mono text-xs text-[var(--muted)]">
                {c.netIOBytes != null ? formatBytes(c.netIOBytes) : "—"}
              </td>
              <td className="px-4 py-3 font-mono text-[11px] text-[var(--muted)]">
                {c.ports || "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const BAR_COLORS: Record<string, string> = {
  sky: "from-sky-500 to-cyan-400",
  violet: "from-violet-500 to-fuchsia-400",
};

function UsageBar({
  pct,
  label,
  color,
}: {
  pct: number | null;
  label: string;
  color: keyof typeof BAR_COLORS;
}) {
  if (pct == null) {
    return <div className="font-mono text-[11px] text-[var(--muted)]">{label}</div>;
  }
  const width = Math.max(2, Math.min(100, pct));
  return (
    <div className="flex flex-col gap-1">
      <div className="relative h-2 w-32 overflow-hidden rounded-full bg-[var(--panel-2)]">
        <div
          className={cn("absolute inset-y-0 left-0 rounded-full bg-gradient-to-r", BAR_COLORS[color])}
          style={{
            width: `${width}%`,
            boxShadow: color === "sky"
              ? "0 0 8px rgba(56,189,248,0.5)"
              : "0 0 8px rgba(167,139,250,0.5)",
          }}
        />
      </div>
      <span className="font-mono text-[11px] text-[var(--foreground)]/80">{label}</span>
    </div>
  );
}

function HealthBadge({ health }: { health: Container["health"] }) {
  const tone = HEALTH_TONES[health ?? "none"];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
        tone,
      )}
    >
      <span
        className={cn(
          "inline-block h-1.5 w-1.5 rounded-full",
          health === "healthy" && "bg-emerald-300",
          health === "unhealthy" && "bg-red-300",
          health === "starting" && "bg-amber-300",
          health === null && "bg-[var(--muted)]",
        )}
      />
      {health ?? "no check"}
    </span>
  );
}

/* ----------------------------------------------------------------------- */
/* Empty + Unavailable states                                               */
/* ----------------------------------------------------------------------- */

function EmptyState({ loading }: { loading: boolean }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-sm text-[var(--muted)]">
      <ContainerIcon className="h-10 w-10 opacity-50" />
      <div className="text-[var(--foreground)] font-medium">
        {loading ? "Looking for containers…" : "No running containers"}
      </div>
      {!loading && (
        <p className="max-w-md text-xs">
          Start one with{" "}
          <code className="rounded bg-[var(--panel-2)] px-1.5 py-0.5 font-mono text-[var(--foreground)]">
            docker run
          </code>{" "}
          and it&apos;ll show up here within five seconds.
        </p>
      )}
    </div>
  );
}

function UnavailableState({
  reason,
  detail,
}: {
  reason: ReturnType<typeof useDocker>["reason"];
  detail?: string;
}) {
  const friendly =
    reason === "docker-not-installed"
      ? {
          title: "Docker isn't installed",
          body: "Claudius couldn't find the `docker` CLI on your PATH. Install Docker Desktop (or the engine + CLI) to monitor containers here.",
          icon: <ShieldAlert className="h-10 w-10 opacity-60" />,
        }
      : reason === "docker-daemon-down"
        ? {
            title: "Docker daemon isn't running",
            body: "The `docker` CLI is installed but couldn't reach the daemon. Start Docker Desktop (or `systemctl start docker`) and refresh.",
            icon: <ServerCrash className="h-10 w-10 opacity-60" />,
          }
        : {
            title: "Couldn't talk to Docker",
            body: detail ?? "Unexpected error from `docker ps`.",
            icon: <ServerCrash className="h-10 w-10 opacity-60" />,
          };
  return (
    <div
      data-testid="docker-unavailable"
      className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-sm text-[var(--muted)]"
    >
      {friendly.icon}
      <div className="text-[var(--foreground)] font-medium">{friendly.title}</div>
      <p className="max-w-md text-xs">{friendly.body}</p>
      {detail && reason !== "docker-daemon-down" && reason !== "docker-not-installed" && (
        <code className="mt-1 rounded bg-[var(--panel-2)] px-2 py-1 font-mono text-[10px] text-[var(--muted)]">
          {detail}
        </code>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------------- */
/* Formatters                                                                */
/* ----------------------------------------------------------------------- */

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log10(n) / 3));
  const v = n / 10 ** (i * 3);
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}
