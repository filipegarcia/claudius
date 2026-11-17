#!/usr/bin/env node
// Golden fixture for the SDK's sandbox merge (`CZ()` + `bZ()`).
//
//   node rust/scripts/sandbox-merge-golden.mjs
//
// `query({sandbox})` folds the sandbox option into the `--settings` JSON. This
// script lifts that code out of the installed
// node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs, runs it over the edge
// cases below, and writes the inputs and results to
// rust/crates/claudius-agent/tests/fixtures/sandbox_merge.json.
// `crates/claudius-agent/tests/sandbox_merge.rs` replays every case against
// `claudius_agent::sandbox::merge_into_args` and compares byte for byte.
//
// The bundle is minified and renamed on every SDK bump, so the merge and its
// helpers are found by the shape of their code, not by name: the merge is the
// `(options, sandbox)` function that throws "Cannot use both a settings file
// path and the sandbox option", and the slice around it runs from the
// settings-JSON braces check through the deep merge and the key sets it
// reads. `JSON.parse` / `JSON.stringify` sit behind the bundle's tracing
// wrappers, so those two names are stubbed out.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const sdkPath = join(repo, "node_modules/@anthropic-ai/claude-agent-sdk");
const bundle = readFileSync(join(sdkPath, "sdk.mjs"), "utf8");
const sdkVersion = JSON.parse(readFileSync(join(sdkPath, "package.json"), "utf8")).version;

function shape(re, what, haystack = bundle) {
  const m = re.exec(haystack);
  if (!m) throw new Error(`${what} moved in sdk.mjs ${sdkVersion}: re-derive the extraction`);
  return m;
}
function oneLiner(name) {
  const m = bundle.match(new RegExp(`function ${name}\\([^)]*\\)\\{[^}]*\\}`));
  if (!m) throw new Error(`function ${name} is not a one-liner in sdk.mjs ${sdkVersion}`);
  return m[0];
}
/** The end of the function starting at `from`, by matching its braces. */
function functionEnd(from) {
  let depth = 0;
  for (let i = bundle.indexOf("{", from); i < bundle.length; i++) {
    if (bundle[i] === "{") depth++;
    else if (bundle[i] === "}" && --depth === 0) return i + 1;
  }
  throw new Error(`unbalanced braces from ${from} in sdk.mjs ${sdkVersion}`);
}

