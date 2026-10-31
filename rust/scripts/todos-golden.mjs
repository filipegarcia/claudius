#!/usr/bin/env bun
// Golden fixture for the to-do helpers the session engine uses.
//
//   bun rust/scripts/todos-golden.mjs      (bun: it imports the .ts sources)
//
// Records, from the TS sources themselves:
// - `parseTaskListResult(text)` (lib/shared/parse-tasklist-result.ts) over
//   well-formed, malformed and whitespace-edge TaskList results;
// - the TaskCreate result → real id parse in `captureSnapshotState`: the
//   regex literal is read from lib/server/session.ts and run as JS, then the
//   JSON `{task: {id}}` fallback exactly as the session does it;
// - `todosCurrentReminderBody`, `todosMidTurnReminderBody` and
//   `staleTodoReminderBody` (which embed `JSON.stringify(todos, null, 2)`);
// - `Session.openTodoCount` (private static, callable at runtime);
// - the module-private `STALE_TODO_TURN_THRESHOLD`,
//   `TODOS_MIDTURN_TOOLUSE_THRESHOLD`, `TODOS_STALE_FLAG_TURNS` and
//   `TODOS_STALE_CLEAR_TURNS`, read from the source.
//
// `undefined` is written as `{"undefined": true}`, a value as `{"value": …}`.
// Written to rust/crates/claudius-core/tests/fixtures/todos_golden.json and
// replayed by crates/claudius-core/tests/todos_golden.rs.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const { parseTaskListResult } = await import(join(repo, "lib/shared/parse-tasklist-result.ts"));
const session = await import(join(repo, "lib/server/session.ts"));
const { Session, todosCurrentReminderBody, todosMidTurnReminderBody, staleTodoReminderBody } = session;

const sessionSrc = readFileSync(join(repo, "lib/server/session.ts"), "utf8");
const constant = (name) => {
  const m = sessionSrc.match(new RegExp(`const ${name} = (\\d+);`));
  if (!m) throw new Error(`${name} moved in session.ts: update the pattern`);
  return Number(m[1]);
};
const reMatch = sessionSrc.match(/const match = \/(.+)\/(\w*)\.exec\(resultText\);/);
if (!reMatch) throw new Error("the TaskCreate result regex moved in session.ts: update the pattern");
const createdRe = new RegExp(reMatch[1], reMatch[2]);

// The TaskCreate branch of `captureSnapshotState`, around the regex above.
function realIdFrom(resultText) {
  const match = createdRe.exec(resultText);
  if (match && match[1]) return match[1];
  try {
    const payload = JSON.parse(resultText);
    if (typeof payload?.task?.id === "string" && payload.task.id) return payload.task.id;
  } catch {
    // neither shape: the temp id stays
  }
  return null;
}

const ch = (...codes) => String.fromCharCode(...codes);
const NBSP = ch(0xa0);
const NEL = ch(0x85);
const BOM = ch(0xfeff);
const LS = ch(0x2028);
const PARTY = String.fromCodePoint(0x1f389);

const TASK_LISTS = [
  null,
  undefined,
  "",
  "   ",
  "\n\n",
  `${NBSP}${BOM}`,
  "#1 [completed] Add shared advisor constants module\n#2 [in_progress] Plumb advisorModel through use-session.ts",
  "#1 [pending]  spaced   subject  ",
  "#1[pending] no space after id",
  "#1 [pending]",
  "#1 [pending] ",
  "#1 [] empty status",
  "# [pending] empty id",
  "#a#b [x] y",
  "#1 [a]b] c",
  "#1 [ in progress ] subject",
  "#1\t[pending]\tTabbed subject",
  "#1 [pending] crlf one\r\n#2 [completed] crlf two\r\n",
  `#1${NBSP}[pending]${NBSP}nbsp separators`,
  `#1${NEL}[pending] nel is not js whitespace`,
  `#1 [pending]${NEL}nel before subject`,
  `#1 [pending] ${BOM}bom-led subject`,
  `#1 [pending] line${LS}separator inside`,
  "#1 [pending] carriage\rreturn inside",
  `#1 [pend${LS}ing] status with a separator`,
  `#1 [${LS}pending${LS}] status trimmed of separators`,
  "   #3 [completed] leading spaces",
  "garbage",
  "No tasks found",
  "Task list:\n#1 [pending] header line skipped",
  "#1 [pending] fix [bug] here",
  `#1 [pending] emoji ${PARTY} ok`,
  "#10 [pending] x\n#2 [completed] y\nnot a task\n#3 [deleted] z",
  `#${PARTY} [pending] astral id`,
  "#1 [pending] trailing tab\t",
  `#1 [pending] ${"  ".repeat(50)}x`,
  "##1 [pending] double hash",
  "#1  [pending]  wide gaps",
  "#1 [pending]x no space after bracket",
];

