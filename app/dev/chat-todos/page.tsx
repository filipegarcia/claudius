"use client";

/**
 * Dev-only preview: a chat mid-conversation with the TodosBanner pinned
 * between the status line and the messages. Hand-built so the screenshot
 * spec can capture the marketing shot without spawning a real Claude
 * session or running TodoWrite live.
 */

import { CheckCircle2, Circle, Loader2, ListChecks, Mic, Paperclip, ArrowUp } from "lucide-react";
import { PreviewChrome } from "../_chat-chrome/PreviewChrome";

const TODOS = [
  { content: "Ship the marketing site", status: "completed" as const },
  { content: "Capturing marketing screenshots", status: "in_progress" as const },
  { content: "Push to GitLab Pages", status: "pending" as const },
];

export default function ChatTodosPreview() {
  const done = TODOS.filter((t) => t.status === "completed").length;
  const active = TODOS.find((t) => t.status === "in_progress");

  return (
    <PreviewChrome
      activeTab="98a3c4f1"
      tabs={[{ id: "98a3c4f1", label: "98a3c4f1", active: true }]}
      todos={TODOS.map((t) => ({ label: t.content, status: t.status }))}
    >
      <div className="relative flex h-full flex-col">
        {/* Status line */}
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--panel)] px-3 py-1.5 text-[11px] text-[var(--muted)]">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />
          <span className="rounded border border-[var(--border)] bg-[var(--panel-2)] px-1.5 py-0.5 font-medium text-[var(--foreground)]">
            Session 98a3c4f1
          </span>
          <span>·</span>
          <span>Working — 2 turns · 14s</span>
          <div className="ml-auto flex items-center gap-2 text-[var(--muted)]">
            <Chip>⊞ Compact</Chip>
            <Chip>◇ Clear</Chip>
            <Chip>◐ bypass ▾</Chip>
            <span className="font-mono text-[10px] opacity-70">claudius v0</span>
          </div>
        </div>

        {/* TodosBanner — hand-built so it doesn't need the real component's
            localStorage / sticky behaviour. Visual matches the in-app one. */}
        <div className="shrink-0 border-b border-[var(--border)] bg-[var(--panel)]">
          <div className="flex items-center gap-2 px-4 py-2">
            <ListChecks className="h-3.5 w-3.5 text-[var(--accent)]" />
            <span className="text-xs font-medium text-[var(--foreground)]">
              Todos
            </span>
            <span className="rounded border border-[var(--border)] bg-[var(--panel-2)] px-1.5 py-0.5 text-[10px] font-mono text-[var(--muted)]">
              {done}/{TODOS.length}
            </span>
            <span className="ml-2 truncate text-xs text-[var(--muted)]">
              {active?.content}…
            </span>
          </div>
          <ul className="space-y-1.5 border-t border-[var(--border)] bg-[var(--panel)]/60 px-4 py-2.5">
            {TODOS.map((t, i) => (
              <li key={i} className="flex items-center gap-2 text-[13px]">
                {t.status === "completed" ? (
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                ) : t.status === "in_progress" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-400" />
                ) : (
                  <Circle className="h-3.5 w-3.5 text-[var(--muted)]" />
                )}
                <span
                  className={
                    t.status === "completed"
                      ? "text-[var(--muted)] line-through"
                      : "text-[var(--foreground)]"
                  }
                >
                  {t.content}
                </span>
              </li>
            ))}
          </ul>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-auto px-6 py-6">
          <div className="mx-auto max-w-3xl space-y-6">
            <UserBubble>
              Great. Mark &ldquo;Ship the marketing site&rdquo; as done — we just deployed it. Briefly summarize what&rsquo;s left in 1-2 sentences.
            </UserBubble>
            <AssistantTurn streaming>
              <p>
                Done — flipped the first todo to{" "}
                <code className="rounded bg-[var(--panel-2)] px-1 py-0.5 font-mono text-xs">
                  completed
                </code>{" "}
                via{" "}
                <code className="rounded bg-[var(--panel-2)] px-1 py-0.5 font-mono text-xs">
                  TodoWrite
                </code>
                . The progress bar in the banner now reads{" "}
                <strong>1/3</strong>.
              </p>
              <p>
                Two left: <strong>capturing marketing screenshots</strong>{" "}
                (in flight — running Playwright against the dev server),
                then <strong>push to GitLab Pages</strong>. The page push
                is gated on the screenshot run finishing, so once Playwright
                exits we&rsquo;ll have everything green.
              </p>
            </AssistantTurn>
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

function UserBubble({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[80%] rounded-2xl border border-[var(--border)] bg-[var(--panel-2)] px-4 py-2 text-sm text-[var(--foreground)]">
        {children}
      </div>
    </div>
  );
}

function AssistantTurn({ children, streaming }: { children: React.ReactNode; streaming?: boolean }) {
  return (
    <div className="group">
      <div className="mb-1.5 flex items-center gap-2 text-[11px] font-medium text-[var(--muted)]">
        <span
          className={
            "inline-block h-1.5 w-1.5 rounded-full bg-[var(--accent)] " +
            (streaming ? "animate-pulse" : "")
          }
        />
        Claude
        {streaming && <span className="text-[10px] opacity-60">streaming…</span>}
      </div>
      <div className="space-y-2 text-sm leading-7 text-[var(--foreground)]">{children}</div>
    </div>
  );
}
