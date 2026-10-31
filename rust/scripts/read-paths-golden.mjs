#!/usr/bin/env node
// Golden fixture for the Read-path extraction behind the post-compaction
// re-seed (S18), recorded from the real TS source:
//
//   node rust/scripts/read-paths-golden.mjs     (node@22)
//
// Runs `extractReadPaths` (lib/shared/read-tool-paths.ts, through node's
// type stripping) over SDK message shapes, odd ones included, and records
// `{ name, message, paths }` per case. The child runs twice and both runs
// must agree byte for byte.
//
// Written to rust/crates/claudius-core/tests/fixtures/read_paths_golden.json
// and replayed by crates/claudius-core/tests/read_paths_golden.rs.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "crates/claudius-core/tests/fixtures/read_paths_golden.json");

if (!process.env.READ_PATHS_GOLDEN_CHILD) {
  const runs = [0, 1].map(() => {
    const r = spawnSync(
      process.execPath,
      ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url)],
      { cwd: repo, encoding: "utf8", maxBuffer: 1 << 26, env: { ...process.env, READ_PATHS_GOLDEN_CHILD: "1" } },
    );
    if (r.status !== 0) {
      process.stderr.write(r.stderr);
      process.exit(r.status ?? 1);
    }
    return r.stdout;
  });
  if (runs[0] !== runs[1]) {
    console.error("read-paths-golden: the two runs disagree");
    process.exit(1);
  }
  writeFileSync(out, runs[0]);
  const n = JSON.parse(runs[0]).length;
  console.log(`wrote ${out.slice(repo.length + 1)}: ${n} cases (stable)`);
  process.exit(0);
}

const { extractReadPaths } = await import(pathToFileURL(join(repo, "lib/shared/read-tool-paths.ts")).href);

const read = (input) => ({ type: "tool_use", id: "toolu_r", name: "Read", input });
const asst = (content) => ({ type: "assistant", message: { role: "assistant", content } });

const CASES = [
  ["null", null],
  ["zero", 0],
  ["a string", "assistant"],
  ["true", true],
  ["an array", [asst([read({ file_path: "/a" })])]],
  ["empty object", {}],
  ["user message with a Read", { type: "user", message: { content: [read({ file_path: "/a" })] } }],
  ["system message", { type: "system", subtype: "compact_boundary", message: { content: [read({ file_path: "/a" })] } }],
  ["type Assistant", { type: "Assistant", message: { content: [read({ file_path: "/a" })] } }],
  ["type not a string", { type: ["assistant"], message: { content: [read({ file_path: "/a" })] } }],
  ["no message", { type: "assistant" }],
  ["null message", { type: "assistant", message: null }],
  ["string message", { type: "assistant", message: "content" }],
  ["number message", { type: "assistant", message: 5 }],
  ["false message", { type: "assistant", message: false }],
  ["array message", { type: "assistant", message: [read({ file_path: "/a" })] }],
  ["content at the top level", { type: "assistant", content: [read({ file_path: "/a" })] }],
  ["string content", { type: "assistant", message: { content: "Read /a" } }],
  ["object content", { type: "assistant", message: { content: { 0: read({ file_path: "/a" }) } } }],
  ["empty content", asst([])],
  ["one Read", asst([read({ file_path: "/repo/src/main.rs" })])],
  ["reads in order with repeats", asst([read({ file_path: "/b" }), read({ file_path: "/a" }), read({ file_path: "/b" })])],
  ["odd blocks are skipped", asst([null, 0, "", false, 5, "tool_use", [], [read({ file_path: "/x" })], {}, read({ file_path: "/kept" })])],
  ["other tools", asst([
    { type: "tool_use", name: "Edit", input: { file_path: "/e" } },
    { type: "tool_use", name: "read", input: { file_path: "/lower" } },
    { type: "tool_use", name: "READ", input: { file_path: "/upper" } },
    { type: "tool_use", name: " Read", input: { file_path: "/space" } },
    { type: "tool_use", name: "mcp__fs__Read", input: { file_path: "/mcp" } },
    { type: "tool_use", input: { file_path: "/noname" } },
    { type: "tool_use", name: null, input: { file_path: "/nullname" } },
  ])],
  ["other block types", asst([
    { type: "text", name: "Read", input: { file_path: "/text" } },
    { type: "server_tool_use", name: "Read", input: { file_path: "/server" } },
    { type: "Tool_use", name: "Read", input: { file_path: "/cased" } },
    { name: "Read", input: { file_path: "/untyped" } },
    { type: null, name: "Read", input: { file_path: "/nulltype" } },
  ])],
  ["odd inputs", asst([
    { type: "tool_use", name: "Read" },
    read(null),
    read("file_path"),
    read(["/arr"]),
    read(7),
    read({}),
    read({ path: "/p" }),
    read({ filePath: "/camel" }),
  ])],
  ["odd file paths", asst([
    read({ file_path: "" }),
    read({ file_path: null }),
    read({ file_path: 5 }),
    read({ file_path: ["/a"] }),
    read({ file_path: { p: "/a" } }),
    read({ file_path: true }),
    read({ file_path: " " }),
    read({ file_path: "relative/x.ts" }),
    read({ file_path: "/with space/and \u00e9\u00e8 \u{1f600}.md" }),
    read({ file_path: "/tab\there\nnewline" }),
    read({ file_path: "C:\\win\\path.txt" }),
  ])],
  ["extra input fields are ignored", asst([read({ file_path: "/a", offset: 10, limit: 20 })])],
  ["a subagent's Read counts", { ...asst([read({ file_path: "/sub" })]), parent_tool_use_id: "toolu_task" }],
  ["mixed with text and thinking", asst([
    { type: "thinking", thinking: "let me read" },
    { type: "text", text: "Reading." },
    read({ file_path: "/one" }),
    { type: "tool_use", name: "Bash", input: { command: "cat /two" } },
    read({ file_path: "/three" }),
  ])],
];

const cases = CASES.map(([name, message]) => ({ name, message, paths: extractReadPaths(message) }));
process.stdout.write(JSON.stringify(cases, null, 1) + "\n");
