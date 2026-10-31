#!/usr/bin/env node
// Golden fixture for `forkSession`: what the REAL TypeScript Agent SDK writes.
//
//   node rust/scripts/fork-golden.mjs
//
// For each case it writes a source transcript (plus an optional
// `custom-title.json` sidecar) under a throwaway CLAUDE_CONFIG_DIR, calls
// `forkSession()` from node_modules/@anthropic-ai/claude-agent-sdk, and records
// the forked JSONL (or the error) into
// rust/crates/claudius-core/tests/fixtures/fork_golden.json.
//
// Forks are random (new uuids, `new Date()`), so the output is normalized:
// the new session id becomes `$FORK`, every other uuid that isn't in the
// source becomes `$U1`, `$U2`, … by first appearance, and every ISO timestamp
// that isn't in the source becomes `$NOW`. `crates/claudius-core/tests/fork_golden.rs`
// runs `sessions_store::fork_file` on the same inputs, normalizes the same
// way, and compares byte for byte. Re-run after bumping the SDK.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const sdkPath = join(repo, "node_modules/@anthropic-ai/claude-agent-sdk");
const sdkVersion = JSON.parse(readFileSync(join(sdkPath, "package.json"), "utf8")).version;

const configDir = mkdtempSync(join(tmpdir(), "claudius-fork-golden-"));
process.env.CLAUDE_CONFIG_DIR = configDir;
const { forkSession } = await import(join(sdkPath, "sdk.mjs"));
const projectDir = join(configDir, "projects", "-golden-project");

const SID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const U = (n) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const ts = (n) => `2026-01-01T00:00:${String(n).padStart(2, "0")}.000Z`;
const base = (uuid, parentUuid, n) => ({
  parentUuid,
  isSidechain: false,
  cwd: "/golden/project",
  sessionId: SID,
  version: "2.1.299",
  uuid,
  timestamp: ts(n),
});
const user = (n, parent, text, extra = {}) => ({
  ...base(U(n), parent, n),
  type: "user",
  message: { role: "user", content: text },
  ...extra,
});
const asst = (n, parent, text, extra = {}) => ({
  ...base(U(n), parent, n),
  type: "assistant",
  message: { id: `msg_${n}`, role: "assistant", content: [{ type: "text", text }] },
  ...extra,
});
const progress = (n, parent) => ({ ...base(U(n), parent, n), type: "progress", data: { type: "hook_progress" } });
const system = (n, parent, subtype, extra = {}) => ({ ...base(U(n), parent, n), type: "system", subtype, ...extra });
const attachment = (n, parent, att, extra = {}) => ({ ...base(U(n), parent, n), type: "attachment", attachment: att, ...extra });
const linear = () => [user(1, null, "hello there"), asst(2, U(1), "hi"), user(3, U(2), "next"), asst(4, U(3), "done")];

