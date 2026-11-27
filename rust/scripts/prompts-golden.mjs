#!/usr/bin/env node
// Golden fixture for the native prompt cards (U08a, rust/app/crates/claudius-prompts):
// the pure helpers they port and what the React cards render.
//
//   node rust/scripts/prompts-golden.mjs     (node@22)
//
// Re-runs itself under `--experimental-transform-types` with HOME in a temp
// dir, twice; both recordings must agree byte for byte. A resolve hook maps
// the `@/` and extensionless imports; a load hook compiles the `.tsx` cards
// with the repo's `typescript` (`jsx: react-jsx`) so react-dom/server can
// render them, and points their `useState` at a shim that can start a state
// hook at a recorded value (`STATE`, by call order) instead of its initial
// one. That is how a card is rendered mid-interaction: React has no DOM here,
// so nothing is clicked.
//
// Sections:
// - `visualize`: `visualizeInvisibleUnicode`, `visualizeHiddenNameUnicode`,
//   `stripInvisibleUnicode` (lib/shared/invisible-unicode.ts).
// - `schema`: `parseElicitationSchema`, then `initialFormValues` and, per
//   value set, `buildElicitationContent` (lib/shared/elicitation.ts).
// - `url`: `safeElicitationUrl` as `{ href, host, origin }` or null.
// - `formatAsk`: ChatSurface.tsx's private `formatAskAsPrompt` (its source
//   is cut out of the file and compiled alone).
// - `looksLikeHtml`: AskUserQuestionPrompt.tsx's private sniff, the same way.
// - `permissionCard`, `elicitationCard`, `askCard`: each card rendered with
//   `renderToStaticMarkup`, reduced to the texts and controls it shows
//   (by `data-testid` and the elements named below).
//
// Written to rust/app/crates/claudius-prompts/tests/fixtures/prompts_golden.json
// and replayed by rust/app/crates/claudius-prompts/tests/prompts_golden.rs.
// ASCII only: non-ASCII test text is written with code-point escapes.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "app/crates/claudius-prompts/tests/fixtures/prompts_golden.json");

if (!process.env.PROMPTS_GOLDEN_CHILD) {
  const runs = [0, 1].map(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "prompts-golden-")));
    try {
      const r = spawnSync(
        process.execPath,
        ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url)],
        {
          cwd: repo,
          encoding: "utf8",
          maxBuffer: 1 << 26,
          env: { PATH: process.env.PATH, HOME: root, TZ: "UTC", NODE_ENV: "production", PROMPTS_GOLDEN_CHILD: root },
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
  if (/[^\x00-\x7f]/.test(runs[0])) throw new Error("the fixture must be ASCII");
  writeFileSync(out, runs[0]);
  const fixture = JSON.parse(runs[0]);
  const counts = Object.entries(fixture).map(([k, v]) => `${k} ${v.length}`);
  const total = Object.values(fixture).reduce((n, v) => n + v.length, 0);
  console.log(`wrote ${out.slice(repo.length + 1)}: ${total} cases (stable)\n  ${counts.join(", ")}`);
  process.exit(0);
}

const ROOT_DIR = process.env.PROMPTS_GOLDEN_CHILD;
const SHIM = join(ROOT_DIR, "state-shim.mjs");
writeFileSync(
  SHIM,
  `import * as React from ${JSON.stringify(pathToFileURL(realpathSync(join(repo, "node_modules/react/index.js"))).href)};
export function useState(init) {
  const q = globalThis.__PROMPTS_STATE;
  const i = q ? q.next++ : -1;
  const [v, set] = React.useState(init);
  if (q && i in q.values) return [q.values[i], set];
  return [v, set];
}
`,
);

