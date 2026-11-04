#!/usr/bin/env node
// Golden fixture for the Files API (D03): every method of
// `app/api/workspaces/[id]/files/route.ts` (GET / PUT / POST / DELETE /
// PATCH) with what it imports: `resolveWorkspaceRoot` / `listWorkspaceRoots`
// (lib/server/workspace-roots.ts), the workspace and customization stores,
// `getRepoRoot` (lib/server/git.ts) and lib/shared/text-encoding.ts.
//
//   node rust/scripts/workspace-files-golden.mjs     (node@22)
//
// Re-runs itself under `--experimental-transform-types` (with a resolve hook
// for the `@/` and extensionless imports), once per group and twice over,
// each group in a fresh world; both recordings must agree byte for byte. A
// world is `$ROOT`, a temp dir (through realpath) padded to exactly
// `rootLen` characters so the Rust replay can rebuild it at the same length
// (Node's NUL-byte messages cut the path at 128 units). The child runs with
// its cwd at `$ROOT/project`, HOME at `$ROOT/home`, CLAUDE_CONFIG_DIR at
// `$ROOT/config`, TZ=UTC, GIT_CONFIG_NOSYSTEM=1 and umask 022, and calls the
// exported handlers directly with a `Request` and `{params}` (the route reads
// nothing from Next's request scope), the id decoded from the path segment
// as Next decodes it.
//
// Records:
// - `pure`: lib/shared/text-encoding.ts over byte strings (`detect`:
//   `detectTextEncoding`, then `decodeText` / `decodePreview` as the GET
//   handler picks; `encode`: `encodeText`, the text also as its UTF-16
//   code units), the windows-1252 preview of every
//   byte, and `String.prototype.toLowerCase` (`lower`: every code point that
//   changes, then whole strings for the Final_Sigma context).
// - `groups`: one world each. `steps` are fs setup ops (`fs`: `mkdir`,
//   `write` text / hex / `rep` (a text repeated), `zero` (a sparse file of
//   `size` bytes), `symlink`, `chmod`, `fifo`, `mtime` (records the ns it
//   read back), `rm`, `gen` (`count` empty-or-`text` files named prefix +
//   zero-padded index)) and requests (`req`: `method`, `url`, `body` text or
//   `bodyHex`). A request records `got`: `status`, `type`, `cache` and the
//   body (`body` text up to 16 KiB, else `sha`: sha256 and length; `hex` or
//   `sha` for a non-JSON body), or `threw` (Next's empty 500). Every step then
//   records `pins` (the mtimes the recorder pinned after it: every regular
//   entry whose mtime changed gets the next pinned time, `[rel, ns]`) and
//   `tree` (each entry under the world whose state changed: kind, mode, size,
//   bytes as hex up to 64 bytes or sha256, link target; `null` when gone).
//   Top-level `gen-*` dirs are neither pinned nor snapshotted, and files over
//   4 MiB are snapshotted without their bytes (`b: "large"`). `init` has the
//   pins of the empty world (`home`, `config`, `project`).
//   `os` marks groups that replay only on the recording platform, `perms`
//   groups that need permissions enforced (not root).
//
// Placeholders: `$ROOT` in paths, URLs, bodies, file texts and link targets;
// `$RREL` is the root without its leading `/` (relative to a `/` root). The
// world root itself is pinned as `""`.
// Strings stay ASCII here: non-ASCII text is built with String.fromCodePoint
// and lone surrogates with String.fromCharCode.
//
// Written to rust/crates/claudius-core/tests/fixtures/workspace_files_golden.json;
// replayed by crates/claudius-core/tests/workspace_files_golden.rs (pure) and
// crates/claudius-server/tests/workspace_files.rs (groups, on the real binary).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "crates/claudius-core/tests/fixtures/workspace_files_golden.json");

const ROOT_LEN = 100;
const GROUPS = ["read", "darwin", "read-perms", "search", "limits", "write", "write-perms", "store"];

/** chmod every directory under `p` back to 0755, so it can be removed. */
function openUp(p) {
  let st;
  try {
    st = lstatSync(p);
  } catch {
    return;
  }
  if (!st.isDirectory()) return;
  try {
    chmodSync(p, 0o755);
  } catch {
    return;
  }
  for (const e of readdirSync(p)) openUp(join(p, e));
}

// ------------------------------- recording -------------------------------

if (!process.env.WF_GOLDEN_ROOT) {
  const child = (group) => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "wf-")));
    try {
      const pad = ROOT_LEN - base.length - 1;
      if (pad < 1) throw new Error(`temp dir too long for a ${ROOT_LEN}-char root: ${base}`);
      const root = join(base, "r".repeat(pad));
      if (root.length !== ROOT_LEN || !/^[A-Za-z0-9_./-]+$/.test(root)) throw new Error(`bad root: ${root}`);
      for (const d of ["home", "config", "project"]) mkdirSync(join(root, d), { recursive: true });
      const r = spawnSync(
        process.execPath,
        ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url)],
        {
          cwd: join(root, "project"),
          encoding: "utf8",
          maxBuffer: 1 << 28,
          env: {
            PATH: process.env.PATH,
            HOME: join(root, "home"),
            CLAUDE_CONFIG_DIR: join(root, "config"),
            TZ: "UTC",
            GIT_CONFIG_NOSYSTEM: "1",
            WF_GOLDEN_ROOT: root,
            WF_GOLDEN_GROUP: group,
            WF_GOLDEN_OUT: join(base, "out.json"),
          },
        },
      );
      if (r.status !== 0) {
        process.stdout.write(r.stdout);
        process.stderr.write(r.stderr);
        process.exit(r.status ?? 1);
      }
      return JSON.parse(readFileSync(join(base, "out.json"), "utf8"));
    } finally {
      openUp(base);
      rmSync(base, { recursive: true, force: true });
    }
  };
  const runs = [0, 1].map(() =>
    JSON.stringify({ rootLen: ROOT_LEN, pure: child("pure"), groups: GROUPS.map((g) => child(g)) }),
  );
  if (runs[0] !== runs[1]) {
    if (process.env.WF_GOLDEN_DUMP) {
      runs.forEach((r, i) => writeFileSync(`${process.env.WF_GOLDEN_DUMP}.${i}.json`, `${JSON.stringify(JSON.parse(r), null, 1)}\n`));
    }
    throw new Error("the two recordings differ");
  }
  const fixture = JSON.parse(runs[0]);
  writeFileSync(out, `${JSON.stringify(fixture, null, 1)}\n`);
  const reqs = fixture.groups.reduce((n, g) => n + g.steps.filter((s) => s.op === "req").length, 0);
  const steps = fixture.groups.reduce((n, g) => n + g.steps.length, 0);
  const pure = fixture.pure.detect.length + fixture.pure.encode.length;
  console.log(
    `wrote ${out.slice(repo.length + 1)}: ${pure} encoding cases, ${fixture.pure.binary.length} binary paths, ` +
      `${fixture.pure.lower.length} lowercased code points, ` +
      `${fixture.pure.lowerStrings.length} lowercased strings, ${fixture.groups.length} groups, ${steps} steps (${reqs} requests) (stable)`,
  );
  process.exit(0);
}

// --------------------------------- child ---------------------------------

const ROOT = process.env.WF_GOLDEN_ROOT;
const GROUP = process.env.WF_GOLDEN_GROUP;
process.umask(0o022);

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
    // A bare CJS subpath without an exports map (\`next/server\`).
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

const cp = (...cps) => String.fromCodePoint(...cps);
const unit = (...units) => String.fromCharCode(...units);
const sha = (buf) => createHash("sha256").update(buf).digest("hex");
// `$RREL` is the root without its leading `/` (a path relative to `/`).
const real = (s) => s.replaceAll("$ROOT", ROOT).replaceAll("$RREL", ROOT.slice(1));
const fake = (s) => s.replaceAll(ROOT, "$ROOT").replaceAll(ROOT.slice(1), "$RREL");
/** `fake` on raw bytes. */
function fakeBytes(buf) {
  const parts = [];
  let at = 0;
  for (const [needle, with_] of [[ROOT, "$ROOT"]]) {
    const n = Buffer.from(needle);
    for (let i = buf.indexOf(n); i >= 0; i = buf.indexOf(n, at)) {
      parts.push(buf.subarray(at, i), Buffer.from(with_));
      at = i + n.length;
    }
  }
  parts.push(buf.subarray(at));
  return Buffer.concat(parts);
}
const hexOf = (s) => Buffer.from(s, "utf8").toString("hex");
const utf16le = (s) => {
  const b = Buffer.alloc(s.length * 2);
  for (let i = 0; i < s.length; i++) b.writeUInt16LE(s.charCodeAt(i), i * 2);
  return b.toString("hex");
};
const utf16be = (s) => {
  const b = Buffer.alloc(s.length * 2);
  for (let i = 0; i < s.length; i++) b.writeUInt16BE(s.charCodeAt(i), i * 2);
  return b.toString("hex");
};

// --------------------------------- pure ---------------------------------

