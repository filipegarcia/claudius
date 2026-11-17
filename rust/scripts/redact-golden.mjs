#!/usr/bin/env node
// Golden fixture for the SDK's secret redaction, `up()`. The SDK runs it on
// the CLI's stderr before quoting it in an exit error (`formatStderrTail`),
// and each time it trims the stderr buffer.
//
//   node rust/scripts/redact-golden.mjs
//
// The redaction function (0.3.299 `up`, 0.3.312 `Qp`) and its two pattern
// lists are module-private in sdk.mjs, so this evaluates the slice of the
// bundle that defines them: from the Slack webhook pattern to the sandbox
// settings-JSON check just past the pattern-building helpers. Minification
// renames all of it on an SDK bump, so both ends and the three names are
// derived from the code's shape, not hard-coded. It records each pattern's
// source, flags and replacement (the Rust port keeps them verbatim, and the
// replay fails when they drift), then hand-written and seeded-random inputs
// with the function's output. Written to
// rust/crates/claudius-agent/tests/fixtures/redact_golden.json and replayed
// by crates/claudius-agent/tests/redact_golden.rs.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const sdkPath = join(repo, "node_modules/@anthropic-ai/claude-agent-sdk");
const sdkVersion = JSON.parse(readFileSync(join(sdkPath, "package.json"), "utf8")).version;
const bundle = readFileSync(join(sdkPath, "sdk.mjs"), "utf8");

function extract() {
  // `function <up>(e){return[...<first>,...<second>].reduce((t,[n,r])=>t.replace(n,r),String(e))}`
  const applier = /function ([\w$]+)\(e\)\{return\[\.\.\.([\w$]+),\.\.\.([\w$]+)\]\.reduce\(\(t,\[n,r\]\)=>t\.replace\(n,r\),String\(e\)\)\}/.exec(bundle);
  if (!applier) throw new Error("the redaction applier moved in sdk.mjs: re-derive the extraction");
  const [, up, first, second] = applier;
  // The slice runs from the Slack webhook pattern (the first declaration the
  // lists need) to the sandbox settings-JSON check that follows the helpers.
  const start = bundle.lastIndexOf("var ", bundle.indexOf("=/hooks\\.slack"));
  const sandboxJson = /function ([\w$]+)\(e\)\{let t=e\.trim\(\);return t\.startsWith\("\{"\)&&t\.endsWith\("\}"\)\}/.exec(bundle);
  if (start < 0 || !sandboxJson || sandboxJson.index < start) {
    throw new Error("redaction code moved in sdk.mjs: re-derive the extraction");
  }
  const slice = bundle.slice(start, sandboxJson.index);
  if (slice.length > 8000 || !slice.includes(`function ${up}(`)) {
    throw new Error(`the ${up} slice is ${slice.length} bytes: re-derive the extraction`);
  }
  return new Function(`${slice};return {list: [...${first}, ...${second}], up: ${up}};`)();
}

const { list, up } = extract();
const patterns = list.map(([re, replacement]) => ({ source: re.source, flags: re.flags, replacement }));

const alnum = (n, seed = "a1B2c3D4e5F6g7H8i9J0") => seed.repeat(Math.ceil(n / seed.length)).slice(0, n);
const upper = (n) => "ABCDEFGHIJKLMNOP0123456789QRSTUVWXYZ".repeat(4).slice(0, n);
const jwt = `eyJ${alnum(12)}.${alnum(14)}.${alnum(16, "Xy_9-Zq")}`;

