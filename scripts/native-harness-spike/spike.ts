/**
 * scripts/native-harness-spike/spike.ts — PROOF OF CONCEPT, not wired into the app.
 *
 * Companion to docs/native-harness-feasibility.md. Proves the one thing the
 * feasibility study has to de-risk: that a hand-rolled agent loop on the RAW
 * Messages API (`@anthropic-ai/sdk`) — i.e. WITHOUT `query()` from the Claude
 * Agent SDK — can run a full tool-use round-trip:
 *
 *   1. send a prompt + a tool schema the model is allowed to call,
 *   2. detect `stop_reason === "tool_use"`,
 *   3. execute the tool OURSELVES (this is the work the SDK hides),
 *   4. feed a `tool_result` back, and
 *   5. loop until the model stops with a final text answer.
 *
 * Everything the SDK gives for free — the tool *implementation* (here a tiny
 * `Read`), permission gating, hooks, streaming-to-UI — is stubbed inline and
 * annotated with the production gap. This is the ~5% (the loop) made concrete
 * so the ~95% (the harness) in the doc is grounded in something real.
 *
 * Run:  ANTHROPIC_API_KEY=… bun scripts/native-harness-spike/spike.ts <file>
 * NOTE: authored + type-checked only. NOT run live here (no API creds in this
 * env, and — see §4.9 of the doc — the raw API key path is NOT the same as the
 * SDK's Claude-subscription auth, which is the headline blocker).
 */
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const MODEL = process.env.NATIVE_SPIKE_MODEL ?? "claude-sonnet-4-6";
const ROOT = process.cwd();
const MAX_TURNS = 8;

// --- The single built-in tool we reimplement natively. ---------------------
// In the SDK this (and ~15 siblings) is implemented inside `query()`. Here we
// own the schema AND the implementation. GAP: real Read does line ranges,
// image/notebook handling, size caps, and path-safety; we do the naive thing.
const READ_TOOL: Anthropic.Tool = {
  name: "Read",
  description: "Read a UTF-8 text file from the workspace and return its contents.",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path relative to the workspace root." },
    },
    required: ["path"],
  },
};

// GAP: production would route this through Claudius's permission UI
// (CanUseTool equivalent) BEFORE executing, and through lib/server/safe-path.ts.
function permit(toolName: string, input: Record<string, unknown>): boolean {
  // Minimal allow-list + traversal guard standing in for the permission layer.
  if (toolName !== "Read") return false;
  const p = String(input.path ?? "");
  const abs = resolve(ROOT, p);
  return abs.startsWith(ROOT);
}

function runRead(input: { path?: string }): string {
  const abs = resolve(ROOT, String(input.path ?? ""));
  if (!abs.startsWith(ROOT)) throw new Error("path escapes workspace root");
  return readFileSync(abs, "utf8").slice(0, 20_000);
}

// --- The hand-rolled agent loop (the part `query()` normally owns). ---------
async function runNativeLoop(client: Anthropic, userPrompt: string): Promise<string> {
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userPrompt },
  ];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      // GAP: the SDK assembles a large dynamic system prompt
      // (SYSTEM_PROMPT_DYNAMIC_BOUNDARY, CLAUDE.md, tool docs). We send a stub.
      system: "You are a coding assistant. Use the Read tool when you need file contents.",
      tools: [READ_TOOL],
      messages,
    });

    // GAP: real impl streams these blocks to the Claudius UI as they arrive
    // (anthropic.messages.stream); here we take the whole message.
    messages.push({ role: "assistant", content: res.content });

    if (res.stop_reason !== "tool_use") {
      const text = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      return text || "(no text)";
    }

    // Execute every tool_use block this turn requested, collect tool_results.
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of res.content) {
      if (block.type !== "tool_use") continue;
      const input = (block.input ?? {}) as Record<string, unknown>;
      let resultText: string;
      let isError = false;
      try {
        if (!permit(block.name, input)) throw new Error(`denied by permission layer: ${block.name}`);
        resultText = runRead(input as { path?: string });
      } catch (err) {
        resultText = err instanceof Error ? err.message : String(err);
        isError = true;
      }
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: resultText,
        is_error: isError,
      });
    }
    messages.push({ role: "user", content: toolResults });
  }

  return `(hit MAX_TURNS=${MAX_TURNS} without a final answer)`;
}

async function main(): Promise<void> {
  const target = process.argv[2] ?? "package.json";
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      "ANTHROPIC_API_KEY is not set. This spike needs the raw Messages API key.\n" +
        "See docs/native-harness-feasibility.md §4.9: this is NOT the SDK's\n" +
        "Claude-subscription auth, which is the headline blocker for going native.",
    );
    process.exit(2);
  }
  const client = new Anthropic();
  const answer = await runNativeLoop(
    client,
    `Read the file "${target}" and tell me, in one sentence, what it is.`,
  );
  console.log("\n=== final answer ===\n" + answer);
}

void main();
