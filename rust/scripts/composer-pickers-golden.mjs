#!/usr/bin/env node
// Golden fixture for the native composer's pickers (U07b): the slash
// commands (lib/shared/slash-commands.ts, SlashCommandPicker.tsx's private
// fuzzyScore / toRuns and its filtered list), the @ mentions
// (components/chat/at-mention.ts, AtMentionPicker.tsx's fsListErrorText,
// its request URL and count), the :shortcode: emoji
// (lib/shared/emoji-shortcodes.ts, EmojiShortcodePicker.tsx's count), and
// PromptInput.tsx's picker patterns (the @ token, slashAtStart, the three
// insert splices, the type-the-closing-colon auto-complete), each read from
// the source and checked to still be there.
//
//   node rust/scripts/composer-pickers-golden.mjs     (node@22)
//
// Re-runs itself under `--experimental-transform-types` with HOME in a temp
// dir and a resolve hook for the `@/` and extensionless imports, twice; both
// recordings must agree byte for byte.
//
// Every case is `{ args, out }` under its helper's name; `undefined` and
// `null` results are `null`. The file is ASCII: every other character is a
// \u escape.
//
// Written to rust/app/crates/claudius-composer/tests/fixtures/composer_pickers_golden.json
// and replayed by app/crates/claudius-composer/tests/composer_pickers_golden.rs.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { register, stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "app/crates/claudius-composer/tests/fixtures/composer_pickers_golden.json");

if (!process.env.COMPOSER_PICKERS_GOLDEN_CHILD) {
  const runs = [0, 1].map(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "composer-pickers-golden-")));
    try {
      const r = spawnSync(
        process.execPath,
        ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url)],
        {
          cwd: repo,
          encoding: "utf8",
          maxBuffer: 1 << 26,
          env: { PATH: process.env.PATH, HOME: root, TZ: "UTC", COMPOSER_PICKERS_GOLDEN_CHILD: root },
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

const ROOT_DIR = process.env.COMPOSER_PICKERS_GOLDEN_CHILD;

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
const sc = await lib("lib/shared/slash-commands.ts");
const am = await lib("components/chat/at-mention.ts");
const es = await lib("lib/shared/emoji-shortcodes.ts");

const read = (p) => readFileSync(join(repo, p), "utf8");
const promptInput = read("components/chat/PromptInput.tsx");
const slashPicker = read("components/chat/SlashCommandPicker.tsx");
const atPicker = read("components/chat/AtMentionPicker.tsx");
const emojiPicker = read("components/chat/EmojiShortcodePicker.tsx");
const sdkHook = read("lib/client/useSdkCommands.ts");
const emojiHook = read("lib/client/useEmojiCompletionEnabled.ts");
const slashSrc = read("lib/shared/slash-commands.ts");

function need(src, s, what) {
  if (!src.includes(s)) throw new Error(`the TS no longer has ${JSON.stringify(s)} (${what}): update the recorder`);
}

// A component's private function, by its source (types stripped).
function privateFn(src, head, what) {
  const from = src.indexOf(head);
  const to = src.indexOf("\n}\n", from);
  if (from < 0 || to < 0 || src.indexOf(head, from + 1) >= 0) {
    throw new Error(`${what}: ${JSON.stringify(head)} isn't declared once: update the recorder`);
  }
  const text = stripTypeScriptTypes(src.slice(from, to + 2)).replace(/^export /, "");
  return new Function(`${text}\nreturn ${what};`)();
}
const fuzzyScore = privateFn(slashPicker, "function fuzzyScore(", "fuzzyScore");
const toRuns = privateFn(slashPicker, "function toRuns(", "toRuns");
const fsListErrorText = privateFn(atPicker, "export function fsListErrorText(", "fsListErrorText");

// A regex literal of the source, between `before` and `after` (found once;
// `before` is the nearest one ahead of it).
function literal(src, before, after, what) {
  const end = src.indexOf(after);
  const at = src.lastIndexOf(before, end);
  if (end < 0 || at < 0 || src.indexOf(after, end + 1) >= 0 || src.slice(at, end).includes("\n")) {
    throw new Error(`${what}: ${JSON.stringify(after)} isn't there once: update the recorder`);
  }
  const lit = src.slice(at + before.length, end);
  const m = /^\/(.+)\/([a-z]*)$/.exec(lit);
  if (!m) throw new Error(`${what}: ${JSON.stringify(lit)} isn't a regex literal`);
  return new RegExp(m[1], m[2]);
}
const AT_TOKEN = literal(promptInput, "const atMatch = ", ".exec(before);", "the @ token");
const SLASH_AT_START = literal(promptInput, "setSlashAtStart(slashTok != null && ", ".test(nextValue));", "slashAtStart");
const SLASH_SPLICE = literal(promptInput, "const replaced = before.replace(", ", (_m, pre) => `${pre}/${cmd} `);", "insertSlashCommand");
const AT_SPLICE = literal(promptInput, "const replaced = before.replace(", ", (_m, pre) => `${pre}@${rel} `);", "insertAtMention");
const EMOJI_SPLICE = literal(promptInput, "const replaced = before.replace(", ", (_m, pre) => `${pre}${emoji} `);", "insertEmojiShortcode");
const EMOJI_CLOSE = literal(promptInput, "const shortcodeMatch = ", ".exec(beforeColon);", "the closing-colon auto-complete");

// ------------------------------------------------------------ encoding

function enc(v) {
  if (v === undefined) return null;
  if (Array.isArray(v)) return v.map(enc);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)]));
  return v;
}