const hook = `
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from ${JSON.stringify(pathToFileURL(join(repo, "node_modules/typescript/lib/typescript.js")).href)};
const ROOT = ${JSON.stringify(pathToFileURL(repo + "/").href)};
const SHIM = ${JSON.stringify(pathToFileURL(SHIM).href)};
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
  if (url.startsWith("file:") && url.endsWith(".tsx") && !url.includes("/node_modules/")) {
    let src = readFileSync(fileURLToPath(url), "utf8");
    const js = ts.transpileModule(src, {
      compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      fileName: fileURLToPath(url),
    }).outputText;
    const shimmed = js.replace(/import \\{([^}]*)\\buseState\\b([^}]*)\\} from "react";/, (m, a, b) =>
      'import {' + a + b + '} from "react"; import { useState } from ' + JSON.stringify(SHIM) + ';');
    return { format: "module", source: shimmed, shortCircuit: true };
  }
  return next(url, ctx);
}`;
register(`data:text/javascript,${encodeURIComponent(hook)}`);

const ts = (await import(join(repo, "node_modules/typescript/lib/typescript.js"))).default;
const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const iu = await import(join(repo, "lib/shared/invisible-unicode.ts"));
const el = await import(join(repo, "lib/shared/elicitation.ts"));
const { PermissionPrompt } = await import(join(repo, "components/chat/PermissionPrompt.tsx"));
const { McpElicitationPrompt } = await import(join(repo, "components/chat/McpElicitationPrompt.tsx"));
const { AskUserQuestionPrompt } = await import(join(repo, "components/chat/AskUserQuestionPrompt.tsx"));

