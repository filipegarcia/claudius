"use client";

/**
 * Dev-only preview: a chat with a COMPLETED workflow (args + parsed
 * WorkflowOutput result) inline, on the shared `PreviewChrome` — CC
 * 2.1.259/2.1.260 parity screenshot target for the syntax-colored JSON
 * rendering in `WorkflowBlock`'s "Args" / "Raw output" disclosures
 * (`tests/e2e/cc-parity-2.1.260-workflow-json-pretty.spec.ts`).
 *
 * Distinct from `/dev/chat-workflow` (a RUNNING workflow, script-only,
 * feeds the committed `workflow.png` marketing shot) — kept separate so
 * this fixture is free to add args/result without touching that golden
 * screenshot's fixture data.
 *
 * Wrapper testid: `chat-workflow-completed-preview`.
 */

import { PreviewChrome } from "../_chat-chrome/PreviewChrome";
import { WorkflowBlock } from "@/components/chat/WorkflowBlock";
import type { TaskInfo } from "@/lib/client/types";

const SCRIPT = `export const meta = {
  name: 'announce-claudius',
  description: 'Research the latest Claudius release and write launch copy',
  phases: [
    { title: 'Research', detail: 'fan out web searches over the changelog' },
    { title: 'Synthesize', detail: 'judge panel picks the strongest angle' },
    { title: 'Write', detail: 'draft three blurbs from the winning angle' },
  ],
}
const findings = await parallel(SEARCHES.map((q) => () => agent(q, { schema: S })))
return { blurbs }`;

const TASK: TaskInfo = {
  taskId: "ws9wwsm3s",
  toolUseId: "tu-workflow-done",
  workflowName: "announce-claudius",
  description: "announce-claudius",
  taskType: "local_workflow",
  status: "completed",
  totalTokens: 528_855,
  toolUses: 180,
  durationMs: 412_000,
};

const RESULT = {
  content: JSON.stringify({
    status: "async_launched",
    taskId: "ws9wwsm3s",
    runId: "wf_9bc88a59ea0",
    summary: "Wrote 3 launch blurbs from the 'fastest-path-to-Claude-in-the-browser' angle.",
    transcriptDir: "/Users/x/.claude/projects/-x/subagents/workflows/wf_9bc88a59-ea0",
    confirmed: true,
    findings: 3,
  }),
};

export default function ChatWorkflowCompletedPreview() {
  return (
    <PreviewChrome
      activeTab="98a3c4f1"
      tabs={[{ id: "98a3c4f1", label: "98a3c4f1", active: true }]}
    >
      <div data-testid="chat-workflow-completed-preview" className="relative flex h-full flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--panel)] px-3 py-1.5 text-[11px] text-[var(--muted)]">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />
          <span className="rounded border border-[var(--border)] bg-[var(--panel-2)] px-1.5 py-0.5 font-medium text-[var(--foreground)]">
            Session 98a3c4f1
          </span>
          <span>·</span>
          <span>Idle — 1 turn · 6m 52s</span>
        </div>

        <div className="flex-1 overflow-hidden">
          <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-6">
            <div className="flex justify-end">
              <div className="max-w-[80%] rounded-2xl border border-[var(--border)] bg-[var(--panel-2)] px-4 py-2 text-sm leading-6">
                Write launch copy for the latest release.
              </div>
            </div>

            <div>
              <div className="mb-1 flex items-center gap-2 text-[11px] font-medium text-[var(--muted)]">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
                Claude
              </div>
              <div className="text-sm leading-7 text-[var(--foreground)]">
                Done — three blurbs from the strongest angle, verified against the changelog.
              </div>
              <WorkflowBlock
                toolUseId="tu-workflow-done"
                input={{ script: SCRIPT, args: { topic: "v0.9 release", tone: "confident, no hype" } }}
                result={RESULT}
                task={TASK}
                defaultOpen
              />
            </div>
          </div>
        </div>
      </div>
    </PreviewChrome>
  );
}
