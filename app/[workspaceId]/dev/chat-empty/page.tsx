"use client";

/**
 * Dev-only preview: the empty chat surface, hand-built so the screenshot
 * spec can capture it without spawning a real Claude session or holding
 * an ANTHROPIC_API_KEY. The visual mirrors `app/page.tsx`'s empty state —
 * Claudius bust, four suggestion chips, prompt input, side rail, activity
 * panel — using static markup instead of `useSession` / SSE.
 */

import { Mic, Paperclip, ArrowUp } from "lucide-react";
import { ClaudiusMark } from "@/components/brand/ClaudiusMark";
import { PreviewChrome } from "../_chat-chrome/PreviewChrome";

const SUGGESTIONS = [
  "Check for security vulnerabilities in the latest git commit",
  "Improve test coverage",
  "Find TODO comments in the codebase",
  "Find performance bottlenecks and suggest fixes",
];

export default function ChatEmptyPreview() {
  return (
    <PreviewChrome activeTab="a6ef5b44" tabs={[{ id: "a6ef5b44", label: "a6ef5b44", active: true }]}>
      <div className="relative flex h-full flex-col">
        {/* Status line */}
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--panel)] px-3 py-1.5 text-[11px] text-[var(--muted)]">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />
          <span className="rounded border border-[var(--border)] bg-[var(--panel-2)] px-1.5 py-0.5 font-medium text-[var(--foreground)]">
            Session a6ef5b44
          </span>
          <span>·</span>
          <span>Idle</span>
          <div className="ml-auto flex items-center gap-2 text-[var(--muted)]">
            <Chip>⊞ Compact</Chip>
            <Chip>◇ Clear</Chip>
            <Chip>🔕 Share</Chip>
            <Chip>◐ Default ▾</Chip>
            <span className="font-mono text-[10px] opacity-70">claudius v0</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center justify-between border-b border-[var(--border)] bg-[var(--background)] px-4 py-1.5 text-[11px] text-[var(--muted)]">
          <span className="italic">Untitled session</span>
          <span className="opacity-60">✎</span>
        </div>

        {/* Empty hero */}
        <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
          {/* The real splash bust — same component the live empty state uses
              in components/chat/MessageList.tsx. Themes via CSS color so it
              honours the active palette. */}
          <ClaudiusMark color="var(--foreground)" size={120} className="mb-5 opacity-90" />
          <h1 className="text-3xl font-semibold tracking-tight text-[var(--foreground)]">Claudius</h1>
          <p className="mt-2 text-sm text-[var(--muted)]">
            A web interface for Claude Code. Type a prompt to start a session.
          </p>

          <div className="mt-8 grid w-full max-w-3xl grid-cols-1 gap-3 sm:grid-cols-2">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                className="rounded-md border border-[var(--border)] bg-[var(--panel)] px-4 py-3 text-left text-sm text-[var(--foreground)] hover:border-[var(--accent)]/60"
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        {/* Prompt input */}
        <div className="shrink-0 px-6 pb-6">
          <div className="mx-auto flex max-w-3xl items-center gap-3 rounded-full border border-[var(--border)] bg-[var(--panel)] px-4 py-2.5">
            <Paperclip className="h-4 w-4 text-[var(--muted)]" />
            <span className="flex-1 truncate text-sm text-[var(--muted)]">
              Message Claudius — / for commands, @ for files, drop or paste images
            </span>
            <Mic className="h-4 w-4 text-[var(--muted)]" />
            <button className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--accent)] text-[var(--background)]">
              <ArrowUp className="h-4 w-4" />
            </button>
          </div>
          <div className="mt-1 text-right text-[10px] text-[var(--muted)]">0 chars</div>
        </div>
      </div>
    </PreviewChrome>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded border border-[var(--border)] bg-[var(--panel-2)] px-1.5 py-0.5 text-[10px]">
      {children}
    </span>
  );
}