if (GROUP === "pure") {
  const te = await import(join(repo, "lib/shared/text-encoding.ts"));
  const ft = await import(join(repo, "lib/shared/file-types.ts"));
  const inputs = [
    "",
    "68656c6c6f",
    "efbbbf",
    "efbbbf68",
    "efbbbfefbbbf68",
    "efbbbfff",
    "efbbbfc3",
    "efbb",
    "ef",
    "fffe",
    "fffe4100",
    "fffe410042",
    "fffe00d8",
    "fffe00d84100",
    "fffe00dc4100",
    "fffe3dd800de",
    "fffe3dd8",
    "fffefffe4100",
    "fffe00",
    "fffe0000",
    "fffe00004100",
    "fffe000041000000",
    "0000feff",
    "0000feff00000041",
    "0000fe",
    "feff",
    "feff0041",
    "feff004100",
    "feffd8000041",
    "feffd83dde00",
    "feffdc00",
    "feff00",
    "fe",
    "ff",
    "00",
    "6100",
    "610062",
    "eda080",
    "eda080eda080",
    "c0af",
    "e0808f",
    "f4908080",
    "f0808080",
    "f09f9880",
    "f09f98",
    "e282",
    "e2",
    "c3a9",
    "c3",
    "e9",
    "80",
    "8081828384858687888990",
    "939a967b",
    "41ff42",
    "efbfbd",
    "f48fbfbf",
    hexOf(`caf${cp(0xe9)} ${cp(0x1f600)} ${cp(0x2028)}${cp(0x10fffd)}`),
    "efbbbf" + hexOf(cp(0xfeff, 0x41)),
    "fffe" + utf16le(`h${cp(0x1f600)}${unit(0xfeff)}`),
    "feff" + utf16be(`h${cp(0x1f600)}`),
    "89504e470d0a1a0a0000000d49484452",
    "47494638396101000100",
    "ffd8ffe000104a464946",
    "7b0a7d",
  ];
  // NUL at the probe's edge (8 KiB), and after it.
  inputs.push("61".repeat(8191) + "00");
  inputs.push("61".repeat(8192) + "00");
  inputs.push("61".repeat(8192) + "00ff");
  inputs.push("efbbbf" + "61".repeat(8189) + "00");
  inputs.push("efbbbf" + "61".repeat(8192) + "00");
  inputs.push("fffe" + "6100".repeat(5000));
  // Every single byte, and every byte after a valid prefix.
  for (let b = 0; b < 256; b++) inputs.push(b.toString(16).padStart(2, "0"));
  for (let b = 0x80; b < 256; b++) inputs.push("41" + b.toString(16).padStart(2, "0") + "42");
  const detect = inputs.map((hex) => {
    const bytes = Buffer.from(hex, "hex");
    const d = te.detectTextEncoding(bytes);
    let content;
    try {
      content = d.editable ? te.decodeText(bytes, d.encoding) : te.decodePreview(bytes, d.guess);
    } catch (e) {
      content = { threw: e.message };
    }
    // Long inputs are kept as their generator, not the bytes.
    const input = hex.length > 400 ? { gen: genSpec(hex) } : { hex };
    return { ...input, detected: d, content };
  });
  // `decodeText` with an encoding the sniff didn't pick (it throws when the
  // bytes don't decode).
  const forced = [];
  for (const hex of ["", "68", "efbbbf68", "fffe6100", "fffe61", "ff", "efbbbfff", "00d8", "6100"]) {
    for (const enc of ["utf-8", "utf-8-bom", "utf-16le"]) {
      let content;
      try {
        content = te.decodeText(Buffer.from(hex, "hex"), enc);
      } catch (e) {
        content = { threw: e.message };
      }
      forced.push({ hex, encoding: enc, content });
    }
  }
  const previews = [];
  for (const hex of ["", "fe", "feff", "feff00", "feff0041dc00", "efbbbf41", "efbbbfff", "ff41", "80ff"]) {
    for (const guess of ["utf-16be", "utf-32", "binary", "legacy"]) {
      previews.push({ hex, guess, content: te.decodePreview(Buffer.from(hex, "hex"), guess) });
    }
  }
  const texts = [
    "",
    "a",
    "hello\nworld",
    cp(0xfeff),
    `${cp(0xfeff)}x`,
    `caf${cp(0xe9)} ${cp(0x1f600)}`,
    unit(0xd800),
    `a${unit(0xdc00)}b`,
    cp(0x10fffd),
    "\u0000\r\n",
  ];
  const encode = [];
  for (const text of texts) {
    for (const enc of ["utf-8", "utf-8-bom", "utf-16le"]) {
      // `units`: the text's UTF-16 code units (4 hex digits each), which a
      // replay can't always tell from the JSON (U+10F800 and up).
      const hex = Buffer.from(te.encodeText(text, enc)).toString("hex");
      encode.push({ text, units: utf16be(text), encoding: enc, hex });
    }
  }
  let win1252 = "";
  for (let b = 0; b < 256; b++) win1252 += te.decodePreview(Buffer.from([b]), "legacy");
  const lower = [];
  for (let c = 0; c <= 0x10ffff; c++) {
    if (c >= 0xd800 && c <= 0xdfff) continue;
    const s = cp(c);
    const l = s.toLowerCase();
    if (l !== s) lower.push([c, l]);
  }
  const SIG = cp(0x3a3);
  const lowerStrings = [
    SIG,
    `A${SIG}`,
    `A${SIG}B`,
    `A${SIG} B`,
    `A${SIG}.`,
    `A${SIG}'`,
    `A'${SIG}`,
    `A${cp(0x301)}${SIG}`,
    `A${SIG}${cp(0x301)}`,
    `A${SIG}${cp(0x301)}B`,
    `${SIG}${SIG}`,
    `${SIG}${SIG}${SIG}`,
    ` ${SIG} `,
    `1${SIG}`,
    `A${SIG}1`,
    `${cp(0x130)}stanbul`,
    `${cp(0x130)}${SIG}`,
    `A${cp(0x200b)}${SIG}`,
    `A${SIG}${cp(0x200b)}`,
    `A${cp(0xad)}${SIG}`,
    `${cp(0x1f600)}${SIG}`,
    `${cp(0x10400)}${SIG}`,
    `${cp(0x3b1)}${SIG}${cp(0x3b1)}`,
    `HELLO ${SIG}${cp(0x391)}${SIG}`,
    `${cp(0x1e9e)}${cp(0x212a)}${cp(0x2126)}`,
    `ABC${unit(0xd800)}${SIG}`,
    `A${SIG}${unit(0xdc00)}`,
  ].map((s) => [s, s.toLowerCase()]);
  // CC 2.1.301 `isKnownBinaryPath` (lib/shared/file-types.ts): every
  // extension of the set in both cases, and the edges of the split (a
  // backslash counts as a separator, a leading dot doesn't open an
  // extension, the ext is lowercased by JS `toLowerCase`).
  const exts = [...ft.BINARY_EXTS];
  const binaryPaths = [
    ...exts.flatMap((e) => [`/w/a.${e}`, `/w/a.${e.toUpperCase()}`]),
    "",
    "/",
    ".",
    "..",
    "a",
    "a.",
    ".zip",
    "/w/.zip",
    "/w/..zip",
    "/w/...zip",
    "zip",
    "/w/a.zip.txt",
    "/w/a.txt.zip",
    "/w/x.tar.gz",
    "/w/a.gz.",
    "/w/a.zip/b",
    "/w/a.zip/b.txt",
    "a.zip\\b",
    "w\\x.parquet",
    "/w/a.zip ",
    "/w/a. zip",
    "/w/a.ZiP",
    "/w/a.json",
    "/w/a.svg",
    "/w/a.csv",
    "/w/a.ipynb",
    "/w/a.md",
    `/w/a.${cp(0x212a)}MV`,
    `/w/a.M${cp(0x212a)}V`,
    `/w/a.z${cp(0x130)}p`,
    `/w/caf${cp(0xe9)}.zip`,
    `/w/${cp(0x1f600)}.zip`,
    `/w/a.zip${cp(0x200b)}`,
    `/w/a.${unit(0xd800)}zip`,
    "/w/a.zip\u0000",
    "/w/sub.zip/a.txt",
    "/w/a.o",
    "/w/a.a",
    "/w/a.A",
  ];
  const binary = binaryPaths.map((path) => [path, ft.isKnownBinaryPath(path)]);
  writeFileSync(
    process.env.WF_GOLDEN_OUT,
    JSON.stringify({ detect, forced, previews, encode, win1252, lower, lowerStrings, exts, binary }),
  );
  process.exit(0);
}

/** A long hex input as `{repeat, count, then}` when it is one byte pair repeated. */
function genSpec(hex) {
  for (const head of ["", "efbbbf", "fffe"]) {
    if (!hex.startsWith(head)) continue;
    const rest = hex.slice(head.length);
    for (const unitLen of [2, 4]) {
      const u = rest.slice(0, unitLen);
      let n = 0;
      while (rest.startsWith(u, n * unitLen)) n++;
      const tail = rest.slice(n * unitLen);
      if (n > 100 && tail.length <= 8) return { head, repeat: u, count: n, tail };
    }
  }
  throw new Error(`no generator for ${hex.slice(0, 40)}`);
}

// --------------------------------- routes ---------------------------------

const route = await import(join(repo, "app/api/workspaces/[id]/files/route.ts"));

const STORE = "home/.claude/.claudius/workspaces.json";
const CUST = "home/.claude/.claudius/customizations";
const R = "$ROOT";

const F = {
  mkdir: (path) => ({ op: "fs", act: "mkdir", path }),
  write: (path, text) => ({ op: "fs", act: "write", path, text }),
  hex: (path, hex) => ({ op: "fs", act: "write", path, hex }),
  rep: (path, text, count, tail = "") => ({ op: "fs", act: "write", path, rep: { text, count, tail } }),
  zero: (path, size) => ({ op: "fs", act: "zero", path, size }),
  link: (path, target) => ({ op: "fs", act: "symlink", path, target }),
  chmod: (path, mode) => ({ op: "fs", act: "chmod", path, mode }),
  fifo: (path) => ({ op: "fs", act: "fifo", path }),
  mtime: (path, sec) => ({ op: "fs", act: "mtime", path, sec }),
  rm: (path) => ({ op: "fs", act: "rm", path }),
  gen: (path, prefix, count, width, text = "") => ({ op: "fs", act: "gen", path, prefix, count, width, text }),
};
const store = (workspaces, extra = {}) => F.write(STORE, JSON.stringify({ version: 1, ...extra, workspaces }, null, 2));
const custIndex = (customizations, extra = {}) =>
  F.write(`${CUST}/index.json`, JSON.stringify({ version: 1, customizations, publishes: [], ...extra }));
const wsEntry = (id, rootPath, extra = {}) => ({ id, name: id, rootPath, ...extra });

// `$ROOT` stays literal (the replay swaps it in the URL text).
const enc = (s) => encodeURIComponent(s).replaceAll("%24ROOT", "$ROOT");
const qs = (params) => {
  const parts = Object.entries(params).map(([k, v]) => `${enc(k)}=${enc(v)}`);
  return parts.length ? `?${parts.join("&")}` : "";
};
const url = (id, params = {}) => `/api/workspaces/${id}/files${typeof params === "string" ? params : qs(params)}`;
const REQ = (method, id, params, extra = {}) => ({ op: "req", method, url: url(id, params), ...extra });
const G = (id, params) => REQ("GET", id, params);
const PUT = (id, params, body = "", extra = {}) => REQ("PUT", id, params, { body, ...extra });
const PUTX = (id, params, hex) => REQ("PUT", id, params, { bodyHex: hex });
const POST = (id, params) => REQ("POST", id, params);
const DEL = (id, params) => REQ("DELETE", id, params);
const PATCH = (id, params) => REQ("PATCH", id, params);

// ------------------------------- the groups -------------------------------

const E = cp(0xe9);
const NFD_E = `e${cp(0x301)}`;
const EMOJI = cp(0x1f600);

