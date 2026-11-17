#!/usr/bin/env node
// Golden fixture for the parts of the SDK's session readers that SDK 0.3.312
// changed (R09), recorded from the REAL Agent SDK:
//
//   node rust/scripts/session-messages-golden.mjs      (node@22)
//
// - `cases`: `getSessionMessages(id, {includeSystemMessages})` over synthetic
//   transcripts, with the SDK's `JSON.stringify` of the result. They pin the
//   two 0.3.312 changes in the pipeline: a task-notification `origin` keeps
//   `taskKind` only when it's exactly "mcp-task" (`yb`, 0.3.299 `dE`), and
//   "[Request interrupted: the session ended before this agent finished...]"
//   now counts as a reply (`aL`, 0.3.299 `AD`), so a queued command it
//   follows is delivered. Each case's transcript is kept as the exact text
//   written, under `<CLAUDE_CONFIG_DIR>/projects/golden/<id>.jsonl`.
// - `files`: `getSessionMessages(id, {includeSystemMessages})` over the
//   transcript FILE as written (I14b), kept as `hex` bytes (or a `dir`, a
//   `symlink`, a `mode`) under `<CLAUDE_CONFIG_DIR>/projects/golden-files/`:
//   the SDK reads the whole file and decodes each `\n`-split line lossily,
//   so invalid UTF-8 is U+FFFD; a BOM, NUL and control bytes, CRLF,
//   U+2028 / U+2029, blank and torn lines, no trailing newline; and the
//   lookup and read failures (empty, a directory, an unreadable file, a
//   dangling link), each `[]` with no throw.
// - `gitStub`: the SDK's private macOS check that `git` is only the
//   developer-tools stub (0.3.312 `PD`, guarding `git worktree list`), lifted
//   out of sdk.mjs by shape and run with a fake `process.platform`, env and
//   fs over a matrix of PATHs and installs.
//
// Runs twice, each in a fresh child with a temp HOME and CLAUDE_CONFIG_DIR;
// both recordings must agree byte for byte. Written to
// rust/crates/claudius-core/tests/fixtures/session_messages_golden.json and
// replayed by crates/claudius-core/tests/session_messages_golden.rs.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "crates/claudius-core/tests/fixtures/session_messages_golden.json");
const sdkPath = join(repo, "node_modules/@anthropic-ai/claude-agent-sdk");

if (!process.env.SESSION_MESSAGES_GOLDEN_CHILD) {
  const runs = [0, 1].map(() => {
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), "smg-rec-")));
    try {
      mkdirSync(join(tmp, "home"));
      mkdirSync(join(tmp, "config"));
      const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
        cwd: repo,
        encoding: "utf8",
        maxBuffer: 1 << 26,
        env: {
          PATH: process.env.PATH,
          HOME: join(tmp, "home"),
          CLAUDE_CONFIG_DIR: join(tmp, "config"),
          TZ: "UTC",
          SESSION_MESSAGES_GOLDEN_CHILD: join(tmp, "out.json"),
        },
      });
      if (r.status !== 0) {
        process.stderr.write(r.stdout + r.stderr);
        process.exit(r.status ?? 1);
      }
      return readFileSync(join(tmp, "out.json"), "utf8");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
  if (runs[0] !== runs[1]) {
    writeFileSync(join(tmpdir(), "smg-run0.json"), runs[0]);
    writeFileSync(join(tmpdir(), "smg-run1.json"), runs[1]);
    throw new Error(`the two recordings differ (see ${tmpdir()}/smg-run{0,1}.json)`);
  }
  const fixture = JSON.parse(runs[0]);
  writeFileSync(out, `${JSON.stringify(fixture, null, 1)}\n`);
  console.log(
    `wrote ${out.slice(repo.length + 1)}: ${fixture.cases.length} transcripts, ` +
      `${fixture.gitStub.length} git-stub probes, ${fixture.files.length} transcript files (SDK ${fixture.sdkVersion}, stable)`,
  );
  process.exit(0);
}

// ---- child ------------------------------------------------------------------

const sdkVersion = JSON.parse(readFileSync(join(sdkPath, "package.json"), "utf8")).version;
const bundle = readFileSync(join(sdkPath, "sdk.mjs"), "utf8");
const { getSessionMessages } = await import(join(sdkPath, "sdk.mjs"));

// ---- 1. getSessionMessages ----

