"use client";

/**
 * Dev-only preview for `components/sessions/TranscriptViewer.tsx`'s user-turn
 * markdown rendering — the second, independent renderer of historic session
 * content (reachable from a session's detail/history route), found during
 * adversarial review of the CC 2.1.234 "user prompts render markdown" parity
 * work to be inconsistent with the live-chat path (`UserMessage.tsx`): a past
 * session's code-fenced prompt rendered as highlighted markdown live, but
 * reverted to a literal ```-fenced wall of text once the session was reopened
 * from history.
 *
 * Mounts the REAL `TranscriptViewer` component directly with a hand-built
 * `SessionMessage[]` fixture (its actual prop shape — no session-store fetch
 * involved), the same "real component + mock data, no live agent" pattern as
 * `dev/chat-verbose` and `dev/chat-user-markdown`.
 *
 * The fixture exercises:
 *   - `u-1` — a user turn with a fenced code block + list, to prove it now
 *     renders through `Markdown` instead of a plain `whitespace-pre-wrap`
 *     block. Selected via `[data-message-uuid="u-1"]`.
 *   - `u-2` — a user turn with a `!`-mode shell fence, to prove
 *     `allowExecute={false}` suppresses the Execute button here too (the
 *     same regression class as `UserMessage.tsx`, in this second renderer).
 *   - `a-1` — an assistant turn with the same `!`-mode fence, to prove the
 *     Execute button still renders on the assistant path.
 */

import { TranscriptViewer } from "@/components/sessions/TranscriptViewer";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";

function userMessage(uuid: string, text: string): SessionMessage {
  return {
    type: "user",
    uuid,
    session_id: "s-preview",
    parent_tool_use_id: null,
    parent_agent_id: null,
    message: { content: [{ type: "text", text }] },
  };
}

function assistantMessage(uuid: string, text: string): SessionMessage {
  return {
    type: "assistant",
    uuid,
    session_id: "s-preview",
    parent_tool_use_id: null,
    parent_agent_id: null,
    message: { content: [{ type: "text", text }] },
  };
}

function makeMessages(): SessionMessage[] {
  return [
    userMessage(
      "u-1",
      "Can you refactor this?\n\n```ts\nfunction add(a, b) {\n  return a + b;\n}\n```\n\nRequirements:\n- add types\n- rename to `sum`\n",
    ),
    assistantMessage(
      "a-0",
      "Sure — here's `sum` with types:\n\n```ts\nfunction sum(a: number, b: number): number {\n  return a + b;\n}\n```\n",
    ),
    userMessage("u-2", "```bash\n!echo hi\n```"),
    assistantMessage("a-1", "```bash\n!echo hi\n```"),
  ];
}

export default function TranscriptViewerMarkdownPreview() {
  const messages = makeMessages();

  return (
    <div
      data-testid="transcript-viewer-markdown-preview-root"
      className="flex h-screen w-screen flex-col overflow-hidden bg-[var(--background)] text-[var(--foreground)]"
    >
      <header className="shrink-0 border-b border-[var(--border)] bg-[var(--panel)] px-4 py-2 text-xs text-[var(--muted)]">
        CC 2.1.234 parity preview — TranscriptViewer user-turn markdown
      </header>
      <div data-testid="transcript-viewer-markdown-preview-body" className="flex-1 overflow-y-auto">
        <TranscriptViewer messages={messages} />
      </div>
    </div>
  );
}
