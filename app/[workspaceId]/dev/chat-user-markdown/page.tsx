"use client";

/**
 * Dev-only preview for Claude Code 2.1.234 parity: "your own prompts now
 * render markdown (highlighted code blocks, inline code, lists) the same
 * way replies do" (`components/chat/UserMessage.tsx` — `InlineUserText`).
 *
 * Mounts the REAL `MessageList` (and therefore the real `UserMessage` /
 * `Markdown` components) with a fixed mock corpus, the same pattern as
 * `dev/chat-verbose` — no live Claude session, no `ANTHROPIC_API_KEY`
 * required, so `tests/e2e/cc-parity-2.1.238-user-prompt-markdown.spec.ts`
 * can screenshot it deterministically.
 *
 * The corpus exercises three cases:
 *   1. `u-1` — a prompt with a fenced code block, an inline-code span, and a
 *      bullet list, to prove those now render through `Markdown` instead of
 *      a plain `whitespace-pre-wrap` block. Selected via
 *      `[data-message-uuid="u-1"]` (set by `MessageList`).
 *   2. `a-1` — a short assistant reply reusing the same shapes, so the
 *      screenshot shows both bubbles side by side for a visual "renders the
 *      same way" comparison.
 *   3. `u-2` — a plain multi-line prompt with NO blank lines between lines
 *      (the common "each thought on its own line" shape). This is the
 *      regression `Markdown`'s `breaks` prop guards against: default
 *      CommonMark would collapse single newlines into a space, silently
 *      reflowing every multi-line prompt that isn't already blank-line
 *      separated. Selected via `[data-message-uuid="u-2"]`; the spec asserts
 *      the three lines still render as three separate lines.
 *   4. `u-3` / `a-2` — a `!`-mode fenced shell block ("```bash\n!echo hi\n```"),
 *      one from the user and one from the assistant, to prove
 *      `allowExecute={false}` actually suppresses `CodeBlock`'s Execute
 *      button on user-authored text while leaving it on the assistant's
 *      (caught in adversarial review of this same change — see
 *      `Markdown.tsx`'s `allowExecute` doc comment).
 */

import { MessageList } from "@/components/chat/MessageList";
import type { DisplayMessage } from "@/lib/client/types";

function makeCorpus(): DisplayMessage[] {
  return [
    {
      uuid: "u-1",
      role: "user",
      blocks: [
        {
          kind: "text",
          text:
            "Can you refactor this?\n\n" +
            "```ts\n" +
            "function add(a, b) {\n" +
            "  return a + b;\n" +
            "}\n" +
            "```\n\n" +
            "Requirements:\n" +
            "- add types\n" +
            "- rename to `sum`\n",
        },
      ],
      createdAt: 1_700_000_000_000,
    },
    {
      uuid: "a-1",
      role: "assistant",
      blocks: [
        {
          kind: "text",
          text:
            "Sure — here's `sum` with types:\n\n" +
            "```ts\n" +
            "function sum(a: number, b: number): number {\n" +
            "  return a + b;\n" +
            "}\n" +
            "```\n\n" +
            "Changes:\n" +
            "- renamed `add` to `sum`\n" +
            "- added `number` parameter and return types\n",
        },
      ],
      createdAt: 1_700_000_001_000,
    },
    {
      uuid: "u-2",
      role: "user",
      blocks: [
        {
          kind: "text",
          text: "First line.\nSecond line.\nThird line.",
        },
      ],
      createdAt: 1_700_000_002_000,
    },
    {
      uuid: "u-3",
      role: "user",
      blocks: [
        {
          kind: "text",
          text: "```bash\n!echo hi\n```",
        },
      ],
      createdAt: 1_700_000_003_000,
    },
    {
      uuid: "a-2",
      role: "assistant",
      blocks: [
        {
          kind: "text",
          text: "```bash\n!echo hi\n```",
        },
      ],
      createdAt: 1_700_000_004_000,
    },
  ];
}

export default function ChatUserMarkdownPreview() {
  const messages = makeCorpus();

  return (
    <div
      data-testid="user-markdown-preview-root"
      className="flex h-screen w-screen flex-col bg-[var(--background)] text-[var(--foreground)]"
    >
      <header className="shrink-0 border-b border-[var(--border)] bg-[var(--panel)] px-4 py-2 text-xs text-[var(--muted)]">
        CC 2.1.234 parity preview — user prompts render markdown
      </header>
      <main
        data-testid="user-markdown-preview-chat"
        className="flex flex-1 flex-col overflow-hidden"
      >
        <MessageList messages={messages} systemEntries={[]} pending={false} verbose="normal" />
      </main>
    </div>
  );
}