// [name, transcript lines (objects or raw strings), options, sidecar title?]
const cases = [
  ["full_copy_with_title", linear(), { title: "  My fork  " }],
  ["title_from_custom_title", [...linear(), { type: "custom-title", customTitle: "Original", sessionId: SID }], {}],
  ["title_from_ai_title", [...linear(), { type: "ai-title", aiTitle: "AI named", sessionId: SID }], {}],
  ["title_from_first_prompt", linear(), {}],
  [
    "title_empty_custom_falls_to_ai",
    [{ type: "ai-title", aiTitle: "AI wins", sessionId: SID }, ...linear(), { type: "custom-title", customTitle: "", sessionId: SID }],
    {},
    "Sidecar loses",
  ],
  ["title_from_sidecar", linear(), {}, "Sidecar title"],
  [
    "title_fallback_forked_session",
    [
      user(1, null, [{ type: "tool_result", tool_use_id: "t", content: "x" }]),
      asst(2, U(1), "only a reply"),
    ],
    {},
  ],
  ["blank_title_option_derives", linear(), { title: "   " }],
  ["up_to_mid_chain", linear(), { upToMessageId: U(2) }],
  ["up_to_not_found", linear(), { upToMessageId: U(99) }],
  [
    "up_to_queued_command_source_uuid",
    [
      user(1, null, "first"),
      asst(2, U(1), "ok"),
      attachment(3, U(2), { type: "queued_command", prompt: "queued", source_uuid: U(1) }),
      attachment(4, U(3), { type: "queued_command", prompt: "other", source_uuid: U(77) }),
      user(5, U(4), "later"),
    ],
    { upToMessageId: U(77) },
  ],
  [
    "progress_bridged_and_dropped",
    [user(1, null, "go"), asst(2, U(1), "working"), progress(3, U(2)), progress(4, U(3)), user(5, U(4), "after"), asst(6, U(5), "fin")],
    {},
  ],
  [
    "progress_cycle",
    [user(1, null, "go"), progress(2, U(3)), progress(3, U(2)), asst(4, U(2), "loop")],
    {},
  ],
  [
    "sidechain_filtered",
    [user(1, null, "main"), asst(2, U(1), "side", { isSidechain: true }), asst(3, U(1), "zero", { isSidechain: 0 }), user(4, U(3), "end")],
    {},
  ],
  [
    "logical_parent_uuid",
    [
      user(1, null, "a"),
      asst(2, U(1), "b"),
      system(3, null, "compact_boundary", { logicalParentUuid: U(2), content: "Conversation compacted" }),
      user(4, U(3), "summary", { isCompactSummary: true, logicalParentUuid: U(88) }),
      asst(5, U(4), "c", { logicalParentUuid: null }),
      user(6, U(5), "d", { logicalParentUuid: 7 }),
    ],
    {},
  ],
  [
    "compact_metadata_remap",
    [
      user(1, null, "a"),
      asst(2, U(1), "b"),
      system(3, U(2), "compact_boundary", {
        compactMetadata: {
          trigger: "auto",
          preservedMessages: { anchorUuid: U(2), uuids: [U(1), U(2), U(55)], allUuids: [U(1)], keep: 1 },
          runningTurnSends: [U(1)],
          preTokens: 1000,
          preservedSegment: { headUuid: U(1), anchorUuid: U(3), tailUuid: U(2), extra: true },
          after: "x",
        },
      }),
      system(4, U(3), "compact_boundary", { compactMetadata: { preservedMessages: null, trigger: "manual" } }),
      system(5, U(4), "compact_boundary", { compactMetadata: { runningTurnSends: [] } }),
      system(6, U(5), "compact_boundary", { compactMetadata: { trigger: "untouched" } }),
      user(7, U(6), "e"),
    ],
    {},
  ],
  [
    "deferred_tools_and_refusal_fallback",
    [
      user(1, null, "a"),
      progress(2, U(1)),
      attachment(3, U(2), { type: "deferred_tools_record", nameOnlyAnnouncements: [U(1), "unknown", 5, U(2)], tools: ["x"] }),
      system(4, U(3), "model_refusal_fallback", { content: "fell back" }),
      asst(5, U(4), "z"),
    ],
    {},
  ],
  [
    "trailer_entries",
    [
      { type: "history-suppression", sessionId: OTHER, cause: "x" },
      { type: "atis-latch", sessionId: SID, atis: "OK~!" },
      { type: "atis-latch", sessionId: SID, atis: "has space" },
      { type: "atis-latch", sessionId: OTHER, atis: "OTHER" },
      { type: "content-replacement", sessionId: SID, replacements: [{ a: 1 }] },
      { type: "content-replacement", sessionId: OTHER, replacements: [{ ignored: true }] },
      ...linear(),
      { type: "content-replacement", sessionId: SID, replacements: [{ b: 2 }, "c"] },
      { type: "relocated", sessionId: SID, relocatedCwd: "/first" },
      { type: "relocated", sessionId: SID, relocatedCwd: "/second" },
      { type: "relocated", sessionId: SID, relocatedCwd: "" },
    ],
    {},
  ],
  [
    "reset_keys_and_forked_from",
    [
      user(1, null, "a", {
        teamName: "t",
        agentName: "ag",
        sessionKind: "k",
        slug: "s",
        sourceToolAssistantUUID: U(9),
        summarizedTurnPromptUuids: [U(9)],
        droppedPromptUuids: [],
        forkedFrom: { sessionId: OTHER, messageUuid: U(9) },
      }),
      asst(2, U(1), "b"),
    ],
    {},
  ],
  [
    "numbers_keys_and_odd_lines",
    [
      user(1, null, "a"),
      `  {"type":"assistant","uuid":"${U(2)}","parentUuid":"${U(1)}","sessionId":"${SID}","timestamp":"${ts(2)}","costUSD":1.0,"big":1e21,"10":1,"2":2,"message":{"id":"m","content":[]}}\r`,
      "not json at all",
      "5",
      "null",
      "[1,2]",
      `{"type":"user","uuid":7,"message":{"content":"bad uuid"}}`,
      "",
      "   ",
      user(3, U(2), "c"),
    ],
    {},
  ],
  [
    "missing_timestamps",
    [
      { type: "user", uuid: U(1), parentUuid: null, sessionId: SID, message: { role: "user", content: "no ts" } },
      { type: "assistant", uuid: U(2), parentUuid: U(1), sessionId: SID, message: { id: "m", content: [] } },
    ],
    {},
  ],
  ["duplicate_uuid", [user(1, null, "a"), asst(2, U(1), "first copy"), asst(2, U(1), "second copy"), user(3, U(2), "c")], {}],
  [
    "no_messages_only_metadata",
    [{ type: "custom-title", customTitle: "x", sessionId: SID }, { type: "summary", summary: "s" }],
    {},
  ],
  ["no_messages_all_progress", [progress(1, null), progress(2, U(1))], {}],
  ["no_messages_all_sidechain", [user(1, null, "x", { isSidechain: true })], {}],
  [
    "up_to_prunes_dead_compaction",
    [
      user(1, null, "a"),
      asst(2, U(1), "b"),
      system(3, null, "compact_boundary", { logicalParentUuid: U(2) }),
      user(4, U(3), "summary", { isCompactSummary: true }),
      asst(5, U(4), "after compact"),
      user(6, U(2), "rewound branch"),
    ],
    { upToMessageId: U(6) },
  ],
  [
    "up_to_compact_boundary",
    [
      user(1, null, "a"),
      asst(2, U(1), "b"),
      system(3, null, "compact_boundary", { logicalParentUuid: U(2) }),
      user(4, U(3), "summary", { isCompactSummary: true }),
    ],
    { upToMessageId: U(3) },
  ],
  [
    "up_to_progress_in_tail",
    [user(1, null, "a"), asst(2, U(1), "b"), progress(3, U(2)), user(4, U(3), "c")],
    { upToMessageId: U(3) },
  ],
  [
    "up_to_keeps_side_branch",
    [user(1, null, "a"), asst(2, U(1), "b"), user(3, U(2), "x"), asst(4, U(3), "y"), user(5, U(2), "f")],
    { upToMessageId: U(5) },
  ],
  [
    "up_to_with_preserved_messages",
    [
      system(1, null, "compact_boundary", {
        compactMetadata: { preservedMessages: { anchorUuid: U(1), uuids: [U(2), U(3)] } },
      }),
      user(2, U(1), "kept a"),
      asst(3, U(2), "kept b"),
      user(4, U(3), "after"),
      asst(5, U(4), "tail"),
      user(6, U(3), "branch"),
    ],
    { upToMessageId: U(6) },
  ],
  [
    "up_to_parallel_tool_results",
    [
      user(1, null, "run two"),
      { ...asst(2, U(1), ""), message: { id: "msg_p", role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] } },
      { ...asst(3, U(2), ""), message: { id: "msg_p", role: "assistant", content: [{ type: "tool_use", id: "t2", name: "Bash", input: {} }] } },
      user(4, U(2), [{ type: "tool_result", tool_use_id: "t1", content: "r1" }]),
      user(5, U(3), [{ type: "tool_result", tool_use_id: "t2", content: "r2" }]),
      asst(6, U(5), "both done"),
      user(7, U(6), "more"),
    ],
    { upToMessageId: U(6) },
  ],
];

