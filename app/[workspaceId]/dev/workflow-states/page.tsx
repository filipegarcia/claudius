"use client";

/**
 * Dev-only preview: a gallery of every WorkflowBlock state, hand-rendered from
 * static fixtures so the marketing screenshot spec
 * (`tests/e2e/chat-screenshots.spec.ts` → `workflow.png`) can snap it
 * deterministically without spawning a real Claude session, running a
 * workflow, or holding an ANTHROPIC_API_KEY.
 *
 * Every card is the REAL `WorkflowBlock` — only the inputs are mocked. Updating
 * the component updates this page for free; the fixtures are snapshots of
 * intent (the live data comes from the `local_workflow` task joined by
 * tool_use_id + the parsed `meta` literal).
 *
 * Wrapper testid: `workflow-states-preview`.
 */

import { WorkflowBlock } from "@/components/chat/WorkflowBlock";
import type { TaskInfo } from "@/lib/client/types";

const SCRIPT3 = `export const meta = {
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

const SCRIPT6 = `export const meta = {
  name: 'review-changes',
  description: 'Multi-dimension review of the branch with adversarial verification',
  phases: [
    { title: 'Scope', detail: 'list changed files' },
    { title: 'Review', detail: 'one agent per dimension' },
    { title: 'Verify', detail: 'adversarial skeptics per finding' },
    { title: 'Dedup', detail: 'merge overlapping findings' },
    { title: 'Synthesize', detail: 'rank and write up' },
    { title: 'Report', detail: 'post inline PR comments' },
  ],
}`;

const SCRIPT_LONG = `export const meta = {
  name: 'comprehensive-multi-repo-security-audit-and-remediation-pipeline',
  description: 'Audit every repo, triage findings, and open remediation PRs',
  phases: [{ title: 'Audit' }, { title: 'Triage' }, { title: 'Remediate' }],
}`;

const PARTIAL =
  '{"script": "export const meta = {\\n  name: \'announce-claudius\',\\n  description: \'Research the lates';

function task(over: Partial<TaskInfo>): TaskInfo {
  return {
    taskId: "t",
    toolUseId: "tu",
    workflowName: "announce-claudius",
    description: "announce-claudius",
    taskType: "local_workflow",
    status: "running",
    totalTokens: 528855,
    toolUses: 180,
    durationMs: 245_000,
    ...over,
  };
}

const doneResult = {
  content: JSON.stringify({
    status: "async_launched",
    taskId: "ws9wwsm3s",
    runId: "wf_9bc88a59ea0",
    summary: "Wrote 3 launch blurbs from the 'fastest-path-to-Claude-in-the-browser' angle.",
    transcriptDir: "/Users/x/.claude/projects/-x/subagents/workflows/wf_9bc88a59-ea0",
  }),
};

function Lane({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="w-full">
      <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-[var(--muted)]">
        {label}
      </div>
      {children}
    </div>
  );
}

export default function WorkflowStatesPreview() {
  return (
    <div
      data-testid="workflow-states-preview"
      className="min-h-screen bg-[var(--background)] p-10 text-[var(--foreground)]"
    >
      <div className="mx-auto max-w-[1480px]">
        <h1 className="mb-1 text-lg font-semibold tracking-tight">Workflow states</h1>
        <p className="mb-7 text-sm text-[var(--muted)]">
          The dynamic-workflow tool, rendered inline in the chat transcript — every state.
        </p>
        <div className="grid grid-cols-1 gap-x-10 gap-y-7 lg:grid-cols-2">
          <Lane label="Streaming — was the raw __partial blob">
            <WorkflowBlock toolUseId="a" input={{ __partial: PARTIAL }} defaultOpen />
          </Lane>

          <Lane label="Pending — queued, not started">
            <WorkflowBlock
              toolUseId="b"
              input={{ script: SCRIPT3 }}
              task={task({ status: "pending", totalTokens: undefined, toolUses: undefined, durationMs: undefined })}
              defaultOpen
            />
          </Lane>

          <Lane label="Running — live aggregate progress">
            <WorkflowBlock
              toolUseId="c"
              input={{ script: SCRIPT3 }}
              task={task({ summary: "Synthesize copy: judging 3 candidate angles for the strongest hook" })}
              defaultOpen
            />
          </Lane>

          <Lane label="Completed — parsed WorkflowOutput + args + script">
            <WorkflowBlock
              toolUseId="d"
              input={{ script: SCRIPT3, args: { topic: "v0.9 release" } }}
              result={doneResult}
              task={task({ status: "completed", durationMs: 412_000 })}
              defaultOpen
            />
          </Lane>

          <Lane label="Failed — error surfaced">
            <WorkflowBlock
              toolUseId="e"
              input={{ script: SCRIPT3 }}
              task={task({ status: "failed", error: "Agent 'synthesize:description' exceeded the token budget (50k).", durationMs: 88_000 })}
              defaultOpen
            />
          </Lane>

          <Lane label="Stopped — cancelled mid-run">
            <WorkflowBlock
              toolUseId="f"
              input={{ script: SCRIPT3 }}
              result={{ content: JSON.stringify({ status: "async_launched", runId: "wf_abc", summary: "Stopped by user after the Research phase." }) }}
              task={task({ status: "stopped", durationMs: 61_000 })}
              defaultOpen
            />
          </Lane>

          <Lane label="Many phases (6) — running">
            <WorkflowBlock
              toolUseId="g"
              input={{ script: SCRIPT6 }}
              task={task({ workflowName: "review-changes", description: "review-changes", summary: "Verify: 3 skeptics refuting finding #4", totalTokens: 1_204_330, toolUses: 421, durationMs: 533_000 })}
              defaultOpen
            />
          </Lane>

          <Lane label="Named workflow — no script, minimal">
            <WorkflowBlock
              toolUseId="h"
              input={{ name: "find-flaky-tests" }}
              task={task({ workflowName: "find-flaky-tests", description: "find-flaky-tests", summary: "Re-running 12 candidate specs with extra logging", totalTokens: 96_400, toolUses: 33, durationMs: 41_000 })}
              defaultOpen
            />
          </Lane>

          <Lane label="Replayed history — no live task (meta + script only)">
            <WorkflowBlock toolUseId="i" input={{ script: SCRIPT3 }} result={doneResult} defaultOpen />
          </Lane>

          <Lane label="Long name — header truncates">
            <WorkflowBlock
              toolUseId="j"
              input={{ script: SCRIPT_LONG }}
              task={task({ workflowName: "comprehensive-multi-repo-security-audit-and-remediation-pipeline", description: "audit", summary: "Triage: classifying 38 CodeQL alerts", totalTokens: 2_010_900, toolUses: 712, durationMs: 1_812_000 })}
              defaultOpen
            />
          </Lane>

          <Lane label="Collapsed — running one-liner">
            <WorkflowBlock
              toolUseId="k"
              input={{ script: SCRIPT3 }}
              task={task({ summary: "x" })}
              defaultOpen={false}
            />
          </Lane>

          <Lane label="Collapsed — completed one-liner">
            <WorkflowBlock
              toolUseId="l"
              input={{ script: SCRIPT3 }}
              result={doneResult}
              task={task({ status: "completed", durationMs: 412_000 })}
              defaultOpen={false}
            />
          </Lane>
        </div>
      </div>
    </div>
  );
}
