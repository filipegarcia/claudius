#!/usr/bin/env node
// Golden fixture for the thinking-block replay recovery (S19), recorded from
// the real TS source:
//
//   node rust/scripts/thinking-replay-golden.mjs     (node@22)
//
// Runs lib/server/thinking-replay-recovery.ts (through node's type stripping,
// with an `@/` resolve hook) and records:
// - `texts`: `isThinkingReplayErrorText(text)`;
// - `messageTexts`: `extractMessageText(message)`;
// - `errors`: `thinkingReplayErrorFrom(record)` (the text, or null);
// - `plans`: `planThinkingReplayRecovery(messages)` as `JSON.stringify` text.
// The child runs twice and both runs must agree byte for byte.
//
// Written to rust/crates/claudius-core/tests/fixtures/thinking_replay_golden.json
// and replayed by crates/claudius-core/tests/thinking_replay_golden.rs.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { register } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "crates/claudius-core/tests/fixtures/thinking_replay_golden.json");

if (!process.env.THINKING_REPLAY_GOLDEN_CHILD) {
  const runs = [0, 1].map(() => {
    const r = spawnSync(
      process.execPath,
      ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url)],
      { cwd: repo, encoding: "utf8", maxBuffer: 1 << 26, env: { ...process.env, THINKING_REPLAY_GOLDEN_CHILD: "1" } },
    );
    if (r.status !== 0) {
      process.stderr.write(r.stderr);
      process.exit(r.status ?? 1);
    }
    return r.stdout;
  });
  if (runs[0] !== runs[1]) {
    console.error("thinking-replay-golden: the two runs disagree");
    process.exit(1);
  }
  writeFileSync(out, runs[0]);
  const f = JSON.parse(runs[0]);
  console.log(
    `wrote ${out.slice(repo.length + 1)}: ${f.texts.length} texts, ${f.messageTexts.length} message texts, ${f.errors.length} records, ${f.plans.length} plans (stable)`,
  );
  process.exit(0);
}

const hook = `
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
const ROOT = ${JSON.stringify(pathToFileURL(repo + "/").href)};
export async function resolve(spec, ctx, next) {
  const s = spec.startsWith("@/") ? new URL(spec.slice(2), ROOT).href : spec;
  if ((s.startsWith(".") || s.startsWith("file:")) && ctx.parentURL) {
    const p = fileURLToPath(new URL(s, ctx.parentURL));
    if (!existsSync(p)) {
      for (const ext of [".ts", ".tsx", "/index.ts"]) {
        if (existsSync(p + ext)) return next(pathToFileURL(p + ext).href, ctx);
      }
    }
  }
  return next(s, ctx);
}`;
register(`data:text/javascript,${encodeURIComponent(hook)}`);

const { extractMessageText, isThinkingReplayErrorText, planThinkingReplayRecovery, thinkingReplayErrorFrom } =
  await import(pathToFileURL(join(repo, "lib/server/thinking-replay-recovery.ts")).href);

const REAL =
  "API Error: 400 messages.25.content.23: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified. These blocks must remain as they were in the original response.";

const TEXTS = [
  REAL,
  "messages.4.content.1: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified.",
  "API Error: The socket connection was closed unexpectedly.",
  "API Error: 400 messages: roles must alternate",
  "thinking budget exceeded the maximum",
  "",
  "thinking cannot be modified",
  "thinking cannot be modified: redacted_thinking",
  "redacted_thinking cannot be modified",
  "THINKING blocks in the LATEST ASSISTANT MESSAGE CANNOT BE MODIFIED",
  "Thinking blocks in the latest assistant message can not be modified",
  "thinking blocks in the latest  assistant message cannot be modified",
  "cannot be modified latest assistant message thinking",
  "thinkingcannot be modifiedlatest assistant message",
  // U+212A KELVIN SIGN lowercases to "k", U+0130 to "i" plus a combining dot.
  "thin\u212Aing in the latest assistant message cannot be modified",
  "th\u0130nking in the latest assistant message cannot be modified",
  "\u0398INKING thinking \u00C0 latest assistant message cannot be modified \u{1f600}",
  "thinking\ncannot be modified\nredacted_thinking",
];

const textBlock = (text) => ({ type: "text", text });
const MESSAGES = [
  null,
  undefined,
  "content",
  5,
  [],
  {},
  { content: "plain" },
  { content: "" },
  { content: [textBlock("a"), textBlock("b")] },
  { content: [textBlock("a"), null, 3, "x", { type: "text" }, { type: "text", text: 7 }, { type: "Text", text: "no" }, textBlock("c")] },
  { content: [{ type: "thinking", thinking: "t" }, { type: "tool_use", name: "Bash", input: {} }] },
  { content: { type: "text", text: "obj" } },
  { content: 9 },
  { content: null },
  { role: "assistant", text: "no content key" },
];

