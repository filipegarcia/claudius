#!/usr/bin/env node
// SDK drift detector. Compares the installed @anthropic-ai/claude-agent-sdk
// with what the Rust port mirrors: `claudius_agent::SDK_VERSION` and the
// checked-in rust/scripts/sdk-snapshot.json.
//
//   rust/scripts/sdk-diff.sh            report; exit 1 on any drift
//   rust/scripts/sdk-diff.sh --update   rewrite the snapshot from the SDK
//   rust/scripts/sdk-diff.sh --sdk DIR  read another SDK copy
//
// What's compared, all extracted by parsing (TypeScript's parser, not
// regexes over minified code):
// - versions: package.json, the `CLAUDE_AGENT_SDK_VERSION` literal baked
//   into sdk.mjs, `SDK_VERSION` in crates/claudius-agent/src/lib.rs, and the
//   snapshot's. All four must agree.
// - control requests: the `SDKControlRequestInner` union in sdk.d.ts
//   (declared), every `request({subtype: "…"})` the host sends, plus
//   `initialize`, every `….request.subtype === "…"` it handles, and the
//   subtypes it deliberately leaves unanswered (`LIST.some((n) => n ===
//   ….request.subtype)`) (sdk.mjs). The runtime sets include internal
//   subtypes the typings don't declare. A change to any of them means
//   re-recording rust/scripts/control-golden.mjs.
// - messages: the `type` / `type/subtype` of every `SDKMessage` member.
// - Options keys: the top-level keys of the `Options` type, and every name
//   query() destructures from its options and internal parameters at the
//   top of its body (the runtime also reads undeclared ones, e.g.
//   `getOAuthToken`).
// - env rules: what the two functions that tag the CLI env
//   (`CLAUDE_CODE_ENTRYPOINT = "sdk-ts"`: query() and ProcessTransport) do
//   to it, per variable: set, delete, read, or key (named in a statement
//   that touches the env object as a whole, e.g. a case-insensitive scan).
//   `host-set` is a write to the host's own `process.env` there, which the
//   CLI env then inherits when no custom `env` is given.
//
// Every difference fails: an added subtype, key or env rule is new SDK
// behaviour to port; a removed or changed one is behaviour the Rust port may
// still mirror. Review the report against the port, then run --update.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const require = createRequire(join(repo, "package.json"));
const ts = require("typescript");

const args = process.argv.slice(2);
const update = args.includes("--update");
const sdkArg = args.indexOf("--sdk");
const sdkDir = sdkArg === -1 ? join(repo, "node_modules/@anthropic-ai/claude-agent-sdk") : resolve(args[sdkArg + 1]);
const snapshotFile = join(here, "sdk-snapshot.json");
const ENV_NAME = /^[A-Z][A-Z0-9_]{2,}$/;

const sorted = (xs) => [...new Set(xs)].sort();
const text = (node) => (ts.isIdentifier(node) || ts.isStringLiteral(node) ? node.text : node.getText());