// Each pattern, its near misses, and their neighbours.
const HAND = [
  "",
  "plain text with no secrets",
  `Authorization: Bearer ${alnum(24)}`,
  `authorization: bearer ${alnum(8)} trailing`,
  `BEARER ${alnum(7)}`,
  `Bearer ${alnum(8)}`,
  `Bearer%20${alnum(30)}`,
  `Bearer ${alnum(4)}%2F${alnum(4)}%zz${alnum(4)}`,
  `Bearer\t\u00a0\ufeff${alnum(10)}`,
  `Bearer\u0085${alnum(10)}`,
  `Bearer\u2028${alnum(10)}`,
  `xBearer ${alnum(20)}`,
  `_Bearer ${alnum(20)}`,
  `-Bearer ${alnum(20)}`,
  `Basic dXNlcjpwYXNzd29yZA==`,
  `Authorization: Basic dXNlcjpwYXNz`,
  `Authorization:   basic   ${alnum(8)}`,
  `Authorization: BASIC ${alnum(7)}`,
  `x:Basic ${alnum(12)}!`,
  `\u017fk-${alnum(24)}`,
  `sk-ant-api03-${alnum(40)}`,
  `sk-ant-${alnum(8)}`,
  `sk-ant-${alnum(7)}`,
  `xsk-ant-${alnum(12)}`,
  `xsk-ant-aaaaaaaaaaaaaaaa`,
  `xsk-ant-11111111a`,
  `sk-proj-${alnum(48)}`,
  `xsk-proj-${alnum(30)}`,
  `sk-svcacct-${alnum(19)}`,
  `sk-admin-${alnum(20)}`,
  `sk-${alnum(20)}`,
  `sk-${alnum(19)}`,
  `SK-${alnum(30)}`,
  `key=AKIA${upper(16)}`,
  `AKIA${upper(16)}`,
  `xAKIA${upper(16)}`,
  `+AKIA${upper(16)}`,
  `AKIA${upper(16)}=`,
  `AKIA${upper(17)}`,
  `ASIA${upper(16)} ABIA${upper(16)} ACCA${upper(16)} A3TX${upper(16)}`,
  `akia${upper(16)}`,
  `ghp_${alnum(36)}`,
  `gho_${alnum(20)} ghu_${alnum(20)} ghs_${alnum(20)} ghr_${alnum(20)}`,
  `xghp_${alnum(30)}`,
  `xghp_${"a".repeat(30)}`,
  `ghp_${alnum(19)}`,
  `GHP_${alnum(30)}`,
  `github_pat_${alnum(82, "a_B1")}`,
  `github_pat_${alnum(81)}`,
  `sq0atp-${alnum(22)} sq0csp-${alnum(30, "x-_9")}`,
  `sq0atp-${alnum(21)}`,
  `EAAA${alnum(56, "a+/=%_-1")}`,
  `/EAAA${alnum(60)}`,
  `xEAAA${alnum(60)}`,
  `glpat-${alnum(20)}`,
  `glpat-${alnum(20)}.${"0a1b2c3d4"}`,
  `glpat-${alnum(20)}.ABCDEFGHI`,
  `xglpat-${alnum(25)}`,
  `xglpat-${"a".repeat(25)}`,
  `gldt-${alnum(20)} glrt-${alnum(20)} glft-${alnum(20)} glsoat-${alnum(20)} gloas-${alnum(20)} glagent-${alnum(20)} glptt-${alnum(20)} glcbt-${alnum(20)} glimt-${alnum(20)} glffct-${alnum(20)}`,
  `xoxb-${alnum(10)}`,
  `XOXB-${alnum(30)}`,
  `xoxb.xoxe-${alnum(12)}`,
  `xapp-1-${alnum(20)}`,
  `xwfp-${alnum(15)}`,
  `zxoxb-${alnum(10)}`,
  `zxoxb-1${alnum(10)}`,
  `zxoxb-${"a".repeat(12)}`,
  `xoxa-${alnum(9)}`,
  `xoxc-${alnum(10)}`,
  `zxoxc-${alnum(16)}`,
  `zxoxd-${"a".repeat(20)}`,
  `zxoxd-${alnum(15)}`,
  `https://hooks.slack.com/services/T000/B000/${alnum(24)}`,
  `HOOKS.SLACK.COM/Workflows/${alnum(10)}`,
  `hooks.slack.com/triggers/a/b_c-d`,
  `hooks.slack.com/other/${alnum(10)}`,
  jwt,
  `token=${jwt}`,
  `prefix-${jwt}`,
  `a-b-c-${jwt}`,
  `x${jwt}`,
  `eyJ${alnum(9)}.${alnum(10)}.${alnum(10)}`,
  `ey${alnum(10)}.${alnum(10)}.${alnum(10)}`,
  `${alnum(5)}.${jwt}`,
  `AIza${alnum(35)}`,
  `key:AIza${alnum(35)}`,
  `AIza${alnum(36)}`,
  `xAIza${alnum(35)}`,
  `GOCSPX-${alnum(28)}`,
  `GOCSPX-${alnum(29)}`,
  `sk_live_${alnum(24)}`,
  `rk_test_${alnum(30)}`,
  `sk_prod_${"a".repeat(30)}`,
  `sk_live_${alnum(24)}=`,
  `x sk_live_${alnum(23)}`,
  // Several at once, and patterns that overlap in list order.
  `Bearer ${alnum(20)} sk-ant-${alnum(30)} AKIA${upper(16)} ghp_${alnum(30)} ${jwt}`,
  `sk-ant-${alnum(30)}sk-ant-${alnum(30)}`,
  `AKIA${upper(16)} AKIA${upper(16)}`,
  `AKIA${upper(16)}AKIA${upper(16)}`,
  `Authorization: Bearer sk-ant-${alnum(30)}`,
  `Basic sk-${alnum(30)}`,
  // Neighbours outside ASCII and the BMP.
  `\u{1F600}sk-ant-${alnum(12)}\u{1F600}`,
  `\u{1F600}AKIA${upper(16)}\u{1F600}`,
  `\u212aBearer ${alnum(10)}`,
  `Bearer \u212a${alnum(10)}`,
  `xox\u017f-${alnum(12)}`,
  `\u00e9AIza${alnum(35)}\u00e9`,
  `\u00a0${jwt}\u00a0`,
];