const fixture = {};
function add(section, args, fn) {
  const a = JSON.parse(JSON.stringify(enc(args)));
  (fixture[section] ??= []).push({ args: enc(args), out: enc(fn(...a)) });
}

// Strings, ASCII-escaped in this file.
const NBSP = "\u00a0";
const IDEO = "\u3000";
const BOM = "\ufeff";
const NEL = "\u0085";
const LS = "\u2028";
const EMOJI = "\ud83d\ude00";
const E_ACUTE = "\u00e9";
const E_NFD = "e\u0301";
const KELVIN = "\u212a";
const DOTTED_I = "\u0130";
const SIGMA = "\u03a3";

// --------------------------------------------------------- the registry

fixture.registry = sc.SLASH_COMMANDS.map((c) => ({
  id: c.id,
  name: c.name,
  aliases: c.aliases ?? [],
  description: c.description,
  category: c.category,
  handler: c.handler,
  argsHint: c.argsHint ?? null,
  forwardsArgsToSdk: c.forwardsArgsToSdk === true,
}));
fixture.categoryLabels = sc.CATEGORY_LABELS;
{
  const m = /const CATEGORY_ORDER: SlashCategory\[\] = \[([^\]]*)\];/.exec(slashSrc);
  if (!m) throw new Error("CATEGORY_ORDER moved: update the recorder");
  fixture.categoryOrder = [...m[1].matchAll(/"([a-z]+)"/g)].map((x) => x[1]);
}

// ---------------------------------------------------- mergeSuggestions

// Registry rows by id (the registry section checks them whole).
const row = (r) => (r.source === "registry" ? r.id : r);
const merge = (cmds, skills, rich) => sc.mergeSuggestions(cmds ?? undefined, skills ?? undefined, rich ?? undefined).map(row);
for (const [cmds, skills, rich] of [
  [null, null, null],
  [[], [], []],
  [["compact", "clear", "reset", "my-cmd"], [], null],
  [["zeta", "Alpha", "beta", "_under", "10x", "9x", "plugin:tool", "a-b", "a_b", "ab", "\u00e9t\u00e9", "Zed"], [], null],
  [["deploy", "lint"], ["deploy", "pdf"], null],
  [["deploy"], ["deploy"], [{ name: "deploy", description: "  Ship it.  ", argumentHint: " <env> ", aliases: ["ship"], builtin: true }]],
  [[], [], [{ name: "only-rich", description: "From the rich list." }, { name: "dup", description: "first" }, { name: "dup", description: "second" }]],
  [["x"], [], [{ name: "x", description: "   " }, { name: "y", argumentHint: "   ", aliases: [] }, null, { name: 7 }, { description: "nameless" }, { name: "z", builtin: 1 }, { name: "w", builtin: false }]],
  [["review", "code-review", "help"], ["review"], [{ name: "review", description: "SDK review", builtin: true }]],
  [["mcp__srv__tool", "mcp__srv__other"], [], [{ name: "mcp__srv__tool", description: "An MCP prompt.", argumentHint: "[q]" }]],
  [["dup", "dup"], ["skill-a"], [{ name: "skill-a" }]],
]) {
  add("mergeSuggestions", [cmds, skills, rich], merge);
}

