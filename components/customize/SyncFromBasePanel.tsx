"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  Loader2,
  RefreshCw,
  GitMerge,
  AlertTriangle,
  ArrowDownToLine,
  Settings as SettingsIcon,
  Sparkles,
} from "lucide-react";

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

/**
 * Verdicts that mean "this file is part of this customization" — the user
 * has edited it (or it conflicts with one they edited). Everything else is
 * upstream activity unrelated to the customization's feature, hidden by
 * default. The toggle reveals them.
 */
const CUSTOMIZATION_VERDICTS: Verdict[] = [
  "user-only",
  "new-user",
  "deleted-user",
  "conflict",
];

/**
 * Lockfiles, runtime state, generated build artifacts. Always hidden in
 * the default view; revealed (along with unrelated upstream changes) when
 * the user toggles "Show all changes".
 */
const NOISE_PATTERNS: RegExp[] = [
  /(^|\/)package-lock\.json$/,
  /(^|\/)bun\.lock(b)?$/,
  /\.lock$/,
  /\.tsbuildinfo$/,
  /^\.claude\//, // Claudius runtime state (sessions, tasks, etc.)
  /^\.next\//, // Next.js build output
  /^node_modules\//,
  /^dist\//,
  /^build\//,
  /^playwright-report\//,
  /^test-results\//,
  /^site\/screenshots\//, // Auto-generated marketing PNGs
];

function isNoise(path: string): boolean {
  return NOISE_PATTERNS.some((p) => p.test(path));
}

function isCustomizationRelevant(verdict: Verdict): boolean {
  return CUSTOMIZATION_VERDICTS.includes(verdict);
}

export function SyncFromBasePanel({ customizationId }: { customizationId: string }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<SyncResult | null>(null);
  const [autoFixBusy, setAutoFixBusy] = useState(false);
  const [autoFixError, setAutoFixError] = useState<string | null>(null);
  const [showNoise, setShowNoise] = useState(false);

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

  /**
   * Compose the auto-fix prompt server-side, switch the active workspace
   * to the customization's workspace, and route the user to chat with
   * the prompt prefilled (?prefill=<encoded>). They can review and send.
   * The actual file edits happen inside Claude Code's agent loop.
   */
  const onAutoFix = useCallback(async () => {
    setAutoFixError(null);
    setAutoFixBusy(true);
    try {
      const r = await fetch(`/api/customizations/${customizationId}/auto-fix`, {
        method: "POST",
      });
      if (!r.ok) {
        const e = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(e.error ?? `HTTP ${r.status}`);
      }
      const data = (await r.json()) as {
        workspaceId: string | null;
        prompt: string;
      };
      if (data.workspaceId) {
        const ws = await fetch(`/api/workspaces/${data.workspaceId}/select`, { method: "POST" });
        if (!ws.ok) throw new Error("could not switch to the customization's workspace");
      } else {
        throw new Error(
          "this customization isn't linked to a workspace — recreate it before using auto-fix",
        );
      }
      // Stash the prompt in sessionStorage; chat page picks it up via
      // ?prefill=1. URL-encoding the full prompt would balloon the URL
      // for long templates.
      try {
        sessionStorage.setItem("claudius.autofix-draft", data.prompt);
      } catch {
        // sessionStorage might be unavailable (privacy mode) — fall back
        // to URL param even if it's noisy.
        window.location.assign(`/?new=1&prefill=${encodeURIComponent(data.prompt)}`);
        return;
      }
      window.location.assign("/?new=1&prefill=1");
    } catch (err) {
      setAutoFixError(err instanceof Error ? err.message : String(err));
    } finally {
      setAutoFixBusy(false);
    }
  }, [customizationId]);

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

  // True totals — always reflect the full picture (used by the action
  // button and the tiles, so the user sees the real scope of what a
  // sync would do).
  const safeCount =
    status.totals["upstream-only"] + status.totals["new-upstream"] + status.totals["deleted-upstream"];
  const conflictCount = status.totals.conflict;
  const userCount =
    status.totals["user-only"] + status.totals["new-user"] + status.totals["deleted-user"];

  // The breakdown defaults to ONLY this customization's footprint:
  // files the user edited (U / +u / -u) plus any conflicts. Upstream-
  // only churn in files this customization never touched is hidden.
  // System files (lockfiles, build artifacts, runtime state) are also
  // hidden. Toggle reveals everything.
  const candidateEntries = status.entries.filter((e) => e.verdict !== "in-sync");
  const visibleEntries = showNoise
    ? candidateEntries
    : candidateEntries.filter(
        (e) => isCustomizationRelevant(e.verdict) && !isNoise(e.path),
      );
  const hiddenCount = candidateEntries.length - visibleEntries.length;

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

      {conflictCount > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-red-300" />
          <span className="text-xs text-red-200">
            {conflictCount} file{conflictCount === 1 ? "" : "s"} need{conflictCount === 1 ? "s" : ""} a manual merge.
          </span>
          <button
            onClick={() => void onAutoFix()}
            disabled={autoFixBusy}
            className="ml-auto flex items-center gap-1.5 rounded-md bg-[var(--accent)] px-2.5 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {autoFixBusy ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Sparkles className="h-3 w-3" />
            )}
            Auto-fix conflicts
          </button>
          <Link
            href="/customize/settings"
            className="flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1 text-[11px] text-[var(--muted)] hover:bg-[var(--panel)] hover:text-[var(--foreground)]"
            title="Configure the auto-fix prompt"
          >
            <SettingsIcon className="h-3 w-3" /> Configure prompt
          </Link>
        </div>
      )}
      {autoFixError && (
        <div className="mt-2 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {autoFixError}
        </div>
      )}

      {candidateEntries.length > 0 && (
        <details className="mt-3" open>
          <summary className="cursor-pointer text-xs text-[var(--muted)]">
            Files in this customization
            {hiddenCount > 0 && !showNoise && (
              <span className="ml-2 text-[10px] text-[var(--muted)]/70">
                ({hiddenCount} unrelated upstream change{hiddenCount === 1 ? "" : "s"} hidden)
              </span>
            )}
          </summary>
          <div className="mt-2 max-h-72 overflow-auto rounded-md border border-[var(--border)] bg-black/30 p-2 font-mono text-[11px]">
            {visibleEntries.length > 0 ? (
              visibleEntries.map((e) => (
                <div key={e.path} className="flex items-center gap-2">
                  {iconFor(e.verdict)}
                  <span className={tagClass(e.verdict)}>{labelFor(e.verdict)}</span>
                  <span className="truncate">{e.path}</span>
                </div>
              ))
            ) : (
              <div className="px-2 py-3 text-center text-[var(--muted)]">
                {hiddenCount > 0
                  ? `This customization has no edits yet — ${hiddenCount} upstream change${hiddenCount === 1 ? "" : "s"} hidden.`
                  : "All files in sync."}
              </div>
            )}
          </div>
          {hiddenCount > 0 && (
            <label className="mt-2 flex items-center gap-2 text-[11px] text-[var(--muted)] cursor-pointer select-none">
              <input
                type="checkbox"
                checked={showNoise}
                onChange={(e) => setShowNoise(e.target.checked)}
                className="h-3 w-3 cursor-pointer"
              />
              Show all changes (unrelated upstream edits + system files)
            </label>
          )}
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