const CREATE_RESULTS = [
  "Task #1 created successfully: Foo",
  "task #A1 CREATED",
  "Task #12  created",
  "Task #12created",
  "Task  #3 created",
  "Created Task #4 created",
  "prefix Task #5 created suffix",
  `Task #${NBSP}7 created`,
  `Task #x${NBSP}created`,
  `Task #x${NEL}created`,
  `Task #x${NEL}y created`,
  "TASK #9 Created",
  "Task #1 created\n" + JSON.stringify({ task: { id: "99" } }),
  JSON.stringify({ task: { id: "42" } }),
  JSON.stringify({ task: { id: "" } }),
  JSON.stringify({ task: { id: 5 } }),
  JSON.stringify({ task: null }),
  JSON.stringify({ task: { id: "8", subject: "s" }, ok: true }),
  ` ${JSON.stringify({ task: { id: "7" } })}\n`,
  `${BOM}${JSON.stringify({ task: { id: "7" } })}`,
  "null",
  "[]",
  '"str"',
  "",
  "not json",
  "Task #1 created", // regex wins
  `Ta${ch(0x17f)}k #1 created`, // long s: no ASCII case fold
  "tasK #b created",
  `Task #k ${ch(0x212a)}reated`.replace(ch(0x212a), "C"),
  "Task #1\tcreated",
  `Task #1${LS}created`,
  "Task # created",
  "Task #a Task #b created",
];

const TODO_LISTS = [
  [],
  [{ content: "a", status: "pending", activeForm: "Doing a" }],
  [
    { id: "1", content: "x", status: "completed" },
    { id: "2", content: "y", status: "in_progress" },
  ],
  [{ 10: 1, 2: 2, b: 3, a: 4 }],
  [{ n: 1.5, big: 1e21, small: 1e-7, int: 3, neg: -2.25 }],
  [null, "str", 5, [], {}, true],
  [{ content: `emoji ${PARTY} and ${LS} separator`, status: "pending" }],
  [{ a: { b: [1, { c: [] }], d: {} } }],
  [{ content: 'quote " and \\ backslash\nnewline', status: "pending" }],
];

const OPEN_COUNT_LISTS = [
  null,
  [],
  [{ status: "completed" }],
  [{ status: "pending" }, { status: "completed" }, {}],
  ["str", 5, [], { status: "Completed" }],
  [{ status: ["completed"] }, { status: "completed", id: "x" }],
];

const enc = (v) => (v === undefined ? { undefined: true } : { value: v });
const parse = TASK_LISTS.map((text) => ({ text: enc(text), out: enc(parseTaskListResult(text)) }));
const realIds = CREATE_RESULTS.map((text) => ({ text, out: realIdFrom(text) }));
const bodies = TODO_LISTS.map((todos) => ({
  todos,
  current: todosCurrentReminderBody(todos),
  midTurn: todosMidTurnReminderBody(todos),
  stale: staleTodoReminderBody(todos),
}));
const openCounts = OPEN_COUNT_LISTS.map((snapshot) => ({ snapshot, out: Session.openTodoCount(snapshot) }));

const out = {
  staleTodoTurnThreshold: constant("STALE_TODO_TURN_THRESHOLD"),
  midTurnToolUseThreshold: constant("TODOS_MIDTURN_TOOLUSE_THRESHOLD"),
  staleFlagTurns: constant("TODOS_STALE_FLAG_TURNS"),
  staleClearTurns: constant("TODOS_STALE_CLEAR_TURNS"),
  parse,
  realIds,
  bodies,
  openCounts,
};
const file = join(rustDir, "crates/claudius-core/tests/fixtures/todos_golden.json");
writeFileSync(file, `${JSON.stringify(out, null, 1)}\n`);
console.log(
  `${parse.length} task lists, ${realIds.length} create results, ${bodies.length} bodies, ${openCounts.length} open counts; wrote ${file.slice(repo.length + 1)}`,
);
process.exit(0);