// --------------------------------------------------- tokens and splices

const BEFORES = [
  "", "/", "/co", "a /co", "a/co", "https://x", " /", "x\n/re", "/a/b", "x /a b", "x /a ", "/" + EMOJI, "\t/x",
  NBSP + "/x", IDEO + "/x", BOM + "/x", NEL + "/x", LS + "/x", "@", "@src", "a @src/lib", "a@b", "@a@b", "x @", "x @ ",
  "e@mail @x", "@" + EMOJI, ":", ":smi", "a :smi", "a:smi", "10:30", "::smi", ":sm-i_+1", ":sm.i", ":SMI", "x :" + E_ACUTE,
  ":heart:", "x\n:fi", NBSP + ":x", NEL + ":x", "/x @y", "@x /y", ":x /y",
];
for (const b of BEFORES) {
  add("slashTokenBeforeCaret", [b], sc.slashTokenBeforeCaret);
  add("atToken", [b], (s) => {
    const m = AT_TOKEN.exec(s);
    return m ? m[2] : null;
  });
  add("parseEmojiTrigger", [b], es.parseEmojiTrigger);
}
for (const v of ["", "/", "/co", "  /co", "\n/co", "/co x", "/co\n", "x /co", NBSP + "/co", NEL + "/co", "/" + EMOJI, "//", "/a/b"]) {
  add("slashAtStart", [v], (s) => SLASH_AT_START.test(s));
}

// What a pick does to `value` with the caret at `caret`: the new text and
// where the caret goes (`replaced.length`), in UTF-16 units.
function splice(re, ins) {
  return (value, caret, name) => {
    const before = value.slice(0, caret);
    const after = value.slice(caret);
    const replaced = before.replace(re, (_m, pre) => `${pre}${ins(name)} `);
    return { next: replaced + after, caret: replaced.length };
  };
}
const SPLICE_CASES = [
  ["/co", 3], ["fix /co please", 7], ["fix /co please", 14], ["/co", 1], ["a\n/re", 5], ["x/co", 4], ["", 0],
  ["see @src", 8], ["see @src and", 8], ["a@b", 3], ["@a@b", 4], ["hi :smi", 7], ["hi :smi there", 7], ["10:30", 5],
  [EMOJI + " /co", 6], [E_ACUTE + " @x", 4], ["/co @x :y", 3], ["/co @x :y", 6], ["/co @x :y", 9],
];
for (const [v, c] of SPLICE_CASES) {
  add("insertSlashCommand", [v, c, "compact"], splice(SLASH_SPLICE, (cmd) => `/${cmd}`));
  add("insertAtMention", [v, c, "src/lib.rs"], splice(AT_SPLICE, (rel) => `@${rel}`));
  add("insertAtMention", [v, c, "agent-reviewer"], splice(AT_SPLICE, (rel) => `@${rel}`));
  for (const name of ["smile", "love", "nope"]) {
    add("insertEmojiShortcode", [v, c, name], (value, caret, n) => {
      const emoji = es.lookupEmojiShortcode(n);
      if (!emoji) return null;
      return splice(EMOJI_SPLICE, () => emoji)(value, caret, n);
    });
  }
}

