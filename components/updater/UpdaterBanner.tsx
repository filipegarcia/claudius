"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowDownToLine, GitMerge, Loader2, RefreshCw, ShieldAlert, Sparkles, TriangleAlert, X } from "lucide-react";
import { useUpdater } from "@/lib/client/use-updater";
import { useElectronUpdater } from "@/lib/client/useElectronUpdater";

// ── 24-hour conflict-banner dismissal ──────────────────────────────────────
//
// The conflicts variant of this banner can persist for days (the user has
// to actually resolve the merge before it clears) — and on every page load
// the unresolved state re-surfaces it, which is a real "I can't get rid of
// this distracting thing" problem. A 24h snooze gives the user a way to
// close it without losing the signal entirely; the same unresolved conflict
// re-appears tomorrow if they haven't dealt with it.
//
// Persisted in localStorage so it survives reload, keyed by the upstream
// SHA the merge tried to land on. If a NEW conflict comes in on a different
// SHA within the 24h window, the banner re-appears (different content,
// dismissal doesn't carry across). Same SHA stays hidden until expiry.
//
// Errors during read/write are swallowed: a corrupt JSON blob or a quota-
// full localStorage just devolves to "no dismissal recorded," which is the
// safe default (banner shows) — not throwing here is more important than
// telling the user a 24h snooze didn't take.
type ConflictDismissal = { sha: string; dismissedAt: number };
const CONFLICT_DISMISS_KEY = "claudius.updater.conflicts.dismissed";
const CONFLICT_DISMISS_TTL_MS = 24 * 60 * 60 * 1000;

function readConflictDismissal(): ConflictDismissal | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(CONFLICT_DISMISS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ConflictDismissal>;
    if (typeof parsed?.sha !== "string" || typeof parsed?.dismissedAt !== "number") return null;
    if (Date.now() - parsed.dismissedAt > CONFLICT_DISMISS_TTL_MS) return null;
    return { sha: parsed.sha, dismissedAt: parsed.dismissedAt };
  } catch {
    return null;
  }
}

