"use client";

/**
 * Dev-only preview: a chat mid-conversation with a dynamic workflow running
 * inline (the real WorkflowBlock). Hand-built on the shared PreviewChrome so
 * the marketing screenshot spec can capture it (`workflow.png`) without a real
 * Claude session or an ANTHROPIC_API_KEY.
 *
 * Wrapper testid: `chat-workflow-preview`.
 */

import { Loader2 } from "lucide-react";
import { PreviewChrome } from "../_chat-chrome/PreviewChrome";
import { WorkflowBlock } from "@/components/chat/WorkflowBlock";
import type { TaskInfo } from "@/lib/client/types";

const SCRIPT = `export const meta = {
  name: 'review-branch',
  description: 'Review the branch across dimensions, then adversarially verify each finding',
  phases: [
    { title: 'Review', detail: 'one agent per dimension — correctness, security, performance' },
    { title: 'Verify', detail: 'independent skeptics try to refute each finding' },
    { title: 'Report', detail: 'rank the survivors and post inline comments' },
  ],
}
const found = await parallel(DIMENSIONS.map((d) => () => agent(d.prompt, { schema: FINDINGS })))
return await pipeline(found.flat(), verifyFinding, postComment)`;

const RUNNING_TASK: TaskInfo = {
  taskId: "ws9wwsm3s",
  toolUseId: "tu-workflow",
  workflowName: "review-branch",
  description: "review-branch",
  taskType: "local_workflow",
  status: "running",
  summary: "Verify: 3 skeptics refuting a suspected auth bypass in the session middleware",
  totalTokens: 612_400,
  toolUses: 214,
  durationMs: 221_000,
};

function Chip({ children, accent }: { children: React.ReactNode; accent?: boolean }) {
  return (
    <span
      className={
        "rounded border px-1.5 py-0.5 " +
        (accent
          ? "border-[var(--accent)]/40 bg-[var(--accent)]/10 text-[var(--accent)]"
          : "border-[var(--border)] bg-[var(--panel-2)] text-[var(--muted)]")
      }
    >
      {children}
    </span>
  );
}

export default function ChatWorkflowPreview() {
  return (
    <PreviewChrome
      activeTab="98a3c4f1"
      tabs={[{ id: "98a3c4f1", label: "98a3c4f1", active: true }]}
    >
      <div data-testid="chat-workflow-preview" className="relative flex h-full flex-col">
        {/* Status line */}
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--panel)] px-3 py-1.5 text-[11px] text-[var(--muted)]">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />
          <span className="rounded border border-[var(--border)] bg-[var(--panel-2)] px-1.5 py-0.5 font-medium text-[var(--foreground)]">
            Session 98a3c4f1
          </span>
          <span>·</span>
          <span>Working — 1 turn · 4m 5s</span>
          <div className="ml-auto flex items-center gap-2">
            <Chip>⊞ Compact</Chip>
            <Chip>◇ Clear</Chip>
            <Chip accent>⚡ workflows ▾</Chip>
          </div>
        </div>

        {/* Transcript */}
        <div className="flex-1 overflow-hidden">
          <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-6">
            {/* User prompt */}
            <div className="flex justify-end">
              <div className="max-w-[80%] rounded-2xl border border-[var(--border)] bg-[var(--panel-2)] px-4 py-2 text-sm leading-6">
                Review the auth refactor on this branch before I merge — correctness, security, and
                performance. Don&apos;t trust the first pass; verify anything that looks risky.
              </div>
            </div>

            {/* Assistant turn */}
            <div>
              <div className="mb-1 flex items-center gap-2 text-[11px] font-medium text-[var(--muted)]">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
                Claude
              </div>
              <div className="text-sm leading-7 text-[var(--foreground)]">
                On it — running a review workflow: one agent per dimension, then an adversarial pass
                where independent skeptics try to refute each finding before I report back.
              </div>
              <WorkflowBlock
                toolUseId="tu-workflow"
                input={{ script: SCRIPT }}
                task={RUNNING_TASK}
                defaultOpen
              />
            </div>

            {/* Working row */}
            <div className="flex items-center gap-2 text-xs text-[var(--muted)]">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--accent)]" />
              <span className="font-medium text-[var(--foreground)]/80">Claude is working…</span>
            </div>
          </div>
        </div>
      </div>
    </PreviewChrome>
  );
}