/** A tree every reading group starts from: `ws` (the workspace), `outside`. */
function baseTree() {
  return [
    F.mkdir("ws"),
    F.mkdir("outside"),
    F.write("outside/secret.txt", "outside the root\n"),
    F.mkdir("outside/dir"),
    F.write("outside/dir/o.txt", "o"),
    F.write("ws/utf8.txt", "hello\nworld\n"),
    F.write("ws/unicode.txt", `caf${E} ${EMOJI} ${cp(0x2028)} ${cp(0x10fffd)} \u0001\u007f"\\ ${cp(0xfeff)}`),
    F.write("ws/empty.txt", ""),
    F.hex("ws/bom.txt", "efbbbf" + hexOf("with bom\n")),
    F.hex("ws/bom-only.txt", "efbbbf"),
    F.hex("ws/bom-bom.txt", "efbbbfefbbbf79"),
    F.hex("ws/bom-bad.txt", "efbbbf41ff"),
    F.hex("ws/u16le.txt", "fffe" + utf16le(`h${EMOJI}i\n`)),
    F.hex("ws/u16le-empty.txt", "fffe"),
    F.hex("ws/u16le-odd.txt", "fffe410042"),
    F.hex("ws/u16le-lone.txt", "fffe00d84100"),
    F.hex("ws/u16be.txt", "feff" + utf16be(`be${EMOJI}\n`)),
    F.hex("ws/u16be-odd.txt", "feff004100"),
    F.hex("ws/u16be-lone.txt", "feffd8000041"),
    F.hex("ws/u32le.txt", "fffe000041000000"),
    F.hex("ws/u32be.txt", "0000feff00000041"),
    F.hex("ws/latin1.txt", "63616689e9" + "80818d8f909d9fff"),
    F.hex("ws/sjis.txt", "93fa967b"),
    F.hex("ws/surrogate.txt", "eda080"),
    F.hex("ws/nul.bin", "61620063"),
    F.hex("ws/png.png", "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"),
    F.write("ws/crlf.txt", "one\r\ntwo\r\n"),
    F.mkdir("ws/sub"),
    F.write("ws/sub/inner.txt", "inner"),
    F.mkdir("ws/sub/deeper"),
    F.write("ws/sub/deeper/leaf.md", "# leaf"),
    F.mkdir("ws/empty-dir"),
  ];
}

const W = "wks_read";

