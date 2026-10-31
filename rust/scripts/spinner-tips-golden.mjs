#!/usr/bin/env node
// Golden fixture for the spinner-tips settings knobs (S22), recorded from the
// real TS source:
//
//   node rust/scripts/spinner-tips-golden.mjs     (node@22)
//
// `mergeSpinnerTipsFile` is module-private and importing all of
// lib/server/session.ts is heavy, so the recorder reads these out of
// session.ts as text and runs them through node's type stripping, failing
// loudly when a marker stops matching:
// - `normalizeSpinnerTipsOverride`, `SPINNER_TIPS_FILE_MAX_BYTES` and
//   `mergeSpinnerTipsFile` (with session.ts's own `fsp` / `homedir` /
//   `isAbsolute` / `pathJoin` bindings);
// - from `start()`, the `readSettings("user", …)` statement and the
//   `this.spinnerTipsConfig = { … }` assignment after it, run with `this` set
//   to a stand-in;
// - from `subscribe()`, the `selectTips({ … })` call behind the `tips` event.
// `readSettings` (lib/server/settings.ts) and `selectTips`
// (lib/shared/tips.ts) are imported as they are.
//
// Each case writes a user settings.json and some files under a temp HOME
// (`$HOME` in a case stands for it), then records, as JSON text (null for
// `undefined`): `normalized` (normalizeSpinnerTipsOverride of the settings'
// `spinnerTipsOverride`), `merged` (mergeSpinnerTipsFile of that), `config`
// (the cached `spinnerTipsConfig`, or `{"throws": message}`) and `tips` (what
// a subscriber receives, with the built-in catalog written `"$DEFAULT_TIPS"`
// and recorded once as `defaultTips`). `joins` records the `~/` expansion
// expression for odd homes. The child runs twice, under two different temp
// HOMEs, and both runs must agree byte for byte.
//
// Written to rust/crates/claudius-core/tests/fixtures/spinner_tips_golden.json
// and replayed by crates/claudius-core/tests/spinner_tips_golden.rs.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "crates/claudius-core/tests/fixtures/spinner_tips_golden.json");

// ─────────────────────────────── recording ───────────────────────────────

if (!process.env.SPINNER_TIPS_GOLDEN_CHILD) {
  const runs = [0, 1].map(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "spinner-tips-golden-")));
    try {
      const home = join(root, "home");
      mkdirSync(home);
      const r = spawnSync(
        process.execPath,
        ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url)],
        {
          cwd: home,
          encoding: "utf8",
          maxBuffer: 1 << 26,
          env: {
            PATH: process.env.PATH,
            HOME: home,
            CLAUDE_CONFIG_DIR: join(root, "config"),
            SPINNER_TIPS_GOLDEN_CHILD: root,
          },
        },
      );
      if (r.status !== 0) {
        process.stderr.write(r.stderr);
        process.exit(r.status ?? 1);
      }
      return r.stdout;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  if (runs[0] !== runs[1]) throw new Error("the two recordings differ: something depends on the temp HOME");
  const fixture = JSON.parse(runs[0]);
  writeFileSync(out, `${JSON.stringify(fixture, null, 1)}\n`);
  console.log(`wrote ${out.slice(repo.length + 1)}: ${fixture.cases.length} cases, ${fixture.joins.length} joins`);
  process.exit(0);
}

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

// ──────────────────────── the real source, as text ────────────────────────