// --- sdk.d.ts --------------------------------------------------------------
function readTypings() {
  const file = ts.createSourceFile("sdk.d.ts", readFileSync(join(sdkDir, "sdk.d.ts"), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const decls = new Map();
  for (const st of file.statements) {
    if (ts.isTypeAliasDeclaration(st) || ts.isInterfaceDeclaration(st)) decls.set(st.name.text, st);
  }
  const need = (name) => {
    const decl = decls.get(name);
    if (!decl) throw new Error(`sdk.d.ts has no type ${name}; re-derive the extraction`);
    return decl;
  };
  // A union's members, following aliases of unions. Unresolved names stay names.
  const members = (node) => {
    if (ts.isTypeAliasDeclaration(node)) return members(node.type);
    if (ts.isParenthesizedTypeNode(node)) return members(node.type);
    if (ts.isUnionTypeNode(node)) return node.types.flatMap(members);
    if (ts.isTypeReferenceNode(node)) {
      const name = text(node.typeName).split(".").pop();
      const decl = decls.get(name);
      if (decl && ts.isTypeAliasDeclaration(decl) && (ts.isUnionTypeNode(decl.type) || ts.isTypeReferenceNode(decl.type))) return members(decl);
      return [{ name, node: decl ?? null }];
    }
    return [{ name: "<inline>", node }];
  };
  // An object type's properties, through aliases and intersections.
  const props = (node, out = new Map()) => {
    if (!node) return out;
    if (ts.isTypeAliasDeclaration(node)) return props(node.type, out);
    if (ts.isParenthesizedTypeNode(node)) return props(node.type, out);
    if (ts.isIntersectionTypeNode(node)) {
      for (const t of node.types) props(t, out);
      return out;
    }
    if (ts.isTypeReferenceNode(node)) return props(decls.get(text(node.typeName).split(".").pop()), out);
    if (ts.isTypeLiteralNode(node) || ts.isInterfaceDeclaration(node)) {
      for (const m of node.members) if (m.name) out.set(text(m.name), m.type ?? null);
    }
    return out;
  };
  const literals = (node) => {
    if (!node) return [];
    if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)) return [node.literal.text];
    if (ts.isUnionTypeNode(node)) return node.types.flatMap(literals);
    if (ts.isParenthesizedTypeNode(node)) return literals(node.type);
    return [];
  };

  const declared = members(need("SDKControlRequestInner")).flatMap(({ name, node }) => {
    const subtypes = literals(props(node).get("subtype"));
    return subtypes.length > 0 ? subtypes : [`?${name}`];
  });
  const messages = members(need("SDKMessage")).flatMap(({ name, node }) => {
    const p = props(node);
    const types = literals(p.get("type"));
    if (types.length === 0) return [`?${name}`];
    const subtypes = literals(p.get("subtype"));
    return types.flatMap((t) => (subtypes.length > 0 ? subtypes.map((s) => `${t}/${s}`) : [t]));
  });
  const optionsKeys = [...props(need("Options")).keys()];
  return { declared: sorted(declared), messages: sorted(messages), optionsKeys: sorted(optionsKeys) };
}

