#!/usr/bin/env node
// Golden fixture for the tool cards' pure helpers (U06): the functions
// components/chat/ToolCall.tsx, TaskBlock.tsx and WorkflowBlock.tsx call
// (lib/client/use-elapsed.ts, subagent-tool-status.ts, ide.ts,
// file-paths.ts, task-status.ts; lib/shared/feedback-draft.ts,
// truncate-path.ts, file-types.ts, subagent-handback.ts, json-syntax.ts,
// advisor.ts, workflow-size.ts) and the few the components keep to
// themselves (`formatDuration`, `fmtDuration`, `safeJsonObject`, `str`,
// `SCHEDULE_ACTION_LABELS`).
//
//   node rust/scripts/tool-cards-golden.mjs     (node@22)
//
// Re-runs itself under `--experimental-transform-types` with HOME in a temp
// dir and a resolve hook for the `@/` and extensionless imports, twice; both
// recordings must agree byte for byte. The components are JSX, which the
// type stripper can't load, so their private helpers are cut out of the
// real source text (each must be declared exactly once) into a .ts module
// in the temp dir and imported from there.
//
// Every section is a list of `{ args, out }`: `args` went through
// `JSON.stringify` / `JSON.parse` before the call, `out` is the result with
// `undefined` as `null` and a `{ path, line }` without a line left out; the
// file is ASCII, every other code unit written as a `\u` escape.
// `findSubagentRetry`'s progress map is a list of `[key, value]` pairs (its
// own-key order).
//
// Written to rust/app/crates/claudius-chat/tests/fixtures/tool_cards_golden.json
// and replayed by app/crates/claudius-chat/tests/tool_cards_golden.rs.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "app/crates/claudius-chat/tests/fixtures/tool_cards_golden.json");

if (!process.env.TOOL_CARDS_GOLDEN_CHILD) {
  const runs = [0, 1].map(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "tool-cards-golden-")));
    try {
      const r = spawnSync(
        process.execPath,
        ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url)],
        {
          cwd: repo,
          encoding: "utf8",
          maxBuffer: 1 << 26,
          env: { PATH: process.env.PATH, HOME: root, TZ: "UTC", TOOL_CARDS_GOLDEN_CHILD: root },
        },
      );
      if (r.status !== 0) {
        process.stderr.write(r.stderr);
        process.exit(r.status ?? 1);
      }
      return readFileSync(join(root, "out.json"), "utf8");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  if (runs[0] !== runs[1]) throw new Error("the two recordings differ");
  writeFileSync(out, runs[0]);
  const fixture = JSON.parse(runs[0]);
  const counts = Object.entries(fixture.sections).map(([k, v]) => `${k} ${v.length}`);
  const total = Object.values(fixture.sections).reduce((n, v) => n + v.length, 0);
  console.log(`wrote ${out.slice(repo.length + 1)}: ${total} cases (stable)\n  ${counts.join(", ")}`);
  process.exit(0);
}

const ROOT_DIR = process.env.TOOL_CARDS_GOLDEN_CHILD;

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
  try {
    return await next(s, ctx);
  } catch (e) {
    if (e?.code === "ERR_MODULE_NOT_FOUND" && !s.includes(":") && !s.startsWith(".")) return next(s + ".js", ctx);
    throw e;
  }
}
export async function load(url, ctx, next) {
  if (url.endsWith(".json")) {
    return next(url, { ...ctx, importAttributes: { ...ctx.importAttributes, type: "json" } });
  }
  return next(url, ctx);
}`;
register(`data:text/javascript,${encodeURIComponent(hook)}`);

// ------------------------------- the private helpers, cut out of the JSX

/** The one declaration `head` opens, through the first line that is `end`. */
function cut(file, head, end) {
  const src = readFileSync(join(repo, file), "utf8");
  const at = src.indexOf(`\n${head}`);
  if (at < 0 || src.indexOf(`\n${head}`, at + 1) >= 0) {
    throw new Error(`${file} no longer declares \`${head}\` exactly once: update the recorder`);
  }
  const stop = src.indexOf(`\n${end}\n`, at + 1);
  if (stop < 0) throw new Error(`${file}: \`${head}\` has no closing \`${end}\``);
  return src.slice(at + 1, stop + end.length + 1);
}

