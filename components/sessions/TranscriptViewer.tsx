"use client";

import { useMemo } from "react";
import { ChevronRight, Wrench } from "lucide-react";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { Markdown } from "@/components/chat/Markdown";

type Props = {
  messages: SessionMessage[];
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

export function TranscriptViewer({ messages, onRewind, rewinding }: Props) {
  const display = useMemo(
    () =>
      messages.filter((m) => m.type === "assistant" || m.type === "user" || m.type === "system"),
    [messages],
  );
  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 px-4 py-6">
      {display.map((m) => {
        const inner = (m.message as { content?: unknown }) ?? {};
        const bs = blocks(inner.content);
        if (m.type === "system") {
          return (
            <div key={m.uuid} className="text-[11px] text-[var(--muted)]">
              <span className="opacity-60">— system —</span>
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
            <div key={m.uuid} className="group flex justify-end">
              <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl border border-[var(--border)] bg-[var(--panel-2)] px-4 py-2 text-sm leading-6">
                {userText}
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
          <div key={m.uuid}>
            <div className="mb-1 flex items-center gap-2 text-[11px] text-[var(--muted)]">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
              Claude
            </div>
            <div className="space-y-2 text-sm leading-7">
              {bs.map((b, i) => {
                if (b.kind === "text")
                  return (
                    <div key={i}>
                      <Markdown>{b.text}</Markdown>
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