// --- sdk.mjs ---------------------------------------------------------------
function readBundle() {
  const file = ts.createSourceFile("sdk.mjs", readFileSync(join(sdkDir, "sdk.mjs"), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const sends = [];
  const handles = [];
  const envFns = [];
  // `LIST.some((n) => n === e.request.subtype)`: subtypes deliberately left
  // unanswered. LIST is a top-level array of string literals.
  const ignoreLists = [];
  const stringArrays = new Map();
  const subtypeOf = (obj) => {
    for (const p of obj.properties) {
      if (ts.isPropertyAssignment(p) && text(p.name) === "subtype" && ts.isStringLiteral(p.initializer)) return p.initializer.text;
    }
    return undefined;
  };
  const isAssign = (n) => ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken;
  (function visit(n) {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "request") {
      const arg = n.arguments[0];
      const subtype = arg && ts.isObjectLiteralExpression(arg) ? subtypeOf(arg) : undefined;
      if (subtype) sends.push(subtype);
    }
    // `initialize` is built by a helper and sent by reference.
    if (ts.isReturnStatement(n) && n.expression && ts.isObjectLiteralExpression(n.expression) && subtypeOf(n.expression) === "initialize") {
      sends.push("initialize");
    }
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken) {
      for (const [a, b] of [[n.left, n.right], [n.right, n.left]]) {
        if (ts.isPropertyAccessExpression(a) && a.name.text === "subtype" && ts.isPropertyAccessExpression(a.expression) && a.expression.name.text === "request" && ts.isStringLiteral(b)) {
          handles.push(b.text);
        }
      }
    }
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && ts.isArrayLiteralExpression(n.initializer) && n.initializer.elements.length > 0 && n.initializer.elements.every(ts.isStringLiteral)) {
      stringArrays.set(n.name.text, n.initializer.elements.map((e) => e.text));
    }
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "some" && ts.isIdentifier(n.expression.expression)) {
      const cb = n.arguments[0];
      const body = cb && ts.isArrowFunction(cb) ? cb.body : undefined;
      const isSubtype = (x) => ts.isPropertyAccessExpression(x) && x.name.text === "subtype" && ts.isPropertyAccessExpression(x.expression) && x.expression.name.text === "request";
      if (body && ts.isBinaryExpression(body) && body.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken && (isSubtype(body.left) || isSubtype(body.right))) {
        ignoreLists.push(n.expression.expression.text);
      }
    }
    if (isAssign(n) && ts.isPropertyAccessExpression(n.left) && n.left.name.text === "CLAUDE_CODE_ENTRYPOINT" && ts.isStringLiteral(n.right) && n.right.text === "sdk-ts") {
      let fn = n.parent;
      while (fn && !ts.isFunctionLike(fn)) fn = fn.parent;
      if (fn) envFns.push({ env: n.left.expression.getText(), fn });
    }
    ts.forEachChild(n, visit);
  })(file);

  let bundleVersion = null;
  const env = {};
  const runtimeOptions = [];
  for (const { env: name, fn } of envFns) {
    const ops = new Map();
    const add = (key, op) => ops.set(key, (ops.get(key) ?? new Set()).add(op));
    const wholeEnvStatements = new Set();
    const isBody = (b) => ts.isBlock(b) && ts.isFunctionLike(b.parent);
    (function walk(n) {
      if (isAssign(n) && ts.isPropertyAccessExpression(n.left) && n.left.expression.getText() === "process.env" && ENV_NAME.test(n.left.name.text)) {
        add(n.left.name.text, "host-set");
      }
      // A nested function taking a parameter of the same name shadows it.
      if (n !== fn && ts.isFunctionLike(n) && n.parameters?.some((p) => p.name.getText() === name)) return;
      if (ts.isIdentifier(n) && n.text === name && n.parent) {
        const p = n.parent;
        if (ts.isPropertyAccessExpression(p) && p.expression === n && ENV_NAME.test(p.name.text)) {
          const gp = p.parent;
          const op = isAssign(gp) && gp.left === p ? "set" : ts.isDeleteExpression(gp) ? "delete" : "read";
          add(p.name.text, op);
          if (op === "set" && p.name.text === "CLAUDE_AGENT_SDK_VERSION" && ts.isStringLiteral(gp.right)) bundleVersion = gp.right.text;
        } else if (!(ts.isPropertyAccessExpression(p) && p.name === n)) {
          let s = n;
          while (s.parent && !isBody(s.parent) && !ts.isFunctionLike(s.parent)) s = s.parent;
          wholeEnvStatements.add(s);
        }
      }
      ts.forEachChild(n, walk);
    })(fn);
    for (const s of wholeEnvStatements) {
      (function lit(n) {
        if (ts.isStringLiteral(n) && ENV_NAME.test(n.text)) add(n.text, "key");
        ts.forEachChild(n, lit);
      })(s);
    }
    const rules = Object.fromEntries([...ops].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, sorted(v).join(",")]));
    const label = ops.has("CLAUDE_AGENT_SDK_VERSION") ? "query" : ops.get("NODE_OPTIONS")?.has("delete") ? "transport" : `fn${Object.keys(env).length + 1}`;
    env[label] = rules;
    if (label === "query") {
      for (const st of fn.body?.statements ?? []) {
        if (!ts.isVariableStatement(st)) continue;
        for (const decl of st.declarationList.declarations) {
          if (!ts.isObjectBindingPattern(decl.name)) continue;
          for (const el of decl.name.elements) if (!el.dotDotDotToken) runtimeOptions.push(text(el.propertyName ?? el.name));
        }
      }
    }
  }
  if (!env.query) throw new Error("query()'s env function not found; re-derive the extraction");
  if (ignoreLists.length === 0) throw new Error("processControlRequest's ignore list not found; re-derive the extraction");
  const ignores = ignoreLists.flatMap((name) => {
    const list = stringArrays.get(name);
    if (!list) throw new Error(`ignore list ${name} isn't a string array literal; re-derive the extraction`);
    return list;
  });
  return { hostSends: sorted(sends), hostHandles: sorted(handles), hostIgnores: sorted(ignores), env, bundleVersion, runtimeOptions: sorted(runtimeOptions) };
}