const SESSION_ENDED = "[Request interrupted: the session ended before this agent finished. Nobody asked it to stop.]";
let n = 0;
const sid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
/** A transcript entry on the main chain (`parent` null for the root). */
function entry(id, parent, type, extra) {
  return {
    parentUuid: parent,
    isSidechain: false,
    cwd: "/golden/project",
    version: "2.1.312",
    uuid: id,
    timestamp: `2026-01-01T00:00:${String(Number(id.slice(1)) % 60).padStart(2, "0")}.000Z`,
    type,
    ...extra,
  };
}
const user = (id, parent, content, extra) => entry(id, parent, "user", { message: { role: "user", content }, ...extra });
const assistant = (id, parent, text) =>
  entry(id, parent, "assistant", { message: { id: `msg_${id}`, role: "assistant", content: [{ type: "text", text }] } });
const queued = (id, parent, attachment) => entry(id, parent, "attachment", { attachment: { type: "queued_command", ...attachment } });
const tn = (extra) => ({ kind: "task-notification", ...extra });

/** A queued command, then `reply` (the entry that may or may not count as a reply). */
const queuedThen = (reply) => [user("u1", null, "go"), assistant("u2", "u1", "on it"), queued("u3", "u2", { prompt: "also this" }), reply];

const CASES = [
  // `taskKind` survives only as exactly "mcp-task".
  [
    "origin_task_kind",
    [
      user("u1", null, "first", { origin: tn({ subkind: "s", fireReason: "f", producer: "p", runId: "run-1", taskKind: "mcp-task", extra: 1 }) }),
      assistant("u2", "u1", "a"),
      user("u3", "u2", "shell", { origin: tn({ taskKind: "shell" }) }),
      assistant("u4", "u3", "b"),
      user("u5", "u4", "upper", { origin: tn({ taskKind: "MCP-TASK", runId: "bad run id" }) }),
      assistant("u6", "u5", "c"),
      user("u7", "u6", "null", { origin: tn({ taskKind: null, subkind: null }) }),
      assistant("u8", "u7", "d"),
      user("u9", "u8", "number", { origin: tn({ taskKind: 7 }) }),
      assistant("u10", "u9", "e"),
      user("u11", "u10", "other kind", { origin: { kind: "human", taskKind: "mcp-task" } }),
      assistant("u12", "u11", "f"),
      user("u13", "u12", "string origin", { origin: "mcp-task" }),
      assistant("u14", "u13", "g"),
    ],
  ],
  // A delivered queued command carries its normalized origin, from the
  // attachment's `origin` or its `commandMode`.
  [
    "queued_origin_task_kind",
    [
      user("u1", null, "go"),
      queued("u2", "u1", { prompt: "from mcp", origin: tn({ taskKind: "mcp-task", runId: "r2" }) }),
      queued("u3", "u2", { prompt: "from shell", origin: tn({ taskKind: "shell" }) }),
      queued("u4", "u3", { prompt: "by mode", commandMode: "task-notification", runId: "r4" }),
      assistant("u5", "u4", "ok"),
    ],
  ],
  // The 0.3.312 interrupt text is a reply in every shape the SDK checks.
  ["session_ended_string_is_a_reply", queuedThen(user("u4", "u3", SESSION_ENDED))],
  ["session_ended_with_more_text_is_a_reply", queuedThen(user("u4", "u3", `${SESSION_ENDED} (and then some)`))],
  ["session_ended_text_block_is_a_reply", queuedThen(user("u4", "u3", [{ type: "text", text: SESSION_ENDED }]))],
  [
    "session_ended_error_tool_result_is_a_reply",
    queuedThen(user("u4", "u3", [{ type: "tool_result", tool_use_id: "toolu_1", is_error: true, content: SESSION_ENDED }])),
  ],
  [
    "session_ended_non_error_tool_result_is_a_tool_reply",
    queuedThen(user("u4", "u3", [{ type: "tool_result", tool_use_id: "toolu_1", content: SESSION_ENDED }])),
  ],
  ["session_ended_mixed_blocks_is_a_prompt", queuedThen(user("u4", "u3", [{ type: "text", text: SESSION_ENDED }, { type: "text", text: "hi" }]))],
  ["session_ended_leading_space_is_a_prompt", queuedThen(user("u4", "u3", ` ${SESSION_ENDED}`))],
  ["other_interrupted_text_is_a_prompt", queuedThen(user("u4", "u3", "[Request interrupted: something else]"))],
  ["user_interrupt_is_a_reply", queuedThen(user("u4", "u3", "[Request interrupted by user]"))],
  ["plain_prompt_after_queued", queuedThen(user("u4", "u3", "a new prompt"))],
  ["assistant_after_queued", queuedThen(assistant("u4", "u3", "done"))],
];

