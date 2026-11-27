#!/usr/bin/env node
// Golden fixture for the pure rules the native Files page ports (U12c):
// lib/client/files-last-open.ts, lib/client/key-match.ts, lib/client/
// shiki.ts's languageForPath, lib/shared/file-types.ts's getPreviewType,
// and the helpers and expressions of app/[workspaceId]/files/page.tsx and
// components/files/{FileTree,FindInFile,FindInFolder,FilePathContextMenu,
// BinaryFilePlaceholder}.tsx.
//
//   node rust/scripts/files-rules-golden.mjs     (node@22)
//
// Re-runs itself under `--experimental-transform-types` with HOME in a temp
// dir and a resolve hook for the `@/` and extensionless imports, twice; both
// recordings must agree byte for byte.
//
// The .tsx files can't be imported (JSX), and most of what the page computes
// lives inside hooks and templates. So each such piece is cut out of the
// source text, verbatim, at a line found by a needle (which must match
// exactly once), has its types stripped (`stripTypeScriptTypes`) and runs as
// a function of the variables it reads. A needle that stops matching fails
// the recording: update it with the TS.
//
// Every case is `{ args, out }` under its helper's name; an `undefined` /
// `null` result is `null`. The file is ASCII: every other character is a \u
// escape.
//
// Written to rust/app/crates/claudius-files/tests/fixtures/files_rules_golden.json
// and replayed by app/crates/claudius-files/tests/rules_golden.rs.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { register, stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "app/crates/claudius-files/tests/fixtures/files_rules_golden.json");

if (!process.env.FILES_RULES_GOLDEN_CHILD) {
  const runs = [0, 1].map(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "files-rules-golden-")));
    try {
      const r = spawnSync(
        process.execPath,
        ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url)],
        {
          cwd: repo,
          encoding: "utf8",
          maxBuffer: 1 << 26,
          env: { PATH: process.env.PATH, HOME: root, TZ: "UTC", FILES_RULES_GOLDEN_CHILD: root },
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
  const counts = Object.entries(fixture).map(([k, v]) => `${k} ${Array.isArray(v) ? v.length : Object.keys(v).length}`);
  console.log(`wrote ${out.slice(repo.length + 1)} (stable)\n  ${counts.join(", ")}`);
  process.exit(0);
}

const ROOT_DIR = process.env.FILES_RULES_GOLDEN_CHILD;

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

// A browser enough for the modules: `window.localStorage`, a platform.
const storage = new Map();
const calls = [];
globalThis.window = {
  localStorage: {
    getItem: (k) => {
      calls.push(["getItem", k]);
      return storage.has(k) ? storage.get(k) : null;
    },
    setItem: (k, v) => {
      calls.push(["setItem", k, String(v)]);
      storage.set(k, String(v));
    },
    removeItem: (k) => {
      calls.push(["removeItem", k]);
      storage.delete(k);
    },
  },
  innerWidth: 1024,
  innerHeight: 768,
};

const lib = (p) => import(join(repo, p));
const lastOpen = await lib("lib/client/files-last-open.ts");
const km = await lib("lib/client/key-match.ts");
const shiki = await lib("lib/client/shiki.ts");
const fileTypes = await lib("lib/shared/file-types.ts");

const src = (p) => readFileSync(join(repo, p), "utf8");
const PAGE = src("app/[workspaceId]/files/page.tsx");
const TREE = src("components/files/FileTree.tsx");
const FIND = src("components/files/FindInFile.tsx");
const FOLDER = src("components/files/FindInFolder.tsx");
const MENU = src("components/files/FilePathContextMenu.tsx");
const BINARY = src("components/files/BinaryFilePlaceholder.tsx");

