#!/usr/bin/env node
// Golden fixture for the pure helpers the native composer ports (U07a):
// lib/shared/prompt-history.ts, lib/client/sendBash.ts's commandNeedsSudo,
// lib/client/cleared-draft.ts, lib/client/pending-draft.ts's
// buildDraftFlushRequest, lib/client/send-outcome.ts, lib/shared/
// markdown-list.ts, lib/shared/invisible-unicode.ts, lib/client/key-match.ts,
// and PromptInput.tsx's KEYWORD_HINTS (read from the source: the patterns
// are a private const) and the copy the composer shows.
//
//   node rust/scripts/composer-rules-golden.mjs     (node@22)
//
// Re-runs itself under `--experimental-transform-types` with HOME in a temp
// dir and a resolve hook for the `@/` and extensionless imports, twice; both
// recordings must agree byte for byte.
//
// Every case is `{ args, out }` under its helper's name. `args` and `out`
// are JSON; a number JSON can't hold is `{"$num": "NaN" | "Infinity" |
// "-Infinity"}`, an `undefined` / `null` result `null`. The file is ASCII:
// every other character is a \u escape.
//
// Written to rust/app/crates/claudius-composer/tests/fixtures/composer_rules_golden.json
// and replayed by app/crates/claudius-composer/tests/composer_rules_golden.rs.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "app/crates/claudius-composer/tests/fixtures/composer_rules_golden.json");

if (!process.env.COMPOSER_RULES_GOLDEN_CHILD) {
  const runs = [0, 1].map(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "composer-rules-golden-")));
    try {
      const r = spawnSync(
        process.execPath,
        ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url)],
        {
          cwd: repo,
          encoding: "utf8",
          maxBuffer: 1 << 26,
          env: { PATH: process.env.PATH, HOME: root, TZ: "UTC", COMPOSER_RULES_GOLDEN_CHILD: root },
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

const ROOT_DIR = process.env.COMPOSER_RULES_GOLDEN_CHILD;

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

const lib = (p) => import(join(repo, p));
const ph = await lib("lib/shared/prompt-history.ts");
const sb = await lib("lib/client/sendBash.ts");
const cd = await lib("lib/client/cleared-draft.ts");
const pd = await lib("lib/client/pending-draft.ts");
const so = await lib("lib/client/send-outcome.ts");
const ml = await lib("lib/shared/markdown-list.ts");
const iu = await lib("lib/shared/invisible-unicode.ts");
const km = await lib("lib/client/key-match.ts");

// ------------------------------------------------------------ encoding

const NUMS = { NaN: NaN, Infinity: Infinity, "-Infinity": -Infinity };
function enc(v) {
  if (typeof v === "number") {
    if (Number.isNaN(v)) return { $num: "NaN" };
    if (!Number.isFinite(v)) return { $num: v > 0 ? "Infinity" : "-Infinity" };
    return v;
  }
  if (v === undefined) return null;
  if (Array.isArray(v)) return v.map(enc);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)]));
  return v;
}
function dec(v) {
  if (Array.isArray(v)) return v.map(dec);
  if (v && typeof v === "object") {
    if (typeof v.$num === "string" && Object.keys(v).length === 1) return NUMS[v.$num];
    if (Array.isArray(v.$repeat) && Object.keys(v).length === 1) return v.$repeat[0].repeat(v.$repeat[1]);
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, dec(x)]));
  }
  return v;
}

const fixture = {};
function add(section, args, fn) {
  // The args go through JSON first, as the replay reads them.
  const a = dec(JSON.parse(JSON.stringify(enc(args))));
  (fixture[section] ??= []).push({ args: enc(args), out: enc(fn(...a)) });
}
// `s.repeat(n)`, kept short in the file.
const rep = (s, n) => ({ $repeat: [s, n] });
// A body too long to keep whole: its ends and its UTF-8 size.
const LONG = 2048;
const long = (s) =>
  s.length <= LONG ? s : { $long: { head: s.slice(0, 64), tail: s.slice(-64), utf8: pd.utf8ByteLength(s) } };

const img = (id, ordinal) => ({ id, ordinal, data: "AAAA", mediaType: "image/png" });

// Strings, ASCII-escaped in this file.
const NBSP = "\u00a0";
const LS = "\u2028";
const PS = "\u2029";
const BOM = "\ufeff";
const BULLET = "\u2022";
const ZWSP = "\u200b";
const RLO = "\u202e";
const LRI = "\u2066";
const TAG_A = "\u{e0041}";
const NEL = "\u0085";
const EMOJI = "\u{1f600}";

// ------------------------------------------------------ prompt-history