const src = readFileSync(join(repo, "lib/server/session.ts"), "utf8");
const once = (needle, what) => {
  const at = src.indexOf(needle);
  if (at < 0 || src.indexOf(needle, at + 1) >= 0) {
    throw new Error(`${what}: ${JSON.stringify(needle)} isn't in session.ts exactly once: update the recorder`);
  }
  return at;
};
const slice = (start, end, what) => {
  const a = once(start, what);
  const b = src.indexOf(end, a);
  if (b < 0) throw new Error(`${what}: no ${JSON.stringify(end)} after it: update the recorder`);
  return src.slice(a, b + end.length);
};
// The module bindings the extracted functions use.
for (const line of [
  /^import \{[^}]*\bpromises as fsp\b[^}]*\} from "node:fs";$/m,
  /^import \{ homedir \} from "node:os";$/m,
  /^import \{ isAbsolute, join as pathJoin \} from "node:path";$/m,
  /^import \{ selectTips\b[^}]*\} from "@\/lib\/shared\/tips";$/m,
  /^import \{[^}]*\breadSettings,[^}]*\} from "\.\/settings";$/m,
]) {
  if (!line.test(src)) throw new Error(`session.ts no longer has ${line}: update the recorder`);
}
const normalizeSrc = slice("export function normalizeSpinnerTipsOverride(", "\n}\n", "normalizeSpinnerTipsOverride");
const maxSrc = src.match(/^const SPINNER_TIPS_FILE_MAX_BYTES = [^;\n]+;$/m)?.[0];
if (!maxSrc) throw new Error("SPINNER_TIPS_FILE_MAX_BYTES moved: update the recorder");
const mergeSrc = slice("async function mergeSpinnerTipsFile(", "\n}\n", "mergeSpinnerTipsFile");
const readSrc = slice('const userSettings = await readSettings("user", this.cwd)', ";\n", "start()'s readSettings");
const configSrc = slice("this.spinnerTipsConfig = {", "\n    };\n", "start()'s spinnerTipsConfig");
// Nothing but comments may sit between the two start() statements.
const gap = src.slice(src.indexOf(readSrc) + readSrc.length, src.indexOf(configSrc));
if (gap.split("\n").some((l) => l.trim() && !l.trim().startsWith("//"))) {
  throw new Error(`start() has code between readSettings and spinnerTipsConfig:\n${gap}`);
}
if (!/^this\.spinnerTipsConfig = \{\n\s+enabled:[\s\S]+override: await mergeSpinnerTipsFile\(\n\s+normalizeSpinnerTipsOverride\(userSettings\.spinnerTipsOverride\),\n\s+\),\n\s+\};\n$/.test(configSrc)) {
  throw new Error(`start()'s spinnerTipsConfig changed shape:\n${configSrc}`);
}
const subscribeSrc = slice("selectTips({\n        spinnerTipsEnabled:", "})", "subscribe()'s selectTips");
if (!src.includes(`tips: ${subscribeSrc},`)) throw new Error("subscribe()'s tips event changed: update the recorder");
// The `~/` expansion inside mergeSpinnerTipsFile, and the absolute-only gate after it.
const expandExpr = mergeSrc.match(/\n {2}const expanded = ([^;\n]+);\n/)?.[1];
if (!expandExpr || !mergeSrc.includes("\n  if (!isAbsolute(expanded)) return rest;\n")) {
  throw new Error("mergeSpinnerTipsFile's `~/` expansion moved: update the recorder");
}

const root = process.env.SPINNER_TIPS_GOLDEN_CHILD;
const home = process.env.HOME;
const modPath = join(root, "spinner-tips-extract.ts");
writeFileSync(
  modPath,
  [
    'import { promises as fsp } from "node:fs";',
    'import { homedir } from "node:os";',
    'import { isAbsolute, join as pathJoin } from "node:path";',
    `import { selectTips, DEFAULT_TIPS } from ${JSON.stringify(pathToFileURL(join(repo, "lib/shared/tips.ts")).href)};`,
    `import { readSettings } from ${JSON.stringify(pathToFileURL(join(repo, "lib/server/settings.ts")).href)};`,
    normalizeSrc,
    maxSrc,
    mergeSrc,
    "export { mergeSpinnerTipsFile, SPINNER_TIPS_FILE_MAX_BYTES };",
    "export async function startBlock(self: any) {",
    "  await (async function (this: any) {",
    `    ${readSrc}`,
    "    this.userSettings = userSettings;",
    `    ${configSrc}`,
    "  }).call(self);",
    "}",
    "export function subscribeTips(self: any) {",
    `  return (function (this: any) { return ${subscribeSrc}; }).call(self);`,
    "}",
    "export function expand(tipsFile: string, home: string) {",
    "  const homedir = () => home;",
    `  return ${expandExpr};`,
    "}",
    "export { isAbsolute, DEFAULT_TIPS };",
    "",
  ].join("\n"),
);
const ex = await import(pathToFileURL(modPath).href);
const MAX = ex.SPINNER_TIPS_FILE_MAX_BYTES;