// Seeded fragments, so the random half is reproducible.
function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const FRAGMENTS = [
  "sk-", "ant-", "proj-", "Bearer ", "bearer\t", "Basic ", ": ", ":", "eyJ", "ey", ".", "-", "_", "=", "+", "/", "%", "%20", "%2f",
  "AKIA", "A3T", "gh", "p_", "github_pat_", "sq0atp-", "EAAA", "glpat-", "xox", "b-", "c-", "xapp-", "hooks.slack.com/services/",
  "AIza", "GOCSPX-", "sk_live_", "rk_test_", " ", "\n", "\r\n", "\u00a0", "\u0085", "\ufeff", "\u017f", "\u212a", "\u{1F600}", "\u00e9", "0", "9",
];
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
function fuzz(seed, count) {
  const rand = mulberry32(seed);
  const pick = (s) => s[Math.floor(rand() * s.length)];
  const out = [];
  for (let i = 0; i < count; i++) {
    let s = "";
    const parts = 1 + Math.floor(rand() * 8);
    for (let p = 0; p < parts; p++) {
      if (rand() < 0.55) s += pick(FRAGMENTS);
      else {
        const n = Math.floor(rand() * 90);
        for (let k = 0; k < n; k++) s += rand() < 0.08 ? pick("_-.=+/%") : pick(ALNUM);
      }
    }
    out.push(s);
  }
  return out;
}

const inputs = [...HAND, ...fuzz(0xc1a0d105, 1500)];
// A long tail like the one the SDK trims: redaction must stay fast.
inputs.push(`${"x".repeat(3000)}Bearer ${alnum(500)} ${"sk-".repeat(400)}${"a-".repeat(800)}${jwt}`);
const cases = inputs.map((input) => ({ input, output: up(input) }));
const redacted = cases.filter((c) => c.input !== c.output).length;

const file = join(rustDir, "crates/claudius-agent/tests/fixtures/redact_golden.json");
writeFileSync(file, `${JSON.stringify({ sdkVersion, patterns, cases }, null, 1)}\n`);
console.log(`${patterns.length} patterns, ${cases.length} cases (${redacted} changed by up())`);
console.log(`wrote ${file.slice(repo.length + 1)}`);