const projects = join(process.env.CLAUDE_CONFIG_DIR, "projects", "golden");
mkdirSync(projects, { recursive: true });
const cases = [];
for (const [name, entries] of CASES) {
  const id = sid();
  const transcript = `${entries.map((e) => JSON.stringify({ ...e, sessionId: id })).join("\n")}\n`;
  writeFileSync(join(projects, `${id}.jsonl`), transcript);
  const results = {};
  for (const includeSystemMessages of [false, true]) {
    results[includeSystemMessages ? "withSystem" : "withoutSystem"] = JSON.stringify(
      await getSessionMessages(id, { includeSystemMessages }),
    );
  }
  cases.push({ name, sessionId: id, transcript, ...results });
}

// ---- 1b. getSessionMessages over transcript files ----

const fileDir = join(process.env.CLAUDE_CONFIG_DIR, "projects", "golden-files");
mkdirSync(fileDir, { recursive: true });
const fsid = () => `00000000-0000-4000-9000-${String(++n).padStart(12, "0")}`;
/** One transcript line for session `id`, as `JSON.stringify` writes it. */
const line = (id, e) => JSON.stringify({ ...e, sessionId: id });
/** A short main chain for `id`: a prompt `text`, a reply, then `more`. */
const chainOf = (id, text, more = "done") => [
  line(id, user("u1", null, text)),
  line(id, assistant("u2", "u1", "ok")),
  line(id, user("u3", "u2", more)),
  line(id, assistant("u4", "u3", "bye")),
];
/** `s` with each `@` replaced by the next of `bytes` (a Buffer each). */
function withBytes(s, ...bytes) {
  const parts = s.split("@");
  if (parts.length !== bytes.length + 1) throw new Error(`withBytes: ${parts.length - 1} marks, ${bytes.length} byte runs`);
  return Buffer.concat(parts.flatMap((p, i) => (i < bytes.length ? [Buffer.from(p), bytes[i]] : [Buffer.from(p)])));
}
const B = (...b) => Buffer.from(b);
const FILES = [
  // Invalid UTF-8 inside strings: each maximal bad run is one U+FFFD.
  ["invalid_utf8_in_strings", (id) => ({ bytes: Buffer.concat([withBytes(`${chainOf(id, "a@b@c@d@e@f@g").join("\n")}\n`,
    B(0xff), B(0xe2, 0x82), B(0xc0, 0xaf), B(0xed, 0xa0, 0x80), B(0xf4, 0x90, 0x80, 0x80), B(0x80))]) })],
  // A bad byte between tokens fails that line's parse: the line is dropped.
  ["invalid_utf8_between_tokens", (id) => {
    const [a, b, c, d] = chainOf(id, "first");
    return { bytes: Buffer.concat([Buffer.from(`${a}\n${b}\n`), withBytes(`${c.slice(0, 1)}@${c.slice(1)}\n${d}\n`, B(0xff))]) };
  }],
  // A character cut by the end of a line, and by the end of the file.
  ["truncated_character_at_line_and_file_end", (id) => {
    const [a, b, c] = chainOf(id, "cut");
    return { bytes: Buffer.concat([Buffer.from(`${a}\n${b}`), B(0xe2, 0x82), Buffer.from(`\n${c}\n`), B(0xf0, 0x9f, 0x98)]) };
  }],
  ["bom_first_line", (id) => ({ bytes: Buffer.from(`\ufeff${chainOf(id, "bom").join("\n")}\n`) })],
  ["crlf", (id) => ({ bytes: Buffer.from(`${chainOf(id, "crlf").join("\r\n")}\r\n`) })],
  ["lone_cr_joins_records", (id) => {
    const [a, b, c, d] = chainOf(id, "cr");
    return { bytes: Buffer.from(`${a}\n${b}\r${c}\n${d}\n`) };
  }],
  // Bytes up to 0x20 (NUL included) before a record are skipped; after one
  // they fail its parse (the would-be leaf `u5` is dropped).
  ["control_bytes_around_records", (id) => {
    const [a, b, c, d] = chainOf(id, "ctl");
    const e = line(id, user("u5", "u4", "nul after"));
    return { bytes: Buffer.concat([B(0x00, 0x01, 0x1f, 0x20, 0x09), Buffer.from(`${a}\n${b}\n${c}\n\x0b\x0c${d}\n${e}`), B(0x00), Buffer.from("\n")]) };
  }],
  ["line_and_paragraph_separators", (id) => ({ bytes: Buffer.from(`${chainOf(id, "one\u2028two\u2029three", "x\u2028").join("\n")}\n`) })],
  ["blank_and_whitespace_lines", (id) => ({ bytes: Buffer.from(`\n\n${chainOf(id, "blank").join("\n \t\n\n")}\n \n`) })],
  ["no_trailing_newline", (id) => ({ bytes: Buffer.from(chainOf(id, "tail").join("\n")) })],
  ["torn_last_line", (id) => {
    const [a, b, c, d] = chainOf(id, "torn");
    return { bytes: Buffer.from(`${a}\n${b}\n${c}\n${d.slice(0, 40)}`) };
  }],
  ["empty_file", () => ({ bytes: Buffer.alloc(0) })],
  ["only_newlines", () => ({ bytes: Buffer.from("\n\n\r\n") })],
  ["unreadable", (id) => ({ bytes: Buffer.from(`${chainOf(id, "secret").join("\n")}\n`), mode: 0 })],
  ["directory", () => ({ dir: true })],
  ["symlink", (id) => ({ symlink: `target-${id}.txt`, target: Buffer.from(`${chainOf(id, "linked").join("\n")}\n`) })],
  ["dangling_symlink", (id) => ({ symlink: `missing-${id}.txt` })],
];
const files = [];
for (const [name, make] of FILES) {
  const id = fsid();
  const body = make(id);
  const path = join(fileDir, `${id}.jsonl`);
  const kept = { name, sessionId: id };
  if (body.bytes !== undefined) {
    writeFileSync(path, body.bytes);
    kept.hex = body.bytes.toString("hex");
  } else if (body.dir) {
    // Not empty, so its `stat` size is over 0 and the lookup takes it.
    mkdirSync(path);
    writeFileSync(join(path, "inside"), "x");
    kept.dir = true;
  } else {
    if (body.target !== undefined) {
      writeFileSync(join(fileDir, body.symlink), body.target);
      kept.targetHex = body.target.toString("hex");
    }
    symlinkSync(body.symlink, path);
    kept.symlink = body.symlink;
  }
  if (body.mode !== undefined) {
    chmodSync(path, body.mode);
    kept.mode = body.mode;
  }
  for (const includeSystemMessages of [false, true]) {
    kept[includeSystemMessages ? "withSystem" : "withoutSystem"] = JSON.stringify(
      await getSessionMessages(id, { includeSystemMessages }),
    );
  }
  files.push(kept);
}