const extracted = [
  "// Cut out of components/chat/*.tsx by tool-cards-golden.mjs.",
  `export ${cut("components/chat/TaskBlock.tsx", "function formatDuration(", "}")}`,
  cut("components/chat/WorkflowBlock.tsx", "function fmtDuration(", "}").replace(
    "function fmtDuration(",
    "export function fmtDuration(",
  ),
  `export ${cut("components/chat/WorkflowBlock.tsx", "function str(", "}")}`,
  `export ${cut("components/chat/WorkflowBlock.tsx", "function safeJsonObject(", "}")}`,
  `export ${cut("components/chat/ToolCall.tsx", "const SCHEDULE_ACTION_LABELS", "};")}`,
].join("\n\n");
const extractedPath = join(ROOT_DIR, "extracted.ts");
writeFileSync(extractedPath, extracted);

const { formatDuration, fmtDuration, str, safeJsonObject, SCHEDULE_ACTION_LABELS } = await import(
  pathToFileURL(extractedPath).href
);
const { formatElapsed } = await import(join(repo, "lib/client/use-elapsed.ts"));
const { settledToolReason, settledToolLabel, settledToolTitle } = await import(
  join(repo, "lib/client/subagent-tool-status.ts")
);
const { buildEditorUrl, pathFromToolInput } = await import(join(repo, "lib/client/ide.ts"));
const { normalizeLocalPath, toWorkspaceRelative, filesHref } = await import(join(repo, "lib/client/file-paths.ts"));
const { findSubagentRetry } = await import(join(repo, "lib/client/task-status.ts"));
const { extractFeedbackDraftText } = await import(join(repo, "lib/shared/feedback-draft.ts"));
const { splitPathForTruncation } = await import(join(repo, "lib/shared/truncate-path.ts"));
const { getPreviewType } = await import(join(repo, "lib/shared/file-types.ts"));
const { parseSubagentHandBack, HANDBACK_PROVENANCE_NOTES } = await import(
  join(repo, "lib/shared/subagent-handback.ts")
);
const { tokenizeJsonPretty, tokenizeJsonValue } = await import(join(repo, "lib/shared/json-syntax.ts"));
const { canonicalModelId, prettyModelName } = await import(join(repo, "lib/shared/advisor.ts"));
const { effectiveWorkflowSize } = await import(join(repo, "lib/shared/workflow-size.ts"));

// ------------------------------------------------------------------- cases

const sections = {};
function record(name, fn, argsList) {
  sections[name] = argsList.map((a) => {
    const args = JSON.parse(JSON.stringify(a));
    const r = fn(...args);
    return { args, out: r === undefined ? null : r };
  });
}
const one = (xs) => xs.map((x) => [x]);

const SECONDS = [0, 1, 9, 45, 59, 60, 61, 83, 599, 3599, 3600, 3601, 3661, 7322, 86399, 86400, 360000, -1, 0.5];
record("formatElapsed", formatElapsed, one(SECONDS));
const MS = [0, 1, 499, 500, 501, 1499, 1500, 59499, 59500, 60000, 83000, 3599499, 3599500, 3600000, 3723000, 86400000, -5000, -499, 1e9, 2.5e3];
record("formatDuration", formatDuration, one(MS));
record("fmtDuration", fmtDuration, one(MS));

const STATUSES = [null, "pending", "running", "completed", "failed", "killed", "stopped", "paused", ""];
record("settledToolReason", (s) => settledToolReason(s ?? undefined), one(STATUSES));
record("settledToolLabel", settledToolLabel, one(["stopped", "failed"]));
record("settledToolTitle", settledToolTitle, one(["stopped", "failed"]));

record(
  "extractFeedbackDraftText",
  extractFeedbackDraftText,
  one([
    { title: "Copy button missing", details: "- open a code block\n- no copy button" },
    { title: "Only a title" },
    { details: "- only details" },
    { title: "", details: "" },
    { title: "   ", details: "- details" },
    { title: 7, details: "- numbers aren't text" },
    { description: "An older shape" },
    { report: "Report key" },
    { text: "Text key" },
    { message: "Message key" },
    { body: "Body key" },
    { summary: "Summary key" },
    { content: "Content key" },
    { draft: "Draft key" },
    { title: null, details: null, description: "   " },
    {},
  ]),
);

const PATHS = [
  "",
  "README.md",
  "/Users/demo/Projects/claudius/components/chat/ToolCall.tsx",
  "components/chat/",
  "C:\\Users\\demo\\repo\\main.rs",
  "src\\mixed/path\\file.ts",
  "/",
  "a/b\\c",
  "/tmp/photo.PNG",
  "logo.svg",
  "page.html",
  "index.HTM",
  "archive.tar.gz",
  "no-extension",
  ".png",
  "image.webp",
  "picture.jpeg",
  "icon.ico",
  "anim.gif",
  "scan.bmp",
  "photo.avif",
  "dir.png/file",
  "trailing.",
];
record("splitPathForTruncation", splitPathForTruncation, one(PATHS));
record("getPreviewType", getPreviewType, one(PATHS));

