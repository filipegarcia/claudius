"use client";

import { useMemo } from "react";
import { ChevronRight, Wrench } from "lucide-react";
import { Markdown } from "@/components/chat/Markdown";
import { SystemPill } from "@/components/chat/SystemPill";
import type { SystemEntry } from "@/lib/client/types";
import type { HistoryMessage } from "@/lib/shared/history-message";
import { COMPACT_SUMMARY_PREFIX } from "@/lib/shared/user-prompt";

type Props = {
  messages: HistoryMessage[];
  onRewind?: (uuid: string) => void;
  rewinding?: string | null;
};

type Block =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { kind: "tool_result"; id: string; text: string; isError?: boolean };

function blocks(content: unknown): Block[] {
  if (typeof content === "string") return [{ kind: "text", text: content }];
  if (!Array.isArray(content)) return [];
  const out: Block[] = [];
  for (const c of content as Array<Record<string, unknown>>) {
    if (c.type === "text" && typeof c.text === "string") out.push({ kind: "text", text: c.text });
    else if (c.type === "thinking" && typeof c.thinking === "string")
      out.push({ kind: "thinking", text: c.thinking });
    else if (c.type === "tool_use")
      out.push({
        kind: "tool_use",
        id: String(c.id ?? ""),
        name: String(c.name ?? ""),
        input: (c.input as Record<string, unknown>) ?? {},
      });
    else if (c.type === "tool_result") {
      let text = "";
      if (typeof c.content === "string") text = c.content;
      else if (Array.isArray(c.content))
        text = (c.content as Array<{ text?: string }>).map((p) => p.text ?? "").join("");
      out.push({ kind: "tool_result", id: String(c.tool_use_id ?? ""), text, isError: Boolean(c.is_error) });
    }
  }
  return out;
}

function plainText(content: unknown): string {
  return blocks(content)
    .filter((b) => b.kind === "text")
    .map((b) => (b as { text: string }).text)
    .join("");
}

function isCompactSummary(m: HistoryMessage): boolean {
  if (m.type !== "user") return false;
  if (m.isCompactSummary === true) return true;
  return plainText((m.message as { content?: unknown })?.content).trimStart().startsWith(COMPACT_SUMMARY_PREFIX);
}

type Row = { kind: "message"; m: HistoryMessage } | { kind: "compaction"; entry: SystemEntry };

/**
 * The transcript includes the turns before each compaction. Each compaction
 * becomes one divider, like the chat's: the `compact_boundary` system row
 * supplies the token stats and the "This session is being continued…"
 * summary that follows it goes behind "show summary", instead of rendering
 * as a wall-of-text user bubble.
 */
function toRows(messages: readonly HistoryMessage[]): Row[] {
  const rows: Row[] = [];
  // Index of a divider still waiting for its summary (the summary is the
  // next user message after the boundary).
  let pending: number | null = null;
  let prev = "";
  for (const m of messages) {
    if (m.type === "system" && m.subtype === "compact_boundary") {
      rows.push({
        kind: "compaction",
        entry: {
          uuid: m.uuid,
          afterMessageUuid: prev,
          kind: "compact_boundary",
          label: "Compacted earlier conversation",
          ...(m.compactBoundary && { compactStats: m.compactBoundary }),
        },
      });
      pending = rows.length - 1;
    } else if (isCompactSummary(m)) {
      const summary = plainText((m.message as { content?: unknown })?.content).trim();
      const open = pending !== null ? rows[pending] : undefined;
      if (open?.kind === "compaction") {
        open.entry = { ...open.entry, compactSummary: summary };
      } else {
        // No boundary row (system messages filtered out): the summary alone
        // still marks the compaction.
        rows.push({
          kind: "compaction",
          entry: {
            uuid: m.uuid,
            afterMessageUuid: prev,
            kind: "compact_boundary",
            label: "Compacted earlier conversation",
            compactSummary: summary,
          },
        });
      }
      pending = null;
    } else if (m.type === "assistant" || m.type === "user" || m.type === "system") {
      rows.push({ kind: "message", m });
      if (m.type !== "system") pending = null;
    }
    prev = m.uuid;
  }
  return rows;
}

