"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowDownToLine, Loader2, RefreshCw, ShieldAlert, Sparkles, TriangleAlert, X } from "lucide-react";
import { useUpdater } from "@/lib/client/use-updater";
import { useElectronUpdater } from "@/lib/client/useElectronUpdater";

/**
 * Slim banner shown only when:
 *   - the updater detected a pending update, OR
 *   - the updater is mid-apply / mid-restart (so the user knows what's happening), OR
 *   - the last apply or check produced an error worth surfacing.
 *
 * Stays out of the way otherwise. Not rendered while the install isn't a
 * git checkout (no upstream to compare against).
 *
 * Priority order matters: a failed apply *and* a pending diff usually
 * coexist (rollback restored HEAD, so pending is still real). We want the
 * user to see the failure first — otherwise they click "Update now" again
 * and the second attempt fails the same way without any visible feedback.
 *
 *   applying / restarting → error → pending
 */
export function UpdaterBanner() {
  // Phase 7 of docs/electron-conversion/PLAN.md — inside the packaged
  // Electron build there's no git checkout to pull from. We instead
  // surface the electron-updater state and short-circuit the legacy
  // git-pull banner entirely.
  const electronUpdater = useElectronUpdater();
  if (electronUpdater) {
    return <ElectronUpdaterBanner state={electronUpdater} />;
  }

  return <WebUpdaterBanner />;
}

