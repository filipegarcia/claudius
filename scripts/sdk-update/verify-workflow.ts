/**
 * scripts/sdk-update/verify-workflow.ts — manual diagnostic.
 *
 * Not run by CI (it makes a real, paid model call). Keep it as the
 * regression check for the orchestrator's `enableWorkflows` config: if a
 * future SDK bump changes how headless workflows behave, run this to see
 * it fail fast instead of discovering it on a live upgrade.
 *
 * Answers the ONE question that gates the "use dynamic workflows in the
 * SDK-update orchestration" change: in a HEADLESS `query()` loop (the
 * exact shape orchestrate.ts uses), can the agent
 *
 *   1. actually invoke the Workflow tool (enableWorkflows gate), and
 *   2. have a background workflow COMPLETE and feed its result back into
 *      the `for await` loop so the parent agent can act on it, and
 *   3. keep emitting messages while the workflow runs — i.e. would the
 *      orchestrator's 15-min idle watchdog survive?
 *
 * It runs a trivial 1-agent workflow whose only job is to echo a
 * sentinel, then checks the sentinel round-trips back to the parent.
 * Every message is timestamped so we can eyeball the silence gaps.
 *
 * Run:  bun scripts/sdk-update/verify-workflow.ts
 * (needs Claude auth — keychain creds, so invoke OUTSIDE the sandbox.)
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SENTINEL = "WORKFLOW_OK_42";
const MODEL = process.env.SDK_UPDATE_MODEL ?? "sonnet";
const HARD_TIMEOUT_MS = 6 * 60_000;

const PROMPT = `You are a connectivity probe. Do exactly this, nothing else.

Call the Workflow tool ONCE with this exact script (pass it as the \`script\` argument):

\`\`\`javascript
export const meta = { name: 'probe', description: 'connectivity probe' }
const r = await agent('Reply with exactly this token and nothing else: ${SENTINEL}', {})
return { token: r }
\`\`\`

When the workflow finishes and returns its result to you, output ONE final
line in this exact format and then stop:

PROBE_RESULT=<the token the workflow returned>

Do not do anything else. Do not read files. Do not explain.`;

function preview(msg: unknown): string {
  try {
    const m = msg as { type?: string; subtype?: string; [k: string]: unknown };
    const parts: string[] = [`type=${m.type ?? "?"}`];
    if (m.subtype) parts.push(`subtype=${m.subtype}`);
    // assistant content: surface tool_use names + text snippets
    const content = (m as { message?: { content?: unknown[] } }).message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        const b = block as { type?: string; name?: string; text?: string };
        if (b.type === "tool_use") parts.push(`tool=${b.name}`);
        else if (b.type === "text" && b.text) parts.push(`text="${b.text.replace(/\s+/g, " ").slice(0, 120)}"`);
      }
    }
    // top-level result text (final message)
    const result = (m as { result?: string }).result;
    if (typeof result === "string") parts.push(`result="${result.replace(/\s+/g, " ").slice(0, 160)}"`);
    return parts.join(" ");
  } catch {
    return JSON.stringify(msg).slice(0, 160);
  }
}

async function main(): Promise<void> {
  console.log(`[probe] model=${MODEL} enableWorkflows=true`);
  const startedAt = Date.now();
  let last = startedAt;
  let maxGapMs = 0;
  let sawWorkflowToolCall = false;
  let sentinelRoundTripped = false;
  let msgCount = 0;

  const q = query({
    prompt: PROMPT,
    options: {
      cwd: ROOT,
      model: MODEL,
      permissionMode: "default",
      canUseTool: async (_toolName: string, input: Record<string, unknown>) => ({
        behavior: "allow" as const,
        updatedInput: input,
      }),
      maxTurns: 40,
      // The whole point of the probe: does this flip the Workflow tool
      // on in a headless session, and does it run without blocking on a
      // usage warning under permissionMode "default" + autoApprove?
      settings: {
        enableWorkflows: true,
      },
      stderr: (chunk: string) => process.stderr.write(`[stderr] ${chunk}`),
    },
  });

  const timer = setTimeout(() => {
    console.error(`[probe] HARD TIMEOUT after ${HARD_TIMEOUT_MS / 1000}s — workflow never returned`);
    process.exit(3);
  }, HARD_TIMEOUT_MS);

  for await (const msg of q) {
    const now = Date.now();
    const gap = now - last;
    if (gap > maxGapMs) maxGapMs = gap;
    last = now;
    msgCount++;
    const line = preview(msg);
    console.log(`[+${((now - startedAt) / 1000).toFixed(1)}s gap=${(gap / 1000).toFixed(1)}s] ${line}`);
    if (line.includes("tool=Workflow")) sawWorkflowToolCall = true;
    if (line.includes(SENTINEL)) sentinelRoundTripped = true;
  }
  clearTimeout(timer);

  console.log("─".repeat(60));
  console.log(`[probe] messages=${msgCount}`);
  console.log(`[probe] Workflow tool invoked:   ${sawWorkflowToolCall ? "YES" : "NO"}`);
  console.log(`[probe] sentinel round-tripped:  ${sentinelRoundTripped ? "YES" : "NO"}`);
  console.log(`[probe] max silence gap:         ${(maxGapMs / 1000).toFixed(1)}s (watchdog limit is 15min=900s)`);
  const ok = sawWorkflowToolCall && sentinelRoundTripped;
  console.log(`[probe] VERDICT: ${ok ? "PASS — workflows are functional headless" : "FAIL — see above"}`);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(`[probe] threw: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(2);
});
