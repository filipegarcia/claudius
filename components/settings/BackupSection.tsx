"use client";

import { useRef, useState } from "react";
import { Download, Info, Upload } from "lucide-react";

import { ImportHealDialog } from "@/components/settings/ImportHealDialog";
import { cn } from "@/lib/utils/cn";
import type { ImportDecision, ImportProgress } from "@/lib/shared/settings-bundle";

const PASTE_HINT =
  "Paste the contents of a previously-exported claudius-backup-*.json here.";

/**
 * Export / import the entire Claudius configuration as a single JSON bundle.
 *
 * - Export navigates to `/api/settings/export`, which the browser saves as
 *   `claudius-backup-YYYY-MM-DD.json` thanks to the `Content-Disposition`
 *   header on the route.
 * - Import accepts either a file picker upload or pasted JSON, POSTs to
 *   `/api/settings/import`, and surfaces the `ImportHealDialog` to walk the
 *   user through any pauses (missing workspace paths, collisions).
 *
 * Lives alongside the other always-visible sections on `/settings` (theme,
 * shortcuts, rate-limit) — sits below the scope-tabbed Claude Code settings
 * because backups span all scopes plus the install-wide stores.
 */
export function BackupSection() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [paste, setPaste] = useState<{ open: boolean; text: string }>({ open: false, text: "" });
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ── Export ─────────────────────────────────────────────────────────────

  function handleExport() {
    // A plain navigation keeps the response streamable and the
    // Content-Disposition filename intact — `fetch` + blob + a-click also
    // works but loses the filename unless we duplicate it client-side.
    window.location.assign("/api/settings/export");
  }

  // ── Import ─────────────────────────────────────────────────────────────

  async function postBundle(init: RequestInit & { body: BodyInit }) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/import", init);
      const json = (await res.json()) as ImportProgress | { error?: string };
      if (!res.ok) {
        setError((json as { error?: string }).error ?? `HTTP ${res.status}`);
        return;
      }
      setProgress(json as ImportProgress);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleFile(file: File) {
    const form = new FormData();
    form.append("file", file);
    await postBundle({ method: "POST", body: form });
  }

  async function handlePaste() {
    const text = paste.text.trim();
    if (!text) return;
    await postBundle({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: text,
    });
    setPaste({ open: false, text: "" });
  }

  async function handleResolve(input: { wsIndex: number; decision: ImportDecision }) {
    if (!progress || progress.state !== "paused") return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/settings/import/${progress.importId}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const json = (await res.json()) as ImportProgress | { error?: string };
      if (!res.ok) {
        setError((json as { error?: string }).error ?? `HTTP ${res.status}`);
        return;
      }
      setProgress(json as ImportProgress);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleCancelImport() {
    if (!progress) return;
    await fetch(`/api/settings/import/${progress.importId}`, { method: "DELETE" }).catch(() => {});
    setProgress(null);
  }

  function closeDialog() {
    setProgress(null);
  }

  return (
    <section
      data-testid="backup-section"
      className="rounded-lg border border-[var(--border)] bg-[var(--panel)]/40 p-4"
    >
      <h2 className="text-sm font-medium">Backup &amp; restore</h2>
      <p className="mt-0.5 text-[11px] text-[var(--muted)]">
        Export every Claudius setting — install-wide stores under{" "}
        <code className="rounded bg-[var(--panel-2)] px-1">~/.claude</code> plus each
        workspace&rsquo;s <code className="rounded bg-[var(--panel-2)] px-1">.claude/</code> dir —
        as a single JSON file. Import on another machine to restore.
      </p>

      <div className="mt-4 flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-200/90">
        <Info className="h-3.5 w-3.5 shrink-0" />
        <span>
          <code className="rounded bg-[var(--panel-2)] px-1">settings.local.json</code> often
          contains machine-specific absolute paths. Review per-workspace after import.
        </span>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
        <div className="rounded-md border border-[var(--border)] bg-[var(--panel-2)]/40 p-3">
          <div className="flex items-center gap-2">
            <Download className="h-3.5 w-3.5 text-[var(--accent)]" />
            <h3 className="text-xs font-medium">Export</h3>
          </div>
          <p className="mt-1 text-[11px] text-[var(--muted)]">
            Downloads <code className="rounded bg-[var(--panel)] px-1">claudius-backup-YYYY-MM-DD.json</code>.
          </p>
          <button
            type="button"
            onClick={handleExport}
            data-testid="backup-export"
            className="mt-3 rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs text-white hover:opacity-90"
          >
            Download bundle
          </button>
        </div>

        <div className="rounded-md border border-[var(--border)] bg-[var(--panel-2)]/40 p-3">
          <div className="flex items-center gap-2">
            <Upload className="h-3.5 w-3.5 text-[var(--accent)]" />
            <h3 className="text-xs font-medium">Import</h3>
          </div>
          <p className="mt-1 text-[11px] text-[var(--muted)]">
            Picks up where the export left off. Missing workspace paths and collisions pause for
            your input.
          </p>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            data-testid="backup-import-file"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleFile(f);
              // Reset so picking the same file twice still triggers `onChange`.
              e.target.value = "";
            }}
            className="sr-only"
          />
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={busy}
              data-testid="backup-import-pick"
              className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs text-white hover:opacity-90 disabled:opacity-40"
            >
              Choose file…
            </button>
            <button
              type="button"
              onClick={() => setPaste((s) => ({ ...s, open: !s.open }))}
              disabled={busy}
              data-testid="backup-import-paste-toggle"
              className={cn(
                "rounded-md border border-[var(--border)] px-3 py-1.5 text-xs hover:bg-[var(--panel)] disabled:opacity-40",
                paste.open ? "bg-[var(--panel)]" : "bg-[var(--panel-2)]",
              )}
            >
              {paste.open ? "Hide paste" : "Paste JSON instead"}
            </button>
          </div>
          {paste.open && (
            <div className="mt-3 space-y-2">
              <textarea
                value={paste.text}
                onChange={(e) => setPaste((s) => ({ ...s, text: e.target.value }))}
                rows={6}
                spellCheck={false}
                placeholder={PASTE_HINT}
                data-testid="backup-import-paste-textarea"
                className="block w-full resize-none rounded-md border border-[var(--border)] bg-[var(--panel)] p-2 font-mono text-[11px] focus:outline-none scroll-thin"
              />
              <button
                type="button"
                onClick={() => void handlePaste()}
                disabled={busy || !paste.text.trim()}
                data-testid="backup-import-paste-submit"
                className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs text-white hover:opacity-90 disabled:opacity-40"
              >
                Import pasted JSON
              </button>
            </div>
          )}
        </div>
      </div>

      {error && (
        <div className="mt-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] text-red-300">
          {error}
        </div>
      )}

      {progress && (
        <ImportHealDialog
          progress={progress}
          busy={busy}
          onResolve={handleResolve}
          onCancel={handleCancelImport}
          onClose={closeDialog}
        />
      )}
    </section>
  );
}