function groupRead() {
  const nul8191 = { op: "fs", act: "write", path: "ws/nul-8191.txt", hex: "61".repeat(8191) + "00" };
  const nul8192 = { op: "fs", act: "write", path: "ws/nul-8192.txt", hex: "61".repeat(8192) + "00" + hexOf("\ntail") };
  return [
    ...baseTree(),
    nul8191,
    nul8192,
    // Listing order and hidden names.
    F.mkdir("ws/order"),
    ...[
      "b",
      "_x",
      "~x",
      "10",
      "9",
      "a b",
      "Zed",
      `${E}a`,
      `${NFD_E}b`,
      cp(0xc4),
      `${cp(0xe4)}2`,
      cp(0xdf),
      "ss",
      EMOJI,
      cp(0x65e5, 0x672c),
      "z",
      "z\u0001",
      "-dash",
      "#hash",
      "a.b",
      "a-b",
      "A1",
    ].map((n) => F.write(`ws/order/${n}`, n)),
    ...["d-b", "D-a", "_d", `${E}dir`].map((n) => F.mkdir(`ws/order/${n}`)),
    F.mkdir("ws/hidden"),
    ...[".git", "node_modules", ".next", "dist", "build", ".turbo", ".cache", "coverage"].map((n) => F.mkdir(`ws/hidden/${n}`)),
    F.write("ws/hidden/.DS_Store", "x"),
    F.write("ws/hidden/.env", "SECRET=1"),
    F.mkdir("ws/hidden/..foo"),
    F.write("ws/hidden/dist ", "trailing space"),
    F.write("ws/hidden/coverage.txt", "c"),
    F.write("ws/hidden/visible", "v"),
    F.mkdir("ws/hidden/Node_Modules2"),
    // Symlinks, a fifo.
    F.link("ws/link-in", "utf8.txt"),
    F.link("ws/link-out", `${R}/outside/secret.txt`),
    F.link("ws/link-dir-in", "sub"),
    F.link("ws/link-dir-out", `${R}/outside/dir`),
    F.link("ws/dangling", `${R}/nowhere`),
    F.link("ws/loop1", "loop2"),
    F.link("ws/loop2", "loop1"),
    F.link("ws/self", "self"),
    F.link("ws/link-up", ".."),
    F.fifo("ws/pipe"),
    F.mkdir("ws/..foo"),
    F.write("ws/..foo/x.txt", "dotdot"),
    F.mkdir("ws/...dots"),
    F.write("ws/.dotfile", "dot"),
    F.write(`ws/${"x".repeat(250)}`, "long name"),
    // Images.
    F.mkdir("ws/img"),
    F.hex("ws/img/a.png", "89504e470d0a1a0a"),
    F.hex("ws/img/b.PNG", "89504e47"),
    ...["jpg", "jpeg", "gif", "svg", "webp", "ico", "bmp", "avif", "tiff", "tif", "txt", "JPEG", "Gif", "gz", "tar.gz", "constructor", "__proto__", "CONSTRUCTOR", "toString", "tostring", "hasOwnProperty", "valueOf", "__PROTO__", "png ", "p" + "ng"].map((ext) =>
      F.hex(`ws/img/f.${ext}`, "ffd8ff"),
    ),
    F.write("ws/img/noext", "x"),
    F.write("ws/img/.png", "dotpng"),
    F.mkdir("ws/img/dir.png"),
    F.link("ws/img/link.png", "a.png"),
    F.link("ws/img/dangling.png", "nope.png"),
    F.mkdir("ws/img.d"),
    F.write("ws/img.d/plain", "p"),
    // Known binary formats (CC 2.1.301): never shown as text, whatever
    // their bytes are.
    F.mkdir("ws/bin"),
    ...["zip", "ZIP", "parquet", "heic", "XLSM", "gz", "db", "o", "a", "wasm", "woff2", "Ogg", "json", "svg", "csv", "txt", "jsonl", "md"].map((ext) =>
      F.write(`ws/bin/f.${ext}`, "plain text\n"),
    ),
    F.write("ws/bin/f.tar.gz", "plain text\n"),
    F.write("ws/bin/.zip", "dotzip"),
    F.write("ws/bin/noext", "x"),
    F.write("ws/bin/trailing.", "x"),
    F.write("ws/bin/a.zip.txt", "x"),
    F.write("ws/bin/f.zip ", "space after the ext"),
    F.write(`ws/bin/f.${cp(0x212a)}MV`, "kelvin ext"),
    F.mkdir("ws/bin/dir.zip"),
    F.write("ws/bin/dir.zip/inner.txt", "inner"),
    F.hex("ws/bin/nul.zip", "61006200"),
    F.hex("ws/bin/u16.zip", "fffe" + utf16le("hi")),
    F.write("ws/bin/empty.zip", ""),
    F.link("ws/bin/link.zip", "f.zip"),
    F.link("ws/bin/dangling.zip", "nope.zip"),
    // Big files (2 MiB / 10 MiB edges), never snapshotted.
    F.mkdir("big"),
    F.zero("big/2m.txt", 2 * 1024 * 1024),
    F.zero("big/2m1.txt", 2 * 1024 * 1024 + 1),
    F.rep("big/2m-text.txt", "abcdefghijklmnop", (2 * 1024 * 1024) / 16),
    F.zero("big/10m.png", 10 * 1024 * 1024),
    F.zero("big/10m1.png", 10 * 1024 * 1024 + 1),
    F.zero("big/10m1.txt", 10 * 1024 * 1024 + 1),
    // Over both caps, but a known binary extension: the placeholder, not
    // "file too large" (real .parquet / .heic are large).
    F.zero("big/5m.parquet", 5 * 1024 * 1024),
    F.zero("big/11m.heic", 11 * 1024 * 1024),
    // A repo the workspace is a subfolder of, for `base=git`.
    F.mkdir("repo/.git/objects"),
    F.mkdir("repo/.git/refs"),
    F.write("repo/.git/HEAD", "ref: refs/heads/main\n"),
    F.write("repo/top.txt", "repo top"),
    F.mkdir("repo/sub"),
    F.write("repo/sub/in-sub.txt", "in sub"),
    F.mkdir("repo/sub/sub"),
    F.write("repo/sub/sub/twice.txt", "sub twice"),
    // Extra roots.
    F.mkdir("extra1"),
    F.write("extra1/e1.txt", "extra one"),
    F.mkdir("extra2"),
    F.write("extra2/e2.txt", "extra two"),
    F.mkdir("extra3"),
    F.write("extra3/e3.txt", "extra three"),
    F.mkdir("ws/.claude"),
    F.write("ws/.claude/settings.json", JSON.stringify({ permissions: { additionalDirectories: [`${R}/extra3`, `${R}/extra1`, "", 7] } })),
    F.link("link-ws", "ws"),
    // Customizations.
    custIndex([{ id: "cust_a", name: "a" }, { id: "cust_nosrc" }]),
    F.mkdir(`${CUST}/cust_a/src`),
    F.write(`${CUST}/cust_a/src/c.txt`, "customized"),
    F.mkdir(`${CUST}/cust_a/src/nested`),
    store([
      wsEntry(W, `${R}/ws`, {
        defaults: { additionalDirectories: [`${R}/extra1`, "  ", 5, null, `${R}/ws`, `${R}/extra2/../extra2/`, `${R}/nowhere`] },
      }),
      wsEntry("wks_git", `${R}/repo/sub`),
      wsEntry("wks_file", `${R}/ws/utf8.txt`),
      wsEntry("wks_missing", `${R}/missing`),
      wsEntry("wks_rel", "relative/dir"),
      wsEntry("wks_empty", ""),
      wsEntry("wks_slash", "/"),
      wsEntry("wks_trailing", `${R}/ws/`),
      wsEntry("wks_link", `${R}/link-ws`),
      wsEntry("wks_dots", `${R}/ws/sub/..`),
    ]),
    F.mtime("ws/sub/inner.txt", -1.5),
    F.mtime("ws/crlf.txt", 0),
    F.mtime("ws/empty.txt", 9100000000.123),
    F.mtime("ws/bom.txt", -86400000.5),
    F.mtime("ws/utf8.txt", 1700000000.000001),
    F.mtime("ws/sub/deeper", 1e-7),

    // ---- Lookup: workspace / root / customization.
    G("wks_nope"),
    G("wks_nope", { root: "primary" }),
    G("wks_nope", { root: "" }),
    G(W),
    G(W, { root: "primary" }),
    G(W, { root: "" }),
    G(W, { root: "extra:0" }),
    G(W, { root: "extra:1" }),
    G(W, { root: "extra:2" }),
    G(W, { root: "extra:3" }),
    G(W, { root: "extra:4" }),
    G(W, { root: "extra:5" }),
    G(W, { root: "extra:-1" }),
    G(W, { root: "PRIMARY" }),
    G(W, { root: "extra:0", path: "e1.txt" }),
    G(W, { root: "extra:2", path: "e3.txt" }),
    G(W, "?root=extra%3A0&root=primary"),
    G(W, "?root=primary&root=extra%3A0"),
    G("cust_a"),
    G("cust_a", { root: "primary" }),
    G("cust_a", { root: "" }),
    G("cust_a", { root: "extra:0" }),
    G("cust_a", { path: "c.txt" }),
    G("cust_nosrc"),
    G("cust_nope"),
    G("cust_nope", { root: "x" }),
    G("cust_"),
    G("wks_git"),
    G("wks_git", { base: "git" }),
    G("wks_git", { base: "git", path: "sub/in-sub.txt" }),
    G("wks_git", { base: "git", path: "in-sub.txt" }),
    G("wks_git", { path: "in-sub.txt" }),
    G("wks_git", { base: "GIT" }),
    G("wks_git", { base: "git", path: ".." }),
    G(W, { base: "git" }),
    G("wks_file"),
    G("wks_file", { path: "x" }),
    G("wks_file", { search: "u" }),
    G("wks_missing"),
    G("wks_rel"),
    G("wks_empty"),
    G("wks_slash", { path: `${R}/ws/utf8.txt` }),
    G("wks_slash", { path: `${R}/ws/sub` }),
    G("wks_slash", { path: `${R}/nowhere` }),
    G("wks_trailing", { path: "sub" }),
    G("wks_link"),
    G("wks_link", { path: "sub" }),
    G("wks_dots", { path: "utf8.txt" }),

    // ---- Paths.
    G(W, { path: "" }),
    G(W, { path: "." }),
    G(W, { path: "/" }),
    G(W, { path: "//" }),
    G(W, { path: "./" }),
    G(W, { path: "sub" }),
    G(W, { path: "sub/" }),
    G(W, { path: "/sub" }),
    G(W, { path: "///sub//deeper/" }),
    G(W, { path: "sub/deeper" }),
    G(W, { path: "sub/./deeper/../deeper" }),
    G(W, { path: ".." }),
    G(W, { path: "../" }),
    G(W, { path: "../ws" }),
    G(W, { path: "../ws/utf8.txt" }),
    G(W, { path: "../outside/secret.txt" }),
    G(W, { path: "sub/../.." }),
    G(W, { path: "sub/../../ws/sub" }),
    G(W, { path: "/../x" }),
    G(W, { path: "/.." }),
    G(W, { path: "..foo" }),
    G(W, { path: "..foo/x.txt" }),
    G(W, { path: "...dots" }),
    G(W, { path: ".dotfile" }),
    G(W, "?path=%2e%2e"),
    G(W, "?path=..%2Foutside%2Fsecret.txt"),
    G(W, "?path=sub%2Finner.txt"),
    G(W, "?path=sub%5Cinner.txt"),
    G(W, "?path=a+b"),
    G(W, "?path=utf8.txt&path=sub"),
    G(W, "?path"),
    G(W, "?path=%zz"),
    G(W, "?path=%E9"),
    G(W, { path: `${R}/ws/utf8.txt` }),
    G(W, { path: "/etc/passwd" }),
    G(W, { path: "~" }),
    G(W, { path: "utf8.txt\u0000" }),
    G(W, { path: "a\u0000b" }),
    G(W, { path: "utf8.txt/x" }),
    G(W, { path: "x".repeat(300) }),
    G(W, { path: "x".repeat(250) }),
    G(W, { path: "nowhere" }),
    G(W, { path: " utf8.txt" }),
    G(W, { path: "link-in" }),
    G(W, { path: "link-out" }),
    G(W, { path: "link-dir-in" }),
    G(W, { path: "link-dir-out" }),
    G(W, { path: "link-dir-out/o.txt" }),
    G(W, { path: "dangling" }),
    G(W, { path: "loop1" }),
    G(W, { path: "self" }),
    G(W, { path: "link-up" }),
    G(W, { path: "pipe" }),
    G(W, { path: "hidden" }),
    G(W, { path: "hidden/.git" }),
    G(W, { path: "hidden/node_modules" }),
    G(W, { path: "hidden/.env" }),
    G(W, { path: "order" }),
    G(W, { path: "empty-dir" }),
    G(W, { path: "img" }),
    G(W, { path: "img.d" }),
    G(W, { depth: "0" }),
    G(W, { depth: "9", path: "sub" }),
    G(W, { depth: "x", path: "sub" }),

    // ---- File content and encodings.
    ...[
      "utf8.txt",
      "unicode.txt",
      "empty.txt",
      "bom.txt",
      "bom-only.txt",
      "bom-bom.txt",
      "bom-bad.txt",
      "u16le.txt",
      "u16le-empty.txt",
      "u16le-odd.txt",
      "u16le-lone.txt",
      "u16be.txt",
      "u16be-odd.txt",
      "u16be-lone.txt",
      "u32le.txt",
      "u32be.txt",
      "latin1.txt",
      "sjis.txt",
      "surrogate.txt",
      "nul.bin",
      "nul-8191.txt",
      "nul-8192.txt",
      "png.png",
      "crlf.txt",
      "sub/inner.txt",
      "sub/deeper/leaf.md",
    ].map((path) => G(W, { path })),
    G("wks_slash", { path: `${R}/big/2m.txt` }),
    G("wks_slash", { path: `${R}/big/2m1.txt` }),
    G("wks_slash", { path: `${R}/big/2m-text.txt` }),
    G("wks_slash", { path: `${R}/big/10m1.txt` }),

    // ---- serve=1.
    G(W, { path: "img/a.png", serve: "1" }),
    G(W, { path: "img/b.PNG", serve: "1" }),
    ...["jpg", "jpeg", "gif", "svg", "webp", "ico", "bmp", "avif", "tiff", "tif", "txt", "JPEG", "Gif", "gz", "tar.gz", "constructor", "__proto__", "CONSTRUCTOR", "toString", "tostring", "hasOwnProperty", "valueOf", "__PROTO__", "png ", "p" + "ng"].map((ext) =>
      G(W, { path: `img/f.${ext}`, serve: "1" }),
    ),
    G(W, { path: "img/noext", serve: "1" }),
    G(W, { path: "img/.png", serve: "1" }),
    G(W, { path: "img/dir.png", serve: "1" }),
    G(W, { path: "img/link.png", serve: "1" }),
    G(W, { path: "img/dangling.png", serve: "1" }),
    G(W, { path: "img.d/plain", serve: "1" }),
    G(W, { path: "img/a.png", serve: "true" }),
    G(W, { path: "img/a.png", serve: "0" }),
    G(W, "?path=img%2Fa.png&serve=1&serve=0"),
    G(W, { path: "utf8.txt", serve: "1" }),
    G(W, { path: "img", serve: "1" }),
    G("wks_slash", { path: `${R}/big/10m.png`, serve: "1" }),
    G("wks_slash", { path: `${R}/big/10m1.png`, serve: "1" }),
    G("wks_slash", { path: `${R}/big/2m1.txt`, serve: "1" }),
    G("cust_a", { path: "c.txt", serve: "1" }),

    // ---- Binary formats (CC 2.1.301).
    ...["zip", "ZIP", "parquet", "heic", "XLSM", "gz", "db", "o", "a", "wasm", "woff2", "Ogg", "json", "svg", "csv", "txt", "jsonl", "md"].map((ext) =>
      G(W, { path: `bin/f.${ext}` }),
    ),
    G(W, { path: "bin/f.tar.gz" }),
    G(W, { path: "bin/.zip" }),
    G(W, { path: "bin/noext" }),
    G(W, { path: "bin/trailing." }),
    G(W, { path: "bin/a.zip.txt" }),
    G(W, { path: "bin/f.zip " }),
    G(W, { path: `bin/f.${cp(0x212a)}MV` }),
    G(W, { path: "bin/dir.zip" }),
    G(W, { path: "bin/dir.zip/inner.txt" }),
    G(W, { path: "bin/nul.zip" }),
    G(W, { path: "bin/u16.zip" }),
    G(W, { path: "bin/empty.zip" }),
    G(W, { path: "bin/link.zip" }),
    G(W, { path: "bin/dangling.zip" }),
    G(W, { path: "bin/f.zip", serve: "1" }),
    G(W, { path: "bin/f.heic", serve: "1" }),
    G(W, { path: "bin" }),
    G(W, { search: "zip" }),
    G(W, { path: "bin", contentSearch: "plain text" }),
    G("wks_slash", { path: `${R}/big/5m.parquet` }),
    G("wks_slash", { path: `${R}/big/11m.heic` }),
    G("wks_slash", { path: `${R}/big/5m.parquet`, serve: "1" }),
    G("wks_slash", { path: `${R}/big/11m.heic`, serve: "1" }),

    // ---- Methods TS doesn't export.
  ];
}

function groupDarwin() {
  // Case-insensitive, normalization-insensitive APFS.
  return [
    ...baseTree(),
    F.write(`ws/caf${E}.txt`, "nfc"),
    F.write(`ws/${NFD_E}cole.txt`, "nfd"),
    F.write("ws/Upper.TXT", "upper"),
    F.mkdir("ws/Dist"),
    store([wsEntry(W, `${R}/ws`)]),
    G(W),
    G(W, { path: "UTF8.TXT" }),
    G(W, { path: "upper.txt" }),
    G(W, { path: `cafe${cp(0x301)}.txt` }),
    G(W, { path: `${cp(0xe9)}cole.txt` }),
    G(W, { path: "SUB" }),
    G(W, { search: "upper" }),
    G(W, { search: E }),
    G(W, { search: NFD_E }),
    G(W, { search: "dist" }),
  ];
}

