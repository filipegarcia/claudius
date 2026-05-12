import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * GET /api/docker/containers
 *
 * Returns the current Docker container fleet plus per-container resource
 * usage. Two CLI calls run in parallel:
 *
 *   - `docker ps    --format '{{json .}}'`       → identity, status, ports
 *   - `docker stats --no-stream --format '{{json .}}'` → CPU%, MEM, NET, BLOCK
 *
 * Both emit NDJSON (one JSON object per line, no enclosing array). The
 * results are joined by container ID before serialising.
 *
 * Failure modes that aren't bugs:
 *   - `docker` binary missing on PATH (ENOENT) → `status: "unavailable"`,
 *     `reason: "docker-not-installed"`.
 *   - Daemon not running (`Cannot connect to the Docker daemon`) →
 *     `status: "unavailable"`, `reason: "docker-daemon-down"`.
 * Both render the friendly empty state on the page; both reply 200 so the
 * frontend can branch on `status` without an error toast.
 *
 * Stats cost: `docker stats --no-stream` samples CPU for ~1s per call.
 * That's a known tradeoff — we pay it once per 5s poll, in parallel with
 * the cheap `ps` call so wall-clock latency is bounded by stats alone.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const execFileP = promisify(execFile);

const DOCKER_PS_TIMEOUT_MS = 2000;
const DOCKER_STATS_TIMEOUT_MS = 3500; // stats samples ~1s + buffer

export type Container = {
  id: string;
  name: string;
  image: string;
  status: string;
  state: string;
  ports: string;
  runningFor: string;
  /** Soft health flag parsed out of STATUS ("(healthy)" / "(unhealthy)"). */
  health: "healthy" | "unhealthy" | "starting" | null;
  /** CPU usage as a percentage, 0..100*n (n = cores). null when stats missing. */
  cpuPct: number | null;
  /** Memory usage as a percentage of the container's limit. */
  memPct: number | null;
  /** Memory usage in bytes (resident). */
  memUsageBytes: number | null;
  /** Memory limit in bytes (the docker stats `MemUsage` denominator). */
  memLimitBytes: number | null;
  /** Aggregated block I/O (read+write) in bytes since container start. */
  blockIOBytes: number | null;
  /** Aggregated network I/O (rx+tx) in bytes since container start. */
  netIOBytes: number | null;
};

export type DockerResponse =
  | { status: "ok"; containers: Container[]; sampledAt: number }
  | {
      status: "unavailable";
      reason: "docker-not-installed" | "docker-daemon-down" | "unknown";
      detail?: string;
      containers: [];
    };

type DockerPsRow = {
  ID?: string;
  Names?: string;
  Image?: string;
  Status?: string;
  State?: string;
  Ports?: string;
  RunningFor?: string;
};

type DockerStatsRow = {
  ID?: string;
  Name?: string;
  CPUPerc?: string; // "1.23%"
  MemPerc?: string; // "4.56%"
  MemUsage?: string; // "23.4MiB / 1.95GiB"
  BlockIO?: string; // "1.2MB / 3.4MB"
  NetIO?: string; // "1.2kB / 3.4kB"
};

function classifyError(err: unknown): {
  reason: Extract<DockerResponse, { status: "unavailable" }>["reason"];
  detail: string;
} {
  const e = err as NodeJS.ErrnoException & { stderr?: string };
  const stderr = String(e?.stderr ?? "");
  if (e?.code === "ENOENT") {
    return { reason: "docker-not-installed", detail: "`docker` not found on PATH" };
  }
  if (
    /Cannot connect to the Docker daemon|connect: no such file or directory|connection refused/i.test(
      stderr,
    )
  ) {
    return { reason: "docker-daemon-down", detail: stderr.split("\n")[0] ?? "daemon unreachable" };
  }
  return {
    reason: "unknown",
    detail: stderr.trim() || (e?.message ?? "docker call failed"),
  };
}

function parseHealth(status: string): Container["health"] {
  const m = /\((healthy|unhealthy|health: starting)\)/i.exec(status);
  if (!m) return null;
  const v = m[1].toLowerCase();
  if (v === "healthy" || v === "unhealthy") return v;
  return "starting";
}