function WebUpdaterBanner() {
  const u = useUpdater(15_000);
  // Remember which error the user dismissed so a transient/offline error
  // (e.g. "fetch failed: ssh: connect to host github.com port 22") can be
  // closed instead of nagging on every 15s poll. Keyed by the error text:
  // a *different* error re-shows the banner; the same one stays hidden.
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  if (!u.data) return null;
  const { state, settings, install } = u.data;
  if (!install.isGitCheckout) return null;
  if (settings.mode === "disabled") return null;

  const status = state.status.kind;
  const pending = state.pending && state.pending.behind > 0 ? state.pending : undefined;
  const hasError = !!state.lastError && state.lastError !== dismissedError;

  if (status === "idle" && !pending && !hasError) return null;

  // Mid-apply / restart — informational, no actions.
  if (status === "applying" || status === "restarting") {
    return (
      <div
        data-pane-name="updater-banner"
        className="flex items-center gap-2 border-b border-[var(--accent)]/40 bg-[var(--accent)]/10 px-4 py-1.5 text-xs"
      >
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[var(--accent)]" />
        <span className="font-medium">
          {status === "applying" ? "Updating Claudius…" : "Restarting Claudius…"}
        </span>
        <span className="hidden text-[var(--muted)] sm:inline">
          {status === "applying"
            ? "pulling, installing dependencies, building"
            : "the page will reconnect once the new build is up"}
        </span>
        <Link
          href="/updater"
          className="ml-auto rounded border border-[var(--accent)]/40 bg-[var(--accent)]/15 px-2 py-0.5 hover:bg-[var(--accent)]/25"
        >
          Details
        </Link>
      </div>
    );
  }

  // Error — takes priority over pending so the user actually sees what
  // went wrong. When both coexist (the common rollback case), the action
  // button retries the apply, not just a fetch.
  if (hasError) {
    // lastError is formatted as `${phase}: ${msg}\n${stderrTail}` — show
    // only the first line in the banner; full text lives on /updater.
    const firstLine = (state.lastError ?? "").split("\n", 1)[0] ?? "";
    const cleanFf = pending && !pending.dirty && pending.ahead === 0 && pending.behind > 0;
    const canRetryApply = !!pending;
    return (
      <div
        data-pane-name="updater-banner"
        className="flex items-center gap-2 border-b border-red-500/40 bg-red-500/10 px-4 py-1.5 text-xs"
      >
        <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-red-400" />
        <span className="font-medium">
          {canRetryApply ? "Update failed" : "Updater error"}
        </span>
        <span className="hidden truncate text-[var(--muted)] sm:inline" title={state.lastError}>
          {firstLine}
          {pending ? (
            <>
              {" · "}
              {pending.behind} {pending.behind === 1 ? "commit" : "commits"} still pending
            </>
          ) : null}
        </span>
        <button
          onClick={() =>
            void (canRetryApply ? u.apply({ allowCcMerge: !cleanFf }) : u.check())
          }
          disabled={u.busy}
          className="ml-auto flex items-center gap-1 rounded border border-red-500/40 bg-red-500/15 px-2 py-0.5 hover:bg-red-500/25 disabled:opacity-50"
        >
          {u.busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          {canRetryApply ? "Retry update" : "Retry check"}
        </button>
        <Link
          href="/updater"
          className="rounded border border-red-500/40 bg-red-500/15 px-2 py-0.5 hover:bg-red-500/25"
        >
          Details
        </Link>
        <button
          onClick={() => setDismissedError(state.lastError ?? null)}
          aria-label="Dismiss updater error"
          title="Dismiss until the error changes"
          className="rounded p-0.5 text-[var(--muted)] hover:bg-red-500/20 hover:text-[var(--foreground)]"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  // Pending update — show "Update now" button. Variant changes for
  // clean-fast-forward vs dirty/diverged.
  if (pending) {
    const p = pending;
    const cleanFf = !p.dirty && p.ahead === 0 && p.behind > 0;
    return (
      <div
        data-pane-name="updater-banner"
        className="flex items-center gap-2 border-b border-emerald-500/40 bg-emerald-500/10 px-4 py-1.5 text-xs"
      >
        <Sparkles className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
        <span className="font-medium">Claudius update available</span>
        <span className="hidden text-[var(--muted)] sm:inline">
          {p.behind} {p.behind === 1 ? "commit" : "commits"} behind {p.upstreamBranch}
          {cleanFf ? " · fast-forward" : p.dirty ? " · local edits" : " · diverged"}
        </span>
        <button
          onClick={() => void u.apply({ allowCcMerge: !cleanFf })}
          disabled={u.busy}
          className="ml-auto flex items-center gap-1 rounded border border-emerald-500/40 bg-emerald-500/15 px-2 py-0.5 hover:bg-emerald-500/25 disabled:opacity-50"
        >
          {u.busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <ArrowDownToLine className="h-3 w-3" />}
          {cleanFf ? "Update now" : "Let Claude resolve"}
        </button>
        <Link
          href="/updater"
          className="rounded border border-emerald-500/40 bg-emerald-500/15 px-2 py-0.5 hover:bg-emerald-500/25"
        >
          Details
        </Link>
      </div>
    );
  }

  return null;
}

/**
 * Electron-only banner — drives off `electron-updater`'s status events
 * forwarded via the IPC bridge. The packaged app does not have a git
 * checkout to compare against; instead the updater downloads a signed
 * dmg/exe and surfaces "restart to install" once it's ready.
 */
function ElectronUpdaterBanner({
  state,
}: {
  state: ReturnType<typeof useElectronUpdater> & object;
}) {
  const { status, check, apply, openAppManagementSettings } = state;
  const [dismissedError, setDismissedError] = useState<string | null>(null);

  if (status.kind === "idle" || status.kind === "checking") return null;

  if (status.kind === "available") {
    return (
      <div
        data-pane-name="updater-banner-electron"
        className="flex items-center gap-2 border-b border-emerald-500/40 bg-emerald-500/10 px-4 py-1.5 text-xs"
      >
        <Sparkles className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
        <span className="font-medium">Claudius {status.version} is downloading…</span>
        <span className="ml-auto text-[var(--muted)]">we&apos;ll prompt you to restart when it&apos;s ready</span>
      </div>
    );
  }

  if (status.kind === "downloading") {
    return (
      <div
        data-pane-name="updater-banner-electron"
        className="flex items-center gap-2 border-b border-[var(--accent)]/40 bg-[var(--accent)]/10 px-4 py-1.5 text-xs"
      >
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[var(--accent)]" />
        <span className="font-medium">Downloading update… {status.percent}%</span>
      </div>
    );
  }

  if (status.kind === "downloaded") {
    return (
      <div
        data-pane-name="updater-banner-electron"
        className="flex items-center gap-2 border-b border-emerald-500/40 bg-emerald-500/10 px-4 py-1.5 text-xs"
      >
        <ArrowDownToLine className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
        <span className="font-medium">Update ready: Claudius {status.version}</span>
        <button
          onClick={apply}
          className="ml-auto flex items-center gap-1 rounded border border-emerald-500/40 bg-emerald-500/15 px-2 py-0.5 hover:bg-emerald-500/25"
        >
          <RefreshCw className="h-3 w-3" />
          Restart and install
        </button>
      </div>
    );
  }

  // macOS App Management denial — distinct, actionable banner. Amber
  // rather than red because this isn't a Claudius bug; the OS gated the
  // bundle swap and the user can flip a switch to unblock it. Keyed on
  // status.message so a future *different* App Management failure
  // re-surfaces the banner after a dismissal.
  if (status.kind === "blocked-app-management") {
    if (dismissedError === status.message) return null;
    return (
      <div
        data-pane-name="updater-banner-electron-blocked"
        className="flex items-center gap-2 border-b border-amber-500/40 bg-amber-500/10 px-4 py-1.5 text-xs"
      >
        <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-amber-400" />
        <span className="font-medium">macOS blocked the update</span>
        <span className="hidden text-[var(--muted)] sm:inline">
          Allow Claudius in Privacy &amp; Security → App Management to update automatically.
        </span>
        <button
          onClick={openAppManagementSettings}
          className="ml-auto flex items-center gap-1 rounded border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 hover:bg-amber-500/25"
        >
          <ShieldAlert className="h-3 w-3" />
          Open Privacy &amp; Security
        </button>
        <button
          onClick={check}
          className="flex items-center gap-1 rounded border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 hover:bg-amber-500/25"
        >
          <RefreshCw className="h-3 w-3" />
          Retry update
        </button>
        <button
          onClick={() => setDismissedError(status.message)}
          aria-label="Dismiss App Management notice"
          title="Dismiss until the error changes"
          className="rounded p-0.5 text-[var(--muted)] hover:bg-amber-500/20 hover:text-[var(--foreground)]"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  // error
  if (dismissedError === status.message) return null;
  return (
    <div
      data-pane-name="updater-banner-electron"
      className="flex items-center gap-2 border-b border-red-500/40 bg-red-500/10 px-4 py-1.5 text-xs"
    >
      <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-red-400" />
      <span className="font-medium">Updater error</span>
      <span className="hidden truncate text-[var(--muted)] sm:inline" title={status.message}>
        {status.message}
      </span>
      <button
        onClick={check}
        className="ml-auto flex items-center gap-1 rounded border border-red-500/40 bg-red-500/15 px-2 py-0.5 hover:bg-red-500/25"
      >
        <RefreshCw className="h-3 w-3" />
        Retry check
      </button>
      <button
        onClick={() => setDismissedError(status.message)}
        aria-label="Dismiss updater error"
        title="Dismiss until the error changes"
        className="rounded p-0.5 text-[var(--muted)] hover:bg-red-500/20 hover:text-[var(--foreground)]"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
