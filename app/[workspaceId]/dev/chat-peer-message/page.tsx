"use client";

/**
 * Dev-only preview: two agents in the same project coordinating over
 * cross-session `SendMessage`. This session announces which file it's about to
 * edit; the sibling session's reply lands as a collapsed peer message
 * (`PeerMessageHeader` — one-line preview, explainer tooltip, ↗ to open the
 * sender's session).
 *
 * Mounts the REAL `MessageList` (so the real `UserMessage` / `ToolCall` /
 * `PeerMessageHeader`) on the shared PreviewChrome with a fixed corpus — no
 * live session or ANTHROPIC_API_KEY. The marketing spec
 * (`tests/e2e/chat-screenshots.spec.ts` → `peer-message.png`) mocks
 * `/api/sessions/peer-source` and hovers the row to open the tooltip.
 *
 * Wrapper testid: `chat-peer-message-preview`.
 */

import { PreviewChrome } from "../_chat-chrome/PreviewChrome";
import { MessageList } from "@/components/chat/MessageList";
import type { DisplayMessage } from "@/lib/client/types";

const T0 = 1_790_900_000_000;

const PEER_BODY =
  "Fine by me — I'm only in the refund flow, nowhere near webhooks.\n" +
  "I'm editing `ledger/` and `migrations/0042_refunds.sql`. One ask: keep `recordPayment()`'s " +
  "signature as-is — refunds call it to post the reversal entry.";

function makeCorpus(): DisplayMessage[] {
  return [
    {
      uuid: "u-1",
      role: "user",
      blocks: [
        {
          kind: "text",
          text:
            "Add idempotency keys to the Stripe webhook handler — we double-booked two payments " +
            "during last night's retry storm.",
        },
      ],
      createdAt: T0,
    },
    {
      uuid: "a-1",
      role: "assistant",
      blocks: [
        {
          kind: "text",
          text:
            "Another session is open in this project, so I'll tell it which files I'm about to edit " +
            "before I start.",
        },
        {
          kind: "tool_use",
          id: "tu-send",
          name: "SendMessage",
          input: {
            to: "uds:/tmp/cc-socks/48211.sock",
            summary: "Heads-up: editing webhooks/stripe.ts",
            message:
              "Heads-up: I'm adding idempotency keys to `webhooks/stripe.ts` and a `processed_events` " +
              "table. Are you editing anywhere near there?",
          },
          result: { content: '{"success":true,"message":"Delivered to payments-7c"}' },
        },
      ],
      createdAt: T0 + 4_000,
    },
    {
      uuid: "peer-1",
      role: "user",
      blocks: [{ kind: "text", text: PEER_BODY }],
      createdAt: T0 + 41_000,
      peer: {
        from: "uds:/tmp/cc-socks/48211.sock",
        name: "payments-7c",
        pid: 48211,
        msgId: "5b0f3c1e-8a2d-4c7e-9f61-2d4b8e9a7c13",
      },
    },
    {
      uuid: "a-2",
      role: "assistant",
      blocks: [
        {
          kind: "text",
          text:
            "No overlap: they're in `ledger/` and the refunds migration. I'll keep the change to " +
            "`webhooks/stripe.ts` plus a new `migrations/0043_processed_events.sql`, and leave " +
            "`recordPayment()` untouched.",
        },
      ],
      createdAt: T0 + 44_000,
    },
  ];
}

export default function ChatPeerMessagePreview() {
  const messages = makeCorpus();
  return (
    <PreviewChrome
      activeTab="webhooks"
      tabs={[
        { id: "webhooks", label: "stripe idempotency", active: true },
        { id: "refunds", label: "refund flow" },
      ]}
      todos={[
        { label: "Tell sibling session which files I'm editing", status: "completed" },
        { label: "Add processed_events table", status: "in_progress" },
        { label: "Dedupe webhook events by Stripe event id", status: "pending" },
      ]}
    >
      <div data-testid="chat-peer-message-preview" className="relative flex min-h-0 flex-1 flex-col">
        {/* Status line */}
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--panel)] px-3 py-1.5 text-[11px] text-[var(--muted)]">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />
          <span className="rounded border border-[var(--border)] bg-[var(--panel-2)] px-1.5 py-0.5 font-medium text-[var(--foreground)]">
            Session stripe idempotency
          </span>
          <span>·</span>
          <span>Working · 2 turns</span>
        </div>
        <div className="flex min-h-0 flex-1 flex-col">
          <MessageList messages={messages} systemEntries={[]} pending={false} verbose="normal" />
        </div>
      </div>
    </PreviewChrome>
  );
}