export function TranscriptViewer({ messages, onRewind, rewinding }: Props) {
  const rows = useMemo(() => toRows(messages), [messages]);
  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 px-4 py-6">
      {rows.map((row) => {
        if (row.kind === "compaction") {
          return (
            <div key={row.entry.uuid} data-testid="transcript-compaction">
              <SystemPill entry={row.entry} />
            </div>
          );
        }
        const m = row.m;
        const inner = (m.message as { content?: unknown }) ?? {};
        const bs = blocks(inner.content);
        if (m.type === "system") {
          return (
            <div key={m.uuid} className="text-[11px] text-[var(--muted)]">
              <span className="opacity-60">— {m.subtype ? m.subtype.replace(/_/g, " ") : "system"} —</span>
            </div>
          );
        }
        const isUser = m.type === "user";
        const userText = isUser ? bs.filter((b) => b.kind === "text").map((b) => (b as { text: string }).text).join("") : "";
        const isToolResultOnly = isUser && bs.length > 0 && bs.every((b) => b.kind === "tool_result");
        if (isToolResultOnly) {
          // Tool results are rendered nested under their tool_use; suppress the user wrapper.
          return null;
        }
        // SDK-injected <task-notification> wrappers are valid model context
        // but pure noise in the transcript — see `isSyntheticTaskNotification`
        // in `lib/client/use-session.ts` for the same filter on the live path.
        if (isUser && /^\s*<task-notification[\s>]/.test(userText)) {
          return null;
        }
        if (isUser) {
          return (
            <div key={m.uuid} data-message-uuid={m.uuid} data-message-role="user" className="group flex justify-end">
              <div className="max-w-[80%] rounded-2xl border border-[var(--border)] bg-[var(--panel-2)] px-4 py-2 text-sm leading-6">
                {userText === "" ? (
                  userText
                ) : (
                  // Claude Code 2.1.234 parity, applied to the historic
                  // transcript view too (found in adversarial review — the
                  // live `UserMessage.tsx` path got the Markdown upgrade
                  // first, but this second, independent renderer of the
                  // same user-turn content was otherwise left inconsistent:
                  // a past session's code-fenced prompt would render as
                  // highlighted markdown live, then revert to a literal
                  // ```-fenced wall of text once the session was reopened
                  // from history). `allowExecute={false}` for the same
                  // reason as `UserMessage.tsx`: this text isn't
                  // model-authored, so the `!`-mode Execute button doesn't
                  // apply.
                  <Markdown breaks literalAsterisks allowExecute={false}>
                    {userText}
                  </Markdown>
                )}
                {onRewind && (
                  <div className="mt-2 flex justify-end">
                    <button
                      onClick={() => onRewind(m.uuid)}
                      disabled={rewinding === m.uuid}
                      className="text-[10px] text-[var(--muted)] opacity-0 transition group-hover:opacity-100 hover:text-[var(--foreground)] disabled:opacity-40"
                    >
                      {rewinding === m.uuid ? "Forking…" : "↺ Rewind here"}
                    </button>
                  </div>
                )}
              </div>
            </div>
          );
        }
        return (
          <div key={m.uuid} data-message-uuid={m.uuid} data-message-role="assistant">
            <div className="mb-1 flex items-center gap-2 text-[11px] text-[var(--muted)]">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
              Claude
            </div>
            <div className="space-y-2 text-sm leading-7">
              {bs.map((b, i) => {
                if (b.kind === "text")
                  return (
                    <div key={i}>
                      <Markdown math>{b.text}</Markdown>
                    </div>
                  );
                if (b.kind === "thinking")
                  return (
                    <details key={i} className="rounded-md border border-[var(--border)] bg-[var(--panel)]/50 text-xs text-[var(--muted)]">
                      <summary className="cursor-pointer px-3 py-1.5">
                        <ChevronRight className="inline h-3 w-3 align-middle" /> Thinking
                      </summary>
                      <div className="border-t border-[var(--border)] px-3 py-2 font-mono whitespace-pre-wrap">
                        {b.text}
                      </div>
                    </details>
                  );
                if (b.kind === "tool_use")
                  return (
                    <details key={i} className="rounded-md border border-[var(--border)] bg-[var(--panel)]/40 text-xs">
                      <summary className="cursor-pointer px-3 py-1.5">
                        <Wrench className="inline h-3 w-3 align-middle text-[var(--accent)]" /> {b.name}
                      </summary>
                      <pre className="max-h-60 overflow-auto rounded-b bg-[var(--panel-2)] p-2 font-mono text-xs scroll-thin">
                        {JSON.stringify(b.input, null, 2)}
                      </pre>
                    </details>
                  );
                return null;
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