for (const t of [
  "",
  "plain",
  "  padded  ",
  "look [Image #1]  here [Image #12] ",
  "[Image #] [Image #x] [Image #1x] keep",
  "[Image #3]",
  "[[Image #3]]",
  "a\t\tb",
  "a" + NBSP + NBSP + "b",
  "a   b    c",
  BOM + " x " + LS,
  "[Image #007]tail",
  "x [Image #1][Image #2] y",
]) {
  add("normalizeHistoryText", [t], ph.normalizeHistoryText);
}

const S = (text, at) => (at === undefined ? { text } : { text, at });
for (const [sent, lifted] of [
  [[], []],
  [[S("one", 10), S("two"), S("three", 30)], [{ text: "late", at: 99 }, { text: "mid", at: 20 }]],
  [[S("a"), S(" a "), S("[Image #1]"), S("b"), S("a")], []],
  [[], [{ text: "x", at: 5 }, { text: "y", at: 5 }, { text: "z", at: 1 }]],
  [[S("s", 5)], [{ text: "eq", at: 5 }]],
  [[S("s", 5)], [{ text: "before", at: 4 }, { text: "  ", at: 1 }]],
  [[S("dup", 10)], [{ text: "dup", at: 1 }]],
  [[S("a", null), S("b", 3)], [{ text: "l", at: 2 }]],
  [[S("a", 1)], [{ text: "n", at: NaN }, { text: "m", at: 0 }]],
  [[S("a", NaN)], [{ text: "l", at: 2 }]],
]) {
  add("buildPromptHistory", [sent, lifted], ph.buildPromptHistory);
}

for (const [h, d] of [
  [[], "x"],
  [["a"], ""],
  [["a"], "a"],
  [["a", "b"], "b"],
  [["a", "b"], " b [Image #2]"],
  [["a", "b"], "a"],
  [["a", "b"], ""],
]) {
  add("historyEntryIndex", [h, d], ph.historyEntryIndex);
}

// ------------------------------------------------------------- sendBash

for (const c of [
  "", "   ", "sudo", "sudo ls", "  sudo ls", "sudo-rs x", "sudo.x", "sudoku", "sudo_x", "sudo1",
  "SUDO ls", "echo sudo", "sudo\tls", "sudo" + NBSP, "sudo" + BULLET, "\nsudo", "sudo" + EMOJI,
]) {
  add("commandNeedsSudo", [c], sb.commandNeedsSudo);
}

// ---------------------------------------------------------- cleared-draft

for (const [t, n] of [["", 0], ["x", 0], ["", 1], ["x", 2]]) {
  add("shouldStashClearedDraft", [t, n], cd.shouldStashClearedDraft);
}
for (let bits = 0; bits < 128; bits++) {
  const b = (i) => (bits & (1 << i)) !== 0;
  add(
    "canRestoreClearedDraft",
    [{
      value: b(0) ? "x" : "",
      imageCount: b(1) ? 1 : 0,
      pickerOpen: b(2),
      atActive: b(3),
      emojiActive: b(4),
      browsingHistory: b(5),
      hasStash: !b(6),
    }],
    cd.canRestoreClearedDraft,
  );
}
for (const [c, ims] of [
  [0, []],
  [2, [img("a", 5), img("b", 1)]],
  [7, [img("a", 5)]],
  [7, [img("a", NaN)]],
  [NaN, [img("a", 1)]],
  [-1, []],
]) {
  add("ordinalFloorAfterRestore", [c, ims], cd.ordinalFloorAfterRestore);
}

// ---------------------------------------------------------- pending-draft

const flush = (pending, unloading) => {
  const r = pd.buildDraftFlushRequest(pending, { unloading });
  if (!r) return null;
  return { url: r.url, method: r.init.method, headers: r.init.headers, body: long(r.init.body), keepalive: r.init.keepalive === true };
};
const EMPTY_BODY = JSON.stringify({ text: "", images: [] }).length;
for (const [p, u] of [
  [null, true],
  [{ sessionId: "", text: "x", images: [] }, true],
  [{ sessionId: "s1", text: "hi", images: [img("i", 1)] }, true],
  [{ sessionId: "s1", text: "hi", images: [] }, false],
  [{ sessionId: "s1", text: rep("x", 60 * 1024 - EMPTY_BODY), images: [] }, true],
  [{ sessionId: "s1", text: rep("x", 60 * 1024 - EMPTY_BODY + 1), images: [] }, true],
  // Under the limit in UTF-16 units, over it in UTF-8 bytes.
  [{ sessionId: "s1", text: rep("\u00e9", 40 * 1024), images: [] }, true],
  [{ sessionId: "s1", text: "q\"\\\n\t\u0001" + LS + EMOJI + "\u007f", images: [img("j", 2.5)] }, true],
  [{ sessionId: "a b", text: "", images: [] }, false],
]) {
  add("buildDraftFlushRequest", [p, u], flush);
}