function writeConflictDismissal(sha: string): ConflictDismissal {
  const entry: ConflictDismissal = { sha, dismissedAt: Date.now() };
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(CONFLICT_DISMISS_KEY, JSON.stringify(entry));
    } catch {
      // Private mode / quota exceeded — ignore. The in-memory state still
      // hides the banner for the rest of this session, just not across reload.
    }
  }
  return entry;
}

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
  // 24h conflict dismissal — read once on mount from localStorage so a
  // reload doesn't bring the banner back. Stays null when no valid
  // unexpired entry exists; updates locally on Dismiss click so the banner
  // hides immediately without waiting for the next render tick.
  const [conflictDismissal, setConflictDismissal] = useState<ConflictDismissal | null>(() =>
    readConflictDismissal(),
  );
  // Session-only dismissal for the recoverable install/build-failure banner,
  // keyed by the failed commit. A *different* failure (new toSha) re-shows it.
  const [dismissedRecovery, setDismissedRecovery] = useState<string | null>(null);
  if (!u.data) return null;
  const { state, settings, install } = u.data;
  if (!install.isGitCheckout) return null;
  if (settings.mode === "disabled") return null;

  const status = state.status.kind;
  const pending = state.pending && state.pending.behind > 0 ? state.pending : undefined;
  const rawConflicts = state.conflicts;
  // Honour the 24h dismissal: when the dismissal SHA matches the current
  // conflict's SHA and the entry hasn't expired, treat conflicts as absent
  // for rendering purposes. Done as a derived flag (not by mutating
  // `state.conflicts`) so the underlying data stays accurate for /updater
  // and any other consumer that might key off it.
  // Fallback key "_no_sha" when conflicts.toSha is undefined keeps the
  // snooze working even when the resolver didn't populate the field — at
  // worst, a different no-sha conflict would also be hidden, which is the
  // intended "shut up for a day" behaviour anyway.
  const conflictSha = rawConflicts?.toSha ?? "_no_sha";
  // The mount-time `readConflictDismissal()` already filtered out expired
  // entries (anything past CONFLICT_DISMISS_TTL_MS returns null), so we
  // don't need a `Date.now()` recheck here — that would also trip React
  // Compiler's purity rule for impure render-time reads. Trade-off: a
  // user who keeps the page open past the 24h boundary without reload
  // stays in the dismissed state until they reload; acceptable for a
  // "snooze 1 day" semantic.
  const isConflictDismissed =
    !!rawConflicts && !!conflictDismissal && conflictDismissal.sha === conflictSha;
  const conflicts = isConflictDismissed ? undefined : rawConflicts;
  // Recoverable install/build failure (HEAD landed at upstream but
  // `bun install` / `bun run build` failed). Like conflicts it's surfaced as
  // its own actionable banner, not the generic red error.
  const rawRecovery = state.recovery;
  const recoveryKey = rawRecovery ? `${rawRecovery.toSha}:${rawRecovery.phase}` : "_none";
  const recovery =
    rawRecovery && dismissedRecovery !== recoveryKey && !conflicts ? rawRecovery : undefined;
  // Conflicts/recovery win over the plain error — `lastError` is set in
  // parallel for both, so without this we'd double-render the same situation
  // as both a red "update failed" banner and the actionable one.
  const hasError =
    !!state.lastError && state.lastError !== dismissedError && !conflicts && !recovery;

  if (status === "idle" && !pending && !hasError && !conflicts && !recovery) return null;

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

  // Conflicts — the update was partially applied (HEAD moved) but a
  // stash pop or merge left markers in the tree. Surface the actionable
  // path (spawn a Claude session at the install root) right here so the
  // user doesn't have to dig into /updater.
  if (conflicts) {
    return (
      <div
        data-pane-name="updater-banner-conflicts"
        className="flex items-center gap-2 border-b border-amber-500/40 bg-amber-500/10 px-4 py-1.5 text-xs"
      >
        <GitMerge className="h-3.5 w-3.5 shrink-0 text-amber-400" />
        <span className="font-medium">Update needs your help</span>
        <span className="hidden text-[var(--muted)] sm:inline">
          local edits conflicted when reapplied on top of upstream
          {conflicts.toSha ? ` · @ ${conflicts.toSha.slice(0, 7)}` : ""}
        </span>
        <button
          onClick={async () => {
            const r = await u.resolveWithClaude();
            if (!r || typeof window === "undefined") return;
            try {
              sessionStorage.setItem("claudius.autofix-draft", r.prompt);
              window.location.assign(`/${r.workspaceId}?new=1&prefill=1`);
            } catch {
              window.location.assign(
                `/${r.workspaceId}?new=1&prefill=${encodeURIComponent(r.prompt)}`,
              );
            }
          }}
          disabled={u.busy}
          className="ml-auto flex items-center gap-1 rounded border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 hover:bg-amber-500/25 disabled:opacity-50"
        >
          {u.busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
          Resolve with Claude Code
        </button>
        <Link
          href="/updater"
          className="rounded border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 hover:bg-amber-500/25"
        >
          Details
        </Link>
        <button
          onClick={() => setConflictDismissal(writeConflictDismissal(conflictSha))}
          aria-label="Dismiss for 24 hours"
          title="Hide for 24 hours — re-appears if a new conflict shows up or the snooze expires"
          className="rounded p-0.5 text-[var(--muted)] hover:bg-amber-500/20 hover:text-[var(--foreground)]"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  // Recoverable install/build failure — the pull landed but dependency
  // install or the Next build failed (e.g. a native module couldn't
  // compile). The new code is already checked out, so we don't roll back;
  // instead hand the captured error to a Claude session that fixes the
  // build in place. Same actionable shape as conflicts.
  if (recovery) {
    return (
      <div
        data-pane-name="updater-banner-recovery"
        className="flex items-center gap-2 border-b border-amber-500/40 bg-amber-500/10 px-4 py-1.5 text-xs"
      >
        <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-amber-400" />
        <span className="font-medium">Update needs your help</span>
        <span className="hidden text-[var(--muted)] sm:inline">
          pulled, but {recovery.phase === "install" ? "installing dependencies" : "the build"} failed
          {recovery.toSha ? ` · @ ${recovery.toSha.slice(0, 7)}` : ""}
        </span>
        <button
          onClick={async () => {
            const r = await u.resolveWithClaude();
            if (!r || typeof window === "undefined") return;
            try {
              sessionStorage.setItem("claudius.autofix-draft", r.prompt);
              window.location.assign(`/${r.workspaceId}?new=1&prefill=1`);
            } catch {
              window.location.assign(
                `/${r.workspaceId}?new=1&prefill=${encodeURIComponent(r.prompt)}`,
              );
            }
          }}
          disabled={u.busy}
          className="ml-auto flex items-center gap-1 rounded border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 hover:bg-amber-500/25 disabled:opacity-50"
        >
          {u.busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
          Resolve with Claude Code
        </button>
        <Link
          href="/updater"
          className="rounded border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 hover:bg-amber-500/25"
        >
          Details
        </Link>
        <button
          onClick={() => setDismissedRecovery(recoveryKey)}
          aria-label="Dismiss for this session"
          title="Hide until this update finishes or a new failure shows up"
          className="rounded p-0.5 text-[var(--muted)] hover:bg-amber-500/20 hover:text-[var(--foreground)]"
        >
          <X className="h-3.5 w-3.5" />
        </button>
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

  // macOS ad-hoc build — an update exists but this build can't self-install
  // it (Squirrel.Mac rejects the swap; see autoUpdateIsSafe in
  // electron/ipc/updater.ts). Point the user at the DMG. `apply()` routes to
  // shell.openExternal(Releases) on the main side for this state.
  if (status.kind === "manual-download") {
    return (
      <div
        data-pane-name="updater-banner-electron-manual"
        className="flex items-center gap-2 border-b border-emerald-500/40 bg-emerald-500/10 px-4 py-1.5 text-xs"
      >
        <Sparkles className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
        <span className="font-medium">Claudius {status.version} is available</span>
        <span className="hidden text-[var(--muted)] sm:inline">
          download the new version and drag it into Applications to update
        </span>
        <button
          onClick={apply}
          className="ml-auto flex items-center gap-1 rounded border border-emerald-500/40 bg-emerald-500/15 px-2 py-0.5 hover:bg-emerald-500/25"
        >
          <ArrowDownToLine className="h-3 w-3" />
          Download update
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
