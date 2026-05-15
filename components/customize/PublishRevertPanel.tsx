"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Rocket, Undo2, RefreshCw } from "lucide-react";
import type { PublishRecord } from "@/lib/server/customizations-store";

type DiffSummary = {
  changedFiles: number;
  addedFiles: number;
  identicalFiles: number;
  files: { path: string; kind: "added" | "changed"; customHash: string; baseHash: string | null }[];
};

export function PublishRevertPanel({
  customizationId,
  onChange,
}: {
  customizationId: string;
  onChange?: () => void;
}) {
  const [publishes, setPublishes] = useState<PublishRecord[]>([]);
  const [diff, setDiff] = useState<DiffSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [refetchTrigger, setRefetchTrigger] = useState(0);

  // Pattern A: the fetch + setState chain lives inside this effect's
  // Promise callbacks, so react-hooks/set-state-in-effect is satisfied.
  // `refresh()` below just bumps the trigger; consumers don't await it
  // — they used to, but the next render's effect now does the work.
  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      fetch(`/api/customizations/${customizationId}/diff`, { signal: controller.signal }),
      fetch(`/api/customizations/${customizationId}/publishes`, { signal: controller.signal }),
    ])
      .then(async ([diffRes, listRes]) => {
        if (diffRes.ok) setDiff((await diffRes.json()) as DiffSummary);
        if (listRes.ok) {
          const d = (await listRes.json()) as { publishes: PublishRecord[] };
          setPublishes(d.publishes);
        }
        setError(null);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [customizationId, refetchTrigger]);

  const refresh = useCallback(() => {
    setLoading(true);
    setRefetchTrigger((n) => n + 1);
  }, []);

  const onPublish = useCallback(async () => {
    if (!confirm("Publish these changes? Base files will be overwritten — snapshots are kept for revert.")) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/customizations/${customizationId}/publish`, { method: "POST" });
      if (!res.ok) {
        const e = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(e.error ?? `HTTP ${res.status}`);
      }
      await refresh();
      onChange?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [customizationId, refresh, onChange]);

  const onRevert = useCallback(
    async (pubId: string) => {
      if (!confirm("Revert this publish? Base files will be restored from the snapshot.")) return;
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`/api/customizations/${customizationId}/publishes/${pubId}/revert`, { method: "POST" });
        if (!res.ok) {
          const e = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(e.error ?? `HTTP ${res.status}`);
        }
        await refresh();
        onChange?.();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [customizationId, refresh, onChange],
  );

  return (
    <div>
      {error && (
        <div className="mb-3 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {error}
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          onClick={() => void onPublish()}
          disabled={busy || !diff || diff.changedFiles + diff.addedFiles === 0}
          className="flex items-center gap-2 rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />}
          Publish
        </button>
        <button
          onClick={() => void refresh()}
          className="flex items-center gap-1 rounded-md border border-[var(--border)] px-2 py-1.5 text-xs hover:bg-[var(--panel-2)]"
        >
          <RefreshCw className="h-3 w-3" /> Recompute diff
        </button>
        {diff && (
          <span className="text-xs text-[var(--muted)]">
            {diff.changedFiles} changed · {diff.addedFiles} new · {diff.identicalFiles} unchanged
          </span>
        )}
      </div>

      {diff && (diff.changedFiles + diff.addedFiles > 0) && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-[var(--muted)]">
            What will change ({diff.changedFiles + diff.addedFiles} files)
          </summary>
          <ul className="mt-2 max-h-48 overflow-auto rounded-md border border-[var(--border)] bg-black/30 p-2 font-mono text-[11px]">
            {diff.files.map((f) => (
              <li key={f.path} className="flex items-center gap-2">
                <span className={f.kind === "added" ? "text-emerald-400" : "text-amber-300"}>
                  {f.kind === "added" ? "+" : "M"}
                </span>
                <span className="truncate">{f.path}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <h3 className="mt-5 mb-2 text-xs font-medium text-[var(--muted)]">Publish history</h3>
      {loading ? (
        <div className="text-xs text-[var(--muted)]">Loading…</div>
      ) : publishes.length === 0 ? (
        <div className="rounded-md border border-dashed border-[var(--border)] px-3 py-4 text-center text-xs text-[var(--muted)]">
          No publishes yet.
        </div>
      ) : (
        <ul className="space-y-2">
          {publishes
            .slice()
            .sort((a, b) => b.publishedAt - a.publishedAt)
            .map((p) => {
              const reverted = p.revertedAt != null;
              return (
                <li
                  key={p.id}
                  className="flex items-center justify-between rounded-md border border-[var(--border)] px-3 py-2 text-xs"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono">{p.id}</span>
                      <span
                        className={
                          reverted
                            ? "rounded-full bg-[var(--panel-2)] px-2 py-0.5 text-[10px] text-[var(--muted)]"
                            : "rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-300"
                        }
                      >
                        {reverted ? `reverted${p.revertReason ? ` (${p.revertReason})` : ""}` : "active"}
                      </span>
                    </div>
                    <div className="mt-0.5 text-[var(--muted)]">
                      Published {new Date(p.publishedAt).toLocaleString()} · {p.files.length} files
                    </div>
                  </div>
                  {!reverted && (
                    <button
                      onClick={() => void onRevert(p.id)}
                      disabled={busy}
                      className="flex items-center gap-1 rounded-md border border-[var(--border)] px-2 py-1 hover:bg-[var(--panel-2)] disabled:opacity-50"
                    >
                      <Undo2 className="h-3 w-3" /> Revert
                    </button>
                  )}
                </li>
              );
            })}
        </ul>
      )}
    </div>
  );
}