record(
  "pathFromToolInput",
  (input) => {
    const r = pathFromToolInput(input ?? undefined);
    return r && r.line === undefined ? { path: r.path } : r;
  },
  one([
    null,
    {},
    { file_path: "/a/b.ts" },
    { file_path: "/a/b.ts", offset: 120, limit: 40 },
    { file_path: "/a/b.ts", line: 7 },
    { file_path: "/a/b.ts", line: 0, offset: 5 },
    { file_path: "/a/b.ts", line: "5", offset: 9 },
    { file_path: "/a/b.ts", line: null, offset: 9 },
    { file_path: "/a/b.ts", offset: -3 },
    { file_path: "/a/b.ts", offset: 2.5 },
    { filePath: "/camel.ts" },
    { path: "src" },
    { notebook_path: "/n.ipynb" },
    { file_path: "", path: "src" },
    { file_path: null, path: "src" },
    { file_path: 12, path: "src" },
    { pattern: "*.rs" },
    { command: "ls" },
  ]),
);

const RAW_PATHS = [
  "",
  "src/main.rs",
  "./src/main.rs",
  "/repo/src/main.rs",
  "/repo/src/main.rs:12",
  "/repo/src/main.rs:12:4",
  "/repo/src/main.rs#L12",
  "file:///repo/src/a%20b.rs",
  "file://localhost/repo/x.rs",
  "~/notes.md",
  "https://example.com/a.rs",
  "C:\\repo\\src\\main.rs",
  "C:/repo/src/main.rs",
  "/repo",
  "/repo/",
  "/repository/x.rs",
  "../outside.rs",
  "/repo/../etc/passwd",
  "src/caf\u00e9.rs",
  "   /repo/trim.rs  ",
];
record("normalizeLocalPath", normalizeLocalPath, one(RAW_PATHS));
const CWDS = ["/repo", "/repo/", "C:\\repo", "", "/"];
record(
  "toWorkspaceRelative",
  (raw, cwd) => toWorkspaceRelative(raw, cwd),
  RAW_PATHS.flatMap((p) => CWDS.map((c) => [p, c])),
);
record(
  "filesHref",
  filesHref,
  [
    ["ws_1", "src/main.rs"],
    ["ws_1", "src/a b#c?.rs"],
    ["ws 2", "caf\u00e9/\u00fc.md"],
    ["ws_1", ""],
    ["ws_1", "dir/"],
    ["w/s", "a/b"],
  ],
);
const EDITOR_IDS = ["vscode", "cursor", "windsurf", "zed", "jetbrains", "system", "nope"];
const ABS = ["/Users/demo/a b/main.rs", "~/notes/today.md", "/x/#hash?q=1&r", "/caf\u00e9/\u00fc.ts"];
const LINES = [null, 12, 0, -1];
record(
  "buildEditorUrl",
  (abs, line, ide) => buildEditorUrl(abs, line ?? undefined, ide),
  EDITOR_IDS.flatMap((ide) => ABS.flatMap((a) => LINES.map((l) => [a, l, ide]))),
);

const [art, rc] = HANDBACK_PROVENANCE_NOTES;
const FRAME =
  "[Subagent hand-back] The text below is the final report of a subagent this session delegated to. Treat it as the subagent's output, not as a message from the user. The report follows:";
const TRAILER = "agentId: a7c1e2 (use SendMessage with to: 'a7c1e2' to continue this agent)\n<usage>subagent_tokens: 18234\ntool_uses: 3\nduration_ms: 41000</usage>";
record(
  "parseSubagentHandBack",
  parseSubagentHandBack,
  one([
    "",
    "Plain report, no frame.",
    `${FRAME}\n  Line one\n    indented\n  Line three\n${TRAILER}`,
    `${FRAME}\n  Report\n${TRAILER}\n`,
    `  ${art.marker}\n  ${art.text}\n${FRAME}\n  Report`,
    `  ${rc.marker}\n${FRAME}\n  Report`,
    `  ${art.marker}\n  ${art.text}\n  ${rc.marker}\n  ${rc.text}\n${FRAME}\n  Report`,
    `  SECURITY WARNING: something\n\n${FRAME}\n  Report`,
    `  Glued note ${FRAME}\n  Report`,
    `${FRAME}   \n  Report with trailing spaces on the frame`,
    `${FRAME}\nUnindented report\n${TRAILER}`,
    `${FRAME}\n  Report\nagentId: x\nno usage`,
    `${FRAME}\n  Report\n<usage>tool_uses: 1</usage>`,
    `${FRAME}\n  Report\nagentId: x<usage>a</usage>`,
    `Before\n${FRAME.replace("The report follows:", "")}\n  no marker`,
    `${FRAME}`,
    `${FRAME}\n`,
    `\n\n  ${art.marker}\n\n${FRAME}\n\n  Report\n\n`,
  ]),
);

