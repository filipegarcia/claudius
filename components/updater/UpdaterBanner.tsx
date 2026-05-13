"use client";

import Link from "next/link";
import { ArrowDownToLine, Loader2, RefreshCw, Sparkles, TriangleAlert } from "lucide-react";
import { useUpdater } from "@/lib/client/use-updater";

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
  const u = useUpdater(15_000);
  if (!u.data) return null;
  const { state, settings, install } = u.data;
  if (!install.isGitCheckout) return null;
  if (settings.mode === "disabled") return null;

  const status = state.status.kind;
  const pending = state.pending && state.pending.behind > 0 ? state.pending : undefined;
  const hasError = !!state.lastError;

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