// ---------------------------------------------------------- send-outcome

for (const v of [
  null, true, false, 0, "", "x", [], {},
  { ok: true }, { ok: 0 }, { ok: null }, { queued: true },
  { ok: false }, { ok: false, error: "network" }, { ok: false, error: "" }, { ok: false, error: 3 },
  { ok: false, error: "http" },
]) {
  add("sendOutcome", [v], so.sendOutcome);
}
for (const e of ["network", "unknown", "http", "", "Network"]) {
  for (const p of ["restore", "stash"]) add("sendFailedNotice", [e, p], so.sendFailedNotice);
}
for (const o of [null, "", "a"]) {
  for (const c of [null, "a", "b"]) {
    for (const [t, n] of [["", 0], ["x", 0], ["", 1]]) {
      add(
        "placeFailedSend",
        [{ originSessionId: o, currentSessionId: c, currentText: t, currentImageCount: n }],
        so.placeFailedSend,
      );
    }
  }
}
for (const [cur, sent] of [
  [{ text: "", images: [] }, { text: "sent [Image #1]", images: [img("x", 1)] }],
  [{ text: "draft [Image #4]", images: [img("d", 2)] }, { text: "see [Image #1] and [Image #9]", images: [img("x", 1)] }],
  [{ text: "", images: [img("d", 1)] }, { text: "[Image #1]", images: [img("x", 1)] }],
  [{ text: "draft", images: [] }, { text: "[Image #1]", images: [img("x", 1)] }],
  [{ text: "[Image #99999999999999999999]", images: [] }, { text: "[Image #1]", images: [img("x", 1)] }],
  [{ text: "d", images: [img("d", 0.5)] }, { text: "[Image #1] [Image #01]", images: [img("x", 1)] }],
  [{ text: "d", images: [img("d", NaN)] }, { text: "[Image #1]", images: [img("x", 1)] }],
  [{ text: "d [Image #2]", images: [] }, { text: "no tokens", images: [] }],
]) {
  add("mergeIntoDraft", [cur, sent], so.mergeIntoDraft);
}

// --------------------------------------------------------- markdown-list

const LINES = [
  "", "-", "- ", "-a", "- a", "* a", BULLET + " a", BULLET + "a", "+ a", "\t- a", "   - a",
  "- [ ] task", "- [x] done", "- [X] done", "- [ ]", "- [ ]  ", "- [y] no", "-  [ ] x",
  "1. one", "9. nine", "  12. twelve", "1.", "1. ", "3.   ", "1.x", "1) x", "0. zero", "007. x",
  "99999999999999999999. x", "9007199254740993. x",
  "plain", "x - a", "- a" + LS + "b", "- " + LS + "x", "-  " + LS, "- x" + PS, "- a\rb",
  NBSP + "- a", "-" + NBSP + "a", BOM + "- a", "-" + NEL + "a", "- " + EMOJI,
];
for (const l of LINES) add("computeListContinuation", [l], ml.computeListContinuation);
for (const l of LINES) add("isListLine", [l], ml.isListLine);
for (const t of [
  "", BULLET + " a\n  " + BULLET + " b", "x " + BULLET + " a", BULLET + "a", "x\n\n " + BULLET + " b",
  BULLET + " " + BULLET + " x", "a\r" + BULLET + " b", "a" + LS + BULLET + " b", "a" + PS + " " + BULLET + " b",
  "a\n" + NBSP + BULLET + " b", BULLET + " \n" + BULLET + " ", "  " + BULLET + " " + NBSP + BULLET + " x",
  "a\n" + NEL + BULLET + " b", BOM + BULLET + " b",
]) {
  add("bulletsToMarkdown", [t], ml.bulletsToMarkdown);
}

// ------------------------------------------------------ invisible-unicode

for (const t of [
  "", "plain", "a" + ZWSP + "b" + RLO + "c" + TAG_A, ZWSP.repeat(3), "x" + LRI + "\u2069",
  "\u2060\ufeff\u202a\u202b\u202c\u202d", "\u{e0001}\u{e0020}\u{e007f}\u{e0080}\u{e0000}",
  "\u200c\u200d\u2065\u206a" + EMOJI,
]) {
  add("stripInvisibleUnicode", [t], iu.stripInvisibleUnicode);
}
for (const [c, b, h] of [
  ["x", 1, false], ["  ", 0, false], ["  ", 0, true], [" /cmd", 0, false], ["!ls", 0, false],
  ["hello", 0, false], ["", 0, false], ["", 0, true], ["a/b", 0, false], [NBSP + "/x", 0, true], ["quit", 2, true],
]) {
  add("invisibleStripNeedsReview", [c, b, h], (cleaned, bidi, has) =>
    iu.invisibleStripNeedsReview(cleaned, bidi, { hasAttachments: has }),
  );
}

