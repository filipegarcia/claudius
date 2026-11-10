"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, ExternalLink, FileText, Loader2 } from "lucide-react";
import { SideNav } from "@/components/nav/SideNav";
import { ReleaseNoteSection } from "@/components/updater/ReleaseNoteSection";
import { openWhatsNew, useReleaseNotes } from "@/lib/client/whats-new";
import { GITHUB_RELEASES_URL, compareVersions } from "@/lib/shared/release-notes";
import { CLAUDIUS_VERSION } from "@/lib/shared/version";

/** Releases rendered per "Show older releases" step. */
const PAGE_SIZE = 25;

/**
 * Every Claudius release bundled into this build (see
 * lib/shared/release-notes.ts), newest first — the "all previous updates"
 * view behind the post-update What's new window. Maintenance-only releases
 * are hidden by default; they'd otherwise outnumber the interesting ones.
 */
function ClaudiusReleases() {
  const state = useReleaseNotes();
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [showMaintenance, setShowMaintenance] = useState(false);

  if (state.kind === "loading") {
    return (
      <div className="flex items-center gap-2 text-xs text-[var(--muted)]">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading release notes…
      </div>
    );
  }
  if (state.kind === "unavailable") {
    return (
      <p className="text-[var(--muted)]">
        This build doesn&apos;t include release notes.{" "}
        <a href={GITHUB_RELEASES_URL} target="_blank" rel="noreferrer" className="text-[var(--accent)] hover:underline">
          See releases on GitHub
        </a>
      </p>
    );
  }
  const currentTag = `v${CLAUDIUS_VERSION}`;
  const all = state.notes;
  const maintenance = all.filter((n) => n.shown === 0).length;
  const listed = showMaintenance ? all : all.filter((n) => n.shown > 0);
  const visible = listed.slice(0, limit);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--muted)]">
        <span>
          {all.length} {all.length === 1 ? "release" : "releases"} bundled with this build
        </span>
        {maintenance > 0 && (
          <label className="flex cursor-pointer items-center gap-1.5">
            <input
              type="checkbox"
              checked={showMaintenance}
              onChange={(e) => setShowMaintenance(e.target.checked)}
              data-testid="release-notes-show-maintenance"
            />
            Show {maintenance} maintenance {maintenance === 1 ? "release" : "releases"}
          </label>
        )}
        <button onClick={openWhatsNew} className="ml-auto text-[var(--accent)] hover:underline">
          Open What&apos;s new
        </button>
      </div>
      {visible.length === 0 ? (
        <p className="text-[var(--muted)]">No user-facing changes recorded yet.</p>
      ) : (
        <div className="flex flex-col gap-3" data-testid="release-notes-history">
          {visible.map((note) => (
            <div
              key={note.tag}
              className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-3"
            >
              <ReleaseNoteSection note={note} current={compareVersions(note.tag, currentTag) === 0} />
            </div>
          ))}
        </div>
      )}
      {listed.length > visible.length && (
        <button
          onClick={() => setLimit((n) => n + PAGE_SIZE)}
          data-testid="release-notes-more"
          className="self-start rounded border border-[var(--border)] px-3 py-1.5 text-xs hover:bg-[var(--panel-2)]"
        >
          Show older releases ({listed.length - visible.length} more)
        </button>
      )}
    </div>
  );
}

export default function ReleaseNotesPage() {
  return (
    <div className="flex h-full">
      <SideNav running={false} />
      <main className="flex h-full flex-1 flex-col overflow-hidden">
        <header className="flex h-9 shrink-0 items-center gap-3 border-b border-[var(--border)] bg-[var(--panel)] px-4 text-xs">
          <Link href="/" className="flex items-center gap-1 text-[var(--muted)] hover:text-[var(--foreground)]">
            <ArrowLeft className="h-3.5 w-3.5" /> Chat
          </Link>
          <span className="opacity-50">·</span>
          <FileText className="h-3.5 w-3.5 text-[var(--muted)]" />
          <span className="font-medium">Release notes</span>
        </header>

        <div className="flex-1 overflow-y-auto scroll-thin">
          <div className="mx-auto max-w-3xl space-y-5 px-6 py-8 text-sm">
            <section>
              <h1 className="mb-2 text-2xl font-semibold tracking-tight">Claudius</h1>
              <p className="text-[var(--muted)]">
                A web interface for Claude Code, built on the official Claude Agent SDK. Phases 0
                through 16 of the original plan have shipped — chat, sessions, permissions, slash
                commands, memory, MCP, hooks, subagents, settings, plan mode, file context, IDE
                links, plugins, cost/auth, worktrees, and polish.
              </p>
            </section>

            <section>
              <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-[var(--muted)]">
                Claudius releases
              </h2>
              <ClaudiusReleases />
            </section>

            <section>
              <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-[var(--muted)]">
                Claude Code release notes
              </h2>
              <p className="mb-3 text-[var(--muted)]">
                The agent and tool behavior come from the Claude Agent SDK and Claude Code itself.
                Their official changelog is here:
              </p>
              <a
                href="https://docs.claude.com/en/release-notes/claude-code"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 rounded-md border border-[var(--accent)]/40 bg-[var(--accent)]/10 px-3 py-1.5 text-[var(--accent)] hover:bg-[var(--accent)]/20"
              >
                Claude Code changelog <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </section>

            <section>
              <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-[var(--muted)]">
                Diagnostics
              </h2>
              <p className="text-[var(--muted)]">
                If something looks off, run <Link href="/doctor" className="text-[var(--accent)] hover:underline">/doctor</Link>{" "}
                — it checks Node, the SDK, auth, ~/.claude permissions, and git.
              </p>
            </section>
          </div>
        </div>
      </main>
    </div>
  );
}