const asst = (content, extra = {}) => ({ type: "assistant", uuid: "a", message: { role: "assistant", content }, ...extra });
const RECORDS = [
  asst([textBlock(REAL)]),
  asst(REAL),
  asst([textBlock("API Error: 400 "), textBlock("messages.1.content.0: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified.")]),
  asst([textBlock("all done")]),
  asst([]),
  asst(""),
  { type: "user", message: { role: "user", content: REAL } },
  { type: "system", message: { content: REAL } },
  { type: "Assistant", message: { content: REAL } },
  { type: "assistant" },
  { type: "assistant", message: null },
  { type: "assistant", message: REAL },
  { type: "assistant", content: REAL },
  null,
  0,
  "assistant",
  [],
  { ...asst([textBlock(REAL)]), parent_tool_use_id: "toolu_sub" },
];

const rec = (type, uuid, content) => ({ type, uuid, session_id: "s", message: { role: type, content }, parent_tool_use_id: null });
const thinkingTurn = (uuid) => rec("assistant", uuid, [
  { type: "thinking", thinking: "", signature: "sig" },
  { type: "tool_use", id: "t1", name: "Bash", input: {} },
]);
const toolResult = (uuid) => rec("user", uuid, [{ type: "tool_result", tool_use_id: "t1", content: "out" }]);