// The onChange auto-complete (PromptInput.tsx:2197): `prev` -> `next` with
// the caret at `caret`. `null`: not taken (the plain edit path runs).
need(promptInput, "if (emojiCompletionEnabled && next.length === value.length + 1 && next[caret - 1] === \":\") {", "the closing-colon guard");
need(promptInput, "const tokenStart = shortcodeMatch.index + shortcodeMatch[1].length;", "the closing-colon token start");
need(promptInput, "const replaced = next.slice(0, tokenStart) + emoji + next.slice(caret);", "the closing-colon splice");
need(promptInput, "const pos = tokenStart + emoji.length;", "the closing-colon caret");
function closeColon(value, next, caret) {
  if (!(next.length === value.length + 1 && next[caret - 1] === ":")) return null;
  const beforeColon = next.slice(0, caret - 1);
  const m = EMOJI_CLOSE.exec(beforeColon);
  const emoji = m ? es.lookupEmojiShortcode(m[2]) : undefined;
  if (!(m && emoji)) return null;
  const tokenStart = m.index + m[1].length;
  return { next: next.slice(0, tokenStart) + emoji + next.slice(caret), caret: tokenStart + emoji.length };
}
for (const [prev, next, caret] of [
  [":heart", ":heart:", 7], ["hi :heart", "hi :heart:", 10], ["hi :heart there", "hi :heart: there", 10], [":HEART", ":HEART:", 7],
  [":love", ":love:", 6], [":nope", ":nope:", 6], [":", "::", 2], ["a:heart", "a:heart:", 8], [":heart", ":heart::", 8],
  [":hea", ":hea:", 5], [":+1", ":+1:", 4], [":100", ":100:", 5], ["x\n:fire", "x\n:fire:", 8], [":heart", "x:heart", 1],
  [":heart", ":heart:x", 7], [EMOJI + " :fire", EMOJI + " :fire:", 9], [":fire", ":fire:", 5], [":smile", ":smile:", 7],
  [NBSP + ":fire", NBSP + ":fire:", 7], [NEL + ":fire", NEL + ":fire:", 7],
]) {
  add("emojiCompleteOnClose", [prev, next, caret], closeColon);
}

// ---------------------------------------------------- the slash ranking

const FILTERS = [
  "", "c", "co", "com", "compact", "cmp", "clr", "re", "reset", "rev", "mo", "model", "zz", "x", "fork", "branch",
  "skill", "doc", "free", "ui", "plugin", "tool", "ctx", "usage", "a", "e", "s", "-", "_", "1", ":", EMOJI, E_ACUTE,
  "mcp", "srv", "deploy", "ship",
];
for (const f of FILTERS) {
  for (const h of ["compact", "Compact", "COMPACT", "reload-plugins", "a", "", "plugin:tool", EMOJI + "x", "x" + EMOJI, "\ud83d\ude01x\ud83d\ude00", E_NFD, "abc".repeat(30)]) {
    add("fuzzyScore", [f, h], fuzzyScore);
  }
}
for (const [f, d] of [
  ["co", "Compact the conversation to free up context."], ["fr", "Compact the conversation to free up context."],
  ["o", "Compact the conversation"], ["ree", "free"], ["", "anything"], ["CO", "compact"], ["k", KELVIN + "elvin"],
  ["i", DOTTED_I + "stanbul"], [E_ACUTE, "caf" + E_ACUTE + " au lait"], ["lait", "caf" + E_ACUTE + "lait"], ["x", ""],
  ["toggle", "Toggle fast mode, or open the picker with no args."], ["v2", "see v2.1"], ["2", "v2"], ["-", "a-b"],
  ["\u03c3", SIGMA + "x"], ["as", "A" + SIGMA],
]) {
  add("descriptionWordPrefixScore", [f, d], sc.descriptionWordPrefixScore);
}
for (const [f, n] of [
  ["co", "compact"], ["cmp", "compact"], ["ct", "compact"], ["zz", "compact"], ["", "compact"], ["CO", "Compact"],
  ["co", "COMPACT"], ["rl", "reload-plugins"], ["x", EMOJI + "x"], [EMOJI, "a" + EMOJI + "b"], ["e", E_NFD + "x"],
  ["\u0301", E_NFD], ["i", DOTTED_I + "x"], ["a", "banana"], ["an", "banana"], ["nn", "banana"], ["k", KELVIN],
  ["tool", "plugin:tool"], ["pt", "plugin:tool"],
]) {
  add("fuzzySlashMatchIndices", [f, n], sc.fuzzySlashMatchIndices);
}
for (const ix of [[], [0], [0, 1, 2], [0, 2, 3, 5], [1, 2, 4], [5]]) {
  add("toRuns", [ix], toRuns);
}
// HighlightedCommandName's pieces: `[text, bold]`.
function highlight(filter, name) {
  const indices = sc.fuzzySlashMatchIndices(filter, name);
  if (!indices || indices.length === 0) return [[name, false]];
  const chars = Array.from(name);
  const pieces = [];
  let cursor = 0;
  for (const [start, end] of toRuns(indices)) {
    if (start > cursor) pieces.push([chars.slice(cursor, start).join(""), false]);
    pieces.push([chars.slice(start, end).join(""), true]);
    cursor = end;
  }
  if (cursor < chars.length) pieces.push([chars.slice(cursor).join(""), false]);
  return pieces;
}
need(slashPicker, "if (!indices || indices.length === 0) return <>{name}</>;", "HighlightedCommandName's fallback");
need(slashPicker, "const chars = Array.from(name);", "HighlightedCommandName's split");
for (const [f, n] of [
  ["co", "compact"], ["cmp", "compact"], ["", "compact"], ["zz", "compact"], ["rl", "reload-plugins"], ["e", E_NFD + "x"],
  ["i", DOTTED_I + "stanbul"], ["st", DOTTED_I + "stanbul"], ["x", EMOJI + "x"], ["ab", "a" + EMOJI + "b"], ["Co", "COMPACT"],
]) {
  add("highlight", [f, n], highlight);
}
for (const [f, n, al] of [
  ["co", "compact", []], ["", "compact", []], ["cm", "compact", []], ["re", "clear", ["reset", "new"]], ["new", "clear", ["reset", "new"]],
  ["tool", "plugin:tool", []], ["plugin", "plugin:tool", []], ["t", "a:b:tool", []], ["co", "Compact", []], ["Co", "Compact", []],
  ["x", "plugin:", []], [":", "a:b", []],
]) {
  add("isConfidentSlashMatch", [f, n, al], (filter, name, aliases) => sc.isConfidentSlashMatch({ name, aliases }, filter));
}

