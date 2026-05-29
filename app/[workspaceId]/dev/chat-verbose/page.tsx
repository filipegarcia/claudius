"use client";

/**
 * Dev-only preview: drives the verbose-level filtering end-to-end with mock
 * data so the Playwright spec in `tests/e2e/chat-verbose.spec.ts` can flip
 * levels and assert what the chat shows / what the right rail shows, without
 * spawning a real Claude session or holding an ANTHROPIC_API_KEY.
 *
 * The page renders three slices:
 *   1. A control bar (left) — the same `VerboseSelector` markup the chat
 *      header uses, fed by a local `useState`. No `useSession`, no PATCH.
 *   2. `MessageList` (middle) — real component, real verbose filtering.
 *      The mock corpus has every block kind so the spec can assert the
 *      transitions between levels.
 *   3. A right rail (right) — a hand-built static list that mirrors what
 *      the live `BackgroundTasksPanel` would show. It's INDEPENDENT of the
 *      verbose level: every tool call from every assistant turn is listed,
 *      proving the contract that the rail isn't gated by chat verbosity.
 *
 * Block-level testids:
 *   - data-testid="verbose-preview-chat" wraps MessageList
 *   - data-testid="verbose-preview-rail" wraps the right rail list
 *   - the rail items use data-testid="rail-tool" so a count assertion is cheap
 */

import { useMemo, useState } from "react";
import { Bot, Brain, Wrench } from "lucide-react";
import { MessageList } from "@/components/chat/MessageList";
import type { DisplayBlock, DisplayMessage, SystemEntry } from "@/lib/client/types";
import {
  VERBOSE_LEVELS,
  verboseDescription,
  verboseLabel,
  type VerboseLevel,
} from "@/lib/shared/verbose";

function block(b: DisplayBlock): DisplayBlock {
  return b;
}

function makeCorpus(): DisplayMessage[] {
  return [
    {
      uuid: "u-1",
      role: "user",
      blocks: [block({ kind: "text", text: "List the files and tell me which is biggest." })],
      createdAt: 1_700_000_000_000,
    },
    {
      uuid: "a-1",
      role: "assistant",
      blocks: [
        block({ kind: "text", text: "On it — let me read the directory." }),
        block({ kind: "thinking", text: "I should call Bash to ls -la, then parse sizes." }),
        block({
          kind: "tool_use",
          id: "toolu_ls",
          name: "Bash",
          input: { command: "ls -la" },
          result: { content: "total 80\n-rw-r--r-- 1 user staff 42 README.md" },
        }),
        block({ kind: "text", text: "README.md is the largest file." }),
      ],
      createdAt: 1_700_000_001_000,
    },
    {
      uuid: "a-2",
      role: "assistant",
      blocks: [
        block({
          kind: "tool_use",
          id: "toolu_task",
          name: "Task",
          input: { description: "spawn a research subagent" },
        }),
      ],
      createdAt: 1_700_000_002_000,
    },
    {
      uuid: "a-3",
      role: "assistant",
      blocks: [block({ kind: "thinking", text: "Just thinking out loud." })],
      createdAt: 1_700_000_003_000,
    },
    {
      uuid: "u-2",
      role: "user",
      blocks: [block({ kind: "text", text: "Great, thanks." })],
      createdAt: 1_700_000_004_000,
    },
  ];
}

// A transient "Status: requesting" pill anchored after the first assistant
// turn. It's plumbing, not conversation — hidden at compact / ultra-compact,
// visible at normal / verbose / ultra-verbose. Lets the spec exercise the
// system-entry filter (the live `systemEntries` stream is otherwise absent
// from this fixture).
function makeSystemEntries(): SystemEntry[] {
  return [{ uuid: "s-status", afterMessageUuid: "a-1", kind: "status", label: "Status: requesting" }];
}