// The one line of `text` holding `needle`, trimmed.
function line(text, needle) {
  const hits = text.split("\n").filter((l) => l.includes(needle));
  if (hits.length !== 1) throw new Error(`${hits.length} lines hold ${JSON.stringify(needle)}: update the recorder`);
  return hits[0].trim();
}
// The lines from the one holding `from` through the next holding `to`.
function block(text, from, to) {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.includes(from));
  if (at < 0 || lines.findIndex((l, i) => i > at && l.includes(from)) >= 0) {
    throw new Error(`${JSON.stringify(from)} isn't once in the source: update the recorder`);
  }
  const end = lines.findIndex((l, i) => i >= at && l.includes(to));
  if (end < 0) throw new Error(`no ${JSON.stringify(to)} after ${JSON.stringify(from)}`);
  return lines.slice(at, end + 1).join("\n");
}
// The first template literal (backticks) on a line.
function template(l) {
  const a = l.indexOf("`");
  const b = l.lastIndexOf("`");
  if (a < 0 || b <= a) throw new Error(`no template in ${l}`);
  return l.slice(a, b + 1);
}
// A function of `params` running `body` (TS, types stripped).
function fn(params, body, scope = {}) {
  const names = Object.keys(scope);
  const js = stripTypeScriptTypes(`(function (${params.join(", ")}) {\n${body}\n})`);
  return new Function(...names, `return ${js};`)(...names.map((n) => scope[n]));
}
// A top-level `function name(...) {...}` of a source (through its closing
// `}` line), as a function.
function topFn(text, name, scope = {}) {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.startsWith(`function ${name}(`) || l.startsWith(`export function ${name}(`));
  if (at < 0) throw new Error(`no function ${name}`);
  const end = lines.findIndex((l, i) => i > at && l === "}");
  const code = lines.slice(at, end + 1).join("\n").replace(/^export /, "");
  return fn([], `${code}\nreturn ${name};`, scope)();
}

const fixture = {};
function add(section, args, f) {
  (fixture[section] ??= []).push({ args, out: f(...args) ?? null });
}

const EMOJI = "\u{1f600}";

// ------------------------------------------------------------ the URLs

const rootParam = topFn(PAGE, "rootParam");
for (const r of ["primary", "extra:0", "extra:12", "", "a b&c", "Primary", "\u00e9" + EMOJI]) add("rootParam", [r], rootParam);

