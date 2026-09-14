"use client";

import { AlertTriangle, CheckCircle2, Download, Loader2, Package, RefreshCw } from "lucide-react";
import { Overlay } from "@/components/overlays/Overlay";
import type { ClaudiusUpdaterStatus } from "@/lib/shared/electron";

/**
 * The desktop update flow as an explicit, stepped dialog.
 *
 * Replaces the old "click once and the app decides everything" behaviour:
 * nothing is downloaded until the user presses Download here, and once the new
 * bundle is staged the restart is theirs to schedule ("Later" just closes this
 * — the banner keeps the staged build one click away).
 *
 * The three steps mirror the main-process status stream exactly:
 *   available → downloading(%) → installing → downloaded
 * `installing` is its own step because unpacking the ~370 MB bundle runs long
 * enough that a progress bar parked at 100% reads as a hang.
 */

type StepState = "pending" | "active" | "done";

function stepStates(kind: ClaudiusUpdaterStatus["kind"]): [StepState, StepState, StepState] {
  switch (kind) {
    case "downloading":
      return ["active", "pending", "pending"];
    case "installing":
      return ["done", "active", "pending"];
    case "downloaded":
      return ["done", "done", "done"];
    default:
      // `available` (and anything we render defensively) — nothing started yet.
      return ["pending", "pending", "pending"];
  }
}

function Step({
  state,
  icon: Icon,
  label,
  detail,
}: {
  state: StepState;
  icon: typeof Download;
  label: string;
  detail?: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <div
        className={[
          "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border",
          state === "done"
            ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-400"
            : state === "active"
              ? "border-[var(--accent)]/50 bg-[var(--accent)]/15 text-[var(--accent)]"
              : "border-[var(--border)] bg-[var(--panel-2)] text-[var(--muted)]",
        ].join(" ")}
      >
        {state === "done" ? (
          <CheckCircle2 className="h-4 w-4" />
        ) : state === "active" ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Icon className="h-4 w-4" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div
          className={
            state === "pending" ? "text-sm text-[var(--muted)]" : "text-sm font-medium"
          }
        >
          {label}
        </div>
        {detail && <div className="text-xs text-[var(--muted)]">{detail}</div>}
      </div>
    </div>
  );
}

export function UpdateModal({
  status,
  version,
  onDownload,
  onApply,
  onClose,
}: {
  status: ClaudiusUpdaterStatus;
  /** Version to show even in states whose payload omits it (e.g. `downloading`). */
  version: string | null;
  onDownload: () => void;
  onApply: () => void;
  onClose: () => void;
}) {
  const [dl, inst, ready] = stepStates(status.kind);
  const isError = status.kind === "error" || status.kind === "blocked-app-management";
  const percent = status.kind === "downloading" ? status.percent : null;
  const busy = status.kind === "downloading" || status.kind === "installing";

  return (
    <Overlay
      title={version ? `Claudius ${version}` : "Update Claudius"}
      subtitle="Update"
      width={520}
      // A backdrop click mid-download would look like it cancelled the update
      // (it doesn't — the main process keeps going), so make dismissal explicit
      // while work is in flight.
      dismissOnBackdrop={!busy}
      onClose={onClose}
    >
      <div className="flex flex-col gap-4 p-4" data-testid="updater-update-modal">
        <div className="flex flex-col gap-3">
          <Step
            state={dl}
            icon={Download}
            label="Download"
            detail={
              percent !== null
                ? `${percent}%`
                : dl === "done"
                  ? "Complete"
                  : "Fetch the new version from GitHub Releases"
            }
          />
          {percent !== null && (
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--panel-2)]"
              role="progressbar"
              aria-valuenow={percent}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Download progress"
            >
              <div
                className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-300"
                style={{ width: `${percent}%` }}
              />
            </div>
          )}
          <Step
            state={inst}
            icon={Package}
            label="Install"
            detail={
              inst === "active"
                ? "Unpacking and staging the new app…"
                : inst === "done"
                  ? "Staged and ready"
                  : "Unpack and stage the new app bundle"
            }
          />
          <Step
            state={ready}
            icon={RefreshCw}
            label="Restart"
            detail={
              ready === "done"
                ? "Restart whenever you're ready — your work is left as is"
                : "Finish the update on your schedule"
            }
          />
        </div>

        {isError && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
            <span className="min-w-0 break-words">{status.message}</span>
          </div>
        )}

        <div className="flex items-center justify-end gap-2 border-t border-[var(--border)] pt-3">
          {status.kind === "downloaded" ? (
            <>
              <button
                onClick={onClose}
                className="rounded border border-[var(--border)] px-3 py-1.5 text-xs hover:bg-[var(--panel-2)]"
              >
                Later
              </button>
              <button
                onClick={onApply}
                data-testid="updater-restart-now"
                className="flex items-center gap-1.5 rounded border border-emerald-500/40 bg-emerald-500/15 px-3 py-1.5 text-xs font-medium hover:bg-emerald-500/25"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Restart now
              </button>
            </>
          ) : busy ? (
            <button
              onClick={onClose}
              className="rounded border border-[var(--border)] px-3 py-1.5 text-xs hover:bg-[var(--panel-2)]"
            >
              Continue in background
            </button>
          ) : (
            <>
              <button
                onClick={onClose}
                className="rounded border border-[var(--border)] px-3 py-1.5 text-xs hover:bg-[var(--panel-2)]"
              >
                Not now
              </button>
              <button
                onClick={onDownload}
                data-testid="updater-start-download"
                className="flex items-center gap-1.5 rounded border border-[var(--accent)]/40 bg-[var(--accent)]/15 px-3 py-1.5 text-xs font-medium hover:bg-[var(--accent)]/25"
              >
                <Download className="h-3.5 w-3.5" />
                Download update
              </button>
            </>
          )}
        </div>
      </div>
    </Overlay>
  );
}