// ──────────────────────────────── cases ────────────────────────────────

const ch = (...codes) => String.fromCharCode(...codes);
const NBSP = ch(0xa0);
const BOM = ch(0xfeff);
const LS = ch(0x2028);
const PS = ch(0x2029);
const NEL = ch(0x85);
const ZWSP = ch(0x200b);
const IDEO = ch(0x3000);
const MVS = ch(0x180e);

const settingsWith = (override, extra = {}) => JSON.stringify({ ...extra, spinnerTipsOverride: override });
const hex = (s) => Buffer.from(s, "latin1").toString("hex");

const FILE_TIPS = JSON.stringify([
  "from file",
  { id: "f", text: " File tip ", priority: 5 },
  "",
  { text: "" },
  7,
  null,
  { id: 3, text: "num id", cooldownSessions: 2 },
  { id: "inline", text: "collides with an inline id" },
]);
const tipsJson = { path: "tips.json", text: FILE_TIPS };
const INLINE = { tips: [" inline ", { id: "inline", text: "Inline obj", priority: 1 }], label: " Org " };
const withFile = (tipsFile, files = [tipsJson], over = INLINE) => ({
  settings: settingsWith({ ...over, tipsFile }),
  files,
});

const CASES = {
  // settings.json itself
  "no settings file": { settings: null },
  "settings {}": { settings: "{}" },
  "settings invalid JSON": { settings: '{"spinnerTipsOverride": {"tips": ["a"]' },
  "settings null": { settings: "null" },
  "settings array": { settings: '[{"spinnerTipsOverride":{"tips":["a"]}}]' },
  "settings string": { settings: '"spinnerTipsOverride"' },
  "settings number": { settings: "7" },
  "settings invalid UTF-8": {
    settingsHex: hex('{"spinnerTipsOverride":{"excludeDefault":true,"tips":["caf\xff au lait"]}}'),
  },
  "settings 1e400 priority": {
    settings: '{"spinnerTipsOverride":{"excludeDefault":true,"tips":[{"text":"huge","priority":1e400},"small"]}}',
  },
  "settings duplicate keys": {
    settings: '{"spinnerTipsOverride":{"tips":["first"]},"spinnerTipsOverride":{"excludeDefault":true,"tips":["second"]}}',
  },

  // spinnerTipsEnabled
  "enabled false, no override": { settings: '{"spinnerTipsEnabled":false}' },
  "enabled false with override": { settings: settingsWith({ excludeDefault: true, tips: ["x"] }, { spinnerTipsEnabled: false }) },
  "enabled true with override": { settings: settingsWith({ excludeDefault: true, tips: ["x"] }, { spinnerTipsEnabled: true }) },
  "enabled true, no override": { settings: '{"spinnerTipsEnabled":true}' },
  'enabled "false"': { settings: settingsWith({ excludeDefault: true, tips: ["x"] }, { spinnerTipsEnabled: "false" }) },
  "enabled 0": { settings: settingsWith({ excludeDefault: true, tips: ["x"] }, { spinnerTipsEnabled: 0 }) },
  "enabled null": { settings: '{"spinnerTipsEnabled":null}' },
  "enabled false with tipsFile": withFile("~/tips.json", [tipsJson], { excludeDefault: true }),

  // the override's own shape
  "override null": { settings: '{"spinnerTipsOverride":null}' },
  "override []": { settings: '{"spinnerTipsOverride":[]}' },
  "override array of tips": { settings: '{"spinnerTipsOverride":[{"excludeDefault":true,"tips":["a"]}]}' },
  "override string": { settings: '{"spinnerTipsOverride":"tips"}' },
  "override 0": { settings: '{"spinnerTipsOverride":0}' },
  "override 1": { settings: '{"spinnerTipsOverride":1}' },
  "override true": { settings: '{"spinnerTipsOverride":true}' },
  "override {}": { settings: '{"spinnerTipsOverride":{}}' },
  "excludeDefault true, no tips": { settings: settingsWith({ excludeDefault: true }) },
  "excludeDefault true, tips []": { settings: settingsWith({ excludeDefault: true, tips: [] }) },
  'excludeDefault "true"': { settings: settingsWith({ excludeDefault: "true", tips: ["x"] }) },
  "excludeDefault 1": { settings: settingsWith({ excludeDefault: 1, tips: ["x"] }) },
  "excludeDefault false": { settings: settingsWith({ excludeDefault: false, tips: ["x"] }) },
  "excludeDefault missing": { settings: settingsWith({ tips: ["x"] }) },
  "tips a string": { settings: settingsWith({ excludeDefault: true, tips: "a" }) },
  "tips an object": { settings: settingsWith({ excludeDefault: true, tips: { 0: "a", length: 1 } }) },
  "tips null": { settings: settingsWith({ excludeDefault: true, tips: null }) },
  "tips a number": { settings: settingsWith({ excludeDefault: true, tips: 5 }) },

  // entries
  "string entries and JS whitespace": {
    settings: settingsWith({
      excludeDefault: true,
      tips: [
        " one ",
        `${NBSP}nbsp${NBSP}`,
        `${BOM}bom${BOM}`,
        `${LS}ls${PS}`,
        `${NEL}nel${NEL}`,
        "\t tab\n",
        "\r\ncrlf\r\n",
        "\v\fvt ff",
        "",
        "   ",
        `${NBSP}${BOM}${LS}`,
        `${ZWSP}zwsp${ZWSP}`,
        `${IDEO}ideo${IDEO}`,
        `${MVS}mvs${MVS}`,
        NEL,
        "in  ner  spaces kept",
      ],
    }),
  },
  "object entries": {
    settings: settingsWith({
      excludeDefault: true,
      tips: [
        { text: "plain" },
        { id: "a", text: " spaced " },
        { text: "" },
        { text: "  " },
        { text: `${NBSP}${BOM}` },
        { id: "x" },
        { text: 5 },
        { text: null },
        { text: ["arr"] },
        { text: { nested: "x" } },
        { id: 7, text: "num id" },
        { id: null, text: "null id" },
        { id: { a: 1 }, text: "obj id" },
        { id: true, text: "bool id" },
        { id: "  ", text: "blank id" },
        { id: " pad ", text: "padded id" },
        { id: NBSP, text: "nbsp id" },
        { id: `${NEL}`, text: "nel id" },
        { id: "", text: "empty id" },
        null,
        42,
        true,
        false,
        [],
        ["nested"],
        [[{ text: "deep" }]],
        { text: "extra fields", command: "mcp", minSessions: 3, label: "inner", requiresNewUser: true },
        { TEXT: "wrong case" },
      ],
    }),
  },
  "index ids follow the normalized list": {
    settings: settingsWith({ excludeDefault: true, tips: ["", "a", { text: " " }, null, "b", { id: "2", text: "claims custom:2" }, "c"] }),
  },
  "duplicate ids": {
    settings: settingsWith({
      excludeDefault: true,
      tips: [
        { id: "a", text: "first a" },
        { id: "a", text: "second a" },
        { id: " a ", text: "padded a" },
        { id: "1", text: "claims custom:1" },
        "index 4",
        { id: "4", text: "claims custom:4 too late" },
        { id: "custom:a", text: "double prefix" },
      ],
    }),
  },
  priorities: {
    settings:
      '{"spinnerTipsOverride":{"excludeDefault":true,"tips":[' +
      [
        '{"text":"p0","priority":0}',
        '{"text":"pneg","priority":-1}',
        '{"text":"pfrac","priority":1.5}',
        '{"text":"pnone"}',
        '{"text":"pstr","priority":"5"}',
        '{"text":"pnull","priority":null}',
        '{"text":"pbig","priority":1e21}',
        '{"text":"ptiny","priority":1e-7}',
        '{"text":"pnegtiny","priority":-1e-7}',
        '{"text":"p2","priority":2}',
        '{"text":"p2b","priority":2.0}',
        '{"text":"pnegzero","priority":-0}',
        '"bare"',
        '{"text":"pbool","priority":true}',
        '{"text":"pu64","priority":12345678901234567890}',
        '{"text":"phuge","priority":123456789012345678901234567890}',
        '{"text":"pexp","priority":1E2}',
        '{"text":"pmax","priority":1.7976931348623157e308}',
        '{"text":"pmin","priority":5e-324}',
        '{"text":"pneghuge","priority":-1e300}',
        '{"text":"parr","priority":[1]}',
        '{"text":"pobj","priority":{"v":1}}',
        '{"text":"p2c","priority":2}',
      ].join(",") +
      "]}}",
  },
  cooldowns: {
    settings:
      '{"spinnerTipsOverride":{"excludeDefault":true,"tips":[' +
      [
        '{"text":"c3","cooldownSessions":3}',
        '{"text":"cneg","cooldownSessions":-2}',
        '{"text":"cfrac","cooldownSessions":0.5}',
        '{"text":"cstr","cooldownSessions":"3"}',
        '{"text":"cnull","cooldownSessions":null}',
        '{"text":"cexp","cooldownSessions":3e0}',
        '{"text":"both","priority":1,"cooldownSessions":4,"id":"b"}',
        '{"cooldownSessions":1,"priority":9,"id":"order","text":"key order"}',
      ].join(",") +
      "]}}",
  },
  "entry duplicate keys": {
    settings: '{"spinnerTipsOverride":{"excludeDefault":true,"tips":[{"text":"dup","text":" dup2 ","priority":1,"priority":3,"id":"x","id":"y"}]}}',
  },
  "entry __proto__ key": {
    settings: '{"spinnerTipsOverride":{"excludeDefault":true,"tips":[{"text":"proto","__proto__":{"priority":9,"id":"p"}}]}}',
  },
  "stable priority sort with defaults": {
    settings: settingsWith({
      tips: [
        { text: "a", priority: -1 },
        "b",
        { text: "c", priority: 3 },
        { text: "d", priority: 0 },
        { text: "e", priority: 3 },
        "f",
        { text: "g", priority: -1 },
      ],
    }),
  },

  // label
  "label missing": { settings: settingsWith({ excludeDefault: true, tips: ["t"] }) },
  'label ""': { settings: settingsWith({ excludeDefault: true, tips: ["t"], label: "" }) },
  "label spaces": { settings: settingsWith({ excludeDefault: true, tips: ["t"], label: "   " }) },
  "label padded": { settings: settingsWith({ excludeDefault: true, tips: ["t", { text: "u" }], label: " Team " }) },
  "label nbsp/bom": { settings: settingsWith({ excludeDefault: true, tips: ["t"], label: `${NBSP}Team${BOM}` }) },
  "label line separators": { settings: settingsWith({ excludeDefault: true, tips: ["t"], label: `${LS}${PS}` }) },
  "label NEL": { settings: settingsWith({ excludeDefault: true, tips: ["t"], label: NEL }) },
  "label number": { settings: settingsWith({ excludeDefault: true, tips: ["t"], label: 42 }) },
  "label null": { settings: settingsWith({ excludeDefault: true, tips: ["t"], label: null }) },
  "label array": { settings: settingsWith({ excludeDefault: true, tips: ["t"], label: ["Team"] }) },
  "label without tips": { settings: settingsWith({ label: "Team" }) },

  // tipsFile: the value
  "tipsFile missing, file present": { settings: settingsWith(INLINE), files: [tipsJson] },
  'tipsFile ""': withFile(""),
  "tipsFile spaces": withFile("   "),
  "tipsFile number": withFile(42),
  "tipsFile null": withFile(null),
  "tipsFile array": withFile(["~/tips.json"]),
  "tipsFile relative": withFile("tips.json"),
  "tipsFile ./relative": withFile("./tips.json"),
  "tipsFile ~/": withFile("~/tips.json"),
  "tipsFile padded ~/": withFile(" ~/tips.json\n"),
  "tipsFile nbsp/bom padded": withFile(`${NBSP}~/tips.json${BOM}`),
  "tipsFile NEL padded": withFile(`${NEL}~/tips.json`),
  "tipsFile ~ alone": withFile("~", [tipsJson, { path: "~", text: FILE_TIPS }]),
  "tipsFile ~/ alone": withFile("~/"),
  "tipsFile ~user": withFile("~user/tips.json"),
  "tipsFile ~\\": withFile("~\\tips.json"),
  "tipsFile ~/ through a missing dir and ..": withFile("~/nosub/../tips.json"),
  "tipsFile ~/./": withFile("~/./tips.json"),
  "tipsFile ~//": withFile("~//tips.json"),
  "tipsFile ~/ trailing slash": withFile("~/tips.json/"),
  "tipsFile ~/ trailing /.": withFile("~/tips.json/."),
  "tipsFile ~/ climbing past root": withFile("~/../../../../../../../../../../../../tips.json"),
  "tipsFile ~/ nested": withFile("~/a/b/tips.json", [{ path: "a/b/tips.json", text: FILE_TIPS }]),
  "tipsFile absolute": withFile("$HOME/tips.json"),
  "tipsFile absolute through a missing dir and ..": withFile("$HOME/nosub/../tips.json"),
  "tipsFile absolute with //": withFile("$HOME//tips.json"),
  "tipsFile absolute missing": withFile("$HOME/missing.json"),
  "tipsFile with NUL": withFile("$HOME/tips.json\u0000.bak"),
  "tipsFile a directory": withFile("$HOME/dir", [tipsJson, { path: "dir", dir: true }]),
  "tipsFile ~ a directory": withFile("~/dir", [tipsJson, { path: "dir", dir: true }]),
  "tipsFile symlink to a file": withFile("$HOME/link.json", [tipsJson, { path: "link.json", symlink: "$HOME/tips.json" }]),
  "tipsFile ~ symlink to a file": withFile("~/link.json", [tipsJson, { path: "link.json", symlink: "tips.json" }]),
  "tipsFile symlink to a dir": withFile("~/link", [{ path: "dir", dir: true }, { path: "link", symlink: "dir" }]),
  "tipsFile dangling symlink": withFile("~/link.json", [{ path: "link.json", symlink: "gone.json" }]),
  "tipsFile is settings.json": withFile("~/.claude/settings.json", []),
  "tipsFile unreadable": withFile("~/locked.json", [{ path: "locked.json", text: FILE_TIPS, mode: 0 }]),

  // tipsFile: the file
  "file size MAX-1": withFile("~/big.json", [{ path: "big.json", text: '["just under"]', padTo: MAX - 1 }]),
  "file size MAX": withFile("~/big.json", [{ path: "big.json", text: '["exactly max"]', padTo: MAX }]),
  "file size MAX+1": withFile("~/big.json", [{ path: "big.json", text: '["one over"]', padTo: MAX + 1 }]),
  "file empty": withFile("~/f.json", [{ path: "f.json", text: "" }]),
  "file whitespace only": withFile("~/f.json", [{ path: "f.json", text: " \n\t " }]),
  "file invalid JSON": withFile("~/f.json", [{ path: "f.json", text: '["a",' }]),
  "file trailing comma": withFile("~/f.json", [{ path: "f.json", text: '["a",]' }]),
  "file null": withFile("~/f.json", [{ path: "f.json", text: "null" }]),
  "file {}": withFile("~/f.json", [{ path: "f.json", text: "{}" }]),
  "file object with tips": withFile("~/f.json", [{ path: "f.json", text: '{"tips":["a"]}' }]),
  "file string": withFile("~/f.json", [{ path: "f.json", text: '"a"' }]),
  "file number": withFile("~/f.json", [{ path: "f.json", text: "42" }]),
  "file true": withFile("~/f.json", [{ path: "f.json", text: "true" }]),
  "file BOM-prefixed array": withFile("~/f.json", [{ path: "f.json", text: `${BOM}["bom"]` }]),
  "file empty array": withFile("~/f.json", [{ path: "f.json", text: "[]" }]),
  "file junk only": withFile("~/f.json", [
    { path: "f.json", text: '["", " ", null, 1, {}, {"text":""}, {"text":3}, [], ["x"], true, {"id":"x"}]' },
  ]),
  "file CRLF and padding": withFile("~/f.json", [{ path: "f.json", text: '\r\n  [ "crlf" ,\r\n {"text":"\\t obj "} ]  \r\n' }]),
  "file escapes": withFile("~/f.json", [
    { path: "f.json", text: '["\\u00a0esc\\u00a0", "\\ud83d\\ude00 pair", "\\u2028", {"text":"\\ufeff"}, "\\"quoted\\""]' },
  ]),
  "file invalid UTF-8": withFile("~/f.json", [
    { path: "f.json", hex: hex('["caf\xff", "ok", "\xed\xa0\x80", "trunc \xe2\x82", "\xf0\x9f\x98", "\xc0\xaf", "\xf4\x90\x80\x80"]') },
  ]),
  "file number forms": withFile("~/f.json", [
    { path: "f.json", text: '[{"text":"n","priority":1.0,"cooldownSessions":1E1},{"text":"m","priority":-0.0},{"text":"z","priority":0.1e1}]' },
  ]),
  "file lone surrogate": withFile("~/f.json", [{ path: "f.json", text: '["\\ud800 lone", "fine"]' }]),
  "file 1e400 priority": withFile("~/f.json", [{ path: "f.json", text: '[{"text":"inf","priority":1e400}, "fine"]' }]),
  "file nested 100 deep": withFile("~/f.json", [{ path: "f.json", text: `[${"[".repeat(100)}${"]".repeat(100)}, "fine"]` }]),
  "file nested 200 deep": withFile("~/f.json", [{ path: "f.json", text: `[${"[".repeat(200)}${"]".repeat(200)}, "fine"]` }]),
  "file duplicate keys": withFile("~/f.json", [{ path: "f.json", text: '[{"text":"a","text":"b","id":"1","id":"2"}]' }]),
  "file with no inline tips": withFile("~/tips.json", [tipsJson], { label: "Org" }),
  "file empty array, no inline tips": withFile("~/f.json", [{ path: "f.json", text: "[]" }], { label: "Org" }),
  "file junk only, no inline tips": withFile("~/f.json", [{ path: "f.json", text: '["", {"text":" "}, null]' }], {}),
  "file missing, no inline tips": withFile("~/missing.json", [], { excludeDefault: true }),
  "file with inline tips not an array": withFile("~/tips.json", [tipsJson], { tips: "inline" }),
  "file with excludeDefault": withFile("~/tips.json", [tipsJson], { ...INLINE, excludeDefault: true }),
  "file with inline junk only": withFile("~/tips.json", [tipsJson], { tips: ["", null, { text: " " }] }),
  "file ids continue after the inline ones": withFile("~/f.json", [
    { path: "f.json", text: '["file 0", {"id":"0","text":"claims custom:0"}, "file 2"]' },
  ], { excludeDefault: true, tips: ["inline 0", "inline 1"] }),
  "file priorities sort among the inline ones": withFile("~/f.json", [
    { path: "f.json", text: '[{"text":"file hi","priority":10},{"text":"file lo","priority":-10},"file none"]' },
  ], { excludeDefault: true, tips: [{ text: "inline 5", priority: 5 }, "inline none", { text: "inline -5", priority: -5 }] }),
  "file many tips": withFile("~/f.json", [
    { path: "f.json", text: JSON.stringify(Array.from({ length: 60 }, (_, i) => (i % 3 ? `tip ${i}` : { id: `k${i % 7}`, text: `obj ${i}`, priority: i % 5 }))) },
  ], { excludeDefault: true }),
};

