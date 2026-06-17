"use client";

import { useState } from "react";
import Link from "next/link";
import {
  ArrowDownToLine,
  CheckCircle2,
  ExternalLink,
  Loader2,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import { useUpdater, type UpdaterMode } from "@/lib/client/use-updater";
import { useElectronUpdater, type ElectronUpdaterState } from "@/lib/client/useElectronUpdater";
import { ResolveWithClaudeModal } from "@/components/updater/ResolveWithClaudeModal";
import { cn } from "@/lib/utils/cn";

const MODE_OPTIONS: ReadonlyArray<{
  id: UpdaterMode;
  label: string;
  blurb: string;
}> = [
  {
    id: "cc-merge",
    label: "Auto + Claude merge (default)",
    blurb:
      "Auto-pull on every check. When the working tree is dirty (e.g. you have published customizations) or the branch has diverged, spawn a Claude Code session to resolve the merge before rebuilding. Costs API credits when conflicts trigger.",
  },
  {
    id: "ff-only",
    label: "Auto, fast-forward only",
    blurb:
      "Auto-pull only when the update is a clean fast-forward. Dirty trees and divergent branches surface a banner with an Apply button — nothing happens without your click.",
  },
  {
    id: "notify-only",
    label: "Notify only",
    blurb:
      "Background check still runs daily and on boot, but never auto-applies. Banner shows; you click Update.",
  },
  {
    id: "disabled",
    label: "Disabled",
    blurb: "No background checks at all.",
  },
];

/**
 * Updater section embedded inside the main /settings page. Install-wide, so
 * it ignores the User/Project/Local scope tabs above it. The deeper status +
 * manual-trigger surface lives at /updater.
 */
export function UpdaterSettingsSection() {
  // Inside the packaged desktop app there's no git checkout to pull from —
  // updates ship as signed builds via electron-updater (download in the
  // background, install + relaunch on restart). Show that flow instead of the
  // git modes + the misleading "not a git checkout" warning. Hooks are called
  // unconditionally above the branch to satisfy rules-of-hooks.
  const electron = useElectronUpdater();
  const u = useUpdater(15_000);
  const data = u.data;
  const [resolveOpen, setResolveOpen] = useState(false);

  if (electron) return <ElectronUpdaterSettings state={electron} />;

  return (
    <section className="rounded-lg border border-[var(--border)] bg-[var(--panel)]/40 p-4">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium">Self-update</h2>
          <p className="mt-0.5 text-[11px] text-[var(--muted)]">
            Install-wide — applies to this Claudius checkout regardless of scope. Background
            check runs on boot and once a day.
          </p>
        </div>
        <Link
          href="/updater"
          className="flex shrink-0 items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1 text-[11px] hover:bg-[var(--panel)]"
        >
          Open updater <ExternalLink className="h-3 w-3" />
        </Link>
      </div>

      <div className="mt-3 space-y-3">
        {!data && u.loading && (
          <div className="text-[11px] text-[var(--muted)]">loading…</div>
        )}
        {data && !data.install.isGitCheckout && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] text-amber-200">
            This install isn&apos;t a git checkout, so the updater can&apos;t check for new
            commits. Re-install via the setup script to enable updates.
          </div>
        )}
        {data && (
          <>
            <div className="space-y-2">
              {MODE_OPTIONS.map((opt) => (
                <label
                  key={opt.id}
                  className={cn(
                    "flex cursor-pointer items-start gap-3 rounded-md border p-3",
                    data.settings.mode === opt.id
                      ? "border-[var(--accent)] bg-[var(--panel-2)]"
                      : "border-[var(--border)] bg-[var(--panel)]/40 hover:bg-[var(--panel-2)]/60",
                  )}
                >
                  <input
                    type="radio"
                    name="updater-mode-settings"
                    checked={data.settings.mode === opt.id}
                    onChange={() => void u.setMode(opt.id)}
                    disabled={u.busy}
                    className="mt-0.5"
                  />
                  <div className="flex-1">
                    <div className="text-xs font-medium">{opt.label}</div>
                    <div className="mt-0.5 text-[11px] text-[var(--muted)]">{opt.blurb}</div>
                  </div>
                </label>
              ))}
            </div>

            {(data.state.recovery || data.state.conflicts) && (
              <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-[11px]">
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                <div className="flex-1">
                  <div className="font-medium text-amber-100">
                    {data.state.conflicts
                      ? "Update left merge conflicts"
                      : data.state.recovery!.phase === "install"
                        ? "Update pulled, but installing dependencies failed"
                        : "Update pulled, but the build failed"}
                  </div>
                  <p className="mt-0.5 text-amber-200/80">
                    The new commits are checked out — the update just didn&apos;t finish. Hand the
                    error to a Claude Code session to fix it in place, then restart from this page.
                    Nothing was rolled back.
                  </p>
                </div>
                <button
                  onClick={() => setResolveOpen(true)}
                  data-testid="updater-settings-resolve"
                  className="flex shrink-0 items-center gap-1 self-center rounded-md border border-amber-500/40 bg-amber-500/15 px-2 py-1 text-amber-100 hover:bg-amber-500/25"
                >
                  <Sparkles className="h-3 w-3" />
                  Resolve with Claude
                </button>
              </div>
            )}

            {resolveOpen && (
              <ResolveWithClaudeModal
                onClose={() => setResolveOpen(false)}
                onDone={() => void u.refresh()}
              />
            )}

            <div className="flex flex-wrap items-center gap-3 text-[11px] text-[var(--muted)]">
              <span>
                Tracking{" "}
                <code className="font-mono text-[var(--foreground)]">
                  {data.settings.remote}/{data.settings.branch}
                </code>{" "}
                · every {data.settings.intervalHours}h
              </span>
              {data.install.currentSha && (
                <span>
                  · at{" "}
                  <code className="font-mono text-[var(--foreground)]">
                    {data.install.currentSha.slice(0, 7)}
                  </code>
                </span>
              )}
              {data.state.pending && data.state.pending.behind > 0 && (
                <span className="text-emerald-300">
                  · {data.state.pending.behind} behind
                </span>
              )}
              {data.state.lastError && (
                <span className="text-red-300">· {data.state.lastError}</span>
              )}
              <button
                onClick={() => void u.check()}
                disabled={u.busy}
                className="ml-auto flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-0.5 text-[var(--foreground)] hover:bg-[var(--panel)] disabled:opacity-50"
              >
                {u.busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                Check now
              </button>
              {u.applyError && (
                <span className="max-w-[24rem] truncate text-[11px] text-red-300" title={u.applyError}>
                  {u.applyError}
                </span>
              )}
              {data.state.pending && data.state.pending.behind > 0 && (
                <button
                  onClick={() =>
                    void u.apply({
                      allowCcMerge:
                        data.state.pending!.dirty || data.state.pending!.ahead > 0,
                    })
                  }
                  disabled={u.busy}
                  className="flex items-center gap-1 rounded-md bg-emerald-500/80 px-2 py-0.5 text-white hover:bg-emerald-500 disabled:opacity-50"
                >
                  {u.busy ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <ArrowDownToLine className="h-3 w-3" />
                  )}
                  Apply
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}

/**
 * Self-update card for the packaged desktop app. Mirrors the ElectronUpdaterBanner
 * states (electron-updater: check → download in background → install + relaunch on
 * restart) but in the settings-card layout, with an always-available "Check now".
 */
function ElectronUpdaterSettings({ state }: { state: ElectronUpdaterState }) {
  const { status, check, apply, openAppManagementSettings } = state;
  return (
    <section className="rounded-lg border border-[var(--border)] bg-[var(--panel)]/40 p-4">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium">Self-update</h2>
          <p className="mt-0.5 text-[11px] text-[var(--muted)]">
            Desktop app — new versions download in the background and install when you restart.
          </p>
        </div>
        <Link
          href="/updater"
          className="flex shrink-0 items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1 text-[11px] hover:bg-[var(--panel)]"
        >
          Open updater <ExternalLink className="h-3 w-3" />
        </Link>
      </div>

      <div className="mt-3 flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--panel)]/40 p-3">
        <ElectronStatusIcon kind={status.kind} />
        <div className="min-w-0 flex-1 text-xs">
          <ElectronStatusText status={status} />
        </div>

        {status.kind === "downloaded" && (
          <button
            onClick={apply}
            data-testid="electron-update-install"
            className="flex shrink-0 items-center gap-1 rounded-md border border-emerald-500/40 bg-emerald-500/15 px-2 py-1 text-emerald-100 hover:bg-emerald-500/25"
          >
            <RefreshCw className="h-3 w-3" />
            Restart &amp; install
          </button>
        )}
        {status.kind === "manual-download" && (
          <button
            onClick={apply}
            data-testid="electron-update-download"
            className="flex shrink-0 items-center gap-1 rounded-md border border-emerald-500/40 bg-emerald-500/15 px-2 py-1 text-emerald-100 hover:bg-emerald-500/25"
          >
            <ArrowDownToLine className="h-3 w-3" />
            Download
          </button>
        )}
        {status.kind === "blocked-app-management" && (
          <button
            onClick={openAppManagementSettings}
            className="flex shrink-0 items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/15 px-2 py-1 text-amber-100 hover:bg-amber-500/25"
          >
            <ShieldAlert className="h-3 w-3" />
            Privacy &amp; Security
          </button>
        )}
        {status.kind !== "downloading" && (
          <button
            onClick={check}
            data-testid="electron-update-check"
            className="flex shrink-0 items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1 hover:bg-[var(--panel)]"
          >
            <RefreshCw className="h-3 w-3" />
            Check now
          </button>
        )}
      </div>
    </section>
  );
}

function ElectronStatusIcon({ kind }: { kind: ElectronUpdaterState["status"]["kind"] }) {
  if (kind === "checking" || kind === "downloading")
    return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[var(--accent)]" />;
  if (kind === "available" || kind === "downloaded" || kind === "manual-download")
    return <Sparkles className="h-4 w-4 shrink-0 text-emerald-400" />;
  if (kind === "blocked-app-management")
    return <ShieldAlert className="h-4 w-4 shrink-0 text-amber-400" />;
  if (kind === "error") return <TriangleAlert className="h-4 w-4 shrink-0 text-red-400" />;
  return <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />;
}

function ElectronStatusText({ status }: { status: ElectronUpdaterState["status"] }) {
  switch (status.kind) {
    case "checking":
      return <span className="text-[var(--muted)]">Checking for updates…</span>;
    case "available":
      return (
        <span>
          <span className="font-medium">Claudius {status.version}</span> available — downloading…
        </span>
      );
    case "downloading":
      return <span className="font-medium">Downloading update… {status.percent}%</span>;
    case "downloaded":
      return (
        <span>
          <span className="font-medium text-emerald-300">Update ready: Claudius {status.version}</span>
          <span className="text-[var(--muted)]"> — restart to install.</span>
        </span>
      );
    case "manual-download":
      return (
        <span>
          <span className="font-medium">Claudius {status.version}</span> available — download and drag
          into Applications to update.
        </span>
      );
    case "blocked-app-management":
      return (
        <span>
          <span className="font-medium text-amber-200">macOS blocked the update.</span>{" "}
          <span className="text-[var(--muted)]">
            Allow Claudius in Privacy &amp; Security → App Management.
          </span>
        </span>
      );
    case "error":
      return (
        <span className="text-red-300" title={status.message}>
          Updater error: {status.message}
        </span>
      );
    default:
      return <span className="text-[var(--muted)]">You&apos;re on the latest version.</span>;
  }
}