function groupReadPerms() {
  return [
    ...baseTree(),
    F.write("ws/locked.txt", "locked"),
    F.chmod("ws/locked.txt", 0o000),
    F.write("ws/wo.txt", "write only"),
    F.chmod("ws/wo.txt", 0o200),
    F.hex("ws/locked.png", "89504e47"),
    F.chmod("ws/locked.png", 0o000),
    // A known binary extension answers from `stat` alone, so no read.
    F.write("ws/locked.zip", "x"),
    F.chmod("ws/locked.zip", 0o000),
    F.mkdir("ws/lockeddir"),
    F.write("ws/lockeddir/in.txt", "in"),
    F.chmod("ws/lockeddir", 0o000),
    F.mkdir("ws/noexec"),
    F.write("ws/noexec/a.txt", "a"),
    F.mkdir("ws/noexec/d"),
    F.write("ws/noexec/.hidden", "h"),
    F.chmod("ws/noexec", 0o644),
    F.mkdir("ws/noread"),
    F.write("ws/noread/b.txt", "b"),
    F.chmod("ws/noread", 0o311),
    F.mkdir("ws/inner-locked"),
    F.mkdir("ws/inner-locked/l"),
    F.write("ws/inner-locked/l/x.txt", "hello"),
    F.write("ws/inner-locked/ok.txt", "hello"),
    F.chmod("ws/inner-locked/l", 0o000),
    store([wsEntry(W, `${R}/ws`)]),
    G(W),
    G(W, { path: "locked.txt" }),
    G(W, { path: "wo.txt" }),
    G(W, { path: "locked.png", serve: "1" }),
    G(W, { path: "lockeddir" }),
    G(W, { path: "lockeddir/in.txt" }),
    G(W, { path: "noexec" }),
    G(W, { path: "noexec/a.txt" }),
    G(W, { path: "noread" }),
    G(W, { path: "noread/b.txt" }),
    G(W, { path: "inner-locked" }),
    G(W, { search: "txt" }),
    G(W, { contentSearch: "hello" }),
    G(W, { contentSearch: "o" }),
    G(W, { path: "lockeddir", search: "in" }),
    G(W, { path: "lockeddir", contentSearch: "in" }),
    // CC 2.1.301 -- the folder a search starts from can't be read: the
    // search failed, it didn't find nothing. A locked folder deeper in is
    // still skipped.
    G(W, { path: "locked.zip" }),
    G(W, { path: "noread", search: "b" }),
    G(W, { path: "noread", contentSearch: "b" }),
    G(W, { path: "noexec", search: "a" }),
    G(W, { path: "noexec", contentSearch: "a" }),
    G(W, { path: "inner-locked", search: "x" }),
    G(W, { path: "inner-locked", contentSearch: "hello" }),
    G(W, { search: "locked" }),
    G(W, { contentSearch: "locked" }),
  ];
}

function groupSearch() {
  const SIG = cp(0x3a3);
  const long1000 = `${"a".repeat(10)}needle${"b".repeat(484)}needle${"c".repeat(484)}needle${"d".repeat(10)}`;
  const longAstral = `${EMOJI.repeat(150)}needle${EMOJI.repeat(150)}`;
  const longEnd = `${"e".repeat(440)}needle`;
  const longStart = `needle${"f".repeat(500)}`;
  const exact400 = `needle${"g".repeat(394)}`;
  const exact401 = `needle${"g".repeat(395)}`;
  const lowerShift = `${cp(0x130).repeat(300)}needle${"h".repeat(200)}`;
  return [
    F.mkdir("s"),
    F.write("s/readme.md", "Hello World\nhello again\r\nno match here\r\nHELLO\n"),
    F.mkdir("s/src"),
    F.write("s/src/main.rs", 'fn main() {\n    println!("hello");\n}\n'),
    F.mkdir("s/src/lib"),
    F.write("s/src/lib/util.txt", "alpha\nbeta\ngamma hello beta hello\n"),
    F.mkdir("s/docs"),
    F.write("s/docs/Guide.TXT", "Guide text\n"),
    F.mkdir("s/docs/sub"),
    F.write("s/docs/sub/deep.txt", "deep hello\n"),
    F.write(`s/caf${E}.txt`, `caf${E} CAF${cp(0xc9)} cafe${cp(0x301)}\n`),
    F.write(
      "s/unicode.txt",
      [
        `${cp(0x130)}stanbul`,
        `${SIG}${SIG} ${cp(0x3c3)}${cp(0x3c2)} A${SIG}B`,
        `stra${cp(0xdf)}e STRASSE`,
        `${EMOJI} emoji ${EMOJI}x`,
        `${cp(0x212a)}elvin ${cp(0x2126)}hm`,
        `tab\there`,
        "",
      ].join("\n"),
    ),
    F.write("s/long.txt", [long1000, longAstral, longEnd, longStart, exact400, exact401, lowerShift, "x".repeat(900)].join("\n")),
    F.write("s/empty.txt", ""),
    F.rep("s/big-1m.txt", "zzzzzzzzzzzzzzz\n", 65535, "hello in big 1m\n"),
    F.rep("s/big-1m1.txt", "zzzzzzzzzzzzzzz\n", 65535, "hello in big 1m+\n"),
    F.hex("s/bin.dat", hexOf("hello") + "00" + hexOf("world")),
    { op: "fs", act: "write", path: "s/late-nul.txt", hex: "61".repeat(8192) + "00" + hexOf("\nhello late\n") },
    F.hex("s/bom.txt", "efbbbf" + hexOf("hello bom\n")),
    F.hex("s/latin1.txt", hexOf("hello caf") + "e9" + hexOf(" end\n")),
    F.hex("s/utf16.txt", "fffe" + utf16le("hello")),
    F.write("s/.hidden.txt", "hello hidden"),
    F.mkdir("s/node_modules"),
    F.write("s/node_modules/x.txt", "hello nm"),
    F.mkdir("s/dist"),
    F.write("s/dist/y.txt", "hello dist"),
    F.mkdir("s/.cache"),
    F.write("s/.cache/z.txt", "hello cache"),
    F.link("s/link.txt", "readme.md"),
    F.link("s/linkdir", "src"),
    F.link("s/dangling.txt", "nope"),
    F.fifo("s/fifo"),
    F.write("s/crlf.txt", "a hello\r\nb hello\r\n\r\nc\rhello\n\rhello\r\r\n"),
    F.write("s/many.txt", "hello hello\nHeLLo\nhElLo world hello\n hello\nhello \n"),
    F.write("s/needle-x.txt", `${"x".repeat(450)}\n${"x".repeat(900)}\nshort x\n`),
    F.mkdir("s/mtime"),
    F.write("s/mtime/m.txt", "hello"),
    F.mkdir("s/Hello"),
    F.write("s/Hello/inside.md", "nothing"),
    F.mkdir("s/order"),
    ...["b.txt", "B2.txt", "a.txt", "_a.txt", "10.txt", "9.txt", `${E}.txt`, "z.txt"].map((n) => F.write(`s/order/${n}`, "hello\nhello\n")),
    store([wsEntry("wks_s", `${R}/s`), wsEntry("wks_sub", `${R}/s/src`)]),
    // ---- filename search.
    G("wks_s", { search: "txt" }),
    G("wks_s", { search: "TXT" }),
    G("wks_s", { search: " txt " }),
    G("wks_s", { search: "\t\n" }),
    G("wks_s", { search: "src/" }),
    G("wks_s", { search: "SRC/LIB" }),
    G("wks_s", { search: "/" }),
    G("wks_s", { search: "." }),
    G("wks_s", { search: "md" }),
    G("wks_s", { search: "hello" }),
    G("wks_s", { search: "nomatch" }),
    G("wks_s", { search: `CAF${cp(0xc9)}` }),
    G("wks_s", { search: `caf${E}` }),
    G("wks_s", { search: cp(0x130) }),
    G("wks_s", { search: "link" }),
    G("wks_s", { search: "fifo" }),
    G("wks_s", { search: "node_modules" }),
    G("wks_s", { search: "txt", path: "docs" }),
    G("wks_s", { search: "docs", path: "docs" }),
    G("wks_s", { search: "txt", path: "readme.md" }),
    G("wks_s", { search: "txt", path: "linkdir" }),
    G("wks_s", { search: "txt", path: "order" }),
    G("wks_s", { search: "txt", contentSearch: "hello" }),
    G("wks_sub", { search: "rs" }),
    G("wks_s", "?search=TXT&search=md"),
    // ---- content search.
    G("wks_s", { contentSearch: "hello" }),
    G("wks_s", { contentSearch: "HELLO" }),
    G("wks_s", { contentSearch: "HELLO", case: "1" }),
    G("wks_s", { contentSearch: "Hello", case: "1" }),
    G("wks_s", { contentSearch: "hello", case: "true" }),
    G("wks_s", { contentSearch: "hello", case: "0" }),
    G("wks_s", { contentSearch: " hello" }),
    G("wks_s", { contentSearch: "hello " }),
    G("wks_s", { contentSearch: "   " }),
    G("wks_s", { contentSearch: "" }),
    G("wks_s", { contentSearch: "needle" }),
    G("wks_s", { contentSearch: "NEEDLE", path: "long.txt" }),
    G("wks_s", { contentSearch: "x".repeat(450) }),
    G("wks_s", { contentSearch: "x".repeat(401) }),
    G("wks_s", { contentSearch: "x".repeat(399) }),
    G("wks_s", { contentSearch: "x".repeat(901) }),
    G("wks_s", { contentSearch: cp(0x130) }),
    G("wks_s", { contentSearch: `i${cp(0x307)}` }),
    G("wks_s", { contentSearch: "istanbul" }),
    G("wks_s", { contentSearch: cp(0x3c3) }),
    G("wks_s", { contentSearch: cp(0x3c2) }),
    G("wks_s", { contentSearch: SIG }),
    G("wks_s", { contentSearch: `A${SIG}` }),
    G("wks_s", { contentSearch: "strasse" }),
    G("wks_s", { contentSearch: cp(0xdf) }),
    G("wks_s", { contentSearch: EMOJI }),
    G("wks_s", { contentSearch: `${EMOJI}x` }),
    G("wks_s", { contentSearch: "kelvin" }),
    G("wks_s", { contentSearch: cp(0x212a) }),
    G("wks_s", { contentSearch: "ohm" }),
    G("wks_s", { contentSearch: `caf${E}` }),
    G("wks_s", { contentSearch: `CAF${cp(0xc9)}`, case: "1" }),
    G("wks_s", { contentSearch: `cafe${cp(0x301)}` }),
    G("wks_s", { contentSearch: "\t" }),
    G("wks_s", { contentSearch: "\r" }),
    G("wks_s", { contentSearch: cp(0xfeff) }),
    G("wks_s", { contentSearch: cp(0xfffd) }),
    G("wks_s", { contentSearch: "late" }),
    G("wks_s", { contentSearch: "world" }),
    G("wks_s", { contentSearch: "a", path: "order" }),
    G("wks_s", { contentSearch: "hello", path: "src" }),
    G("wks_s", { contentSearch: "hello", path: "linkdir" }),
    G("wks_s", { contentSearch: "hello", path: "readme.md" }),
    G("wks_s", { contentSearch: "hello", path: "nowhere" }),
    G("wks_sub", { contentSearch: "hello" }),
    G("wks_s", "?contentSearch=hello&contentSearch=world"),
    G("wks_s", "?contentSearch=hello&case=1&case=0"),
  ];
}