// -------------------------------------------------------------- key-match

for (const [key, code, alt, letter] of [
  ["c", "KeyC", false, "c"], ["C", "KeyC", false, "c"], ["j", "KeyC", false, "c"],
  ["\u0441", "KeyC", false, "c"], ["\u0441", "KeyC", true, "c"], ["Process", "KeyC", false, "c"],
  ["\u212a", "KeyX", false, "k"], ["\u0130", "KeyI", false, "i"], [EMOJI, "KeyC", false, "c"],
  ["Enter", "Enter", false, "c"], ["", "KeyC", false, "c"], ["\u00e7", "KeyC", false, "c"],
  ["c", "KeyV", true, "c"], ["5", "KeyC", false, "c"], ["\u017f", "KeyS", false, "s"],
]) {
  add("isLetterKey", [key, code, alt, letter], (k, c, a, l) => km.isLetterKey({ key: k, code: c, altKey: a }, l));
}

// -------------------------------------------------- PromptInput's source

const promptInput = readFileSync(join(repo, "components/chat/PromptInput.tsx"), "utf8");
const queueIndicator = readFileSync(join(repo, "components/chat/QueueIndicator.tsx"), "utf8");
const block = (() => {
  const from = promptInput.indexOf("\nconst KEYWORD_HINTS:");
  const to = promptInput.indexOf("\n];", from);
  if (from < 0 || to < 0 || promptInput.indexOf("\nconst KEYWORD_HINTS:", from + 1) >= 0) {
    throw new Error("PromptInput.tsx no longer declares KEYWORD_HINTS once: update the recorder");
  }
  return promptInput.slice(from, to);
})();
const hints = [];
for (const m of block.matchAll(/\{\s*id: "([^"]+)",\s*pattern: \/((?:[^/\\\n]|\\.)+)\/([a-z]*),\s*label: "([^"]*)",(?:\s*ignoredLabel: "([^"]*)",)?\s*\}/g)) {
  hints.push({ id: m[1], source: m[2], flags: m[3], label: m[4], ignoredLabel: m[5] ?? null });
}
if (hints.length !== (block.match(/\bid: "/g) ?? []).length) {
  throw new Error("a KEYWORD_HINTS row didn't parse: update the recorder");
}
const compiled = hints.map((h) => ({ ...h, re: new RegExp(h.source, h.flags) }));
fixture.keywordHints = hints.map(({ id, source, flags, label, ignoredLabel }) => ({ id, source, flags, label, ignoredLabel }));
for (const v of [
  "", "run a Workflow now", "workflows.", "workflowy", "subworkflow", "my_x workflow", "my_workflow",
  "WORKFLOWS", "workflowss", "a goal and a workflow", "my goal", "goals!", "goalie", "_goal", "goal_",
  "work flow", "\u212aworkflow", "workflow\u017f", "go-al", "goal" + EMOJI, EMOJI + "goal", "x\ngoal\n",
  "workflow1", "1workflow", "!workflow",
]) {
  (fixture.keywordHintMatches ??= []).push({ value: v, matched: compiled.filter((h) => h.re.test(v)).map((h) => h.id) });
}

// The copy the composer shows, each found verbatim in its TS source.
const COPY = {
  placeholderStarting: [promptInput, "Starting session\u2026"],
  placeholderPending: [promptInput, "Queue a follow-up \u2014 Shift+Enter for newline"],
  placeholderIdle: [promptInput, "Message Claudius \u2014 / for commands, @ for files/agents, drop or paste images, ! for shell"],
  queueHintEmpty: [promptInput, "Send queues until current response finishes"],
  queueHintQueued: [promptInput, "queued \u00b7 edit above"],
  sendNowHint: [promptInput, "\u00b7 Ctrl+Enter to send now"],
  hiddenChars: [promptInput, "hidden character"],
  hiddenCharsReview: [promptInput, " \u2014 review and press Send again."],
  queueHeader: [queueIndicator, "Queued \u00b7 sends after current response"],
  sendAllNow: [queueIndicator, "Send all now"],
  sdkTurnsSent: [queueIndicator, "sent \u00b7 runs"],
};
fixture.copy = {};
for (const [k, [src, s]] of Object.entries(COPY)) {
  if (!src.includes(s)) throw new Error(`the TS no longer has ${JSON.stringify(s)} (${k}): update the recorder`);
  fixture.copy[k] = s;
}

const ascii = (s) => s.replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
writeFileSync(join(ROOT_DIR, "out.json"), ascii(JSON.stringify(fixture, null, 1)) + "\n");
