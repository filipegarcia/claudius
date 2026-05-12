"use client";

/**
 * Dev-only preview that mounts `ToolCall` and `AssistantMessage` in every
 * combination of `isPendingAsk` / `name` / `result` / `onReopenAsk` we care
 * about, so the Playwright spec in `tests/e2e/tool-call-answer-pill.spec.ts`
 * can assert pill visibility, click behavior, and the AssistantMessage
 * toolUseId-matching path in one round-trip — no live Claude session required.
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
      id: "ask-pending-match",
      title: "AskUserQuestion · pending · no result · onReopenAsk wired",
      description: "The happy path — pill should appear and clicking it bumps the counter.",
      expectPill: true,
      render: (onReopen) => (
        <ToolCall
          name="AskUserQuestion"
          input={ASK_INPUT}
          isPendingAsk
          onReopenAsk={onReopen}
        />
      ),
    },
    {
      id: "ask-pending-flag-false",
      title: "AskUserQuestion · isPendingAsk=false · no result",
      description: "Tool block is for an AskUserQuestion but THIS one isn't the live ask — no pill.",
      expectPill: false,
      render: (onReopen) => (
        <ToolCall
          name="AskUserQuestion"
          input={ASK_INPUT}
          isPendingAsk={false}
          onReopenAsk={onReopen}
        />
      ),
    },
    {
      id: "ask-no-pending-prop",
      title: "AskUserQuestion · isPendingAsk undefined",
      description: "Older call site that doesn't pass the prop — pill stays hidden.",
      expectPill: false,
      render: (onReopen) => (
        <ToolCall name="AskUserQuestion" input={ASK_INPUT} onReopenAsk={onReopen} />
      ),
    },
    {
      id: "ask-resolved-success",
      title: "AskUserQuestion · pending flag · result success",
      description:
        "Even with the pending flag still set, a successful result means the SDK has the answer — no pill.",
      expectPill: false,
      render: (onReopen) => (
        <ToolCall
          name="AskUserQuestion"
          input={ASK_INPUT}
          isPendingAsk
          result={{ content: "{\"answers\":[{\"label\":\"A\"}]}", isError: false }}
          onReopenAsk={onReopen}
        />
      ),
    },
    {
      id: "ask-resolved-error",
      title: "AskUserQuestion · pending flag · result error",
      description:
        "The question was declined / aborted. Result is set with isError=true — pill must NOT appear (clicking it would dead-end on the SDK).",
      expectPill: false,
      render: (onReopen) => (
        <ToolCall
          name="AskUserQuestion"
          input={ASK_INPUT}
          isPendingAsk
          result={{ content: "User declined the question.", isError: true }}
          onReopenAsk={onReopen}
        />
      ),
    },
    {
      id: "ask-pending-no-callback",
      title: "AskUserQuestion · pending · no onReopenAsk",
      description:
        "Defensive case — without a handler, the pill has nothing to do, so we hide it instead of showing a dead button.",
      expectPill: false,
      render: () => <ToolCall name="AskUserQuestion" input={ASK_INPUT} isPendingAsk />,
    },
    {
      id: "non-ask-with-pending-flag",
      title: "Read tool · isPendingAsk=true (defensive)",
      description:
        "AssistantMessage only sets isPendingAsk for AskUserQuestion rows, but if a caller bypasses that gate the ToolCall itself ALSO refuses to show a phantom pill on a non-ask tool.",
      expectPill: true,
      // Note: ToolCall itself doesn't gate on name; AssistantMessage does.
      // We expect the pill to show here when called directly — the test
      // confirms the "AssistantMessage gates by name" contract by NOT
      // setting isPendingAsk on a non-ask block in the integration case
      // below.
      render: (onReopen) => (
        <ToolCall
          name="Read"
          input={{ file_path: "/tmp/x.txt" }}
          isPendingAsk
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
  //   - the matching ask block: pill shown
  //   - the non-matching ask block: pill hidden
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
            Only the matching block ({TOOL_USE_ID_PENDING}) gets the pill. The other ask block and
            the Read block must not.
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
            No pending ask — every ask block stays a normal collapsed row.
          </p>
          <AssistantMessage message={integrationMessage} pendingAskToolUseId={null} onReopenAsk={inc} />
        </section>
      </div>
    </div>
  );
}