function groupLimits() {
  const ops = [];
  // Filename-search result cap: two folders of 600 matches each.
  ops.push(F.mkdir("gen-results/a"), F.mkdir("gen-results/b"));
  ops.push(F.gen("gen-results/a", "m", 600, 4), F.gen("gen-results/b", "m", 600, 4));
  ops.push(F.mkdir("gen-results999"), F.gen("gen-results999", "m", 999, 4));
  ops.push(F.mkdir("gen-results1000"), F.gen("gen-results1000", "m", 1000, 4));
  // Scan cap: T holds 49 999 counted entries (50 dirs, a FIFO and 49 948
  // files) and a symlink, which the walk skips before counting.
  for (let d = 0; d < 50; d++) {
    const dir = `gen-scan/T/d${String(d).padStart(2, "0")}`;
    ops.push(F.mkdir(dir), F.gen(dir, "f", d === 49 ? 948 : 1000, 4));
  }
  ops.push(F.fifo("gen-scan/T/zfifo"), F.link("gen-scan/T/zlink", "d00"));
  // Content-search file cap: A has 4 999 files, B 5 000; the last has the hit.
  ops.push(F.mkdir("gen-content/A"), F.gen("gen-content/A", "c", 4999, 4, "x\n"));
  ops.push(F.write("gen-content/A/c4998", "hit\n"));
  ops.push(F.write("gen-content/A/c0000", "hit first\n"));
  ops.push(F.mkdir("gen-content/B"), F.gen("gen-content/B", "c", 5000, 4, "x\n"));
  ops.push(F.write("gen-content/B/c4999", "hit\n"));
  ops.push(F.write("gen-content/B/c0000", "hit first\n"));
  // Content-search result cap.
  ops.push(F.mkdir("gen-lines"), F.rep("gen-lines/one.txt", "hit\n", 1005));
  ops.push(F.mkdir("gen-lines2"), F.rep("gen-lines2/a.txt", "hit\n", 600), F.rep("gen-lines2/b.txt", "hit\n", 600));
  ops.push(F.mkdir("gen-lines3"), F.rep("gen-lines3/a.txt", "hit\n", 999), F.write("gen-lines3/b.txt", "hit\nhit\n"));
  ops.push(F.mkdir("gen-lines4"), F.rep("gen-lines4/a.txt", "hit\n", 1000));
  ops.push(
    store([
      wsEntry("wks_results", `${R}/gen-results`),
      wsEntry("wks_r999", `${R}/gen-results999`),
      wsEntry("wks_r1000", `${R}/gen-results1000`),
      wsEntry("wks_scan", `${R}/gen-scan`),
      wsEntry("wks_content", `${R}/gen-content`),
      wsEntry("wks_lines", `${R}/gen-lines`),
      wsEntry("wks_lines2", `${R}/gen-lines2`),
      wsEntry("wks_lines3", `${R}/gen-lines3`),
      wsEntry("wks_lines4", `${R}/gen-lines4`),
    ]),
  );
  return [
    ...ops,
    G("wks_results", { search: "m" }),
    G("wks_results", { search: "m", path: "a" }),
    G("wks_r999", { search: "m" }),
    G("wks_r1000", { search: "m" }),
    G("wks_scan", { search: "f0999" }),
    G("wks_scan", { search: "f0999", path: "T" }),
    G("wks_scan", { search: "d00/f09" }),
    G("wks_scan", { search: "d49/f094" }),
    G("wks_scan", { search: "f0947", path: "T/d49" }),
    G("wks_content", { contentSearch: "hit" }),
    G("wks_content", { contentSearch: "hit", path: "A" }),
    G("wks_content", { contentSearch: "hit", path: "B" }),
    G("wks_lines", { contentSearch: "hit" }),
    G("wks_lines2", { contentSearch: "hit" }),
    G("wks_lines3", { contentSearch: "hit" }),
    G("wks_lines4", { contentSearch: "hit" }),
    G("wks_lines", { contentSearch: "HIT", case: "1" }),
  ];
}

const WW = "wks_w";

function groupWrite() {
  const nul = (s) => s.replace("|", "\u0000");
  return [
    F.mkdir("w"),
    F.write("w/a.txt", "old"),
    F.hex("w/bom.txt", "efbbbf" + hexOf("bom")),
    F.hex("w/u16le.txt", "fffe" + utf16le("le")),
    F.hex("w/u16be.txt", "feff" + utf16be("be")),
    F.hex("w/legacy.txt", "e9"),
    F.hex("w/binary.bin", "000102"),
    F.hex("w/u32.txt", "fffe0000"),
    F.write("w/empty.txt", ""),
    F.mkdir("w/dir"),
    F.write("w/dir/keep.txt", "keep"),
    F.mkdir("w/out"),
    F.write("w/out/target.txt", "target"),
    F.mkdir("outside"),
    F.write("outside/o.txt", "outside"),
    F.link("w/link-in", "a.txt"),
    F.link("w/link-out", `${R}/outside/o.txt`),
    F.link("w/link-dir-out", `${R}/outside`),
    F.link("w/dangling", "made-by-link.txt"),
    F.link("w/dangling-deep", "no/such/dir.txt"),
    F.link("w/dangling2", "nowhere-else"),
    F.link("w/loop1", "loop2"),
    F.link("w/loop2", "loop1"),
    F.mkdir("w/..foo"),
    F.mkdir("repo/.git/objects"),
    F.mkdir("repo/.git/refs"),
    F.write("repo/.git/HEAD", "ref: refs/heads/main\n"),
    F.mkdir("repo/sub"),
    F.write("repo/r.txt", "repo"),
    custIndex([{ id: "cust_w" }]),
    F.mkdir(`${CUST}/cust_w/src`),
    F.mkdir("extra"),
    store([
      wsEntry(WW, `${R}/w`, { defaults: { additionalDirectories: [`${R}/extra`] } }),
      wsEntry("wks_git", `${R}/repo/sub`),
      wsEntry("wks_slash", "/"),
      wsEntry("wks_file", `${R}/w/a.txt`),
      wsEntry("wks_missing", `${R}/missing`),
    ]),

    // ---- PUT: validation order.
    PUT("wks_nope", { path: "x" }, "x"),
    PUTX("wks_nope", { path: "x" }, "ff"),
    PUT(WW, {}, "x"),
    PUT(WW, { path: "" }, "x"),
    PUT(WW, { path: "." }, "x"),
    PUT(WW, { path: "./" }, "x"),
    PUT(WW, { path: "/" }, "x"),
    PUT(WW, { path: ".." }, "x"),
    PUT(WW, { path: "../x" }, "x"),
    PUT(WW, { path: "a/../../x" }, "x"),
    PUT(WW, { path: "/../x" }, "x"),
    PUT(WW, { path: "..foo" }, "x"),
    PUT(WW, { path: "..foo/x" }, "x"),
    PUT(WW, { path: "sub/.." }, "x"),
    PUTX(WW, { path: "x" }, "ff"),
    PUTX(WW, { path: "x" }, "c3"),
    PUTX(WW, { path: "x" }, "eda080"),
    PUT(WW, { path: "dir" }, "x"),
    PUTX(WW, { path: "dir" }, "ff"),
    // ---- PUT: writes.
    PUT(WW, { path: "new.txt" }, "hello"),
    PUT(WW, { path: "new.txt" }, ""),
    PUT(WW, { path: "a.txt" }, `caf${E} ${EMOJI}`),
    PUT(WW, { path: "/abs.txt" }, "abs"),
    PUT(WW, { path: "deep/er/new.txt" }, "deep"),
    PUT(WW, { path: "deep//er/./x/../y.txt" }, "y"),
    PUTX(WW, { path: "bom-new.txt" }, "efbbbf" + hexOf("x")),
    G(WW, { path: "bom-new.txt" }),
    PUT(WW, { path: "bom.txt" }, "new bom"),
    PUT(WW, { path: "bom.txt" }, `${cp(0xfeff)}lead`),
    G(WW, { path: "bom.txt" }),
    PUT(WW, { path: "u16le.txt" }, `h${EMOJI}${cp(0xe9)}`),
    G(WW, { path: "u16le.txt" }),
    PUT(WW, { path: "u16be.txt" }, "x"),
    PUT(WW, { path: "legacy.txt" }, "x"),
    PUT(WW, { path: "binary.bin" }, "x"),
    PUT(WW, { path: "u32.txt" }, "x"),
    PUT(WW, { path: "empty.txt" }, "now text"),
    PUT(WW, { path: "crlf.txt" }, "a\r\nb\r\n"),
    PUT(WW, { path: "link-in" }, "through link"),
    PUT(WW, { path: "link-out" }, "escaped through link"),
    PUT(WW, { path: "link-dir-out/new.txt" }, "via dir link"),
    PUT(WW, { path: "dangling" }, "created by link"),
    PUT(WW, { path: "dangling-deep" }, "x"),
    PUT(WW, { path: "loop1" }, "x"),
    PUT(WW, { path: "a.txt/x" }, "x"),
    PUT(WW, { path: "a.txt/x/y" }, "x"),
    PUT(WW, { path: nul("nul|.txt") }, "x"),
    PUT(WW, { path: nul("nul|dir/x.txt") }, "x"),
    PUT(WW, { path: "x".repeat(300) }, "x"),
    PUT(WW, { path: `${"x".repeat(300)}/y` }, "x"),
    PUT(WW, { path: `caf${E}/${EMOJI}.txt` }, "unicode path"),
    PUT(WW, { path: "sp ace/q'uote\".txt" }, "odd"),
    PUT(WW, { path: "r.txt", base: "git" }, "via git base"),
    PUT("wks_git", { path: "r.txt", base: "git" }, "repo rewritten"),
    PUT("wks_git", { path: "sub/s.txt", base: "git" }, "in sub"),
    PUT("wks_git", { path: "s2.txt" }, "ws root"),
    PUT("wks_git", { path: "..", base: "git" }, "x"),
    PUT("wks_slash", { path: `${R}/w/slash.txt` }, "x"),
    PUT("wks_slash", { path: "/" }, "x"),
    PUT("wks_file", { path: "x" }, "x"),
    PUT("wks_missing", { path: "m.txt" }, "made under missing root"),
    PUT("cust_w", { path: "c.txt" }, "cust"),
    PUT("cust_w", { path: "c.txt", root: "extra:0" }, "cust"),
    PUT(WW, { path: "e.txt", root: "extra:0" }, "extra"),
    PUT(WW, { path: "e.txt", root: "extra:9" }, "extra"),
    PUT(WW, { path: "q.txt" }, "\u0000nul body"),
    // ---- POST.
    POST(WW, {}),
    POST(WW, { kind: "FILE" }),
    POST(WW, { kind: "" }),
    POST("wks_nope", {}),
    POST("wks_nope", { kind: "file" }),
    POST(WW, { kind: "file" }),
    POST(WW, { kind: "file", path: "." }),
    POST(WW, { kind: "file", path: ".." }),
    POST(WW, { kind: "file", path: "..foo" }),
    POST(WW, { kind: "file", path: "made.txt" }),
    POST(WW, { kind: "file", path: "made.txt" }),
    POST(WW, { kind: "dir", path: "made.txt" }),
    POST(WW, { kind: "dir", path: "made-dir" }),
    POST(WW, { kind: "dir", path: "made-dir" }),
    POST(WW, { kind: "file", path: "made-dir" }),
    POST(WW, { kind: "dir", path: "p/q/r" }),
    POST(WW, { kind: "file", path: "p/q/r.txt" }),
    POST(WW, { kind: "file", path: "link-in" }),
    POST(WW, { kind: "file", path: "dangling-deep" }),
    POST(WW, { kind: "dir", path: "dangling-deep" }),
    POST(WW, { kind: "dir", path: "loop1/x" }),
    POST(WW, { kind: "file", path: "loop1/x" }),
    POST(WW, { kind: "dir", path: "a.txt/x" }),
    POST(WW, { kind: "file", path: "a.txt/x" }),
    POST(WW, { kind: "dir", path: nul("n|d") }),
    POST(WW, { kind: "file", path: nul("n|f") }),
    POST(WW, { kind: "file", path: nul("n|d/f") }),
    POST(WW, { kind: "dir", path: "y".repeat(256) }),
    POST(WW, { kind: "file", path: "y".repeat(256) }),
    POST(WW, { kind: "file", path: "link-dir-out/made-out.txt" }),
    POST(WW, { kind: "dir", path: "base-ignored", base: "git" }),
    POST("wks_git", { kind: "file", path: "posted.txt", base: "git" }),
    POST("wks_slash", { kind: "file", path: `${R}/w/slash-post.txt` }),
    POST("wks_slash", { kind: "dir", path: `${R}/w/slash-dir` }),
    POST("cust_w", { kind: "dir", path: "cd" }),
    POST(WW, { kind: "file", path: "x.txt", root: "extra:0" }),
    // ---- PATCH.
    PATCH(WW, {}),
    PATCH(WW, { path: "made.txt" }),
    PATCH(WW, { path: "made.txt", newPath: "" }),
    PATCH(WW, { path: "made.txt", newPath: ".." }),
    PATCH(WW, { path: "..", newPath: "x" }),
    PATCH("wks_nope", { path: "a", newPath: "b" }),
    PATCH(WW, { path: "made.txt", newPath: "a.txt" }),
    PATCH(WW, { path: "made.txt", newPath: "made.txt" }),
    PATCH(WW, { path: "made.txt", newPath: "renamed.txt" }),
    PATCH(WW, { path: "renamed.txt", newPath: "moved/deep/renamed.txt" }),
    PATCH(WW, { path: "nope.txt", newPath: "new-parent/nope.txt" }),
    PATCH(WW, { path: "made-dir", newPath: "made-dir/sub/x" }),
    PATCH(WW, { path: "made-dir", newPath: "dir2" }),
    PATCH(WW, { path: "link-in", newPath: "link-moved" }),
    PATCH(WW, { path: "dir2", newPath: "dangling2" }),
    PATCH(WW, { path: "a.txt", newPath: "a.txt/b" }),
    PATCH(WW, { path: "loop1", newPath: "loop-moved" }),
    PATCH(WW, { path: nul("a|b"), newPath: "c" }),
    PATCH(WW, { path: "new.txt", newPath: nul("c|d") }),
    PATCH(WW, { path: "new.txt", newPath: nul("e|f/g") }),
    PATCH(WW, { path: "new.txt", newPath: "z".repeat(300) }),
    PATCH(WW, { path: "new.txt", newPath: "link-dir-out/moved-out.txt" }),
    PATCH(WW, { path: "abs.txt", newPath: "/abs2.txt", base: "git" }),
    PATCH(WW, { path: "e.txt", newPath: "e2.txt", root: "extra:0" }),
    PATCH(WW, { path: "e2.txt", newPath: "e3.txt", root: "extra:7" }),
    PATCH("wks_slash", { path: `${R}/w/abs2.txt`, newPath: `${R}/w/abs3.txt` }),
    PATCH("cust_w", { path: "c.txt", newPath: "c2.txt" }),
    // ---- DELETE.
    DEL(WW, {}),
    DEL(WW, { path: "." }),
    DEL(WW, { path: ".." }),
    DEL(WW, { path: "../outside/o.txt" }),
    DEL("wks_nope", { path: "x" }),
    DEL(WW, { path: "nope" }),
    DEL(WW, { path: "a.txt/x" }),
    DEL(WW, { path: nul("a|b") }),
    DEL(WW, { path: "y".repeat(300) }),
    DEL(WW, { path: "abs3.txt" }),
    DEL(WW, { path: "abs3.txt" }),
    DEL(WW, { path: "link-moved" }),
    DEL(WW, { path: "link-out" }),
    DEL(WW, { path: "dangling-deep" }),
    DEL(WW, { path: "loop2" }),
    DEL(WW, { path: "deep" }),
    DEL(WW, { path: "link-dir-out/new.txt" }),
    DEL(WW, { path: "dir" }),
    DEL(WW, { path: "dir" }),
    DEL(WW, { path: "x.txt", root: "extra:0" }),
    DEL("wks_slash", { path: `${R}/w/slash-dir` }),
    DEL("cust_w", { path: "cd" }),
    DEL("wks_git", { path: "s2.txt", base: "git" }),
    DEL(WW, { path: "moved" }),
    G(WW),
  ];
}

