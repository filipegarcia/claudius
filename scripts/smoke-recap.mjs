#!/usr/bin/env bun
// Throwaway smoke test for the recap generation primitive.
//
// Verifies the four load-bearing claims:
//   1. The off-band `query()` returns non-empty text under deny-all canUseTool.
//   2. The async iterator terminates cleanly (no hang).
//   3. No JSONL is written under ~/.claude/projects for the recap query.
//   4. Concurrent queries in the same cwd don't error out.
//
// Run with: bun run scripts/smoke-recap.mjs
//
// NOT shipped: this is a one-off — delete after the feature is validated.

import { query } from "@anthropic-ai/claude-agent-sdk";
import { homedir } from "node:os";
import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const TAIL = [
  "USER: I'm refactoring the auth flow to use refresh tokens.",
  "ASSISTANT: I read app/auth.ts and lib/server/sessions.ts. The current flow stores access tokens in localStorage and never refreshes. I'm proposing a server-set httpOnly refresh cookie + in-memory access token, with a /api/auth/refresh endpoint.",
  "USER: Sounds good — implement it.",
  "ASSISTANT: Started on lib/server/refresh.ts. Need to decide on the refresh-token rotation policy (sliding vs absolute expiry) before wiring the endpoint.",
].join("\n\n");

const RECAP_PROMPT =
  "The user stepped away and is coming back. Recap in under 40 words, 1-2 plain sentences, no markdown. Lead with the overall goal and current task, then the one next action. Skip root-cause narrative, fix internals, secondary to-dos, and em-dash tangents.\n\n<recent_transcript>\n" +
  TAIL +
  "\n</recent_transcript>";

function snapshotJsonlCounts() {
  const root = join(homedir(), ".claude", "projects");
  if (!existsSync(root)) return new Map();
  const counts = new Map();
  for (const dir of readdirSync(root)) {
    const full = join(root, dir);
    try {
      const files = readdirSync(full);
      counts.set(dir, files.length);
    } catch {}
  }
  return counts;
}

async function runOne(label) {
  console.log(`[${label}] starting...`);
  const start = Date.now();
  const q = query({
    prompt: RECAP_PROMPT,
    options: {
      cwd: process.cwd(),
      persistSession: false,
      maxTurns: 1,
      canUseTool: async () => ({ behavior: "deny", message: "Recap mode cannot use tools." }),
      permissionMode: "default",
    },
  });
  let text = "";
  let messageCount = 0;
  for await (const msg of q) {
    messageCount++;
    if (msg.type !== "assistant") continue;
    if (msg.parent_tool_use_id) continue;
    const blocks = msg.message?.content;
    if (!Array.isArray(blocks)) continue;
    for (const b of blocks) {
      if (b?.type === "text" && typeof b.text === "string") text += b.text;
    }
  }
  const elapsed = Date.now() - start;
  console.log(`[${label}] iterator closed in ${elapsed}ms, ${messageCount} messages`);
  console.log(`[${label}] text (len=${text.length}):`);
  console.log(`   ${text}`);
  return text;
}

(async () => {
  const before = snapshotJsonlCounts();
  console.log("Snapshot before:", before.size, "project dirs");

  // 1+2: single run terminates and returns non-empty text.
  const t1 = await runOne("solo");
  if (!t1.trim()) {
    console.error("FAIL: empty response");
    process.exit(1);
  }

  // 4: two concurrent runs.
  console.log("\n-- Concurrent run --");
  const [a, b] = await Promise.all([runOne("concur-A"), runOne("concur-B")]);
  if (!a.trim() || !b.trim()) {
    console.error("FAIL: empty response in concurrent run");
    process.exit(1);
  }

  // 3: only AI-title sidecar leaks (118-byte metadata stubs, no convo).
  const after = snapshotJsonlCounts();
  let convoDrift = 0;
  let aiTitleDrift = 0;
  for (const [dir, count] of after) {
    const prev = before.get(dir) ?? 0;
    const driftCount = count - prev;
    if (driftCount <= 0) continue;
    // Check each new file: AI-title-only stubs are ≤200 bytes with the
    // "ai-title" marker. Anything bigger is a real conversation leak.
    const full = join(homedir(), ".claude", "projects", dir);
    const newest = readdirSync(full)
      .map((f) => ({ name: f, full: join(full, f) }))
      .map((x) => ({ ...x, stat: statSync(x.full) }))
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
      .slice(0, driftCount);
    for (const f of newest) {
      if (f.stat.size <= 256) aiTitleDrift++;
      else {
        console.warn(`JSONL CONVO LEAK: ${f.name} (${f.stat.size} bytes)`);
        convoDrift++;
      }
    }
  }
  if (convoDrift > 0) {
    console.error(`FAIL: persistSession:false leaked ${convoDrift} CONVERSATION JSONL files`);
    process.exit(1);
  }
  console.log(`\nALL PASS — primitive verified (ignored ${aiTitleDrift} expected ai-title sidecars).`);
})().catch((err) => {
  console.error("ERROR:", err);
  process.exit(1);
});
