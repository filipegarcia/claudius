#!/usr/bin/env node
// Golden fixture for how the SDK finds and launches the `claude` binary.
//
//   node rust/scripts/binary-golden.mjs     (macOS; builds claudius-fake-claude)
//
// 1. `candidates`: the SDK's default lookup, `xZ(resolve, {platform, arch,
//    exists, preferMusl})`, sliced out of sdk.mjs and run with a fake
//    resolver over Node platform/arch names, both libc preferences and
//    several sets of installed packages. Records what it tried, in order,
//    and what it picked.
// 2. `notFound`: the error template when no package is installed.
// 3. `launches`: real `query()` runs with `pathToClaudeCodeExecutable`
//    pointing at things that fail to launch (missing, a directory, not
//    executable, no shebang, a JS entry with or without `node` on PATH, a
//    secret-looking path). Records the error each stream ended with, or
//    that `query()` itself threw (Node's `spawn` throws synchronously for
//    any errno but EACCES/EAGAIN/EMFILE/ENFILE/ENOENT). Paths are written
//    relative to a `$TMP` placeholder.
// 4. `jsEntry`: a `.js` entry the SDK runs through `node` with
//    `executableArgs`. The script records its argv and exec args.
// 5. `errnoNames`: `util.getSystemErrorName(-n)` for n = 1..120, the names
//    those messages use.
//
// Written to rust/crates/claudius-agent/tests/fixtures/binary_golden.json and
// replayed by crates/claudius-agent/tests/binary_golden.rs.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { getSystemErrorName } from "node:util";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const sdkPath = join(repo, "node_modules/@anthropic-ai/claude-agent-sdk");
const { query } = await import(pathToFileURL(join(sdkPath, "sdk.mjs")).href);
const sdkVersion = JSON.parse(readFileSync(join(sdkPath, "package.json"), "utf8")).version;
const bundle = readFileSync(join(sdkPath, "sdk.mjs"), "utf8");

if (process.platform !== "darwin") throw new Error("record on macOS: the launch errors are macOS errno behaviour");

// ---- 1. candidate lookup ----
function extractLookup() {
  const start = bundle.indexOf('var pc="@anthropic-ai/claude-agent-sdk"');
  const end = bundle.indexOf("var DVe=", start);
  if (start < 0 || end < start) throw new Error("xZ moved in sdk.mjs: update the anchors");
  const slice = bundle.slice(start, end);
  if (!slice.includes("function xZ(")) throw new Error("xZ is not in the slice");
  // `PVe` (existsSync) is imported; every call passes `exists` explicitly.
  return new Function("PVe", `${slice};return xZ;`)(() => {
    throw new Error("unexpected default exists");
  });
}
const xZ = extractLookup();
const PLATFORMS = ["darwin", "linux", "win32", "android", "freebsd"];
const ARCHES = ["arm64", "x64", "ia32", "arm"];
const INSTALLS = [
  [],
  ["darwin-arm64"],
  ["linux-x64"],
  ["linux-x64-musl"],
  ["linux-x64", "linux-x64-musl"],
  ["linux-arm64-android"],
  ["win32-x64"],
  ["win32-arm64", "darwin-arm64"],
];
const candidates = [];
for (const platform of PLATFORMS)
  for (const arch of ARCHES)
    for (const preferMusl of [false, true])
      for (const installed of INSTALLS) {
        const tried = [];
        const resolveFn = (spec) => {
          tried.push(spec);
          // Like `require.resolve`: throws for a package that isn't there.
          const pkg = spec.split("/").slice(0, 2).join("/");
          if (!installed.some((i) => pkg === `@anthropic-ai/claude-agent-sdk-${i}`)) throw new Error("MODULE_NOT_FOUND");
          return `/nm/${spec}`;
        };
        const picked = xZ(resolveFn, { platform, arch, preferMusl, exists: () => true });
        candidates.push({ platform, arch, preferMusl, installed, tried, picked });
      }