// `(settings) => settings.trim()` is braced-JSON is the first declaration the merge
// needs; the merge itself is the last. Everything between (the deep merge and
// the four key sets it reads) comes along in one slice.
const braces = shape(/function ([\w$]+)\(e\)\{let t=e\.trim\(\);return t\.startsWith\("\{"\)&&t\.endsWith\("\}"\)\}/, "the settings-JSON check");
const mergeIntoArgs = shape(/function ([\w$]+)\(e,t\)\{let n=\{\.\.\.e\};if\(!t\)return n;/, "the sandbox merge");
const lifted = bundle.slice(braces.index, functionEnd(mergeIntoArgs.index));
if (!lifted.includes("Cannot use both a settings file path and the sandbox option")) {
  throw new Error(`lifted code isn't the sandbox merge in sdk.mjs ${sdkVersion}; re-derive the extraction`);
}
// The helpers the lifted code calls, named inside it: a plain-object test, a
// `[...new Set]` dedupe, and the two JSON wrappers (stubbed). Each name is
// read out of the slice, not the whole bundle, so an identical shape
// elsewhere can't win.
const isPlainObject = shape(/([\w$]+)\(e\)\?\{\.\.\.e\}:\{\}/, "the plain-object test", lifted)[1];
const dedupe = shape(/=([\w$]+)\(\[\.\.\.[\w$]+,\.\.\.[\w$]+\]\)/, "the array-union dedupe", lifted)[1];
const jsonParse = shape(/try\{[\w$]+=([\w$]+)\([\w$]+\)\}catch\{\}/, "the settings JSON.parse", lifted)[1];
const jsonStringify = shape(/\.settings=([\w$]+)\(\{\.\.\.[\w$]+,sandbox:[\w$]+\}\)/, "the settings JSON.stringify", lifted)[1];
const CZ = new Function(
  [
    lifted,
    oneLiner(isPlainObject),
    oneLiner(dedupe),
    `const ${jsonParse} = (s) => JSON.parse(s); const ${jsonStringify} = (v) => JSON.stringify(v);`,
    `return ${mergeIntoArgs[1]};`,
  ].join("\n"),
)();

// Inputs are JSON text so `__proto__` keys become own properties, the way
// they do when JSON reaches the SDK. `args` is `{...extraArgs, settings?}`;
// `sandbox` is the option (`null` = falsy, not absent).
const S = (o) => JSON.stringify(o);
const claudiusSandbox = {
  enabled: true,
  autoAllowBashIfSandboxed: true,
  failIfUnavailable: false,
  filesystem: { disabled: true },
  network: { allowedDomains: ["github.com"], strictAllowlist: true },
};
const cases = [
  ["enabled_no_settings", {}, S({ enabled: true })],
  ["empty_option", {}, "{}"],
  ["falsy_null", { settings: S({ a: 1 }) }, "null"],
  ["falsy_false", {}, "false"],
  ["falsy_zero", {}, "0"],
  ["falsy_empty_string", {}, '""'],
  ["settings_path_conflict", { settings: "/etc/claude/settings.json" }, S({ enabled: true })],
  ["settings_path_not_closed", { settings: "{ not closed" }, S({ enabled: true })],
  ["settings_empty_string", { settings: "" }, S({ enabled: true })],
  ["settings_unparseable", { settings: "  {bad json}  " }, S({ enabled: true })],
  ["settings_nbsp_trimmed_but_invalid_json", { settings: "\u00a0{\"a\":1}" }, S({ enabled: true })],
  ["settings_json_whitespace", { settings: "\n {\"a\":1} \n" }, S({ enabled: true })],
  ["settings_null_extra_arg", { foo: "1", settings: null, bar: null }, S({ enabled: true })],
  ["extra_args_keep_settings_position", { foo: "1", settings: S({ a: 1 }), bar: null }, S({ enabled: true })],
  [
    "golden_sandbox_bypass",
    { settings: S({ includeCoAuthoredBy: true, sandbox: { autoAllowBashIfSandboxed: true } }) },
    S({ enabled: true }),
  ],
  ["claudius_session_no_settings", {}, S(claudiusSandbox)],
  [
    "claudius_session_over_user_sandbox",
    {
      settings: S({
        model: "x",
        sandbox: {
          filesystem: { denyRead: ["/a"], disabled: false },
          network: { httpProxyPort: 8080, socksProxyPort: 1080, deniedDomains: ["x.com"] },
        },
        after: true,
      }),
    },
    S(claudiusSandbox),
  ],
  [
    "union_paths",
    {
      settings: S({
        sandbox: {
          filesystem: { denyRead: ["/a", "/b"], denyWrite: ["/w"], allowWrite: ["/k"] },
          network: { deniedDomains: ["a.com", 1], allowedDomains: ["keep.com"] },
          credentials: { files: [{ path: "/p", mode: "deny" }], envVars: ["A"] },
        },
      }),
    },
    S({
      filesystem: { denyRead: ["/b", "/c"], allowWrite: ["/z"] },
      network: { deniedDomains: ["a.com", "b.com", 1.0] },
      credentials: { files: [{ path: "/p", mode: "deny" }], envVars: ["A", "B"] },
    }),
  ],
  [
    "union_needs_both_arrays",
    { settings: S({ sandbox: { filesystem: { denyRead: "/a" } } }) },
    S({ filesystem: { denyRead: ["/b"] } }),
  ],
  [
    "replace_paths",
    {
      settings: S({
        sandbox: {
          ripgrep: { command: "rg", args: ["-x"] },
          network: { tlsTerminate: { a: 1, b: 2 }, other: { a: 1, b: 2 } },
        },
      }),
    },
    S({ ripgrep: { command: "rg2" }, network: { tlsTerminate: { a: 9 }, other: { a: 9 } } }),
  ],
  [
    "fs_disabled_dropped_when_option_configures_fs",
    { settings: S({ sandbox: { filesystem: { disabled: true, denyRead: ["/a"] } } }) },
    S({ filesystem: { denyRead: ["/b"] } }),
  ],
  [
    "fs_disabled_kept_when_option_sets_null",
    { settings: S({ sandbox: { filesystem: { disabled: true } } }) },
    S({ filesystem: { disabled: null } }),
  ],
  [
    "fs_disabled_dropped_by_credential_deny",
    { settings: S({ sandbox: { filesystem: { disabled: true } } }) },
    S({ credentials: { files: [{ path: "/k", mode: "deny" }] } }),
  ],
  [
    "fs_disabled_kept_for_credential_allow",
    { settings: S({ sandbox: { filesystem: { disabled: true } } }) },
    S({ credentials: { files: [{ path: "/k", mode: "allow" }, "deny"] } }),
  ],
  [
    "fs_option_null_replaces",
    { settings: S({ sandbox: { filesystem: { disabled: true } } }) },
    S({ filesystem: null }),
  ],
  [
    "proxy_ports_dropped_by_allowed_domains_null",
    { settings: S({ sandbox: { network: { httpProxyPort: 1, socksProxyPort: 2, x: 3 } } }) },
    S({ network: { allowedDomains: null } }),
  ],
  [
    "proxy_ports_kept_for_empty_denied",
    { settings: S({ sandbox: { network: { httpProxyPort: 1, socksProxyPort: 2 } } }) },
    S({ network: { deniedDomains: [] } }),
  ],
  [
    "proxy_ports_dropped_by_denied_string",
    { settings: S({ sandbox: { network: { httpProxyPort: 1, socksProxyPort: null } } }) },
    S({ network: { deniedDomains: "x.com" } }),
  ],
  [
    "proxy_ports_dropped_by_denied_length_object",
    { settings: S({ sandbox: { network: { httpProxyPort: 1 } } }) },
    S({ network: { deniedDomains: { length: 2 } } }),
  ],
  [
    "proxy_port_set_by_option_survives",
    { settings: S({ sandbox: { network: { httpProxyPort: 1, socksProxyPort: 2 } } }) },
    S({ network: { strictAllowlist: true, httpProxyPort: 9 } }),
  ],
  [
    "strict_allowlist_must_be_true",
    { settings: S({ sandbox: { network: { httpProxyPort: 1 } } }) },
    S({ network: { strictAllowlist: "true" } }),
  ],
  [
    "fail_if_unavailable_user_false_kept",
    { settings: S({ sandbox: { failIfUnavailable: false } }) },
    S({ enabled: true }),
  ],
  ["fail_if_unavailable_null_kept", {}, S({ enabled: true, failIfUnavailable: null })],
  ["enabled_must_be_true", {}, S({ enabled: "true" })],
  ["prototype_keys_skipped", {}, '{"__proto__":{"x":1},"constructor":1,"prototype":2,"ok":1}'],
  [
    "prototype_keys_in_settings_kept",
    { settings: '{"sandbox":{"__proto__":{"y":1}},"__proto__":{"z":2}}' },
    S({ enabled: true }),
  ],
  ["key_order_sandbox_in_middle", { settings: S({ a: 1, sandbox: { x: 1 }, b: 2 }) }, S({ y: 2 })],
  [
    "numbers_normalized_like_js",
    { settings: '{"n":[1.0,1e2,-0,1E21,12345678901234567890,0.000001,1e-7]}' },
    S({ enabled: true }),
  ],
  ["integer_keys_first", { settings: '{"b":1,"10":2,"2":3,"01":4,"-1":5}' }, S({ enabled: true })],
  ["duplicate_keys_last_wins", { settings: '{"a":1,"sandbox":{"q":1},"a":2}' }, S({ enabled: true })],
  ["user_sandbox_not_object", { settings: S({ sandbox: ["x"], k: 1 }) }, S({ enabled: true })],
  ["option_true", {}, "true"],
  ["option_string", {}, '"ab"'],
  ["option_array", {}, S([{ enabled: true }])],
  ["unicode_and_escapes", { settings: S({ s: "\u00e9\n\u001f\"\u2028" }) }, S({ enabled: true })],
];

const out = cases.map(([name, args, sandboxJson]) => {
  const sandbox = JSON.parse(sandboxJson);
  let result;
  try {
    result = { args: CZ({ ...args }, sandbox) };
  } catch (e) {
    result = { error: e.message };
  }
  return { name, args, sandbox, result };
});

const file = join(rustDir, "crates/claudius-agent/tests/fixtures/sandbox_merge.json");
writeFileSync(file, JSON.stringify({ sdkVersion, cases: out }, null, 2) + "\n");
console.log(`wrote ${out.length} cases to ${file}`);
