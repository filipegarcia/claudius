"use client";

/**
 * Dev-only preview that mounts `ToolCall` and `AssistantMessage` in every
 * combination of `liveAsk` / `name` / `result` / `onReopenAsk` we care
 * about, so the Playwright spec in `tests/e2e/tool-call-answer-pill.spec.ts`
 * can assert pill visibility, click behavior, and the AssistantMessage
 * toolUseId-matching path in one round-trip — no live Claude session required.
 *
 * The pill renders on every AskUserQuestion row that has an `onReopenAsk`
 * handler — even historic / errored ones. The visual distinction is encoded
 * via the `liveAsk` flag (pulse + "Answer" label) vs. historic (no pulse,
 * "Reopen" label). See the README at the top of `ToolCall.tsx` for the
 * "AssistantMessage gates by name; ToolCall trusts its caller" contract.
 *
 * Each card sits behind a unique `data-testid="case:<name>"` wrapper. The
 * reopen-click counter is exposed via `data-reopen-count` on the page root
 * so tests can assert it without poking React internals.
 */

import { useState } from "react";
import { ToolCall } from "@/components/chat/ToolCall";
import { AssistantMessage } from "@/components/chat/AssistantMessage";
import type { DisplayMessage } from "@/lib/client/types";

type Case = {
  id: string;
  title: string;
  description: string;
  expectPill: boolean;
  render: (onReopen: () => void) => React.ReactNode;
};

const TOOL_USE_ID_PENDING = "toolu_pending";
const TOOL_USE_ID_OTHER = "toolu_other";

const ASK_INPUT = {
  questions: [{ question: "Pick a thing", options: [{ label: "A" }, { label: "B" }] }],
};

