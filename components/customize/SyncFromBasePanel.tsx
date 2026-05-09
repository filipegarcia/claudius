"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, GitMerge, AlertTriangle, ArrowDownToLine } from "lucide-react";

type Verdict =
  | "in-sync"
  | "upstream-only"
  | "user-only"
  | "conflict"
  | "new-upstream"
  | "new-user"
  | "deleted-upstream"
  | "deleted-user";

type Status = {
  manifestCreatedAt: number;
  totals: Record<Verdict, number>;
  entries: { path: string; verdict: Verdict }[];
};

type SyncResult = {
  applied: number;
  added: number;
  deleted: number;
  skippedConflicts: number;
  appliedPaths: string[];
};

const SAFE: Verdict[] = ["upstream-only", "new-upstream", "deleted-upstream"];

export function SyncFromBasePanel({ customizationId }: { customizationId: string }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<SyncResult | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const r = await fetch(`/api/customizations/${customizationId}/sync`);
      if (!r.ok) {
        const e = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(e.error ?? `HTTP ${r.status}`);
      }
      setStatus((await r.json()) as Status);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [customizationId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onSync = useCallback(async () => {
    if (!status) return;
    const safeCount =
      status.totals["upstream-only"] + status.totals["new-upstream"] + status.totals["deleted-upstream"];
    const conflictCount = status.totals.conflict;
    const msg =
      `Sync ${safeCount} safe update${safeCount === 1 ? "" : "s"} from base?` +
      (conflictCount > 0
        ? `\n\n${conflictCount} file(s) have conflicting edits and will NOT be touched. You'll need to resolve those manually.`
        : "");
    if (!confirm(msg)) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/customizations/${customizationId}/sync`, { method: "POST" });
      if (!r.ok) {
        const e = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(e.error ?? `HTTP ${r.status}`);
      }
      setLastResult((await r.json()) as SyncResult);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [customizationId, status, refresh]);

  if (loading) {
    return <div className="flex items-center gap-2 text-xs text-[var(--muted)]"><Loader2 className="h-3 w-3 animate-spin" /> Loading sync status…</div>;
  }
  if (!status) {
    return <div className="text-xs text-[var(--muted)]">{error ?? "Sync status unavailable."}</div>;
  }

  const safeCount =
    status.totals["upstream-only"] + status.totals["new-upstream"] + status.totals["deleted-upstream"];
  const conflictCount = status.totals.conflict;
  const userCount = status.totals["user-only"] + status.totals["new-user"] + status.totals["deleted-user"];

  return (
    <div>
      {error && (
        <div className="mb-3 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {error}
        </div>
      )}
      {lastResult && (
        <div className="mb-3 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">
          Synced {lastResult.applied} updated, {lastResult.added} added, {lastResult.deleted} removed.
          {lastResult.skippedConflicts > 0 ? ` ${lastResult.skippedConflicts} skipped (conflicts).` : ""}
        </div>
      )}

      <div className="grid grid-cols-3 gap-2 mb-3 text-xs">
        <Stat label="Upstream available" value={safeCount} tone="text-sky-300" />
        <Stat label="Your edits" value={userCount} tone="text-amber-300" />
        <Stat label="Conflicts" value={conflictCount} tone={conflictCount > 0 ? "text-red-300" : "text-[var(--muted)]"} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => void onSync()}
          disabled={busy || safeCount === 0}
          className="flex items-center gap-2 rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowDownToLine className="h-4 w-4" />}
          Sync {safeCount} safe update{safeCount === 1 ? "" : "s"}
        </button>
        <button
          onClick={() => void refresh()}
          className="flex items-center gap-1 rounded-md border border-[var(--border)] px-2 py-1.5 text-xs hover:bg-[var(--panel-2)]"
        >
          <RefreshCw className="h-3 w-3" /> Recompute
        </button>
        <span className="text-xs text-[var(--muted)]">
          Fork point: {new Date(status.manifestCreatedAt).toLocaleString()}
        </span>
      </div>

      {(safeCount > 0 || conflictCount > 0 || userCount > 0) && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-[var(--muted)]">Show file-by-file breakdown</summary>
          <div className="mt-2 max-h-72 overflow-auto rounded-md border border-[var(--border)] bg-black/30 p-2 font-mono text-[11px]">
            {status.entries
              .filter((e) => e.verdict !== "in-sync")
              .map((e) => (
                <div key={e.path} className="flex items-center gap-2">
                  {iconFor(e.verdict)}
                  <span className={tagClass(e.verdict)}>{labelFor(e.verdict)}</span>
                  <span className="truncate">{e.path}</span>
                </div>
              ))}
            {status.entries.every((e) => e.verdict === "in-sync") && (
              <div className="px-2 py-3 text-center text-[var(--muted)]">All files in sync.</div>
            )}
          </div>
        </details>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="rounded-md border border-[var(--border)] bg-black/20 px-3 py-2">
      <div className={`text-lg font-semibold ${tone}`}>{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-[var(--muted)]">{label}</div>
    </div>
  );
}

function iconFor(v: Verdict) {
  if (SAFE.includes(v)) return <ArrowDownToLine className="h-3 w-3 shrink-0 text-sky-400" />;
  if (v === "conflict") return <AlertTriangle className="h-3 w-3 shrink-0 text-red-400" />;
  return <GitMerge className="h-3 w-3 shrink-0 text-amber-400" />;
}

function labelFor(v: Verdict): string {
  switch (v) {
    case "upstream-only": return "M ";
    case "new-upstream": return "+ ";
    case "deleted-upstream": return "- ";
    case "user-only": return "U ";
    case "new-user": return "+u";
    case "deleted-user": return "-u";
    case "conflict": return "!!";
    default: return "  ";
  }
}

function tagClass(v: Verdict): string {
  if (SAFE.includes(v)) return "text-sky-300";
  if (v === "conflict") return "text-red-300";
  return "text-amber-300";
}