const UUID_G = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const ISO_G = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;
function normalize(text, source, forkId) {
  const seen = new Map();
  return text
    .split(forkId)
    .join("$FORK")
    .replace(UUID_G, (u) => {
      if (source.includes(u)) return u;
      if (!seen.has(u)) seen.set(u, `$U${seen.size + 1}`);
      return seen.get(u);
    })
    .replace(ISO_G, (t) => (source.includes(t) ? t : "$NOW"))
    .split("\n");
}

const out = [];
for (const [name, lines, options, sidecar] of cases) {
  rmSync(projectDir, { recursive: true, force: true });
  mkdirSync(projectDir, { recursive: true });
  const transcript = lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n";
  writeFileSync(join(projectDir, `${SID}.jsonl`), transcript);
  if (sidecar !== undefined) {
    mkdirSync(join(projectDir, SID), { recursive: true });
    writeFileSync(join(projectDir, SID, "custom-title.json"), JSON.stringify({ customTitle: sidecar }));
  }
  let result;
  try {
    const { sessionId } = await forkSession(SID, options);
    const forked = readFileSync(join(projectDir, `${sessionId}.jsonl`), "utf8");
    result = { lines: normalize(forked, transcript, sessionId) };
  } catch (e) {
    result = { error: e.message };
  }
  out.push({ name, sessionId: SID, transcript, sidecar: sidecar ?? null, options, result });
}
rmSync(configDir, { recursive: true, force: true });

const file = join(rustDir, "crates/claudius-core/tests/fixtures/fork_golden.json");
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, JSON.stringify({ sdkVersion, cases: out }, null, 2) + "\n");
console.log(`wrote ${out.length} cases to ${file}`);