export default function ToolCallPreviewPage() {
  // A single counter is enough — each test case clicks at most once and we
  // assert the delta, so there's no need to track per-case counts.
  const [reopenCount, setReopenCount] = useState(0);
  const inc = () => setReopenCount((n) => n + 1);

  const cases: Case[] = [
    {
      id: "ask-live-match",
      title: "AskUserQuestion · liveAsk · no result · onReopenAsk wired",
      description: "The pulsing Answer pill — the SDK is actively waiting on this row.",
      expectPill: true,
      render: (onReopen) => (
        <ToolCall
          name="AskUserQuestion"
          input={ASK_INPUT}
          liveAsk
          onReopenAsk={onReopen}
        />
      ),
    },
    {
      id: "ask-historic-no-result",
      title: "AskUserQuestion · liveAsk=false · no result",
      description:
        "Historic ask: not the live one, but still resurrectable. Non-pulsing 'Reopen' pill.",
      expectPill: true,
      render: (onReopen) => (
        <ToolCall
          name="AskUserQuestion"
          input={ASK_INPUT}
          liveAsk={false}
          onReopenAsk={onReopen}
        />
      ),
    },
    {
      id: "ask-no-liveask-prop",
      title: "AskUserQuestion · liveAsk undefined",
      description:
        "Caller didn't pass liveAsk — pill still shows (historic variant) because the row IS an ask and a handler is wired.",
      expectPill: true,
      render: (onReopen) => (
        <ToolCall name="AskUserQuestion" input={ASK_INPUT} onReopenAsk={onReopen} />
      ),
    },
    {
      id: "ask-resolved-success",
      title: "AskUserQuestion · liveAsk · result success",
      description:
        "Even with a successful result, the pill remains — the user may still want to revisit what was asked or send a follow-up answer.",
      expectPill: true,
      render: (onReopen) => (
        <ToolCall
          name="AskUserQuestion"
          input={ASK_INPUT}
          liveAsk
          result={{ content: "{\"answers\":[{\"label\":\"A\"}]}", isError: false }}
          onReopenAsk={onReopen}
        />
      ),
    },
    {
      id: "ask-resolved-error",
      title: "AskUserQuestion · result error (declined / aborted)",
      description:
        "Permission stream commonly closes before the user answers (the SDK records an error tool_result). Pill must STILL appear so the user can resurrect the modal — submitting goes through as a regular follow-up message.",
      expectPill: true,
      render: (onReopen) => (
        <ToolCall
          name="AskUserQuestion"
          input={ASK_INPUT}
          result={{ content: "User declined the question.", isError: true }}
          onReopenAsk={onReopen}
        />
      ),
    },
    {
      id: "ask-no-callback",
      title: "AskUserQuestion · no onReopenAsk",
      description:
        "Defensive case — without a handler, the pill has nothing to do, so we hide it instead of showing a dead button.",
      expectPill: false,
      render: () => <ToolCall name="AskUserQuestion" input={ASK_INPUT} liveAsk />,
    },
    {
      id: "non-ask-with-liveask-flag",
      title: "Read tool · liveAsk=true (defensive)",
      description:
        "ToolCall ALSO gates on `name === 'AskUserQuestion'` — even if a caller bypasses AssistantMessage's gate and sets liveAsk on a non-ask row, no pill renders.",
      expectPill: false,
      render: (onReopen) => (
        <ToolCall
          name="Read"
          input={{ file_path: "/tmp/x.txt" }}
          liveAsk
          onReopenAsk={onReopen}
        />
      ),
    },
  ];

  // ── Integration cases via AssistantMessage ─────────────────────────────
  //
  // Render an assistant turn that contains TWO AskUserQuestion tool_use
  // blocks (different toolUseIds) plus a non-ask tool. The page passes
  // `pendingAskToolUseId = TOOL_USE_ID_PENDING`, and we expect:
  //   - the matching ask block: live pill (pulsing)
  //   - the non-matching ask block: historic pill (still visible, no pulse)
  //   - the non-ask block: pill hidden (gated by name in AssistantMessage)
  const integrationMessage: DisplayMessage = {
    uuid: "integration-turn",
    role: "assistant",
    blocks: [
      { kind: "text", text: "Let me ask you a couple of things." },
      {
        kind: "tool_use",
        id: TOOL_USE_ID_PENDING,
        name: "AskUserQuestion",
        input: ASK_INPUT,
      },
      {
        kind: "tool_use",
        id: TOOL_USE_ID_OTHER,
        name: "AskUserQuestion",
        input: ASK_INPUT,
      },
      {
        kind: "tool_use",
        id: "toolu_non_ask",
        name: "Read",
        input: { file_path: "/tmp/x.txt" },
      },
    ],
  };

  return (
    <div
      className="min-h-screen bg-[var(--background)] p-8 text-[var(--foreground)]"
      data-reopen-count={reopenCount}
      data-testid="tool-call-preview-root"
    >
      <h1 className="mb-4 text-xl font-semibold">ToolCall · Answer pill matrix</h1>
      <p className="mb-6 text-sm text-[var(--muted)]">
        Reopen counter: <span data-testid="reopen-count">{reopenCount}</span>
      </p>
      <div className="space-y-6">
        {cases.map((c) => (
          <section key={c.id} data-testid={`case:${c.id}`}>
            <h2 className="text-sm font-medium">{c.title}</h2>
            <p className="mb-2 text-xs text-[var(--muted)]">{c.description}</p>
            <div data-testid={`case-body:${c.id}`}>{c.render(inc)}</div>
            <div className="mt-1 text-[10px] text-[var(--muted)]">
              expected-pill: <code data-testid={`case-expect:${c.id}`}>{String(c.expectPill)}</code>
            </div>
          </section>
        ))}

        <hr className="border-[var(--border)]" />

        <section data-testid="case:integration-matching">
          <h2 className="text-sm font-medium">
            AssistantMessage · pendingAskToolUseId matches one of two ask blocks
          </h2>
          <p className="mb-2 text-xs text-[var(--muted)]">
            Both ask blocks render a pill — the matching one ({TOOL_USE_ID_PENDING}) in the
            pulsing &quot;live&quot; variant, the other in the static &quot;Reopen&quot; variant. The
            Read block stays plain.
          </p>
          <AssistantMessage
            message={integrationMessage}
            pendingAskToolUseId={TOOL_USE_ID_PENDING}
            onReopenAsk={inc}
          />
        </section>

        <section data-testid="case:integration-no-match">
          <h2 className="text-sm font-medium">AssistantMessage · pendingAskToolUseId null</h2>
          <p className="mb-2 text-xs text-[var(--muted)]">
            No live ask — both ask blocks still get a pill (historic / Reopen variant). The
            Read block stays plain.
          </p>
          <AssistantMessage message={integrationMessage} pendingAskToolUseId={null} onReopenAsk={inc} />
        </section>
      </div>
    </div>
  );
}
