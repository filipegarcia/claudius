"use client";

import Link from "next/link";
import { ArrowLeft, ExternalLink, FileText } from "lucide-react";
import { SideNav } from "@/components/nav/SideNav";

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
              <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-[var(--muted)]">
                Claude Code release notes
              </h2>
              <p className="mb-3 text-[var(--muted)]">
                Claudius doesn&apos;t bundle its own release notes — the agent and tool behavior come
                from the Claude Agent SDK and Claude Code itself. The official changelog is here:
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
