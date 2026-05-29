"use client";

import Link from "next/link";
import {
  ArrowDownToLine,
  ArrowLeft,
  Download,
  LifeBuoy,
  Loader2,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { SideNav } from "@/components/nav/SideNav";
import { useUpdater, type UpdaterMode } from "@/lib/client/use-updater";
import { cn } from "@/lib/utils/cn";

/**
 * Phase → user-facing guidance. The `lastError` string we get from the
 * server is formatted as `${phase}: ${msg}\n${stderrTail}`, so we parse the
 * leading token to pick the right recovery hint. Keep these short and
 * imperative — the user wants to know "what do I run" first, "why" second.
 */
type ApplyPhase = "detect" | "pull" | "merge" | "install" | "build" | "restart" | "init";

const PHASE_GUIDE: Record<ApplyPhase, { label: string; what: string; fix: string }> = {
  detect: {
    label: "Network / fetch",
    what:
      "git fetch couldn't reach the remote — usually a network blip, a private repo with stale credentials, or a remote that's been moved.",
    fix: "Confirm your network is up and `git fetch origin main` works from the install root. Then click Retry.",
  },
  pull: {
    label: "Fast-forward refused",
    what:
      "The local branch has diverged from upstream (you have local commits, or the upstream rewrote history). A plain `git pull --ff-only` can't proceed.",
    fix: "Switch the mode to 'Auto + Claude merge' below and click Retry — Claude will reconcile. Or manually: `git pull --rebase origin main` from the install root.",
  },
  merge: {
    label: "Claude merge failed",
    what:
      "Claude was spawned to resolve the merge but couldn't converge (real conflicts in customized files, or the run timed out).",
    fix: "Open a Claudius workspace at the install root and run `git status` to see what's blocking. Resolve, commit, then click Retry.",
  },
  install: {
    label: "bun install failed",
    what:
      "Dependencies couldn't be resolved or downloaded. Common causes: a registry outage, a corrupted lockfile after upstream changes, or a missing native build tool.",
    fix: "Try the steps below manually — if `bun install` works there, click Retry. (cc-merge mode does NOT auto-spawn Claude for install/build errors today.)",
  },
  build: {
    label: "bun run build failed",
    what:
      "Type-check, lint, or Next.js compile errored. Usually a real upstream regression or an incompatibility with a local customization.",
    fix: "Reproduce with the steps below; the error message above shows the failing file. Fix or revert the offending change, then Retry.",
  },
  restart: {
    label: "Restart failed",
    what:
      "The new code is on disk and built successfully, but the supervisor couldn't restart cleanly. Often this means you're running `bun run dev` directly (no daemon), or the pid file is stale.",
    fix: "Restart Claudius yourself — `claudiusd restart`, or kill the dev process and `bun run dev` again. The update is already applied.",
  },
  init: {
    label: "Setup error",
    what: "The apply failed before any phase could run — usually a permissions or filesystem issue at the install root.",
    fix: "Check the log; if the install root isn't writable, fix permissions and click Retry.",
  },
};

function parsePhase(lastError: string | undefined): ApplyPhase | null {
  if (!lastError) return null;
  const head = lastError.split(":", 1)[0]?.trim() as ApplyPhase | undefined;
  if (head && head in PHASE_GUIDE) return head;
  return null;
}

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
      "Auto-pull only when the update is a clean fast-forward. Dirty trees and divergent branches surface a warning instead — apply manually or switch modes.",
  },
  {
    id: "notify-only",
    label: "Notify only",
    blurb:
      "Background check still runs daily and on boot, but never auto-applies. The banner shows an 'Update now' button you click to apply.",
  },
  {
    id: "disabled",
    label: "Disabled",
    blurb:
      "No background checks at all. Re-run the install script (or `git pull` yourself) to update.",
  },
];

function fmt(ts: number | undefined): string {
  if (!ts) return "never";
  const d = new Date(ts);
  return d.toLocaleString();
}