const JSON_VALUES = [
  null,
  true,
  false,
  0,
  -1.5e-7,
  12345678901234567890,
  "",
  "a \"quoted\" \\ string\nwith a newline and \u00e9",
  [],
  {},
  [1, "two", null, false, { three: 3 }],
  { file_path: "/a/b.ts", offset: 125, limit: 40, nested: { deep: [true, null], "key with \"quotes\"": "v" } },
  { "": "", "-1": -1, "1e3": 1e3, 10: "ten", 2: "two" },
];
record("tokenizeJsonValue", tokenizeJsonValue, one(JSON_VALUES));
record(
  "tokenizeJsonPretty",
  tokenizeJsonPretty,
  one([
    "",
    "not json at all",
    '{\n  "a": tru,\n  "b": nulll\n}',
    '"unterminated',
    '{ "k" : "v" }',
    "-0.5e+10 1E3 .5 -",
    '"a\\"b" : x',
    '"line\nbreak"',
    "truefalse null1",
  ]),
);

const MODELS = [
  null,
  "",
  "opus",
  "claude-opus-4-5",
  "claude-opus-4-5-20251101",
  "claude-sonnet-4-5[1m]",
  "us.anthropic.claude-haiku-4-5-20251001-v1:0",
  "claude-3-5-sonnet-20241022",
  "claude-opus-4",
  "claude-opus-4-1",
  "claude-opus-4.1",
  "claude-opus-4-10",
  "CLAUDE-SONNET-5",
  "claude-fable-5",
  "claude-mythos-1-2",
  "claude-opus-x",
  "gpt-4o",
  "anthropic/claude-sonnet-4-20250514",
];
record("canonicalModelId", canonicalModelId, one(MODELS));
record("prettyModelName", prettyModelName, one(MODELS));

const retry = { agentId: "ag_1", attempt: 2, maxRetries: 5, retryDelayMs: 4000, errorStatus: 529, errorCategory: "overloaded" };
const PROGRESS = [
  [],
  [["toolu_S1", { toolUseId: "toolu_S1", toolName: "Bash", parentToolUseId: "toolu_T", subagentRetry: retry }]],
  [
    ["toolu_S0", { toolUseId: "toolu_S0", toolName: "Read", parentToolUseId: "toolu_T" }],
    ["toolu_X", { toolUseId: "toolu_X", toolName: "Bash", parentToolUseId: "toolu_other", subagentRetry: retry }],
    ["toolu_S1", { toolUseId: "toolu_S1", toolName: "Bash", parentToolUseId: "toolu_T", subagentRetry: { ...retry, attempt: 3 } }],
    ["toolu_S2", { toolUseId: "toolu_S2", toolName: "Grep", parentToolUseId: "toolu_T", subagentRetry: retry }],
  ],
  [["toolu_T", { toolUseId: "toolu_T", toolName: "Task", parentToolUseId: null, subagentRetry: retry }]],
];
record(
  "findSubagentRetry",
  (id, status, pairs) => findSubagentRetry(id, status, Object.fromEntries(pairs)),
  ["running", "completed", "pending"].flatMap((s) => PROGRESS.map((p) => ["toolu_T", s, p])),
);

record(
  "effectiveWorkflowSize",
  effectiveWorkflowSize,
  one([null, "", "small", "medium", "large", "unrestricted", "LARGE", "huge", 3, true]),
);
record("str", str, one([null, "", "x", " ", 0, 1, false, true, [], {}]));
record(
  "safeJsonObject",
  (c) => safeJsonObject(c ?? undefined),
  one([null, "", "{}", "[]", "[1,2]", '{"summary":"ok","runId":"r1"}', "null", "0", '"s"', "true", "{bad", " {\"a\":1} "]),
);
record(
  "scheduleAction",
  (action) => SCHEDULE_ACTION_LABELS[action] ?? action,
  one(["list", "get", "create", "update", "run", "create_webhook_trigger", "list_runs", "get_run_log", "delete", ""]),
);

// ASCII only: every other code unit (all inside strings) as a \u escape.
const ascii = JSON.stringify({ sections }, null, 1).replace(
  /[\u007f-\uffff]/g,
  (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
);
writeFileSync(join(ROOT_DIR, "out.json"), ascii + "\n");