// --- compare ---------------------------------------------------------------
const pkgVersion = JSON.parse(readFileSync(join(sdkDir, "package.json"), "utf8")).version;
const rustVersion = /pub const SDK_VERSION: &str = "([^"]+)";/.exec(readFileSync(join(rustDir, "crates/claudius-agent/src/lib.rs"), "utf8"))?.[1] ?? null;
const typings = readTypings();
const bundle = readBundle();
const current = {
  sdkVersion: pkgVersion,
  controlRequests: { declared: typings.declared, hostSends: bundle.hostSends, hostHandles: bundle.hostHandles, hostIgnores: bundle.hostIgnores },
  messages: typings.messages,
  optionsKeys: typings.optionsKeys,
  queryReads: bundle.runtimeOptions,
  env: bundle.env,
};
let snapshot = null;
try {
  snapshot = JSON.parse(readFileSync(snapshotFile, "utf8"));
} catch (e) {
  if (e.code !== "ENOENT" || !update) throw e;
}

const lines = [];
let drift = 0;
const versions = { installed: pkgVersion, bundle: bundle.bundleVersion, "claudius_agent::SDK_VERSION": rustVersion, snapshot: snapshot?.sdkVersion ?? null };
const versionOk = Object.values(versions).every((v) => v === pkgVersion);
if (!versionOk) drift++;
lines.push(`  versions  ${Object.entries(versions).map(([k, v]) => `${k} ${v}`).join(" · ")}  ${versionOk ? "ok" : "MISMATCH"}`);

function section(label, want, got) {
  const diffs = [];
  if (Array.isArray(got)) {
    const before = new Set(want ?? []);
    const after = new Set(got);
    for (const x of got) if (!before.has(x)) diffs.push(`+ ${x}`);
    for (const x of want ?? []) if (!after.has(x)) diffs.push(`- ${x}`);
  } else {
    const before = want ?? {};
    for (const [k, v] of Object.entries(got)) {
      if (!(k in before)) diffs.push(`+ ${k} (${v})`);
      else if (before[k] !== v) diffs.push(`~ ${k} (${before[k]} → ${v})`);
    }
    for (const k of Object.keys(before)) if (!(k in got)) diffs.push(`- ${k} (${before[k]})`);
  }
  const count = Array.isArray(got) ? got.length : Object.keys(got).length;
  lines.push(`  ${label.padEnd(44)} ${String(count).padStart(3)}  ${diffs.length === 0 ? "ok" : `${diffs.length} changed`}`);
  for (const d of diffs) lines.push(`      ${d}`);
  drift += diffs.length;
}
const want = snapshot ?? {};
section("control requests declared (sdk.d.ts)", want.controlRequests?.declared, current.controlRequests.declared);
section("control requests the host sends (sdk.mjs)", want.controlRequests?.hostSends, current.controlRequests.hostSends);
section("control requests the host handles (sdk.mjs)", want.controlRequests?.hostHandles, current.controlRequests.hostHandles);
section("control requests left unanswered (sdk.mjs)", want.controlRequests?.hostIgnores, current.controlRequests.hostIgnores);
section("SDKMessage type/subtype (sdk.d.ts)", want.messages, current.messages);
section("Options keys (sdk.d.ts)", want.optionsKeys, current.optionsKeys);
section("names query() destructures (sdk.mjs)", want.queryReads, current.queryReads);
const envLabels = sorted([...Object.keys(want.env ?? {}), ...Object.keys(current.env)]);
for (const label of envLabels) section(`env rules: ${label}`, want.env?.[label], current.env[label] ?? {});

console.log(`SDK drift report: ${sdkDir.replace(`${repo}/`, "")} vs rust/scripts/sdk-snapshot.json`);
console.log(lines.join("\n"));
if (update) {
  writeFileSync(snapshotFile, `${JSON.stringify(current, null, 2)}\n`);
  console.log(`snapshot updated (${drift} change${drift === 1 ? "" : "s"} recorded)`);
  // The snapshot now carries the installed version; the others must agree.
  if (![bundle.bundleVersion, rustVersion].every((v) => v === pkgVersion)) {
    console.log("versions still disagree: bump SDK_VERSION in crates/claudius-agent/src/lib.rs");
    process.exit(1);
  }
} else if (drift > 0) {
  console.log(`DRIFT: ${drift} change${drift === 1 ? "" : "s"}. Review them against the Rust port, then run with --update.`);
  process.exit(1);
} else {
  console.log("clean: no drift");
}