/** A private function cut out of a source file and compiled on its own. */
async function privateFn(file, name) {
  const src = readFileSync(join(repo, file), "utf8");
  const decl = `\nfunction ${name}(`;
  const at = src.indexOf(decl);
  if (at < 0 || src.indexOf(decl, at + 1) >= 0) {
    throw new Error(`${file} no longer declares \`function ${name}(\` exactly once: update the recorder`);
  }
  const end = src.indexOf("\n}\n", at);
  const body = src.slice(at + 1, end + 2);
  const js = ts.transpileModule(`export ${body}`, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const path = join(ROOT_DIR, `${name}.mjs`);
  writeFileSync(path, js);
  return (await import(pathToFileURL(path).href))[name];
}
const formatAskAsPrompt = await privateFn("components/chat/ChatSurface.tsx", "formatAskAsPrompt");
const looksLikeHtml = await privateFn("components/chat/AskUserQuestionPrompt.tsx", "looksLikeHtml");

// ------------------------------ tiny DOM ------------------------------

const VOID = new Set(["input", "br", "img", "hr", "meta", "link"]);
function decode(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}
/** React's static markup as a tree of `{ tag, attrs, children }` / strings. */
function parse(html) {
  const root = { tag: "#root", attrs: {}, children: [] };
  const stack = [root];
  const re = /<(\/?)([a-zA-Z][\w-]*)((?:\s+[\w:-]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(html))) {
    const top = stack[stack.length - 1];
    if (m[5] !== undefined) {
      top.children.push(decode(m[5]));
      continue;
    }
    const [, close, tag, rawAttrs, selfClose] = m;
    if (close) {
      if (top.tag !== tag) throw new Error(`markup: </${tag}> closes <${top.tag}>`);
      stack.pop();
      continue;
    }
    const attrs = {};
    for (const a of rawAttrs.matchAll(/([\w:-]+)(?:="([^"]*)")?/g)) attrs[a[1]] = a[2] === undefined ? "" : decode(a[2]);
    const node = { tag, attrs, children: [] };
    top.children.push(node);
    if (!selfClose && !VOID.has(tag)) stack.push(node);
  }
  if (stack.length !== 1) throw new Error("markup: unclosed elements");
  return root;
}
const text = (n) => (typeof n === "string" ? n : n.children.map(text).join(""));
function all(n, pred, outList = []) {
  if (typeof n === "string") return outList;
  if (pred(n)) outList.push(n);
  for (const c of n.children) all(c, pred, outList);
  return outList;
}
const byTestId = (root, id) => all(root, (n) => n.attrs["data-testid"] === id)[0] ?? null;
const hasClass = (n, cls) => (n.attrs.class ?? "").split(/\s+/).includes(cls);
const classAll = (root, tag, classes) => all(root, (n) => n.tag === tag && classes.every((c) => hasClass(n, c)));
const textOf = (n) => (n ? text(n) : null);

function render(Component, props, state) {
  globalThis.__PROMPTS_STATE = state ? { next: 0, values: state } : undefined;
  try {
    return parse(renderToStaticMarkup(createElement(Component, props)));
  } finally {
    globalThis.__PROMPTS_STATE = undefined;
  }
}

const sections = {};
const noop = () => {};

// ------------------------------ visualize ------------------------------

const TEXTS = [
  "",
  "plain ascii",
  "a\u{200B}b\u{2060}c\u{FEFF}d",
  "bidi \u{202A}\u{202B}\u{202C}\u{202D}\u{202E} and \u{2066}\u{2067}\u{2068}\u{2069}",
  "edges \u{2029}\u{2065}\u{206A}\u{202F}\u{E0000}\u{E0001}\u{E001F}\u{E0020}\u{E007F}\u{E0080}",
  "joiners stay \u{200C}\u{200D} emoji \u{1F469}\u{200D}\u{1F4BB}",
  "names deploy\u{3164} nbsp\u{A0} lrm\u{200E} soft\u{AD} braille\u{2800} obj\u{FFFC} bamum\u{16910}",
  "tags \u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}",
  "space\u{2003}em\u{3000}ideo\u{1680}ogham",
];
sections.visualize = TEXTS.map((t) => ({
  text: t,
  invisible: iu.visualizeInvisibleUnicode(t),
  hiddenName: iu.visualizeHiddenNameUnicode(t),
  strip: iu.stripInvisibleUnicode(t),
}));

// ------------------------------- schema --------------------------------

const SCHEMAS = [
  {
    name: "primitives",
    schema: {
      type: "object",
      properties: {
        title: { type: "string", title: "Title", description: "Short", minLength: 3, maxLength: 8, default: "" },
        email: { type: "string", format: "email" },
        when: { type: "string", format: "date-time", default: "2026-01-01T00:00:00Z" },
        count: { type: "integer", minimum: 1, maximum: 13, default: 3 },
        ratio: { type: "number", minimum: -1.5, maximum: 1e21, default: 0.1 },
        big: { type: "number", default: 1e21 },
        negz: { type: "number", default: -0 },
        notify: { type: "boolean", default: true },
        off: { type: "boolean", default: "yes" },
      },
      required: ["title", "count", 7, null],
    },
    values: [
      null,
      { title: " abc ", email: "a@b", count: " 0x5 ", ratio: "1e3", notify: false },
      { title: "ab", count: "2.5", ratio: "-2" },
      { title: "abcdefghi", count: "14", ratio: "x" },
      { title: "", count: "", ratio: "Infinity" },
      { title: "\u{1F600}\u{1F600}", count: "-0", ratio: ".5", off: "true" },
      { title: "okay", count: "1e1", big: "  ", email: 5 },
    ],
  },
  {
    name: "enums",
    schema: {
      properties: {
        pri: { type: "string", enum: ["low", 2, "high", " pad "], enumNames: ["Low", "Two", ""] },
        one: { oneOf: [{ const: "a", title: "A" }, { const: 1 }, "x", { const: "b", title: "" }], default: "b" },
        any: { anyOf: [{ const: "z" }], default: "" },
        both: { enum: [], oneOf: [{ const: "q" }], type: "string" },
        empty: { oneOf: [{ const: 3 }], type: "boolean" },
        tags: { type: "array", items: { enum: ["bug", "ui", "port"] }, minItems: 2, maxItems: 2, default: ["ui", 4, "nope"] },
        alt: { type: "array", title: "Alt", items: { anyOf: [{ const: "x", title: "Ex" }] } },
        bad: { type: "array", items: { enum: [] } },
        noitems: { type: "array" },
      },
      required: ["pri", "tags", "alt"],
    },
    values: [
      null,
      { pri: "low", one: "a", any: "z", both: "q", tags: ["bug", "ui"], alt: ["x"] },
      { pri: " low ", one: "c", tags: ["bug"], alt: [] },
      { pri: "pad", tags: ["bug", "ui", "port"], alt: ["x", "y"] },
      { pri: " pad ", tags: ["nope"], alt: "x", empty: true },
    ],
  },
  {
    name: "keys",
    schema: {
      properties: {
        b: { type: "string" },
        10: { type: "string" },
        2: { type: "boolean" },
        "01": { type: "string" },
        __proto__: { type: "string" },
        constructor: { type: "string" },
        prototype: { type: "string" },
        obj: { type: "object" },
        str: "string",
        list: [{ type: "string" }],
        nul: null,
        none: { title: "No type" },
      },
      required: ["b", "10"],
    },
    values: [null, { b: "x", 10: "y", 2: true, "01": "z" }, { 10: "y" }],
  },
  { name: "not-a-record", schema: [], values: [null] },
  { name: "no-properties", schema: { type: "object" }, values: [null] },
  { name: "array-properties", schema: { properties: [{ type: "string" }] }, values: [null] },
  {
    name: "caps",
    schema: {
      properties: Object.fromEntries([
        ...Array.from({ length: 55 }, (_, i) => [`f${i}`, i === 0 ? { enum: Array.from({ length: 205 }, (_, j) => `o${j}`) } : { type: "string" }]),
      ]),
    },
    values: [null, { f0: "o204", f1: "x".repeat(10005) }, { f0: "o199" }],
  },
];
// A JSON-parsed `__proto__` is an own key (an object literal's isn't).
SCHEMAS[2].schema = JSON.parse(JSON.stringify(SCHEMAS[2].schema).replace('"b":', '"__proto__":{"type":"string"},"b":'));

function buildCase(fields, values) {
  const v = values ?? el.initialFormValues(fields);
  const r = el.buildElicitationContent(fields, v);
  return { values: values ?? null, out: r.ok ? { ok: r.content } : { errors: r.errors } };
}
sections.schema = SCHEMAS.map(({ name, schema, values }) => {
  const fields = el.parseElicitationSchema(schema);
  return {
    name,
    schema,
    fields,
    initial: el.initialFormValues(fields),
    builds: values.map((v) => buildCase(fields, v)),
  };
});

// -------------------------------- url ----------------------------------

const URLS = [
  undefined,
  "",
  "https://example.com/a?b=1#c",
  " https://Example.COM:8443/x/../y ",
  "http://x.test:80/",
  "https://user:pw@host.test/p",
  "http://[::1]:3000/cb",
  "https://b\u{FC}cher.example/",
  "javascript:alert(1)",
  "data:text/html,<b>x</b>",
  "file:///etc/passwd",
  "ftp://x.test/",
  "not a url",
  "HTTPS://LOUD.TEST",
  "https:\\\\back.test\\path",
];
sections.url = URLS.map((raw) => {
  const u = el.safeElicitationUrl(raw);
  return { raw: raw ?? null, out: u ? { href: u.href, host: u.host, origin: u.origin } : null };
});

// ------------------------------ formatAsk ------------------------------

const Q = (question, labels, multiSelect = false) => ({
  question,
  header: "",
  options: labels.map((label) => ({ label, description: "" })),
  multiSelect,
});
const ASKS = [
  { questions: [], answers: [] },
  { questions: [Q("Which DB?", ["P", "S"])], answers: [{ label: "P" }] },
  { questions: [Q("Which DB?", ["P", "S"])], answers: [] },
  { questions: [Q("Which DB?", ["P", "S"])], answers: [{ label: null, custom: "  mine  " }] },
  { questions: [Q("Which DB?", ["P", "S"])], answers: [{ label: "", custom: "   " }] },
  {
    questions: [Q("Q1", ["a", "b"]), Q("Q2", ["c", "d"], true), Q("Q3", ["e", "f"])],
    answers: [{ label: "a" }, { selected: ["c", "d"], custom: "x" }],
  },
  { questions: [Q("Multi", ["a", "b"], true)], answers: [{ selected: [], label: "b" }] },
  { questions: [Q("Multi", ["a", "b"], true)], answers: [{ selected: ["a"], label: "b" }] },
  { questions: [Q("Lines\nin it", ["a", "b"])], answers: [{ label: "a, b" }, { label: "extra" }] },
];
sections.formatAsk = ASKS.map((c) => ({ ...c, out: formatAskAsPrompt(c.questions, c.answers) }));

sections.looksLikeHtml = [
  "", "plain", "<b>x</b>", "a < div>", "</p>", "<x", "< /a>", "<br/>", "a < b", "<1>", "</ a>", "<>", "<-->",
  "x <\t\nspan class=\"q\">", "<\u{A0}a>", "<\u{3000}a>", "1 < 2 > 0", "<a", "<<a>", "+--+\n| A |\n+--+",
].map((s) => ({ s, out: looksLikeHtml(s) }));

// --------------------------- permission card ---------------------------

const P = (extra) => ({
  type: "permission_request",
  requestId: "r1",
  toolName: "Bash",
  toolUseId: "t1",
  input: { command: "git status" },
  ...extra,
});
const PERMS = [
  { name: "bash", request: P({}), props: { queueTotal: 1, autoModeAvailable: true } },
  { name: "queued", request: P({ suggestedRules: [{ toolName: "Bash", ruleContent: "git status:*" }] }), props: { queueTotal: 3, autoModeAvailable: false } },
  { name: "auto-off", request: P({}), props: { autoModeAvailable: false } },
  { name: "edit", request: P({ toolName: "Edit", input: { file_path: "a.rs" } }), props: { autoModeAvailable: true } },
  { name: "titled", request: P({ title: "Run the tests?", description: "In the sandbox", displayName: "Shell" }), props: {} },
  { name: "empty-title", request: P({ title: "", displayName: null }), props: {} },
  { name: "display-name", request: P({ displayName: "Shell" }), props: {} },
  {
    name: "rules",
    request: P({ suggestedRules: [{ toolName: "Bash", ruleContent: "npm test:*" }, { toolName: "Read", ruleContent: "" }, { toolName: "Edit" }] }),
    props: {},
  },
  { name: "suppress", request: P({ suppressAlwaysAllowRule: true }), props: { autoModeAvailable: true } },
  { name: "default-to-no", request: P({ defaultToNo: true }), props: { autoModeAvailable: true, queueTotal: 2 } },
  { name: "subagent", request: P({ agentId: "explorer-2" }), props: {} },
  { name: "mcp-sdk", request: P({ toolName: "mcp__claudius__x", mcpServer: { name: "claudius", source: "sdk" } }), props: {} },
  { name: "mcp-user", request: P({ toolName: "mcp__srv__x", mcpServer: { name: "srv\u{3164}\u{200E}", source: "user" } }), props: {} },
  { name: "hook", request: P({ hookAsk: {} }), props: {} },
  { name: "hook-reason", request: P({ hookAsk: { reason: "Policy \u{202E}says ask" } }), props: {} },
  { name: "symlink-in", request: P({ toolName: "Read", symlink: { target: "/w/real.txt", outsideWorkingDirs: false, operation: "read" } }), props: {} },
  { name: "symlink-out", request: P({ toolName: "Write", symlink: { target: "/etc/x\u{2060}", outsideWorkingDirs: true, operation: "modify" } }), props: {} },
  { name: "hidden-one", request: P({ input: { command: "echo \u{200B}" } }), props: {} },
  {
    name: "hidden-many",
    request: P({ title: "t\u{202E}", description: "d\u{2066}", input: { command: "rm -rf \u{E0041}\u{E0042}", nested: [1, { k: "\u{FEFF}" }] } }),
    props: {},
    state: [false, "", true],
  },
  { name: "input-open", request: P({ input: { command: "ls", n: 1.5, deep: { a: [true, null] } } }), props: {}, state: [false, "", true] },
  { name: "deny-open", request: P({}), props: {}, state: [true, "because", false] },
];
function permFacts(root) {
  const buttons = all(root, (n) => n.tag === "button").map(text);
  const mcp = byTestId(root, "permission-mcp-source-badge");
  const queue = byTestId(root, "permission-queue-count");
  return {
    summary: textOf(classAll(root, "div", ["mt-0.5", "text-sm", "font-medium"])[0]),
    description: textOf(classAll(root, "div", ["mt-1", "text-xs"])[0]),
    queue: textOf(queue),
    queueTitle: queue ? queue.attrs.title : null,
    agent: textOf(byTestId(root, "permission-agent-badge")),
    mcp: textOf(mcp),
    mcpSdk: mcp ? !(mcp.attrs.class ?? "").includes("amber") : null,
    hook: textOf(byTestId(root, "permission-hook-reason")),
    symlink: textOf(byTestId(root, "permission-symlink-target")),
    hidden: textOf(byTestId(root, "permission-hidden-chars")),
    rule: textOf(byTestId(root, "permission-always-rule")),
    autoTip: !!byTestId(root, "permission-auto-mode-tip"),
    defaultToNo: all(root, (n) => n.attrs["data-default-to-no"] === "true").length > 0,
    buttons,
    denyPanel: all(root, (n) => n.tag === "textarea").length > 0,
    input: textOf(all(root, (n) => n.tag === "pre")[0]),
  };
}
sections.permissionCard = PERMS.map(({ name, request, props, state }) => ({
  name,
  request,
  queueTotal: props.queueTotal ?? null,
  autoModeAvailable: !!props.autoModeAvailable,
  state: state ?? null,
  out: permFacts(
    render(PermissionPrompt, { request, onResolve: noop, onSwitchToAutoMode: noop, ...props }, state ? { 0: state[0], 1: state[1], 2: state[2] } : null),
  ),
}));

// --------------------------- elicitation card --------------------------

const E = (extra) => ({ type: "mcp_elicitation_request", requestId: "e1", serverName: "linear", message: "", mode: "form", ...extra });
const ELICITS = [
  { name: "empty-form", request: E({}) },
  {
    name: "form",
    request: E({
      message: "Fill it in.\nTwo lines.",
      description: "From Linear",
      requestedSchema: SCHEMAS[0].schema,
    }),
    queueTotal: 2,
  },
  { name: "enums", request: E({ displayName: "Linear", requestedSchema: SCHEMAS[1].schema }) },
  { name: "titled", request: E({ title: "Confirm", displayName: null, requestedSchema: SCHEMAS[2].schema }), queueTotal: 1 },
  { name: "url", request: E({ mode: "url", url: "https://github.com/login?x=1", message: "Sign in" }) },
  { name: "url-id", request: E({ mode: "url", url: "http://auth.test:8080/a", elicitationId: "el-1", displayName: "GitHub" }) },
  { name: "url-unsafe", request: E({ mode: "url", url: "javascript:alert(1)" }) },
  { name: "url-none", request: E({ mode: "url" }) },
  { name: "url-opened", request: E({ mode: "url", url: "https://x.test/" }), state: { 2: true } },
  { name: "url-opened-id", request: E({ mode: "url", url: "https://x.test/", elicitationId: "e" }), state: { 2: true } },
  {
    name: "errors",
    request: E({ requestedSchema: SCHEMAS[0].schema }),
    state: { 1: { title: "Required", count: "Must be at least 1" } },
  },
];
function fieldFacts(root) {
  const body = classAll(root, "div", ["mt-3", "space-y-3"])[0];
  if (!body) return [];
  return body.children.map((f) => {
    const input = all(f, (n) => n.tag === "input" && n.attrs.type !== "checkbox")[0];
    const checks = all(f, (n) => n.tag === "input" && n.attrs.type === "checkbox");
    const select = all(f, (n) => n.tag === "select")[0];
    const head = f.tag === "fieldset" ? all(f, (n) => n.tag === "legend")[0] : all(f, (n) => n.tag === "label")[0];
    const err = all(f, (n) => (n.attrs["data-testid"] ?? "").startsWith("mcp-elicitation-error-"))[0];
    const help = all(f, (n) => n.tag === "div" && hasClass(n, "text-[11px]") && !hasClass(n, "text-red-400"))[0];
    return {
      label: textOf(head),
      control: select ? "select" : f.tag === "fieldset" ? "multi" : input ? "input" : "checkbox",
      type: input ? input.attrs.type : null,
      testid: input ? input.attrs["data-testid"] : null,
      value: input ? input.attrs.value : select ? (all(select, (n) => n.tag === "option" && "selected" in n.attrs)[0]?.attrs.value ?? "") : null,
      checked: checks.map((c) => "checked" in c.attrs),
      options: select ? all(select, (n) => n.tag === "option").map(text) : f.tag === "fieldset" ? all(f, (n) => n.tag === "label").map(text) : [],
      help: textOf(help),
      error: textOf(err),
    };
  });
}
sections.elicitationCard = ELICITS.map(({ name, request, queueTotal, state }) => {
  const root = render(McpElicitationPrompt, { request, onResolve: noop, queueTotal }, state ?? null);
  const open = byTestId(root, "mcp-elicitation-open");
  const hrefDiv = classAll(root, "div", ["break-all", "font-mono"])[0];
  return {
    name,
    request,
    queueTotal: queueTotal ?? null,
    state: state ?? null,
    out: {
      heading: textOf(classAll(root, "div", ["mt-0.5", "text-sm", "font-medium"])[0]),
      server: textOf(byTestId(root, "mcp-elicitation-server")),
      queue: textOf(byTestId(root, "mcp-elicitation-queue-count")),
      description: textOf(classAll(root, "div", ["mt-1", "text-xs"])[0]),
      message: textOf(byTestId(root, "mcp-elicitation-message")),
      host: textOf(byTestId(root, "mcp-elicitation-host")),
      href: textOf(hrefDiv),
      unsafe: !!byTestId(root, "mcp-elicitation-unsafe-url"),
      submit: textOf(byTestId(root, "mcp-elicitation-submit")),
      open: open ? { disabled: "disabled" in open.attrs } : null,
      done: !!byTestId(root, "mcp-elicitation-done"),
      fields: fieldFacts(root),
    },
  };
});

// ------------------------------ ask card -------------------------------

const opt = (label, description = "", preview) => (preview === undefined ? { label, description } : { label, description, preview });
const ASKQ = {
  db: { question: "Which DB?", header: "DB", options: [opt("Postgres", "Server"), opt("SQLite", "One file")], multiSelect: false },
  feat: { question: "Which features?", header: "", options: [opt("Auth"), opt("Search"), opt("Billing")], multiSelect: true },
  prev: {
    question: "Which layout?",
    header: "Layout",
    options: [opt("Grid", "", "<div class=\"g\">grid</div>"), opt("List", "", "+--+\n|  |\n+--+"), opt("None")],
    multiSelect: false,
  },
  firstOnly: { question: "First preview?", header: "", options: [opt("A", "", "<b>A</b>"), opt("B")], multiSelect: false },
  emptyFocused: { question: "Empty?", header: "", options: [opt("A", "", "<b>A</b>"), opt("B", "", "")], multiSelect: false },
};
const W = (selectedLabels = [], custom = "", showOther = false) => ({ selectedLabels, custom, showOther });
// useState order: active, working, focusedOption, focusOtherNonce, lastActive.
const st = (active, working, focused = 0) => ({ 0: active, 1: working, 2: focused, 4: active });
const ASKCASES = [
  { name: "inline-fresh", questions: [ASKQ.db, ASKQ.feat], inline: true, label: "Port the prompts" },
  { name: "modal-fresh", questions: [ASKQ.db, ASKQ.feat], inline: false, label: "  ", minimize: true },
  { name: "modal-no-minimize", questions: [ASKQ.db], inline: false },
  { name: "inline-one-ready", questions: [ASKQ.db, ASKQ.feat], inline: true, state: st(0, [W(["SQLite"]), W()]) },
  { name: "inline-q2-multi", questions: [ASKQ.db, ASKQ.feat], inline: true, state: st(1, [W(["SQLite"]), W(["Auth", "Billing"])]) },
  { name: "modal-q2-other", questions: [ASKQ.db, ASKQ.feat], inline: false, minimize: true, state: st(1, [W(["SQLite"]), W(["Auth"], "x", true)]) },
  { name: "inline-other-empty", questions: [ASKQ.db, ASKQ.feat], inline: true, state: st(0, [W([], "  ", true), W()]) },
  { name: "inline-all-ready-first", questions: [ASKQ.db, ASKQ.feat], inline: true, state: st(0, [W(["Postgres"]), W([], "mine", true)]) },
  { name: "preview-focused", questions: [ASKQ.prev], inline: true, state: st(0, [W()], 0) },
  { name: "preview-text", questions: [ASKQ.prev], inline: true, state: st(0, [W(["List"])], 1) },
  { name: "preview-missing", questions: [ASKQ.prev], inline: false, state: st(0, [W()], 2) },
  { name: "preview-first-only", questions: [ASKQ.firstOnly], inline: true, state: st(0, [W()], 1) },
  { name: "preview-empty-focused", questions: [ASKQ.emptyFocused], inline: true, state: st(0, [W()], 1) },
  { name: "three-chips", questions: [ASKQ.db, ASKQ.feat, ASKQ.prev], inline: false, state: st(2, [W(["Postgres"]), W(), W()]) },
];
function askFacts(root) {
  const footer = classAll(root, "div", ["border-t"]).at(-1);
  const btn = (id) => {
    const b = byTestId(root, id);
    return b ? { disabled: "disabled" in b.attrs } : null;
  };
  const chips = all(root, (n) => /^ask-tab-\d+$/.test(n.attrs["data-testid"] ?? ""));
  const previewLabel = all(root, (n) => n.tag === "div" && hasClass(n, "mb-2") && text(n).startsWith("Preview \u{B7} "))[0];
  const pre = all(root, (n) => n.tag === "pre")[0];
  const html = all(root, (n) => n.tag === "div" && hasClass(n, "bg-[#ffffff]"))[0];
  return {
    waiting: textOf(all(root, (n) => n.tag === "span" && text(n) === "Waiting for your answer")[0]) !== null,
    session: textOf(byTestId(root, "ask-session-label")),
    position: textOf(all(root, (n) => n.tag === "span" && /^\d+ of \d+$/.test(text(n)))[0]),
    multiBadge: !!byTestId(root, "ask-multiselect-badge"),
    chips: chips.map((c) => ({ text: text(c), ready: c.children.some((x) => typeof x !== "string") })),
    header: textOf(byTestId(root, "ask-question-header")),
    question: textOf(classAll(root, "p", ["text-sm", "font-medium"])[0]),
    multiHint: textOf(byTestId(root, "ask-multiselect-hint")),
    options: all(root, (n) => /^ask-option-\d+$/.test(n.attrs["data-testid"] ?? "")).map((o) => ({
      text: text(o),
      selected: o.attrs["data-selected"] === "true",
    })),
    otherInline: !!byTestId(root, "ask-other-input-inline"),
    otherPane: !!byTestId(root, "ask-other-input"),
    previewLabel: textOf(previewLabel),
    previewNone: all(root, (n) => text(n) === "No preview for this option." && n.tag === "div").length > 0,
    previewText: textOf(pre),
    previewHtml: html ? true : false,
    hint: textOf(footer?.children[0]),
    prev: btn("ask-prev"),
    next: btn("ask-next"),
    submit: btn("ask-submit"),
    minimize: !!byTestId(root, "ask-minimize"),
  };
}
sections.askCard = ASKCASES.map(({ name, questions, inline, label, minimize, state }) => ({
  name,
  questions,
  inline,
  sessionLabel: label ?? null,
  minimize: !!minimize,
  state: state ?? null,
  out: askFacts(
    render(
      AskUserQuestionPrompt,
      {
        request: { type: "ask_user_question", requestId: "q1", toolUseId: "t1", questions },
        onSubmit: noop,
        onCancel: noop,
        ...(minimize ? { onMinimize: noop } : {}),
        sessionLabel: label ?? null,
        inline,
      },
      state ?? null,
    ),
  ),
}));

// ------------------------------- write ---------------------------------

/** JSON with every non-ASCII character as an escape, so the file stays ASCII. */
function asciiJson(v) {
  return JSON.stringify(v, null, 1).replace(/[^\x00-\x7f]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}
writeFileSync(join(ROOT_DIR, "out.json"), asciiJson(sections) + "\n");
