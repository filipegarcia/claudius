"use client";

import { useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  ExternalLink,
  Loader2,
  Package,
  RefreshCw,
} from "lucide-react";
import { Overlay } from "@/components/overlays/Overlay";
import { ChangelogGroups } from "@/components/updater/ChangelogGroups";
import type { ClaudiusUpdaterStatus } from "@/lib/shared/electron";
import type { ReleaseChangelog } from "@/lib/shared/release-changelog";
import { CLAUDIUS_VERSION } from "@/lib/shared/version";

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
 *
 * Above the steps sits a "What's new" list built from the commits between the
 * running build and the offered one (GitHub Releases carry no notes — see
 * lib/shared/release-changelog.ts).
 *
 * Pressing Download hands the flow back to the banner strip: the banner closes
 * this window, the download runs in the background, and the strip fills with
 * progress and offers "Restart now" once the bundle is staged. Reopening the
 * window mid-download ("View progress") shows the steps.
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

type ChangelogState =
  | { kind: "loading" }
  | { kind: "ready"; changelog: ReleaseChangelog }
  | { kind: "unavailable" };

// Survives the modal unmounting (minimize / close → reopen) so the list
// doesn't flash back to a spinner. Keyed by target version.
const changelogCache = new Map<string, ChangelogState>();

function useReleaseChangelog(version: string | null): ChangelogState | null {
  const [, force] = useState(0);
  const target = version && version !== CLAUDIUS_VERSION ? version : null;
  useEffect(() => {
    if (!target) return;
    // A previous failure is retried on the next mount (reopen / restore).
    const cached = changelogCache.get(target);
    if (cached && cached.kind !== "unavailable") return;
    changelogCache.set(target, { kind: "loading" });
    const qs = new URLSearchParams({ from: CLAUDIUS_VERSION, to: target });
    fetch(`/api/updater/changelog?${qs}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        return (await res.json()) as ReleaseChangelog;
      })
      .then((changelog) => changelogCache.set(target, { kind: "ready", changelog }))
      .catch(() => changelogCache.set(target, { kind: "unavailable" }))
      .finally(() => force((n) => n + 1));
  }, [target]);
  if (!target) return null;
  return changelogCache.get(target) ?? { kind: "loading" };
}

function Changelog({ state }: { state: ChangelogState }) {
  if (state.kind === "loading") {
    return (
      <div className="flex items-center gap-2 text-xs text-[var(--muted)]">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading changes…
      </div>
    );
  }
  if (state.kind === "unavailable") {
    return (
      <div className="text-xs text-[var(--muted)]">
        Couldn&apos;t load the changelog.{" "}
        <a
          href="https://github.com/filipegarcia/claudius/releases"
          target="_blank"
          rel="noreferrer"
          className="text-[var(--accent)] hover:underline"
        >
          See releases on GitHub
        </a>
      </div>
    );
  }
  const { changelog } = state;
  const shown = changelog.groups.reduce((n, g) => n + g.entries.length, 0);
  const hidden = changelog.total - shown;
  return (
    <div className="flex flex-col gap-2">
      {shown === 0 ? (
        <div className="text-xs text-[var(--muted)]">
          Internal changes only — no user-facing changes listed.
        </div>
      ) : (
        <div
          className="scroll-thin flex max-h-72 flex-col gap-3 overflow-y-auto pr-1"
          data-testid="updater-changelog"
        >
          <ChangelogGroups groups={changelog.groups} />
        </div>
      )}
      <div className="flex items-center gap-2 text-[11px] text-[var(--muted)]">
        {hidden > 0 && (
          <span>
            +{hidden} internal {hidden === 1 ? "change" : "changes"}
          </span>
        )}
        <a
          href={changelog.compareUrl}
          target="_blank"
          rel="noreferrer"
          className="ml-auto inline-flex items-center gap-1 text-[var(--accent)] hover:underline"
        >
          Full diff on GitHub <ExternalLink className="h-3 w-3" />
        </a>
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
  const changelog = useReleaseChangelog(version);
  const isError = status.kind === "error" || status.kind === "blocked-app-management";
  const percent = status.kind === "downloading" ? status.percent : null;
  const busy = status.kind === "downloading" || status.kind === "installing";

  return (
    <Overlay
      title={version ? `Claudius ${version}` : "Update Claudius"}
      subtitle="Update"
      width={560}
      // A floating, movable window rather than a blocking modal: no dimmed /
      // blurred backdrop, the app underneath stays usable, and the header
      // drags it out of the way while the download runs.
      backdrop={false}
      draggable
      // Escape mid-download would look like it cancelled the update (it
      // doesn't — the main process keeps going), so make dismissal explicit
      // while work is in flight.
      dismissOnBackdrop={!busy}
      onClose={onClose}
    >
      <div className="flex flex-col gap-4 p-4" data-testid="updater-update-modal">
        {changelog && (
          <div className="flex flex-col gap-2 border-b border-[var(--border)] pb-4">
            <div className="text-sm font-medium">
              What&apos;s new
              <span className="ml-2 text-xs font-normal text-[var(--muted)]">
                since v{CLAUDIUS_VERSION}
              </span>
            </div>
            <Changelog state={changelog} />
          </div>
        )}
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
                Download in background
              </button>
            </>
          )}
        </div>
      </div>
    </Overlay>
  );
}