function groupWritePerms() {
  return [
    F.mkdir("w"),
    F.mkdir("w/ro"),
    F.write("w/ro/existing.txt", "existing"),
    F.chmod("w/ro", 0o555),
    F.write("w/ro-file.txt", "read only"),
    F.chmod("w/ro-file.txt", 0o444),
    F.write("w/wo-file.txt", "write only"),
    F.chmod("w/wo-file.txt", 0o200),
    F.write("w/none.txt", "none"),
    F.chmod("w/none.txt", 0o000),
    F.mkdir("w/nosearch"),
    F.write("w/nosearch/f.txt", "f"),
    F.chmod("w/nosearch", 0o666),
    F.mkdir("w/tree"),
    F.write("w/tree/a.txt", "a"),
    F.mkdir("w/tree/locked"),
    F.write("w/tree/locked/l1.txt", "l1"),
    F.chmod("w/tree/locked", 0o555),
    F.write("w/tree/z.txt", "z"),
    F.mkdir("w/unreadable"),
    F.write("w/unreadable/u.txt", "u"),
    F.chmod("w/unreadable", 0o333),
    F.mkdir("w/empty-locked"),
    F.chmod("w/empty-locked", 0o000),
    F.mkdir("w/full-locked"),
    F.write("w/full-locked/x", "x"),
    F.chmod("w/full-locked", 0o000),
    store([wsEntry(WW, `${R}/w`)]),
    PUT(WW, { path: "ro/new.txt" }, "x"),
    PUT(WW, { path: "ro/existing.txt" }, "x"),
    PUT(WW, { path: "ro/sub/new.txt" }, "x"),
    PUT(WW, { path: "ro-file.txt" }, "x"),
    PUT(WW, { path: "wo-file.txt" }, "x"),
    PUT(WW, { path: "none.txt" }, "x"),
    PUT(WW, { path: "nosearch/f.txt" }, "x"),
    PUT(WW, { path: "nosearch/g.txt" }, "x"),
    POST(WW, { kind: "file", path: "ro/p.txt" }),
    POST(WW, { kind: "dir", path: "ro/pd" }),
    POST(WW, { kind: "file", path: "ro/deeper/p.txt" }),
    POST(WW, { kind: "dir", path: "nosearch/d" }),
    PATCH(WW, { path: "ro/existing.txt", newPath: "moved.txt" }),
    PATCH(WW, { path: "a-missing.txt", newPath: "ro/x/y.txt" }),
    PATCH(WW, { path: "ro-file.txt", newPath: "ro/in.txt" }),
    PATCH(WW, { path: "ro-file.txt", newPath: "ro-renamed.txt" }),
    DEL(WW, { path: "ro/existing.txt" }),
    DEL(WW, { path: "tree" }),
    DEL(WW, { path: "unreadable" }),
    DEL(WW, { path: "empty-locked" }),
    DEL(WW, { path: "full-locked" }),
    DEL(WW, { path: "none.txt" }),
    DEL(WW, { path: "nosearch/f.txt" }),
    G(WW),
  ];
}