export default function ChatVerbosePreview() {
  const [verbose, setVerbose] = useState<VerboseLevel>("normal");
  const messages = useMemo(() => makeCorpus(), []);
  const systemEntries = useMemo(() => makeSystemEntries(), []);

  // The "rail" data: derived ONCE from the unfiltered corpus, so it never
  // changes as the user flips verbose. This is what the live rail does too:
  // it reads `toolHistory` separately from `messages`.
  const railRows = useMemo(() => {
    const rows: { id: string; kind: "tool" | "thinking"; label: string }[] = [];
    for (const m of messages) {
      for (const b of m.blocks) {
        if (b.kind === "tool_use") {
          rows.push({ id: b.id, kind: "tool", label: b.name });
        }
        if (b.kind === "thinking") {
          rows.push({ id: `${m.uuid}-think`, kind: "thinking", label: "thinking" });
        }
      }
    }
    return rows;
  }, [messages]);

  return (
    <div
      data-testid="verbose-preview-root"
      className="flex h-screen w-screen bg-[var(--background)] text-[var(--foreground)]"
    >
      {/* Left: selector controls. We don't pull in the full StatusLine here
          because it has many props we'd have to stub; the dropdown belongs
          to StatusLine and is tested via its own integration on the live
          chat page. The radio-list here gives the spec a deterministic way
          to flip levels via data-testid. */}
      <aside className="flex w-56 shrink-0 flex-col gap-2 border-r border-[var(--border)] bg-[var(--panel)] p-3 text-xs">
        <h2 className="text-[10px] uppercase tracking-wide text-[var(--muted)]">
          Verbose level
        </h2>
        <ul className="space-y-1">
          {VERBOSE_LEVELS.map((lvl) => {
            const active = lvl === verbose;
            return (
              <li key={lvl}>
                <button
                  type="button"
                  data-testid={`set-verbose-${lvl}`}
                  onClick={() => setVerbose(lvl)}
                  className={`flex w-full flex-col items-start gap-0.5 rounded-md border px-2 py-1.5 text-left ${
                    active
                      ? "border-[var(--accent)] bg-[var(--panel-2)]"
                      : "border-[var(--border)] bg-[var(--panel-2)]/40 hover:bg-[var(--panel-2)]"
                  }`}
                >
                  <span className="font-medium">{verboseLabel(lvl)}</span>
                  <span className="text-[10px] text-[var(--muted)]">
                    {verboseDescription(lvl)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        <div className="mt-3 rounded-md border border-[var(--border)] bg-[var(--panel-2)]/40 px-2 py-1.5 text-[10px] text-[var(--muted)]">
          Current:{" "}
          <span data-testid="verbose-current" className="font-mono text-[var(--foreground)]">
            {verbose}
          </span>
        </div>
      </aside>

      {/* Middle: the real MessageList wired to the local verbose state. */}
      <main
        data-testid="verbose-preview-chat"
        data-verbose={verbose}
        className="flex flex-1 flex-col overflow-hidden"
      >
        <MessageList
          messages={messages}
          systemEntries={systemEntries}
          pending={false}
          verbose={verbose}
        />
      </main>

      {/* Right: static "rail" — independent of verbose. The spec asserts
          its row count stays constant across level changes. */}
      <aside
        data-testid="verbose-preview-rail"
        className="flex w-64 shrink-0 flex-col gap-2 border-l border-[var(--border)] bg-[var(--panel)] p-3 text-xs"
      >
        <h2 className="text-[10px] uppercase tracking-wide text-[var(--muted)]">
          Tools (right rail)
        </h2>
        <ul className="space-y-1">
          {railRows.map((r) => (
            <li
              key={r.id}
              data-testid="rail-tool"
              data-rail-kind={r.kind}
              className="flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--panel-2)]/40 px-2 py-1.5"
            >
              {r.kind === "thinking" ? (
                <Brain className="h-3 w-3 text-[var(--muted)]" />
              ) : r.label === "Task" ? (
                <Bot className="h-3 w-3 text-[var(--muted)]" />
              ) : (
                <Wrench className="h-3 w-3 text-[var(--muted)]" />
              )}
              <span className="font-mono">{r.label}</span>
            </li>
          ))}
        </ul>
        <div className="mt-2 text-[10px] text-[var(--muted)]">
          This list never changes with the verbose level — it mirrors what
          the live activity rail shows.
        </div>
      </aside>
    </div>
  );
}