export default function UpdaterPage() {
  const u = useUpdater(5_000);
  const data = u.data;

  return (
    <div className="flex h-full">
      <SideNav running={false} />
      <main data-pane-name="updater-main" className="flex h-full flex-1 flex-col overflow-hidden">
        <header className="flex h-9 shrink-0 items-center gap-3 border-b border-[var(--border)] bg-[var(--panel)] px-4 text-xs">
          <Link href="/" className="flex items-center gap-1 text-[var(--muted)] hover:text-[var(--foreground)]">
            <ArrowLeft className="h-3.5 w-3.5" /> Chat
          </Link>
          <span className="opacity-50">·</span>
          <Download className="h-3.5 w-3.5 text-[var(--muted)]" />
          <span className="font-medium">Self-update</span>
          {u.loading && !data && <span className="text-[var(--muted)]">loading…</span>}
          {u.error && <span className="text-red-400">{u.error}</span>}
          <button
            onClick={() => void u.check()}
            disabled={u.busy}
            className="ml-auto flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-0.5 hover:bg-[var(--panel)] disabled:opacity-50"
          >
            {u.busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            Check now
          </button>
        </header>

        <div className="flex-1 overflow-y-auto scroll-thin">
          <div className="mx-auto max-w-3xl space-y-5 px-6 py-6">
            {data && (
              <>
                <Section title="Status">
                  <Row label="Install root">
                    <code className="font-mono text-[11px] text-[var(--muted)]">{data.install.root}</code>
                  </Row>
                  <Row label="Runtime">
                    <span className="font-mono text-[11px]">{data.install.runtimeMode}</span>
                    <span className="ml-2 text-[11px] text-[var(--muted)]">
                      {data.install.runtimeMode === "daemon"
                        ? "background process — auto-restart works"
                        : "foreground dev — restart manually after apply"}
                    </span>
                  </Row>
                  <Row label="Branch / SHA">
                    <span className="font-mono text-[11px]">
                      {data.install.currentBranch ?? "(detached)"}
                      {data.install.currentSha ? ` @ ${data.install.currentSha.slice(0, 7)}` : ""}
                    </span>
                  </Row>
                  <Row label="Last checked">
                    <span className="text-[11px]">{fmt(data.state.lastCheckAt)}</span>
                  </Row>
                  <Row label="Last applied">
                    <span className="text-[11px]">
                      {fmt(data.state.lastUpdateAt)}
                      {data.state.lastUpdateSha ? ` (${data.state.lastUpdateSha.slice(0, 7)})` : ""}
                    </span>
                  </Row>
                  {data.state.lastError && (
                    <Row label="Last error">
                      <pre className="whitespace-pre-wrap break-words rounded border border-red-500/30 bg-red-500/5 p-2 font-mono text-[11px] leading-snug text-red-300">
                        {data.state.lastError}
                      </pre>
                    </Row>
                  )}
                </Section>

                {data.state.lastError && (
                  <RecoverySection
                    lastError={data.state.lastError}
                    installRoot={data.install.root}
                  />
                )}

                {data.state.pending && data.state.pending.behind > 0 && (
                  <Section
                    title="Pending update"
                    subtitle={`${data.state.pending.behind} commit${data.state.pending.behind === 1 ? "" : "s"} behind ${data.state.pending.upstreamBranch}`}
                  >
                    <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3">
                      <div className="flex items-start gap-2">
                        <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
                        <div className="flex-1 text-xs">
                          <div>
                            <span className="text-[var(--muted)]">Local:</span> {data.install.currentSha?.slice(0, 7)}{" "}
                            → <span className="text-[var(--muted)]">remote:</span>{" "}
                            {data.state.pending.remoteSha.slice(0, 7)}
                          </div>
                          <div className="mt-1 text-[var(--muted)]">
                            ahead {data.state.pending.ahead} · behind {data.state.pending.behind} ·{" "}
                            {data.state.pending.dirty ? "working tree dirty" : "working tree clean"}
                          </div>
                          {data.state.pending.recentCommits && data.state.pending.recentCommits.length > 0 && (
                            <ul className="mt-2 space-y-0.5 font-mono text-[11px]">
                              {data.state.pending.recentCommits.map((c, i) => (
                                <li key={i} className="truncate">
                                  • {c}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      </div>
                      <div className="mt-3 flex gap-2">
                        <button
                          onClick={() => void u.apply()}
                          disabled={u.busy}
                          className="flex items-center gap-1 rounded-md bg-emerald-500/80 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
                        >
                          {u.busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <ArrowDownToLine className="h-3 w-3" />}
                          Apply
                        </button>
                        <button
                          onClick={() => void u.apply({ allowCcMerge: true })}
                          disabled={u.busy}
                          className="flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-3 py-1 text-xs hover:bg-[var(--panel)] disabled:opacity-50"
                          title="Spawn Claude Code to resolve the merge — useful when working tree is dirty or branches diverged"
                        >
                          <Sparkles className="h-3 w-3" />
                          Apply with Claude merge
                        </button>
                      </div>
                    </div>
                  </Section>
                )}

                <Section
                  title="Auto-update mode"
                  subtitle="Applies to background checks (boot + every interval). Manual buttons above are not gated by this."
                >
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
                          name="updater-mode"
                          checked={data.settings.mode === opt.id}
                          onChange={() => void u.setMode(opt.id)}
                          className="mt-0.5"
                        />
                        <div className="flex-1">
                          <div className="text-xs font-medium">{opt.label}</div>
                          <div className="mt-0.5 text-[11px] text-[var(--muted)]">{opt.blurb}</div>
                        </div>
                      </label>
                    ))}
                  </div>
                  <div className="text-[11px] text-[var(--muted)]">
                    Tracking <code className="font-mono">{data.settings.remote}/{data.settings.branch}</code> ·{" "}
                    every {data.settings.intervalHours}h. Override via{" "}
                    <code className="font-mono">~/.claude/.claudius/updater.json</code>.
                  </div>
                </Section>

                {!data.install.isGitCheckout && (
                  <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200">
                    This install isn&apos;t a git checkout, so the updater can&apos;t check for new
                    commits. Re-install via the setup script to enable updates.
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-[var(--border)] bg-[var(--panel)]/40 p-4">
      <h2 className="text-sm font-medium">{title}</h2>
      {subtitle && <p className="mt-0.5 text-[11px] text-[var(--muted)]">{subtitle}</p>}
      <div className="mt-3 space-y-3">{children}</div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3 text-xs">
      <div className="w-28 shrink-0 text-[10px] uppercase tracking-wide text-[var(--muted)]">{label}</div>
      <div className="flex-1">{children}</div>
    </div>
  );
}

/**
 * Per-phase recovery guidance. Surfaces only when there's a `lastError`.
 * The goal is to answer the two questions users actually have when an
 * update fails:
 *
 *   1. What went wrong, in plain terms?
 *   2. What commands do I run to unblock myself?
 *
 * It also explains the (currently surprising) gap that cc-merge mode only
 * covers git merge conflicts, not install/build regressions — so the
 * "auto-fix everything" mental model doesn't fit yet.
 */
function RecoverySection({
  lastError,
  installRoot,
}: {
  lastError: string;
  installRoot: string;
}) {
  const phase = parsePhase(lastError);
  const guide = phase ? PHASE_GUIDE[phase] : null;

  return (
    <Section title="How to recover" subtitle="What just happened and what to do about it.">
      <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs">
        <div className="flex items-start gap-2">
          <LifeBuoy className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
          <div className="flex-1 space-y-3">
            {guide ? (
              <>
                <div>
                  <div className="font-medium">
                    {guide.label}
                    {phase && (
                      <span className="ml-2 rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] uppercase text-amber-200">
                        phase: {phase}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-[var(--muted)]">{guide.what}</p>
                </div>

                <div>
                  <div className="text-[10px] uppercase tracking-wide text-[var(--muted)]">
                    Try this
                  </div>
                  <p className="mt-1">{guide.fix}</p>
                </div>
              </>
            ) : (
              <p className="text-[var(--muted)]">
                Couldn&apos;t classify the failure from the error message — see the log and recovery
                steps below.
              </p>
            )}

            <div>
              <div className="text-[10px] uppercase tracking-wide text-[var(--muted)]">
                Manual recovery commands
              </div>
              <pre className="mt-1 overflow-x-auto rounded bg-black/30 p-2 font-mono text-[11px] leading-relaxed text-[var(--foreground)]">
                {`cd ${installRoot}
git status                          # see what's in the tree
tail -50 .claudius/logs/updater.log # full output from the failed apply
bun install                         # re-run the install phase
bun run build                       # re-run the build phase
# if all green, restart Claudius (claudiusd restart, or kill+relaunch dev)`}
              </pre>
            </div>

            <div className="rounded border border-[var(--border)]/50 bg-[var(--panel-2)]/40 p-2 text-[var(--muted)]">
              <span className="font-medium text-[var(--foreground)]">
                Why didn&apos;t Claude auto-fix this?
              </span>{" "}
              The <code className="font-mono">cc-merge</code> mode only spawns Claude for{" "}
              <em>git merge conflicts</em> (phase <code className="font-mono">merge</code>). For{" "}
              <code className="font-mono">install</code>, <code className="font-mono">build</code>,
              and <code className="font-mono">restart</code> failures the updater just rolls back
              and surfaces the error — there&apos;s no agent in the loop yet. Easiest workaround
              when stuck: open a Claudius workspace at the install root above and paste the error
              into the chat.
            </div>
          </div>
        </div>
      </div>
    </Section>
  );
}