function groupStore() {
  const S = "s";
  const at = (workspaces, extra) => store(workspaces, extra);
  return [
    F.mkdir("s"),
    F.write("s/f.txt", "f"),
    F.mkdir("project/relative"),
    F.write("project/relative/r.txt", "relative"),
    F.mkdir("x"),
    F.mkdir("project/a"),
    F.mkdir("project/b"),
    // No store yet.
    G("wks_s"),
    G("wks_s", { root: "x" }),
    PUT("wks_s", { path: "f.txt" }, "x"),
    F.write(STORE, "{not json"),
    G("wks_s"),
    PUT("wks_s", { path: "f.txt" }, "x"),
    POST("wks_s", { kind: "file", path: "n" }),
    POST("wks_s", { kind: "nope", path: "n" }),
    F.write(STORE, "null"),
    G("wks_s"),
    F.write(STORE, "[]"),
    G("wks_s"),
    F.write(STORE, JSON.stringify({ version: 2, workspaces: [wsEntry("wks_s", `${R}/s`)] })),
    G("wks_s"),
    F.write(STORE, JSON.stringify({ version: "1", workspaces: [wsEntry("wks_s", `${R}/s`)] })),
    G("wks_s"),
    F.write(STORE, JSON.stringify({ version: 1.0, workspaces: {} })),
    G("wks_s"),
    at([null, wsEntry("wks_s", `${R}/s`)]),
    G("wks_s"),
    at([wsEntry("wks_s", `${R}/s`), null]),
    G("wks_s"),
    G("wks_other"),
    at([5, "x", [], wsEntry("wks_s", `${R}/s`)]),
    G("wks_s"),
    at([{ id: 5, rootPath: `${R}/s` }]),
    G("5"),
    at([wsEntry("wks_s", 5)]),
    G("wks_s"),
    PUT("wks_s", { path: "f.txt" }, "x"),
    at([{ id: "wks_s" }]),
    G("wks_s"),
    at([wsEntry("wks_s", null)]),
    G("wks_s"),
    at([wsEntry("wks_s", "relative")]),
    G("wks_s"),
    G("wks_s", { path: "r.txt" }),
    at([wsEntry("wks_s", `${R}/s`, { defaults: { additionalDirectories: "ab" } })]),
    G("wks_s", { root: "extra:0" }),
    G("wks_s", { root: "extra:1" }),
    at([wsEntry("wks_s", `${R}/s`, { defaults: { additionalDirectories: 5 } })]),
    G("wks_s"),
    at([wsEntry("wks_s", `${R}/s`, { defaults: { additionalDirectories: { a: 1 } } })]),
    G("wks_s"),
    at([wsEntry("wks_s", `${R}/s`, { defaults: null })]),
    G("wks_s"),
    at([wsEntry("wks_s", `${R}/s`, { defaults: 5 })]),
    G("wks_s"),
    at([wsEntry("wks_s", `${R}/s`, { defaults: { additionalDirectories: [`${R}/x`, `${R}/x/`, `${R}//x`, " ", `${R}/s`] } })]),
    G("wks_s", { root: "extra:0" }),
    G("wks_s", { root: "extra:1" }),
    F.mkdir("s/.claude"),
    F.write("s/.claude/settings.json", JSON.stringify({ permissions: { additionalDirectories: [`${R}/project/a`, `${R}/x`] } })),
    G("wks_s", { root: "extra:1" }),
    F.write("s/.claude/settings.json", JSON.stringify({ permissions: { additionalDirectories: `${R}/project/a` } })),
    G("wks_s", { root: "extra:1" }),
    F.write("s/.claude/settings.json", "{bad"),
    G("wks_s", { root: "extra:1" }),
    F.write("s/.claude/settings.json", "null"),
    G("wks_s", { root: "extra:1" }),
    // Customizations index variants.
    G("cust_c"),
    custIndex([{ id: "cust_c" }]),
    G("cust_c"),
    F.mkdir(`${CUST}/cust_c/src`),
    G("cust_c"),
    F.write(`${CUST}/index.json`, "{bad"),
    G("cust_c"),
    F.write(`${CUST}/index.json`, "null"),
    G("cust_c"),
    custIndex([null, { id: "cust_c" }]),
    G("cust_c"),
    custIndex([{ id: "cust_c" }, null]),
    G("cust_c"),
    custIndex([{ id: "cust_c" }], { version: 2 }),
    G("cust_c"),
    custIndex([{ id: "cust_c" }], { publishes: {} }),
    G("cust_c"),
    custIndex([{ id: "cust_../../.." }, { id: "cust_x/../../y" }]),
    F.mkdir("home/y/src"),
    F.write("home/y/src/escaped.txt", "escaped"),
    REQ("GET", "cust_..%2F..%2F..", {}),
    REQ("GET", "cust_x%2F..%2F..%2Fy", {}),
    REQ("GET", "cust_x%2F..%2F..%2Fy", { path: "escaped.txt" }),
    REQ("PUT", "cust_x%2F..%2F..%2Fy", { path: "put.txt" }, { body: "via escaped customization" }),
    REQ("GET", "wks%5Fs", {}),
    at([wsEntry("wks_s", `${R}/s`), wsEntry("wks_s", `${R}/x`)]),
    G("wks_s"),
    at([wsEntry("wks_s", `${R}/s`)], { activeId: "wks_s" }),
    G("wks_s", { path: S }),
  ];
}

// ------------------------------- run the steps -------------------------------

const SKIP_TOP = (name) => name.startsWith("gen-");
/** Files bigger than this are snapshotted by kind, mode and size only. */
const HASH_MAX = 4 * 1024 * 1024;

/** Every entry under the world, as `rel -> lstat` (dirs that can't be read have no children). */
function walk() {
  const out = [["", lstatSync(ROOT, { bigint: true })]];
  const visit = (rel) => {
    let names;
    try {
      names = readdirSync(rel ? join(ROOT, rel) : ROOT);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (!rel && SKIP_TOP(name)) continue;
      const r = rel ? `${rel}/${name}` : name;
      let st;
      try {
        st = lstatSync(join(ROOT, r), { bigint: true });
      } catch {
        continue;
      }
      out.push([r, st]);
      if (st.isDirectory()) visit(r);
    }
  };
  visit("");
  return out;
}

const hashCache = new Map();
function entryOf(rel, st) {
  const mode = Number(st.mode & 0o7777n);
  if (st.isSymbolicLink()) return { k: "l", t: fake(readlinkSync(join(ROOT, rel))) };
  if (st.isDirectory()) return { k: "d", m: mode };
  if (st.isFIFO()) return { k: "p", m: mode };
  if (!st.isFile()) return { k: "o", m: mode };
  const key = `${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
  let b = hashCache.get(rel)?.key === key ? hashCache.get(rel).b : undefined;
  if (b === undefined) {
    if (st.size > BigInt(HASH_MAX)) b = "large";
    else try {
      const buf = fakeBytes(readFileSync(join(ROOT, rel)));
      b = buf.length <= 64 ? buf.toString("hex") : `sha:${sha(buf)}:${buf.length}`;
    } catch {
      b = null;
    }
    hashCache.set(rel, { key, b });
  }
  return { k: "f", m: mode, s: Number(st.size), b };
}

let lastTree = new Map();
function treeDiff() {
  const now = new Map();
  for (const [rel, st] of walk()) if (rel) now.set(rel, JSON.stringify(entryOf(rel, st)));
  const diff = {};
  for (const [rel, e] of now) if (lastTree.get(rel) !== e) diff[rel] = JSON.parse(e);
  for (const rel of lastTree.keys()) if (!now.has(rel)) diff[rel] = null;
  lastTree = now;
  return diff;
}

// The pinned mtimes: every regular entry whose mtime moved gets the next one.
const pinned = new Map();
let pinN = 0;
const FRACS = [0, 0.5, 0.123456789, 0.999999999, 0.000001, 0.25, 0.1, 0.000000001];
function pin() {
  const pins = [];
  for (const [rel, st] of walk()) {
    if (st.isSymbolicLink()) continue;
    if (pinned.get(rel) === st.mtimeNs) continue;
    const t = 1_600_000_000 + pinN * 86_399 + FRACS[pinN % FRACS.length];
    pinN++;
    utimesSync(join(ROOT, rel), t, t);
    const got = lstatSync(join(ROOT, rel), { bigint: true }).mtimeNs;
    pinned.set(rel, got);
    pins.push([rel, String(got)]);
  }
  return pins;
}

function applyFs(s) {
  const p = join(ROOT, s.path);
  switch (s.act) {
    case "mkdir":
      mkdirSync(p, { recursive: true });
      break;
    case "write": {
      mkdirSync(dirname(p), { recursive: true });
      let data;
      if (s.hex !== undefined) data = Buffer.from(real(s.hex), "hex");
      else if (s.rep !== undefined) data = Buffer.from(s.rep.text.repeat(s.rep.count) + s.rep.tail);
      else data = Buffer.from(real(s.text));
      writeFileSync(p, data);
      break;
    }
    case "zero": {
      const fd = openSync(p, "w");
      ftruncateSync(fd, s.size);
      closeSync(fd);
      break;
    }
    case "symlink":
      symlinkSync(real(s.target), p);
      break;
    case "chmod":
      chmodSync(p, s.mode);
      break;
    case "fifo": {
      const r = spawnSync("mkfifo", [p]);
      if (r.status !== 0) throw new Error(`mkfifo ${p}`);
      break;
    }
    case "mtime": {
      // A Date: a negative number of seconds would mean "now" to utimes.
      const t = new Date(s.sec * 1000);
      utimesSync(p, t, t);
      const ns = lstatSync(p, { bigint: true }).mtimeNs;
      pinned.set(s.path, ns);
      return { ns: String(ns) };
    }
    case "rm":
      openUp(p);
      rmSync(p, { recursive: true, force: true });
      break;
    case "gen":
      for (let i = 0; i < s.count; i++) writeFileSync(join(p, s.prefix + String(i).padStart(s.width, "0")), s.text);
      break;
    default:
      throw new Error(`unknown fs op ${s.act}`);
  }
  return {};
}

async function request(s) {
  const target = `http://localhost${real(s.url)}`;
  const id = decodeURIComponent(new URL(target).pathname.split("/")[3]);
  const init = { method: s.method };
  if (s.body !== undefined) init.body = Buffer.from(real(s.body), "utf8");
  else if (s.bodyHex !== undefined) init.body = Buffer.from(s.bodyHex, "hex");
  const req = new Request(target, init);
  try {
    const res = await route[s.method](req, { params: Promise.resolve({ id }) });
    const type = res.headers.get("content-type");
    const got = { status: res.status, type };
    const cache = res.headers.get("cache-control");
    if (cache !== null) got.cache = cache;
    const others = [...res.headers.keys()].filter((k) => !["content-type", "cache-control"].includes(k));
    if (others.length) got.headers = others;
    const buf = Buffer.from(await res.arrayBuffer());
    if (type === "application/json") {
      const text = fake(buf.toString("utf8"));
      if (buf.length <= 16384) got.body = text;
      else got.sha = `${sha(Buffer.from(text, "utf8"))}:${Buffer.byteLength(text)}`;
    } else if (buf.length <= 64) got.hex = buf.toString("hex");
    else got.sha = `${sha(buf)}:${buf.length}`;
    return got;
  } catch (e) {
    return { threw: fake(e instanceof Error ? e.message : String(e)) };
  }
}

const BUILD = {
  read: groupRead,
  darwin: groupDarwin,
  "read-perms": groupReadPerms,
  search: groupSearch,
  limits: groupLimits,
  write: groupWrite,
  "write-perms": groupWritePerms,
  store: groupStore,
};
const META = {
  darwin: { os: "darwin" },
  "read-perms": { perms: true },
  "write-perms": { perms: true },
};

lastTree = new Map();
treeDiff();
const init = { pins: pin() };
const steps = [];
for (const raw of BUILD[GROUP]()) {
  const s = { ...raw };
  if (s.op === "fs") Object.assign(s, applyFs(s));
  else s.got = await request(s);
  const pins = pin();
  if (pins.length) s.pins = pins;
  const tree = treeDiff();
  if (Object.keys(tree).length) s.tree = tree;
  steps.push(s);
}
writeFileSync(process.env.WF_GOLDEN_OUT, JSON.stringify({ name: GROUP, ...(META[GROUP] ?? {}), platform: process.platform, init, steps }));
process.exit(0);