// The picker's `filtered` (SlashCommandPicker.tsx:125): the slash query to
// the lowercased filter, then the ranked names (before the 16-row cap).
need(slashPicker, "const filter = value.startsWith(\"/\") ? value.slice(1).trim().toLowerCase() : \"\";", "the picker's filter");
need(slashPicker, "fuzzyScore(filter, cmd.name),", "the name score");
need(slashPicker, "...((cmd.aliases ?? []).map((a) => fuzzyScore(filter, a))),", "the alias scores");
need(slashPicker, "descriptionWordPrefixScore(filter, cmd.description),", "the description score");
need(slashPicker, "if (score > 0) scored.push({ cmd, score });", "the score floor");
need(slashPicker, "scored.sort((a, b) => b.score - a.score);", "the ranking");
need(slashPicker, "const visible = filtered.slice(0, 16);", "the row cap");
function ranked(query, cmds, skills, rich) {
  const all = sc.mergeSuggestions(cmds, skills, rich);
  const value = `/${query}`;
  const filter = value.startsWith("/") ? value.slice(1).trim().toLowerCase() : "";
  if (!filter) return { filter, names: all.map((c) => c.name) };
  const scored = [];
  for (const cmd of all) {
    const score = Math.max(
      fuzzyScore(filter, cmd.name),
      ...(cmd.aliases ?? []).map((a) => fuzzyScore(filter, a)),
      sc.descriptionWordPrefixScore(filter, cmd.description),
    );
    if (score > 0) scored.push({ cmd, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return { filter, names: scored.map((s) => s.cmd.name) };
}
const SDK = ["deploy", "my-review", "plugin:tool", "Upper"];
const RICH = [{ name: "deploy", description: "Ship the build to an environment.", aliases: ["ship"] }];
for (const q of [...FILTERS, "CO", "Re", "Upper", "upper", "MY"]) {
  add("ranked", [q, SDK, ["deploy"], RICH], ranked);
}

// ------------------------------------------------------------ @ mentions

for (const q of ["", "src", "agent", "agent-", "agent-rev", "agent-agent-", "Agent-x", "./src", ".", "./", "././a", "../x"]) {
  add("parseAtMentionQuery", [q], am.parseAtMentionQuery);
  add("normalizeFileMentionQuery", [q], am.normalizeFileMentionQuery);
}
add("itemToken", [{ kind: "file", relPath: "src/lib.rs", type: "file" }], am.itemToken);
add("itemToken", [{ kind: "file", relPath: "src", type: "dir" }], am.itemToken);
add("itemToken", [{ kind: "agent", name: "reviewer" }], am.itemToken);
const AGENTS = [
  { name: "reviewer", description: "Reviews diffs.", model: "sonnet" },
  { name: "Explore", description: "Read-only search agent." },
  { name: "general-purpose", description: "General agent." },
  { name: "_internal" },
  { name: "b-agent", description: "Writes DOCS" },
  { name: "a_agent", model: "haiku" },
  { name: "Zed" },
  { name: "\u00e9clair", description: "caf" + E_ACUTE },
  { name: "10x" },
  { name: "9x" },
];
for (const f of ["", "re", "RE", "agent", "docs", "search", "x", "zz", E_ACUTE, "-", "_"]) {
  add("filterAgents", [AGENTS, f], am.filterAgents);
}
add("filterAgents", [Array.from({ length: 40 }, (_, i) => ({ name: `agent${String(i).padStart(2, "0")}` })), ""], am.filterAgents);
for (const [status, body] of [
  [403, { error: "Search failed: permission denied" }], [403, {}], [500, { error: "boom" }], [500, {}], [503, { error: null }],
  [400, { error: "unknown cwd" }], [404, {}], [200, {}], [499, { error: "x" }], [502, { error: 7 }], [500, { error: "" }],
]) {
  add("fsListErrorText", [status, body], fsListErrorText);
}
need(atPicker, "const params = new URLSearchParams({ q: normalizeFileMentionQuery(query), limit: \"50\" });", "the search params");
need(atPicker, "if (cwd) params.set(\"cwd\", cwd);", "the search cwd");
need(atPicker, "fetch(`/api/fs/list?${params}`", "the search URL");
for (const [q, cwd] of [
  ["", null], ["src", "/w/p"], ["./src", "/w/p"], ["a b", "/w/my project"], ["a+b&c=d", ""], ["\u00e9t\u00e9/" + EMOJI, "/w/" + E_ACUTE],
  ["*-._~!'()", "/x"], ["%41", null], ["#frag?q", "/a#b"],
]) {
  add("fsListUrl", [q, cwd], (query, c) => {
    const params = new URLSearchParams({ q: am.normalizeFileMentionQuery(query), limit: "50" });
    if (c) params.set("cwd", c);
    return `/api/fs/list?${params}`;
  });
}
need(atPicker, "fetch(`/api/sessions/${encodeURIComponent(sessionId)}/agents`", "the agents URL");
need(sdkHook, "fetch(`/api/sessions/${encodeURIComponent(sessionId)}/commands`)", "the commands URL");
for (const id of ["s1", "a b", "x/y", "\u00e9"]) {
  add("agentsUrl", [id], (s) => `/api/sessions/${encodeURIComponent(s)}/agents`);
  add("commandsUrl", [id], (s) => `/api/sessions/${encodeURIComponent(s)}/commands`);
}
need(atPicker, ": `${visible.length} ${agentMode ? \"agent\" : \"file\"}${visible.length === 1 ? \"\" : \"s\"}`;", "the count label");
for (const [loading, agentMode, n] of [[true, false, 0], [true, true, 3], [false, false, 0], [false, false, 1], [false, false, 2], [false, true, 1], [false, true, 30]]) {
  add("atCountLabel", [loading, agentMode, n], (l, a, k) => (l ? "loading\u2026" : `${k} ${a ? "agent" : "file"}${k === 1 ? "" : "s"}`));
}

// ---------------------------------------------------------------- emoji

fixture.emojiShortcodes = Object.entries(es.EMOJI_SHORTCODES);
fixture.emojiAliases = Object.entries(es.EMOJI_ALIASES);
for (const q of ["", "smi", "SMI", "s", "heart", "he", "love", "lo", "+", "+1", "-1", "1", "100", "_", "face", "x", "zzz", "thumbs", "fire", "e", "a"]) {
  add("filterEmojiShortcodes", [q], es.filterEmojiShortcodes);
}
for (const n of ["smile", "SMILE", "heart", "love", "LOVE", "satisfied", "collision", "+1", "-1", "100", "nope", "", "telephone", "thumbsup"]) {
  add("lookupEmojiShortcode", [n], es.lookupEmojiShortcode);
}
// Plain-object lookups that hit Object.prototype: the TS "finds" a
// function / an object (the Rust doesn't).
fixture.emojiPrototypeQuirk = ["constructor", "__proto__", "CONSTRUCTOR"].map((n) => ({ name: n, type: typeof es.lookupEmojiShortcode(n) }));
need(emojiPicker, "{visible.length} match{visible.length === 1 ? \"\" : \"es\"}", "the emoji count");
for (const n of [0, 1, 2, 30]) add("emojiCountLabel", [n], (k) => `${k} match${k === 1 ? "" : "es"}`);

// useEmojiCompletionEnabled: an OK body to what it sets (`null`: it throws,
// the setting stays).
need(emojiHook, "setEnabled(data.settings.emojiCompletionEnabled !== false);", "the setting read");
need(emojiHook, "fetch(`/api/settings?scope=user&cwd=${encodeURIComponent(cwd)}`", "the settings URL");
for (const body of [
  { settings: {} }, { settings: { emojiCompletionEnabled: false } }, { settings: { emojiCompletionEnabled: true } },
  { settings: { emojiCompletionEnabled: 0 } }, { settings: { emojiCompletionEnabled: null } }, { settings: { emojiCompletionEnabled: "false" } },
  { settings: null }, {}, null, 5, "x", [], { settings: 5 }, { settings: [] }, { settings: "s" },
]) {
  add("emojiEnabledOf", [body], (data) => {
    try {
      return data.settings.emojiCompletionEnabled !== false;
    } catch {
      return null;
    }
  });
}
for (const cwd of ["/w/p", "", "/w/my project", "/w/" + E_ACUTE]) {
  add("settingsUrl", [cwd], (c) => `/api/settings?scope=user&cwd=${encodeURIComponent(c)}`);
}

// useSdkCommands / the agents fetch: what an OK body leaves (names only).
need(sdkHook, "list: d && Array.isArray(d.commands) ? d.commands : undefined,", "the commands read");
need(atPicker, "setAgentState({ for: sessionId, agents: d && Array.isArray(d.agents) ? d.agents : [] });", "the agents read");
for (const body of [{ commands: [{ name: "a" }, { name: "b", description: "B" }] }, { commands: [] }, {}, null, { commands: "x" }, { commands: {} }]) {
  add("sdkCommandsOf", [body], (d) => (d && Array.isArray(d.commands) ? d.commands.map((c) => c.name) : null));
}
for (const body of [{ agents: [{ name: "a" }] }, { agents: [] }, {}, null, { agents: "x" }]) {
  add("agentsOf", [body], (d) => (d && Array.isArray(d.agents) ? d.agents.map((a) => a.name) : []));
}

// ----------------------------------------------------------------- copy

const COPY = {
  slashHeader: [slashPicker, "Slash commands \u00b7 Tab to insert"],
  builtinBadge: [slashPicker, "built-in"],
  badgeApp: [slashPicker, "native: { label: \"app\""],
  badgeSdk: [slashPicker, "sdk: { label: \"sdk\""],
  badgeExternal: [slashPicker, "external: { label: \"external\""],
  pointer: [slashPicker, "{i === hi ? \"\u276f\" : \"\"}"],
  atHeader: [atPicker, "@-mention \u00b7 Tab to insert"],
  atLoading: [atPicker, "? \"loading\u2026\""],
  emojiHeader: [emojiPicker, "Emoji \u00b7 Tab to insert"],
  skillFallback: [slashSrc, "\"Skill provided by the SDK.\""],
  sdkFallback: [slashSrc, "\"Provided by the SDK.\""],
};
fixture.copy = {};
for (const [k, [src, s]] of Object.entries(COPY)) {
  need(src, s, k);
  fixture.copy[k] = s;
}

const ascii = (s) => s.replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
writeFileSync(join(ROOT_DIR, "out.json"), ascii(JSON.stringify(fixture, null, 1)) + "\n");