const enc = encodeURIComponent;
// page.tsx's fetches and replaces, each the template at its call.
const pageRead = fn(["wsId", "e", "rootId"], `return ${template(line(PAGE, "files?path=${encodeURIComponent(e.relPath)}${rootParam(rootId)}"))};`, { rootParam, encodeURIComponent: enc });
const SAVE_LINES = PAGE.split("\n").filter((l) => l.includes("files?path=${encodeURIComponent(open.relPath)}${rootParam(open.root)}"));
if (SAVE_LINES.length !== 2) throw new Error("save / delete URL lines moved: update the recorder");
const pageSave = fn(["wsId", "open"], `return ${template(SAVE_LINES[0])};`, { rootParam, encodeURIComponent: enc });
const pageDelete = fn(["wsId", "open"], `return ${template(SAVE_LINES[1])};`, { rootParam, encodeURIComponent: enc });
const pageRename = fn(["wsId", "open", "next"], `return ${template(line(PAGE, "&newPath=${encodeURIComponent(next)}"))};`, { rootParam, encodeURIComponent: enc });
const pageCreate = fn(["wsId", "next", "kind", "targetRoot"], `return ${template(line(PAGE, "&kind=${kind}"))};`, { rootParam, encodeURIComponent: enc });
const pageRoots = fn(["wsId"], `return ${template(line(PAGE, "/roots`"))};`);
const REPLACE = PAGE.split("\n").filter((l) => l.includes("router.replace(`${pathname}?path="));
const ROOTQ = PAGE.split("\n").filter((l) => l.includes("const rootQ = "));
if (REPLACE.length !== 2 || ROOTQ.length !== 2) throw new Error("router.replace lines moved: update the recorder");
// page.tsx:163-164 (a pick) and :267-268 (a rename).
const pageReplace = fn(["pathname", "ref"], `${ROOTQ[0].trim()}\nreturn ${template(REPLACE[0])};`, { encodeURIComponent: enc });
const pageRenameReplace = fn(["pathname", "open", "next"], `${ROOTQ[1].trim()}\nreturn ${template(REPLACE[1])};`, { encodeURIComponent: enc });
// FileTree.tsx:87-88 (search) and :128-130 (a folder's listing).
const treeSearchRoot = line(block(TREE, "const t = setTimeout(() => {", "fetch("), "const rootParam = ");
const treeSearch = fn(["workspaceId", "root", "q"], `${treeSearchRoot}\nreturn ${template(line(TREE, "files?search="))};`, { encodeURIComponent: enc });
const treeListRoot = line(block(TREE, "const load = useCallback(async (path", "&depth=1"), "const rootParam = ");
const treeList = fn(["workspaceId", "root", "path"], `${treeListRoot}\nreturn ${template(line(TREE, "&depth=1"))};`, { encodeURIComponent: enc });
// FindInFolder.tsx:91-95.
const folderQ = block(FOLDER, "const rootQ = rootId", "const pathQ = ");
const folderUrl = fn(["workspaceId", "rootId", "folderPath", "q", "caseSensitive"], `${folderQ}\nreturn ${template(line(FOLDER, "files?contentSearch="))};`, { encodeURIComponent: enc });
// FilePathContextMenu.tsx:98-101.
const revealUrl = fn(["workspaceId"], `return ${template(line(MENU, "${workspaceId}/reveal`"))};`);
const revealBody = fn(["relPath", "root"], `return ${line(MENU, "body: JSON.stringify(").replace(/^body: /, "").replace(/,$/, "")};`);

const URL_CASES = [
  { ws: "w1", root: "primary", rel: "src/main.rs", next: "src/lib.rs", kind: "file", q: "fn main", folder: "", caseSensitive: false, treeRoot: null },
  { ws: "w1", root: "extra:0", rel: "docs/a b.md", next: "docs/a&b.md", kind: "dir", q: "a&b=c", folder: "docs/", caseSensitive: true, treeRoot: "extra:0" },
  { ws: "ws_9", root: "extra:3", rel: "\u00e9t\u00e9/" + EMOJI + ".txt", next: "x?y#z%", kind: "file", q: "  pad  ", folder: "a/b", caseSensitive: false, treeRoot: "primary" },
  { ws: "w", root: "primary", rel: "", next: "", kind: "dir", q: "", folder: "/", caseSensitive: true, treeRoot: "" },
  { ws: "w", root: "a/b", rel: "+plus;semi,comma", next: "~!*()'", kind: "file", q: "\\n[x]", folder: "src/", caseSensitive: false, treeRoot: "a/b" },
];
for (const c of URL_CASES) {
  const open = { root: c.root, relPath: c.rel };
  fixture.urls ??= [];
  fixture.urls.push({
    args: c,
    out: {
      roots: pageRoots(c.ws),
      read: pageRead(c.ws, { relPath: c.rel }, c.root),
      save: pageSave(c.ws, open),
      delete: pageDelete(c.ws, open),
      rename: pageRename(c.ws, open, c.next),
      create: pageCreate(c.ws, c.next, c.kind, c.root),
      replace: pageReplace(`/${c.ws}/files`, { root: c.root, relPath: c.rel }),
      renameReplace: pageRenameReplace(`/${c.ws}/files`, open, c.next),
      treeSearch: treeSearch(c.ws, c.treeRoot, c.q),
      treeList: treeList(c.ws, c.treeRoot, c.rel),
      contentSearch: folderUrl(c.ws, c.root, c.folder, c.q, c.caseSensitive),
      revealUrl: revealUrl(c.ws),
      revealBody: revealBody(c.rel, c.treeRoot),
    },
  });
}

// ------------------------------------------------------------ sizes, titles

const formatSize = topFn(BINARY, "formatSize");
const fmtSize = topFn(TREE, "fmtSize");
const SIZES = [0, 1, 512, 1023, 1024, 1075, 1076, 1126, 1127, 1536, 10239, 10240, 102348, 1048575, 1048576, 1101004, 1101005,
  1572864, 5.5e6, 1073741824, 1e12, 1e21, 0.5, 1023.5, 2.5 * 1024, 1024 * 1.05, 1024 * 1.15, 1024 * 1.25, 1048576 * 9.95, 1048576 * 99.95];
for (const n of SIZES) add("formatSize", [n], formatSize);
for (const n of SIZES) add("fmtSize", [n], fmtSize);

const binary = await (async () => {
  // BinaryFilePlaceholder.tsx's exports, by evaluating its non-JSX head.
  const head = BINARY.split("export function BinaryFilePlaceholder(")[0].replace(/^"use client";/, "").replace(/^import .*$/m, "");
  return fn([], `${head.replace(/export /g, "")}\nreturn { BINARY_SAVE_TITLE, ENCODING_READONLY_SAVE_TITLE, saveButtonTitle };`)();
})();
for (const b of [false, true]) for (const r of [false, true]) add("saveButtonTitle", [b, r], (binary_, readOnly) => binary.saveButtonTitle({ binary: binary_, readOnly }));
// BinaryFilePlaceholder.tsx:44 and :55-56.
const binaryName = fn(["path"], `${line(BINARY, "const name = path.split")}\nreturn name;`);
const captionExpr = line(BINARY, "typeof sizeBytes === \"number\" ?").replace(/^\{/, "").replace(/\}$/, "");
const binaryCaption = fn(["path", "sizeBytes"], `${line(BINARY, "const name = path.split")}\nreturn name + (${captionExpr});`, { formatSize });
for (const [p, s] of [["data/metrics.parquet", 482113], ["a.zip", null], ["dir/", 10], ["", 0], ["/abs/x.bin", 1048576], ["no-slash", 1023], ["a//b", 2048]]) {
  add("binaryName", [p], binaryName);
  add("binaryCaption", [p, s], (path, size) => binaryCaption(path, size ?? undefined));
}

// ------------------------------------------------------------ the page's expressions

// page.tsx:226 / :285-289.
const deleteQuestion = fn(["open"], `return ${template(line(PAGE, "This cannot be undone."))};`);
for (const r of ["a.txt", "src/deep/x.rs", "", "\u00e9 " + EMOJI]) add("deleteQuestion", [r], (rel) => deleteQuestion({ relPath: rel }));
const promptArgs = block(PAGE, "kind === \"dir\" ? \"New folder path:\" : \"New file path:\"", "baseHint + (kind");
const createPromptFn = fn(["open", "kind"], `${line(PAGE, "const baseHint = ")}\nreturn [${promptArgs}];`);
for (const rel of [null, "a.txt", "src/x.rs", "src/", "a/b/c/", "\u00e9/" + EMOJI]) {
  for (const kind of ["file", "dir"]) add("createPrompt", [kind, rel], (k, r) => createPromptFn(r === null ? null : { relPath: r }, k));
}
// page.tsx:188 / :306 the picked entry's name.
const lastSegment = fn(["p"], `return ${line(PAGE, "void onPick({ name: p.split").match(/name: (p\.split\("\/"\)\.pop\(\) \?\? p)/)[1]};`);
for (const p of ["a/b/c.txt", "c.txt", "a/", "", "/x", "a//"]) add("lastSegment", [p], lastSegment);
// page.tsx:421-427 a group's open state, label and badge.
const groupOpen = fn(["query", "openGroups", "r"], `return ${line(PAGE, "const isOpen = ").replace(/^const isOpen = /, "").replace(/;$/, "")};`);
for (const q of ["", "  ", "x", "\u00a0", "\u2028", "\ufeff"]) for (const t of [null, true, false]) {
  add("groupOpen", [q, t], (query, toggled) => groupOpen(query, toggled === null ? {} : { g: toggled }, { id: "g" }));
}
const labelExpr = block(PAGE, "                    r.source === \"primary\"", ": r.absPath.split").replace(/;\s*$/, "");
const rootLabel = fn(["r"], `return ${labelExpr};`);
const badgeExpr = line(PAGE, "r.source === \"settings\" ?").replace(/;$/, "");
const sourceBadge = fn(["r"], `return ${badgeExpr};`);
for (const [source, absPath] of [["primary", "/Users/me/proj"], ["settings", "/Users/me/other/"], ["workspace", "/a//b//"], ["settings", "/"], ["x", ""], ["workspace", "rel/dir"], ["settings", "///"]]) {
  add("rootLabel", [source, absPath], (s, a) => rootLabel({ source: s, absPath: a }));
  add("sourceBadge", [source], (s) => sourceBadge({ source: s }));
}
// page.tsx:405-411 the tree's highlighted path.
const selectedExpr = block(PAGE, "                  open?.root === \"primary\"", "                      : null").replace(/\n\s*/g, " ");
const selectedPrimary = fn(["open", "searchParams"], `return ${selectedExpr};`);
const selectedGroupExpr = block(PAGE, "                    open?.root === r.id", "                        : null;").replace(/;\s*$/, "").replace(/\n\s*/g, " ");
const selectedGroup = fn(["open", "searchParams", "r"], `return ${selectedGroupExpr};`);
const params = (root, path) => ({ get: (k) => (k === "root" ? root : k === "path" ? path : null) });
for (const open of [null, ["primary", "a.txt"], ["extra:0", "b/c.txt"]]) {
  for (const [root, path] of [[null, null], [null, "x/y.md"], ["primary", "p.md"], ["extra:0", "e.md"], ["extra:1", "f.md"], [null, ""]]) {
    for (const id of ["primary", "extra:0"]) {
      const o = open && { root: open[0], relPath: open[1] };
      add("selectedPath", [open, root, path, id], () =>
        id === "primary" ? selectedPrimary(o, params(root, path)) : selectedGroup(o, params(root, path), { id }),
      );
      if (id !== "primary") continue;
      // The group form for primary agrees with the single-tree form.
      if (selectedGroup(o, params(root, path), { id }) !== selectedPrimary(o, params(root, path))) throw new Error("forms disagree");
    }
  }
}
// page.tsx:501 the encoding badge.
const badgeCond = line(PAGE, "{!open.binary && open.encoding && open.encoding !== \"utf-8\" && open.encodingLabel && (").replace(/^\{/, "").replace(/ && \($/, "");
const encodingBadge = fn(["open"], `return (${badgeCond}) ? open.encodingLabel : null;`);
for (const b of [false, true]) for (const e of [null, "", "utf-8", "utf-8-bom", "utf-16le", "latin1"]) for (const l of [null, "", "UTF-16 LE"]) {
  add("encodingBadge", [b, e, l], (binary_, encoding, encodingLabel) =>
    encodingBadge({ binary: binary_, encoding: encoding ?? undefined, encodingLabel: encodingLabel ?? undefined }) || null,
  );
}

// ------------------------------------------------------------ the tree

// FileTree.tsx:140 a listing's hidden-count key.
const loadKey = fn(["path"], `${line(TREE, "const key = !path || path.endsWith")}\nreturn key;`);
for (const p of ["", "src", "src/", "a/b", "a/b/", "/"]) add("loadKey", [p], loadKey);
// FileTree.tsx:180-188 the deep link's walk.
const walk = fn(["selectedPath"], `${line(TREE, "const segs = selectedPath.split")}
if (segs.length <= 1) return [];
const out = [];
${line(TREE, "let prefix = \"\";")}
${line(TREE, "for (let i = 0; i < segs.length - 1; i++) {")}
${line(TREE, "prefix = prefix ? `${prefix}/${segs[i]}` : segs[i];")}
${line(TREE, "const dirKey = `${prefix}/`;")}
out.push([prefix, dirKey]);
}
return out;`);
for (const p of ["a.txt", "a/b.txt", "a/b/c/d.txt", "/a/b", "a//b/c", "a/b/", "", "x/" + EMOJI + "/y"]) add("ancestorDirs", [p], walk);

// ------------------------------------------------------------ find in file

const matchesBody = block(FIND, "const matches = useMemo(() => {", "}, [value, query, caseSensitive]);")
  .replace(/^.*useMemo\(\(\) => \{/, "")
  .replace(/\}, \[value, query, caseSensitive\]\);\s*$/, "");
const findMatches = fn(["value", "query", "caseSensitive"], matchesBody);
const FIND_CASES = [
  ["hello world hello", "hello", false],
  ["Hello HELLO hello", "hello", false],
  ["Hello HELLO hello", "hello", true],
  ["aaaa", "aa", false],
  ["abc", "", false],
  ["", "x", false],
  ["\u0130stanbul \u0130", "i", false],
  ["\u0130stanbul", "\u0130", false],
  ["stra\u00dfe STRASSE", "ss", false],
  [EMOJI + "a" + EMOJI + "A", "a", false],
  [EMOJI + EMOJI, EMOJI, false],
  ["\u212a k K", "k", false],
  ["line1\nline2\nLINE3", "line", false],
  ["\u03a3\u03c3\u03c2", "\u03c3", false],
  ["x".repeat(6000), "x", false],
  ["ab".repeat(3000), "ab", true],
];
for (const [v, q, c] of FIND_CASES) {
  const m = findMatches(v, q, c);
  const args = v.length > 100 ? [{ repeat: [v.slice(0, v.length / (v.startsWith("ab") ? 3000 : 6000)), v.startsWith("ab") ? 3000 : 6000] }, q, c] : [v, q, c];
  (fixture.findMatches ??= []).push({ args, out: m.length > 50 ? { count: m.length, first: m[0], last: m[m.length - 1] } : m });
}
// FindInFile.tsx's counter (:182) and case title (:172).
const counterExpr = line(FIND, "{query === \"\" ? \"\" : matches.length === 0").replace(/^\{/, "").replace(/\}$/, "");
const counter = fn(["query", "matches", "activeIdx"], `return ${counterExpr};`);
for (const [q, n, a] of [["", 0, 0], ["", 3, 1], ["x", 0, 0], ["x", 1, 0], ["x", 5, 4], ["ab", 5000, 4999]]) {
  add("findCounter", [q, n, a], (query, count, active) => counter(query, { length: count }, active));
}
const caseTitle = fn(["caseSensitive"], `return ${line(FIND, "title={caseSensitive ?").replace(/^title=\{/, "").replace(/\}$/, "")};`);
const folderCaseTitle = fn(["caseSensitive"], `return ${line(FOLDER, "title={caseSensitive ?").replace(/^title=\{/, "").replace(/\}$/, "")};`);
for (const on of [false, true]) {
  add("caseTitle", [on], caseTitle);
  add("folderCaseTitle", [on], folderCaseTitle);
}
// FindInFile.tsx:123-130 next / prev.
const nextFn = fn(["i", "matches"], `return ${line(FIND, "setActiveIdx((i) => (i + 1)").match(/=> (\(i \+ 1\) % matches\.length)/)[1]};`);
const prevFn = fn(["i", "matches"], `return ${line(FIND, "setActiveIdx((i) => (i - 1").match(/=> (\(i - 1 \+ matches\.length\) % matches\.length)/)[1]};`);
for (const [i, n] of [[0, 1], [0, 3], [2, 3], [1, 3], [4999, 5000]]) {
  add("findNext", [i, n], (a, count) => nextFn(a, { length: count }));
  add("findPrev", [i, n], (a, count) => prevFn(a, { length: count }));
}

// ------------------------------------------------------------ find in folder

const groupedBody = block(FOLDER, "const grouped = useMemo(() => {", "}, [matches]);")
  .replace(/^.*useMemo\(\(\) => \{/, "")
  .replace(/\}, \[matches\]\);\s*$/, "");
const grouped = fn(["matches"], groupedBody);
const hit = (relPath, line_) => ({ relPath, line: line_, col: 1, colEnd: 2, text: "t" });
for (const ms of [
  null,
  [],
  [hit("a.txt", 1)],
  [hit("a.txt", 1), hit("a.txt", 3), hit("b.txt", 2)],
  [hit("a.txt", 1), hit("b.txt", 1), hit("a.txt", 9)],
  [hit("x/y.rs", 1), hit("x/y.rs", 2), hit("x/y.rs", 3)],
]) {
  (fixture.groupMatches ??= []).push({
    args: [ms && ms.map((m) => m.relPath)],
    out: grouped(ms).map((g) => [g.relPath, g.hits.map((h) => ms.indexOf(h))]),
  });
}
const display = fn(["folderPath", "folderLabel"], `return ${line(FOLDER, "const folderDisplay = ").replace(/^const folderDisplay = /, "").replace(/;$/, "")};`);
for (const [f, l] of [["", "root"], ["src/", "src"], ["src", "x"], ["a/b//", "b"], ["/", "r"], ["", ""]]) add("folderDisplay", [f, l], display);
// FindInFolder.tsx:281-286 the footer.
const footerCond = line(FOLDER, "{(truncated || (scanned > 0 && totalMatches === 0)) && (").replace(/^\{/, "").replace(/ && \($/, "");
const showing = template(line(FOLDER, "`Showing first ${totalMatches} matches"));
const scannedT = template(line(FOLDER, "`Scanned ${scanned} files.`"));
const footer = fn(["truncated", "scanned", "totalMatches"], `return (${footerCond}) ? (truncated ? ${showing} : ${scannedT}) : null;`);
for (const t of [false, true]) for (const s of [0, 1, 42, 1.5]) for (const n of [0, 1, 200]) add("folderFooter", [t, s, n], footer);
// FindInFolder.tsx:301-305 MatchedLine's cut.
const cut = block(FOLDER, "const start = Math.max(0, Math.min(text.length, col - 1));", "if (end <= start)").replace(/if \(end <= start\).*$/, "if (end <= start) return null;");
const matchedLine = fn(["text", "col", "colEnd"], `${cut}\nreturn [text.slice(0, start), text.slice(start, end), text.slice(end)];`);
for (const [t, a, b] of [
  ["hello world", 7, 12], ["hello", 1, 6], ["hello", 0, 3], ["hello", 3, 3], ["hello", 4, 2], ["hello", 9, 12],
  ["hello", -5, 2], ["hello", 2, 99], ["", 1, 2], [EMOJI + "ab", 3, 5], ["a" + EMOJI + "b", 2, 4], ["abc", 1.5, 2.5], ["abcdef", 2.9, 4.1], ["abc", 2, 2.5],
]) add("matchedLine", [t, a, b], matchedLine);

// ------------------------------------------------------------ the context menu

const EST = { EST_WIDTH: Number(line(MENU, "const EST_WIDTH = ").match(/= (\d+);/)[1]), EST_HEIGHT: Number(line(MENU, "const EST_HEIGHT = ").match(/= (\d+);/)[1]) };
fixture.menuEstimate = [{ args: [], out: [EST.EST_WIDTH, EST.EST_HEIGHT] }];
const clamp = topFn(MENU, "clamp");
for (const [x, y, w, h, vw, vh] of [
  [100, 100, 200, 56, 1024, 768], [1000, 760, 200, 56, 1024, 768], [0, 0, 200, 56, 1024, 768], [-50, -50, 200, 56, 1024, 768],
  [500.5, 300.5, 200, 56, 1024, 768], [501.5, 301.5, 200, 56, 1024, 768], [100, 100, 224, 80, 1280, 820], [5, 5, 2000, 2000, 1024, 768],
  [816.4, 703.6, 200, 56, 1024, 768], [-0.4, 8.5, 200, 56, 1024, 768],
]) {
  add("clampMenu", [x, y, w, h, vw, vh], (a, b, c, d, ww, hh) => {
    window.innerWidth = ww;
    window.innerHeight = hh;
    const r = clamp(a, b, c, d);
    return [r.left, r.top];
  });
}
const revealLabel = topFn(MENU, "revealLabel", { window, navigator: { platform: "" } });
for (const plat of ["darwin", "win32", "linux"]) {
  window.claudius = { platform: plat };
  add("revealLabel", [plat], () => revealLabel());
}
delete window.claudius;

// ------------------------------------------------------------ lib modules

for (const [key, code, alt, letter] of [
  ["s", "KeyS", false, "s"], ["S", "KeyS", false, "s"], ["\u044b", "KeyS", false, "s"], ["\u044b", "KeyS", true, "s"],
  ["Process", "KeyS", false, "s"], ["o", "KeyS", false, "s"], ["f", "KeyF", false, "f"], ["\u0430", "KeyF", false, "f"],
  ["", "KeyS", false, "s"], ["Enter", "Enter", false, "s"], ["\u017f", "KeyS", false, "s"], [EMOJI, "KeyS", false, "s"],
]) add("isLetterKey", [key, code, alt, letter], (k, c, a, l) => km.isLetterKey({ key: k, code: c, altKey: a }, l));

const PATHS = [
  "", "a.ts", "src/main.rs", "README.md", "Dockerfile", "Dockerfile.dev", "dockerfile", "Makefile", "makefile.inc", "GNUmakefile",
  ".env", ".env.local", ".envrc", "package.json", "PACKAGE.JSON", "x.d.ts", "a.test.ts", "a.tsx", "a.TSX", "a.jsonc", "a.yml", "a.yaml",
  "a.toml", "a.sh", "a.zsh", "a.py", "a.go", "a.java", "a.kt", "a.swift", "a.c", "a.h", "a.cpp", "a.hpp", "a.cs", "a.rb", "a.php",
  "a.sql", "a.html", "a.css", "a.scss", "a.vue", "a.svelte", "a.lua", "a.r", "a.ex", "a.exs", "a.erl", "a.hs", "a.ml", "a.clj",
  "a.dart", "a.zig", "a.nim", "a.tf", "a.proto", "a.graphql", "a.xml", "a.svg", "a.ini", "a.cfg", "a.conf", "a.diff", "a.patch",
  "a.txt", "a.unknown", "noext", "dir.d/file", "a.b.c", ".gitignore", ".bashrc", "CMakeLists.txt", "Gemfile", "Pipfile", "go.mod",
  "Cargo.lock", "tsconfig.json", "x/.prettierrc", "a.md.bak", "a.mdx", "a.ps1", "a.bat", "a.vim", "a.nix", "a.jl", "a.scala",
  "a.groovy", "a.gradle", "a.pl", "a.tex", "a.csv", "a.log", "a.lock", "Procfile", "Jenkinsfile", "Vagrantfile", "a.mjs", "a.cjs",
  "a.mts", "a.cts", "a.jsx", "a.json5", "a.rst", "a.astro", "a.prisma", "a.sol", "a.wgsl", "a.glsl", "a.hcl", "a.dockerfile",
  "dir/Makefile", "\u00e9.py", "A.PY", "x.", ".", "..", "a/b/",
];
for (const p of PATHS) add("languageForPath", [p], (path) => shiki.languageForPath(path) ?? null);
for (const p of ["a.png", "a.PNG", "a.jpeg", "x/y.svg", "a.html", "a.HTM", "a.txt", "png", "a.png/b", "", "a.tiff", "a.avif", "a.ico", "a.webp", "a.gif", "a.bmp", "a.tif", "a.jpg", "a.heic"]) {
  add("previewType", [p], (path) => fileTypes.getPreviewType(path));
}

// files-last-open.ts: what a stored value reads as, what a write stores.
for (const raw of [
  null, "", "{}", "null", "[]", "\"str\"", "not json", "{\"root\":\"primary\",\"relPath\":\"a.txt\"}",
  "{\"root\":\"extra:0\",\"relPath\":\"d/e.md\",\"x\":1}", "{\"root\":1,\"relPath\":\"a\"}", "{\"root\":\"primary\",\"relPath\":\"\"}",
  "{\"root\":\"primary\",\"relPath\":5}", "{\"root\":\"\",\"relPath\":\"a\"}", " {\"root\":\"primary\",\"relPath\":\"a\"} ", "0", "true",
  "{\"relPath\":\"a\",\"root\":\"primary\"}", "{\"root\":\"primary\",\"relPath\":\"" + "\u00e9" + EMOJI + "\"}",
]) {
  storage.clear();
  if (raw !== null) storage.set("claudius.files.lastOpen.w1", raw);
  add("lastOpenRead", [raw], () => lastOpen.readLastOpenFile("w1"));
}
for (const [ws, entry] of [["w1", { root: "primary", relPath: "a.txt" }], ["ws 2", { root: "extra:1", relPath: "\u00e9/" + EMOJI + "\"q\".md" }]]) {
  storage.clear();
  calls.length = 0;
  lastOpen.writeLastOpenFile(ws, entry);
  lastOpen.clearLastOpenFile(ws);
  (fixture.lastOpenWrite ??= []).push({ args: [ws, entry.root, entry.relPath], out: calls.map((c) => [...c]) });
}

// ------------------------------------------------------------ copy

// The strings the native page shows, each found in its TS source (JSX text
// with its lines joined and entities decoded, as React renders it).
const flat = (s) => s.split("\n").map((l) => l.trim()).join(" ").replace(/&apos;/g, "'");
const COPY = {
  binaryHeadline: [BINARY, "Binary file \u2014 not shown as text"],
  binaryBody: [BINARY, "This file isn't text (a spreadsheet, archive, database, media file or similar), so it can't be opened in the editor."],
  readOnlyDefault: [PAGE, "Read-only: this file's encoding isn't UTF-8, and saving would convert it."],
  renamePrompt: [PAGE, "New path (relative to its root):"],
  hiddenHint: [TREE, "Dotfiles and folders like .git, node_modules, dist and build aren't shown in the tree."],
  searchPlaceholder: [PAGE, "Search files (incl. nested folders)"],
  pickAFile: [PAGE, "Pick a file to view or edit."],
  noWorkspace: [PAGE, "No active workspace."],
  noFilesMatch: [TREE, "No files match."],
  emptyFolder: [TREE, "This folder is empty."],
  noFolderMatches: [FOLDER, "No matches in this folder."],
  typeToSearch: [FOLDER, "Type to search inside"],
  findPlaceholder: [FIND, "Find in file"],
  extraTitleFallback: [PAGE, "additional directory"],
  encodingTitle: [PAGE, "Saved back in this encoding"],
  renameTitle: [PAGE, "Rename / move"],
  saving: [PAGE, "Saving\u2026"],
  prevTitle: [FIND, "Previous match (Shift+Enter)"],
  nextTitle: [FIND, "Next match (Enter)"],
  closeFindTitle: [FIND, "Close find (Esc)"],
  closeFolderTitle: [FOLDER, "Close (Esc)"],
};
fixture.copy = {};
for (const [k, [text, s]] of Object.entries(COPY)) {
  if (!flat(text).includes(s)) throw new Error(`the TS no longer has ${JSON.stringify(s)} (${k}): update the recorder`);
  fixture.copy[k] = s;
}

const ascii = (s) => s.replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
writeFileSync(join(ROOT_DIR, "out.json"), ascii(JSON.stringify(fixture, null, 1)) + "\n");