// ---- 2. not-found message template ----
const nf = bundle.match(/Native CLI binary for \$\{process\.platform\}-\$\{process\.arch\} not found\.[^`]*/);
if (!nf) throw new Error("not-found message moved in sdk.mjs");
const notFound = nf[0];

// ---- 3 and 4. launches ----
function buildFake() {
  execFileSync("cargo", ["build", "-q", "-p", "claudius-agent", "--bin", "claudius-fake-claude"], {
    cwd: rustDir,
    stdio: "inherit",
    env: { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` },
  });
  return join(rustDir, "target/debug/claudius-fake-claude");
}
buildFake();
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "binary-golden-")));
const nodeDir = dirname(process.execPath);
const emptyDir = join(tmp, "empty-bin");
mkdirSync(emptyDir);
mkdirSync(join(tmp, "a-directory"));
writeFileSync(join(tmp, "not-executable"), "#!/bin/sh\nexit 0\n");
chmodSync(join(tmp, "not-executable"), 0o644);
writeFileSync(join(tmp, "no-shebang"), "exit 0\n");
chmodSync(join(tmp, "no-shebang"), 0o755);
const ENTRY = `const fs = require("fs");
fs.writeFileSync(process.env.ARGV_OUT, JSON.stringify({ argv: process.argv.slice(1), execArgv: process.execArgv }));
`;
symlinkSync(join(tmp, "loop-b"), join(tmp, "loop-a"));
symlinkSync(join(tmp, "loop-a"), join(tmp, "loop-b"));
writeFileSync(join(tmp, "entry.js"), ENTRY);
writeFileSync(join(tmp, "entry.cjs.ts"), ENTRY);
const secret = `sk-ant-api03-${"a1B2".repeat(10)}`;

// [name, relative path, PATH dirs ("$NODE" = this node's dir), executableArgs]
const LAUNCHES = [
  ["missing_native", "nope/claude", ["/usr/bin", "/bin"]],
  ["directory", "a-directory", ["/usr/bin", "/bin"]],
  ["not_executable", "not-executable", ["/usr/bin", "/bin"]],
  ["no_shebang", "no-shebang", ["/usr/bin", "/bin"]],
  ["parent_is_a_file", "not-executable/claude", ["/usr/bin", "/bin"]],
  ["name_too_long", `${"n".repeat(300)}/claude`, ["/usr/bin", "/bin"]],
  ["symlink_loop", "loop-a", ["/usr/bin", "/bin"]],
  ["missing_js_without_node", "nope.mjs", [emptyDir]],
  ["js_without_node", "entry.js", [emptyDir]],
  ["secret_in_path", `${secret}/claude`, ["/usr/bin", "/bin"]],
  ["secret_js_without_node", `${secret}.js`, [emptyDir]],
];
const sub = (s) => s.split(tmp).join("$TMP");

async function launch([name, rel, pathDirs]) {
  const base = { name, path: rel, pathDirs: pathDirs.map((d) => (d === emptyDir ? "$EMPTY" : d)) };
  let q;
  try {
    q = query({
    prompt: "go",
    options: {
      pathToClaudeCodeExecutable: join(tmp, rel),
      cwd: tmp,
      executable: "node",
      env: { PATH: pathDirs.join(":"), HOME: tmp },
    },
  });
  } catch (e) {
    return { ...base, threw: true, error: sub(e.message) };
  }
  let error = null;
  try {
    for await (const msg of q) void msg;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  return { ...base, threw: false, error: error && sub(error) };
}
const launches = [];
for (const l of LAUNCHES) launches.push(await launch(l));

async function jsEntry(file, executableArgs) {
  const out = join(tmp, `argv-${launches.length}-${file}.json`);
  const q = query({
    prompt: "go",
    options: {
      pathToClaudeCodeExecutable: join(tmp, file),
      cwd: tmp,
      executable: "node",
      executableArgs,
      env: { PATH: `${nodeDir}:/usr/bin:/bin`, HOME: tmp, ARGV_OUT: out },
    },
  });
  let error = null;
  try {
    for await (const msg of q) void msg;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const seen = JSON.parse(readFileSync(out, "utf8"));
  return { file, executableArgs, argv: seen.argv.map(sub), execArgv: seen.execArgv, error: error && sub(error) };
}
const jsEntries = [await jsEntry("entry.js", ["--no-warnings", "--max-old-space-size=64"]), await jsEntry("entry.cjs.ts", [])];

const errnoNames = Array.from({ length: 120 }, (_, i) => getSystemErrorName(-(i + 1)));

rmSync(tmp, { recursive: true, force: true });
const file = join(rustDir, "crates/claudius-agent/tests/fixtures/binary_golden.json");
writeFileSync(file, `${JSON.stringify({ sdkVersion, os: "macos", candidates, notFound, launches, jsEntries, errnoNames }, null, 1)}\n`);
for (const l of launches) console.log(`${l.name.padEnd(26)} ${l.threw ? "(threw) " : ""}${l.error}`);
for (const j of jsEntries) console.log(`${j.file.padEnd(26)} ${JSON.stringify(j.execArgv)} ${JSON.stringify(j.argv.slice(0, 4))}… ${j.error}`);
console.log(`${candidates.length} lookup cases; wrote ${file.slice(repo.length + 1)}`);
