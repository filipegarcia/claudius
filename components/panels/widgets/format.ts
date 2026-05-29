export function fmtUsd(n: number | undefined | null): string {
  if (!n || !isFinite(n)) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

export function fmtTokens(n: number | undefined | null): string {
  if (!n || !isFinite(n)) return "0";
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function fmtElapsedSec(s: number): string {
  if (s < 60) return `${Math.floor(s)}s`;
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  if (m < 60) return r === 0 ? `${m}m` : `${m}m ${r}s`;
  const h = Math.floor(m / 60);
  const mr = m % 60;
  return mr === 0 ? `${h}h` : `${h}h ${mr}m`;
}

export function fmtMs(ms: number | undefined | null): string {
  if (!ms || !isFinite(ms)) return "—";
  if (ms < 1000) return `${ms}ms`;
  return fmtElapsedSec(ms / 1000);
}

/** Truncate a path to ~maxLen by keeping the last 2 segments. */
export function fmtPath(p: string, maxLen = 36): string {
  if (p.length <= maxLen) return p;
  const parts = p.split("/").filter(Boolean);
  if (parts.length <= 2) return "…/" + parts.join("/").slice(-(maxLen - 2));
  const tail = parts.slice(-2).join("/");
  return "…/" + tail.slice(-(maxLen - 2));
}