const PLANS = [
  ["rewinds to the assistant boundary before the last real prompt", [
    rec("user", "u0", "first prompt"), rec("assistant", "a0", [textBlock("ok")]), rec("user", "u1", "all 14, in batches"),
    thinkingTurn("a1"), toolResult("tr1")]],
  ["skips tool_result-only user records", [
    rec("assistant", "a0", [textBlock("ok")]), rec("user", "u1", "real prompt"),
    rec("assistant", "a1", [{ type: "tool_use", id: "t1", name: "Bash", input: {} }]), toolResult("tr1")]],
  ["rewinds past the poison after a fresh prompt", [
    rec("assistant", "a0", [textBlock("ok")]), rec("user", "u1", "all 14, in batches"), thinkingTurn("a1"), toolResult("tr1"),
    rec("user", "u2", "are you stuck?")]],
  ["fresh prompt answered by a later non-thinking turn", [
    rec("assistant", "a0", [textBlock("ok")]), rec("user", "u1", "go"), thinkingTurn("a1"),
    rec("user", "u2", "again"), rec("assistant", "a2", [textBlock("API Error: 400 ...")])]],
  ["the poisoned turn was the first", [rec("user", "u1", "first and only prompt"),
    rec("assistant", "a1", [{ type: "thinking", thinking: "", signature: "s" }])]],
  ["no real user prompt", [rec("assistant", "a0", [textBlock("hi")]), toolResult("tr1")]],
  ["no messages", []],
  ["only users", [rec("user", "u1", "a"), rec("user", "u2", "b")]],
  ["no thinking anywhere: the latest assistant anchors", [
    rec("assistant", "a0", [textBlock("one")]), rec("user", "u1", "p1"), rec("assistant", "a1", [textBlock("two")]),
    rec("user", "u2", "p2"), rec("assistant", "a2", [textBlock("three")])]],
  ["the latest thinking turn anchors", [
    rec("assistant", "a0", [textBlock("x")]), rec("user", "u1", "p1"), thinkingTurn("a1"), rec("user", "u2", "p2"),
    thinkingTurn("a2"), rec("user", "u3", "p3"), rec("assistant", "a3", [textBlock("plain")])]],
  ["redacted thinking counts", [
    rec("assistant", "a0", [textBlock("x")]), rec("user", "u1", "p1"), rec("assistant", "a1", [{ type: "redacted_thinking", data: "zz" }]),
    rec("user", "u2", "p2"), rec("assistant", "a2", [textBlock("y")])]],
  ["thinking in a user record doesn't anchor", [
    rec("assistant", "a0", [textBlock("x")]), rec("user", "u1", "p1"), rec("assistant", "a1", [textBlock("y")]),
    rec("user", "u2", [{ type: "thinking", thinking: "" }, textBlock("p2")]), rec("assistant", "a2", [textBlock("z")])]],
  ["string-content assistants never have thinking", [
    rec("assistant", "a0", "x"), rec("user", "u1", "p1"), rec("assistant", "a1", "thinking"), rec("user", "u2", "p2"), rec("assistant", "a2", "y")]],
  ["thinking type is exact", [
    rec("assistant", "a0", [textBlock("x")]), rec("user", "u1", "p1"), rec("assistant", "a1", [{ type: "Thinking" }, { type: "thinking_delta" }]),
    rec("user", "u2", "p2"), rec("assistant", "a2", [textBlock("y")])]],
  ["odd blocks around a thinking block", [
    rec("assistant", "a0", [textBlock("x")]), rec("user", "u1", "p1"), rec("assistant", "a1", [null, 5, "thinking", { type: "thinking" }]),
    rec("user", "u2", "p2"), rec("assistant", "a2", [textBlock("y")])]],
  ["text-block prompts", [
    rec("assistant", "a0", [textBlock("x")]), rec("user", "u1", [textBlock("part one, "), textBlock("part two")]), thinkingTurn("a1")]],
  ["a task notification is not a prompt", [
    rec("assistant", "a0", [textBlock("x")]), rec("user", "u1", "real"), rec("assistant", "a1", [textBlock("y")]),
    rec("user", "u2", "<task-notification>\n<task-id>t</task-id>\n</task-notification>"), thinkingTurn("a2")]],
  ["a compact summary is not a prompt", [
    rec("assistant", "a0", [textBlock("x")]), rec("user", "u1", "real"), rec("assistant", "a1", [textBlock("y")]),
    rec("user", "u2", "This session is being continued from a previous conversation that ran out of context. The summary below covers it."),
    thinkingTurn("a2")]],
  ["leading system reminders are stripped", [
    rec("assistant", "a0", [textBlock("x")]), rec("user", "u1", "<system-reminder>\nnote\n</system-reminder>\nthe ask"), thinkingTurn("a1")]],
  ["a reminder-only prompt is skipped", [
    rec("assistant", "a0", [textBlock("x")]), rec("user", "u1", "earlier"), rec("assistant", "a1", [textBlock("y")]),
    rec("user", "u2", "<system-reminder>\nonly\n</system-reminder>"), thinkingTurn("a2")]],
  ["an image-only prompt is skipped", [
    rec("assistant", "a0", [textBlock("x")]), rec("user", "u1", "earlier"), rec("assistant", "a1", [textBlock("y")]),
    rec("user", "u2", [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } }]), thinkingTurn("a2")]],
  ["an empty prompt is skipped", [
    rec("assistant", "a0", [textBlock("x")]), rec("user", "u1", "earlier"), rec("assistant", "a1", [textBlock("y")]),
    rec("user", "u2", ""), thinkingTurn("a2")]],
  ["an assistant without a uuid is passed over", [
    rec("assistant", "a0", [textBlock("x")]), { type: "assistant", message: { content: [textBlock("no uuid")] } },
    rec("user", "u1", "p"), thinkingTurn("a1")]],
  ["an empty uuid is passed over", [
    rec("assistant", "a0", [textBlock("x")]), rec("assistant", "", [textBlock("empty")]), rec("user", "u1", "p"), thinkingTurn("a1")]],
  ["a null uuid is passed over", [
    rec("assistant", "a0", [textBlock("x")]), rec("assistant", null, [textBlock("null")]), rec("user", "u1", "p"), thinkingTurn("a1")]],
  ["no boundary with a uuid", [
    { type: "assistant", message: { content: [textBlock("x")] } }, rec("user", "u1", "p"), thinkingTurn("a1")]],
  ["the prompt has no uuid", [
    rec("assistant", "a0", [textBlock("x")]), { type: "user", message: { content: "p" } }, thinkingTurn("a1")]],
  ["system and progress records between", [
    rec("assistant", "a0", [textBlock("x")]), { type: "system", uuid: "s1", subtype: "init" }, rec("user", "u1", "p"),
    { type: "progress", uuid: "pr1" }, thinkingTurn("a1"), { type: "system", uuid: "s2", subtype: "compact_boundary" }]],
  ["a record without a message", [
    rec("assistant", "a0", [textBlock("x")]), { type: "user", uuid: "u0" }, rec("user", "u1", "p"), { type: "assistant", uuid: "a1" }]],
  ["records with a null message", [
    rec("assistant", "a0", [textBlock("x")]), { type: "user", uuid: "u1", message: null }, rec("user", "u2", "p"),
    { type: "assistant", uuid: "a1", message: null }]],
  ["the prompt right after the boundary's tool results", [
    rec("user", "u0", "start"), thinkingTurn("a0"), toolResult("tr0"), rec("assistant", "a0b", [textBlock("done")]),
    rec("user", "u1", "next"), thinkingTurn("a1"), toolResult("tr1")]],
  ["unicode prompt", [rec("assistant", "a0", [textBlock("x")]), rec("user", "u1", "  caf\u00E9 \u{1f600} \u212A  "), thinkingTurn("a1")]],
];

const fixture = {
  texts: TEXTS.map((text) => ({ text, matches: isThinkingReplayErrorText(text) })),
  messageTexts: MESSAGES.filter((m) => m !== undefined).map((message) => ({ message, text: extractMessageText(message) })),
  errors: RECORDS.map((record) => ({ record, error: thinkingReplayErrorFrom(record) })),
  plans: PLANS.map(([name, messages]) => ({ name, messages, plan: JSON.stringify(planThinkingReplayRecovery(messages)) })),
};
if (extractMessageText(undefined) !== "") throw new Error("extractMessageText(undefined)");
process.stdout.write(JSON.stringify(fixture, null, 1) + "\n");