// The `~/` expansion against odd home dirs.
const JOIN_HOMES = ["/Users/me", "/Users/me/", "/", "//", "/a/b/..", "/a/./b", "/a//b", "relative", "rel/", "", "."];
const JOIN_FILES = [
  "~/x", "~/", "~/x/", "~/../x", "~/../../../../x", "~/./x", "~/a//b", "~/a/./b/../c", "~/.", "~/..", "~/...",
  "~/.x", "~/x/..", "~/x/../", "~//x", "~/x/./", "~/a/../../b/", "~", "~x", "/abs/x", "/abs/../x", "rel/x", "",
];

// ─────────────────────────────── recording ───────────────────────────────

const fill = (s) => s.split("$HOME").join(home);
const unfill = (s) => s.split(home).join("$HOME");
const enc = (v) => (v === undefined ? null : unfill(JSON.stringify(v)));
// `tips` texts spell the built-in catalog `"$DEFAULT_TIPS"` (it's recorded once, as `defaultTips`).
const defaultTips = JSON.stringify(ex.DEFAULT_TIPS);
const encTips = (v) => enc(v).split(defaultTips.slice(1, -1)).join('"$DEFAULT_TIPS"');
if (JSON.stringify(home) !== `"${home}"`) throw new Error(`HOME needs JSON escapes: ${home}`);