/** "1.23%" → 1.23. Returns null on parse failure. */
function parsePercent(s: string | undefined): number | null {
  if (!s) return null;
  const m = /(-?\d+(?:\.\d+)?)\s*%?/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Docker formats bytes with binary (KiB/MiB/GiB) or decimal (kB/MB/GB) suffixes
 * depending on the metric. We accept both. Returns null on parse failure.
 */
const SUFFIXES: Record<string, number> = {
  B: 1,
  KB: 1e3,
  MB: 1e6,
  GB: 1e9,
  TB: 1e12,
  KIB: 1024,
  MIB: 1024 ** 2,
  GIB: 1024 ** 3,
  TIB: 1024 ** 4,
};
function parseSize(s: string | undefined): number | null {
  if (!s) return null;
  const m = /(-?\d+(?:\.\d+)?)\s*([a-zA-Z]+)?/.exec(s.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = (m[2] ?? "B").toUpperCase();
  const factor = SUFFIXES[unit] ?? 1;
  return n * factor;
}

/** "23.4MiB / 1.95GiB" → [used, limit]. */
function parseUsage(s: string | undefined): { used: number | null; limit: number | null } {
  if (!s) return { used: null, limit: null };
  const parts = s.split("/");
  return {
    used: parseSize(parts[0]),
    limit: parseSize(parts[1]),
  };
}

/** "1.2MB / 3.4MB" → sum in bytes. */
function parseIOSum(s: string | undefined): number | null {
  if (!s) return null;
  const parts = s.split("/").map((p) => parseSize(p) ?? 0);
  if (parts.length === 0) return null;
  return parts.reduce((a, b) => a + b, 0);
}

function parseNdjson<T>(stdout: string): T[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as T;
      } catch {
        return null;
      }
    })
    .filter((r): r is T => r !== null);
}

export async function GET(): Promise<Response> {
  const sampledAt = Date.now();
  try {
    // Run both in parallel; if either fails we still classify the error.
    const [psResult, statsResult] = await Promise.allSettled([
      execFileP("docker", ["ps", "--format", "{{json .}}"], {
        timeout: DOCKER_PS_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
      }),
      execFileP("docker", ["stats", "--no-stream", "--format", "{{json .}}"], {
        timeout: DOCKER_STATS_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
      }),
    ]);

    // `ps` failing is fatal — we can't render anything sensible. `stats`
    // failing is degraded mode: we still ship the container list with null
    // CPU/MEM, which the page renders as "—".
    if (psResult.status === "rejected") throw psResult.reason;

    const psRows = parseNdjson<DockerPsRow>(psResult.value.stdout);
    const statsRows =
      statsResult.status === "fulfilled" ? parseNdjson<DockerStatsRow>(statsResult.value.stdout) : [];
    const statsById = new Map<string, DockerStatsRow>();
    for (const s of statsRows) {
      if (s.ID) statsById.set(s.ID.slice(0, 12), s);
    }

    const containers: Container[] = psRows.map((r) => {
      const shortId = (r.ID ?? "").slice(0, 12);
      const stats = statsById.get(shortId);
      const usage = parseUsage(stats?.MemUsage);
      return {
        id: shortId,
        name: r.Names ?? "",
        image: r.Image ?? "",
        status: r.Status ?? "",
        state: r.State ?? "",
        ports: r.Ports ?? "",
        runningFor: r.RunningFor ?? "",
        health: parseHealth(r.Status ?? ""),
        cpuPct: parsePercent(stats?.CPUPerc),
        memPct: parsePercent(stats?.MemPerc),
        memUsageBytes: usage.used,
        memLimitBytes: usage.limit,
        blockIOBytes: parseIOSum(stats?.BlockIO),
        netIOBytes: parseIOSum(stats?.NetIO),
      };
    });

    const body: DockerResponse = { status: "ok", containers, sampledAt };
    return NextResponse.json(body);
  } catch (err) {
    const { reason, detail } = classifyError(err);
    const body: DockerResponse = { status: "unavailable", reason, detail, containers: [] };
    return NextResponse.json(body);
  }
}