// ---- 2. the git stub check ----

/** `PD` and the fs / path names it imports, found by shape. */
function liftGitStub() {
  const fn = /function ([\w$]+)\(e,t\)\{if\(process\.platform!=="darwin"\|\|Boolean\(t\.DEVELOPER_DIR\)\)return!1;/.exec(bundle);
  if (!fn) throw new Error(`the git-stub check moved in sdk.mjs ${sdkVersion}: re-derive the extraction`);
  let depth = 0;
  let end = -1;
  for (let i = bundle.indexOf("{", fn.index); i < bundle.length; i++) {
    if (bundle[i] === "{") depth++;
    else if (bundle[i] === "}" && --depth === 0) {
      end = i + 1;
      break;
    }
  }
  const src = bundle.slice(fn.index, end);
  if (end < 0 || src.length > 1000 || !src.includes('"/var/db/xcode_select_link"')) {
    throw new Error(`the git-stub slice is wrong in sdk.mjs ${sdkVersion}: re-derive the extraction`);
  }
  // The module imports just before it bind the six helpers it calls.
  const head = bundle.slice(Math.max(0, fn.index - 1000), fn.index);
  const alias = (exported, module) => {
    const imports = [...head.matchAll(new RegExp(`import\\{([^}]*)\\}from"${module}"`, "g"))];
    for (const m of imports.reverse()) {
      const hit = new RegExp(`(?:^|,)${exported} as ([\\w$]+)(?:,|$)`).exec(m[1]);
      if (hit && src.includes(`${hit[1]}(`)) return hit[1];
    }
    throw new Error(`${module}.${exported} isn't imported before the git-stub check in sdk.mjs ${sdkVersion}`);
  };
  const names = [
    alias("existsSync", "fs"),
    alias("lstatSync", "fs"),
    alias("readdirSync", "fs"),
    alias("statSync", "fs"),
    alias("isAbsolute", "path"),
    alias("join", "path"),
  ];
  return (fake) =>
    new Function("process", ...names, `${src}\nreturn ${fn[1]};`)(
      { platform: fake.platform },
      (p) => fake.exists.includes(p),
      (p, o) => probe(fake.lstat?.[p], o),
      (p) => {
        if (p !== "/Applications" || fake.apps === "error") throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        return fake.apps;
      },
      (p, o) => probe(fake.stat?.[p], o),
      nodePath.posix.isAbsolute,
      nodePath.posix.join,
    );
}
/** A staged stat: "present", "error" (throws), else missing. */
function probe(state, options) {
  if (options?.throwIfNoEntry !== false) throw new Error("the check always passes throwIfNoEntry: false");
  if (state === "present") return { isFile: () => false };
  if (state === "error") throw Object.assign(new Error("EACCES"), { code: "EACCES" });
  return undefined;
}

const gitStub = liftGitStub();
const CLT = "/Library/Developer/CommandLineTools";
const LINK = "/var/db/xcode_select_link";
const bare = { platform: "darwin", env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, exists: ["/usr/bin/git"], apps: ["Safari.app"] };
const PROBES = [
  ["stub", bare],
  ["linux", { ...bare, platform: "linux" }],
  ["win32", { ...bare, platform: "win32" }],
  ["developer_dir", { ...bare, env: { ...bare.env, DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer" } }],
  ["developer_dir_empty", { ...bare, env: { ...bare.env, DEVELOPER_DIR: "" } }],
  ["command_line_tools", { ...bare, stat: { [CLT]: "present" } }],
  ["command_line_tools_unreadable", { ...bare, stat: { [CLT]: "error" } }],
  ["xcode_select_link", { ...bare, lstat: { [LINK]: "present" } }],
  ["xcode_select_link_unreadable", { ...bare, lstat: { [LINK]: "error" } }],
  ["xcode_app", { ...bare, apps: ["Safari.app", "Xcode.app"] }],
  ["xcode_beta_app", { ...bare, apps: ["Xcode-beta.app"] }],
  ["xcode_lowercase", { ...bare, apps: ["xcode.APP"] }],
  ["xcode_no_suffix", { ...bare, apps: ["Xcode"] }],
  ["xcode_not_first", { ...bare, apps: ["MyXcode.app"] }],
  ["xcode_app_bak", { ...bare, apps: ["Xcode.app.bak"] }],
  ["xcode_newline", { ...bare, apps: ["Xcode\n.app"] }],
  ["xcode_line_separator", { ...bare, apps: ["Xcode\u2028.app"] }],
  ["xcode_tab", { ...bare, apps: ["Xcode\t.app"] }],
  ["xcode_non_ascii_fold", { ...bare, apps: ["\u212Acode.app", "Xcod\u00E9.app"] }],
  ["applications_unreadable", { ...bare, apps: "error" }],
  ["applications_empty", { ...bare, apps: [] }],
  ["homebrew_git_first", { ...bare, env: { PATH: "/opt/homebrew/bin:/usr/bin" }, exists: ["/opt/homebrew/bin/git", "/usr/bin/git"] }],
  ["homebrew_dir_without_git", { ...bare, env: { PATH: "/opt/homebrew/bin:/usr/bin" } }],
  ["no_git_anywhere", { ...bare, exists: [] }],
  ["no_path", { ...bare, env: {} }],
  ["empty_path", { ...bare, env: { PATH: "" } }],
  ["relative_entries_skipped", { ...bare, env: { PATH: "bin:.:/usr/bin" }, exists: ["bin/git", "git", "/usr/bin/git"] }],
  ["trailing_slash", { ...bare, env: { PATH: "/usr/bin/" } }],
  ["double_slash", { ...bare, env: { PATH: "/usr//bin" } }],
  ["dot_dot", { ...bare, env: { PATH: "/usr/local/../bin" } }],
  ["dot_segment", { ...bare, env: { PATH: "/usr/./bin" } }],
  ["root_git", { ...bare, env: { PATH: "/:/usr/bin" }, exists: ["/git", "/usr/bin/git"] }],
  ["other_git", { ...bare, env: { PATH: "/usr/local/bin" }, exists: ["/usr/local/bin/git"] }],
];
const gitStubResults = PROBES.map(([name, fake]) => ({ name, ...fake, stub: gitStub(fake)("git", fake.env) }));

writeFileSync(
  process.env.SESSION_MESSAGES_GOLDEN_CHILD,
  JSON.stringify({ sdkVersion, cases, gitStub: gitStubResults, files }),
);