function wipeHome() {
  for (const name of readdirSync(home)) rmSync(join(home, name), { recursive: true, force: true });
}
function writeFiles(c) {
  if (c.settings != null || c.settingsHex != null) {
    mkdirSync(join(home, ".claude"), { recursive: true });
    const body = c.settingsHex != null ? Buffer.from(c.settingsHex, "hex") : fill(c.settings);
    writeFileSync(join(home, ".claude/settings.json"), body);
  }
  for (const f of c.files ?? []) {
    const p = join(home, f.path);
    mkdirSync(dirname(p), { recursive: true });
    if (f.dir) mkdirSync(p);
    else if (f.symlink) symlinkSync(fill(f.symlink), p);
    else {
      let body = f.hex != null ? Buffer.from(f.hex, "hex") : Buffer.from(f.text, "utf8");
      if (f.padTo != null) body = Buffer.concat([body, Buffer.alloc(f.padTo - body.length, " ")]);
      writeFileSync(p, body);
      if (f.mode != null) chmodSync(p, f.mode);
    }
  }
}

const cases = [];
for (const [name, c] of Object.entries(CASES)) {
  wipeHome();
  writeFiles(c);
  const self = { cwd: root };
  let config;
  try {
    await ex.startBlock(self);
    config = enc(self.spinnerTipsConfig);
  } catch (e) {
    config = JSON.stringify({ throws: e instanceof Error ? e.message : String(e) });
  }
  const us = self.userSettings;
  const raw = us == null ? undefined : us.spinnerTipsOverride;
  const normalized = ex.normalizeSpinnerTipsOverride(raw);
  const merged = await ex.mergeSpinnerTipsFile(ex.normalizeSpinnerTipsOverride(raw));
  const tips = "spinnerTipsConfig" in self ? encTips(ex.subscribeTips(self)) : null;
  cases.push({ name, ...c, normalized: enc(normalized), merged: enc(merged), config, tips });
}
wipeHome();

const joins = [];
for (const h of JOIN_HOMES) {
  for (const tipsFile of JOIN_FILES) {
    const expanded = ex.expand(tipsFile, h);
    joins.push({ home: h, tipsFile, expanded, absolute: ex.isAbsolute(expanded) });
  }
}

process.stdout.write(JSON.stringify({ maxBytes: MAX, defaultTips, cases, joins }));
