#!/usr/bin/env node
// Golden fixture for V8's `JSON.parse` SyntaxError messages, which TS route
// handlers echo when they catch `await req.json()` (`rewind`'s 503, the
// `settings/import` 400s) and which `sanitizeJsonParseReason` reduces.
//
//   node rust/scripts/json-parse-golden.mjs        (node@22: the V8 Next runs on)
//
// It records the real `JSON.parse` over hand-picked inputs for every V8
// template and boundary (the 21-unit context cut-off, the +-10-unit window,
// positions near both ends, line/column after LF / CRLF / lone CR, every
// escape and control character, astral characters around the window cuts,
// BOM and the whitespace JSON doesn't allow), seeded fuzz (mulberry32
// mutations of valid documents, and token soups), valid documents, and
// `new Response(bytes).json()` over raw bodies (BOM stripping and the UTF-8
// decoder's U+FFFD). Written to
// rust/crates/claudius-agent/tests/fixtures/json_parse_golden.json and
// replayed by crates/claudius-agent/tests/json_parse_golden.rs.
//
// A Rust `String` can't hold a lone surrogate, so every recorded string is
// stored as `rustable` (lone surrogates removed) plus, when it had any, its
// exact UTF-16 code units. Inputs with a raw lone surrogate go to `jsOnly`
// (code units only); the replay feeds them to the UTF-16 entry point.
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../crates/claudius-agent/tests/fixtures/json_parse_golden.json");

const U = (cp) => String.fromCodePoint(cp);
const EMOJI = U(0x1f600); // two UTF-16 units
const NBSP = U(0xa0);
const BOM = U(0xfeff);

function message(text) {
  try {
    JSON.parse(text);
    return null;
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
    return e.message;
  }
}

const units = (s) => Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));

/** `s` without its lone surrogates, and how many there were. */
function rustable(s) {
  let lone = 0;
  let text = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        text += s[i] + s[i + 1];
        i++;
      } else lone++;
    } else if (c >= 0xdc00 && c <= 0xdfff) lone++;
    else text += s[i];
  }
  return { text, lone };
}

/** The value as it leaves the process in UTF-8: every string and key well-formed. */
function wellFormed(v) {
  if (typeof v === "string") return v.toWellFormed();
  if (Array.isArray(v)) return v.map(wellFormed);
  // `fromEntries` defines own properties, so a `__proto__` key stays a key.
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k.toWellFormed(), wellFormed(x)]));
  return v;
}

function depth(text) {
  let d = 0;
  let max = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "[" || c === "{") max = Math.max(max, ++d);
    else if (c === "]" || c === "}") d--;
  }
  return max;
}

/** One recorded outcome: the message (or `null`), and the value for valid text. */
function outcome(text) {
  const m = message(text);
  const rec = {};
  if (m === null) {
    rec.message = null;
    // Past serde_json's 127 levels Rust has no value to compare (a documented
    // gap); record the depth instead.
    const d = depth(text);
    if (d >= 128) rec.depth = d;
    else rec.value = JSON.stringify(wellFormed(JSON.parse(text)));
  } else {
    const r = rustable(m);
    rec.message = r.text;
    if (r.lone) {
      rec.lone = r.lone;
      rec.messageUnits = units(m);
    }
  }
  return rec;
}

// ---- hand-picked inputs ------------------------------------------------------

const cases = []; // [group, input]
const add = (group, ...inputs) => {
  for (const s of inputs) cases.push([group, s]);
};

const seq = (n, alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz") =>
  Array.from({ length: n }, (_, i) => alphabet[i % alphabet.length]).join("");
/** A valid prefix of exactly `p` units that ends where a value is expected. */
function valuePrefix(p) {
  if (p === 0) return "";
  const pairs = Math.floor((p - 1) / 2);
  return "[" + ((p - 1) % 2 ? "[" : "") + Array.from({ length: pairs }, (_, i) => `${i % 10},`).join("");
}
/** A text of `len` units with the illegal token `tok` (one unit) at `p`. */
const tokenAt = (len, p, tok = "x") => valuePrefix(p) + tok + seq(len - p - 1);

add("eos", "", " ", "\t\n\r ", "[", "[ ", "{\"a\":", "{\"a\": ", "[1,", "[1, ", "[[[", "tru", "t", "fals", "f", "nu", "n");
add("eos", '"\\', '["\\', '{"a":"\\', "[".repeat(3000), '{"a":'.repeat(600), "[{\"a\":[");

// The short / start / surround / end forms around the 21-unit cut-off and the
// 10-unit window.
for (let len = 1; len <= 26; len++) for (let p = 0; p < len; p++) add("token-window", tokenAt(len, p));
for (const len of [30, 31, 40, 63, 64, 100, 257]) {
  const ps = [0, 1, 2, 8, 9, 10, 11, 12, len >> 1, len - 12, len - 11, len - 10, len - 9, len - 2, len - 1];
  for (const p of new Set(ps)) add("token-window", tokenAt(len, p));
}

// Each kind of illegal token at a value position, short and long.
const TOKEN_CHARS = [
  "}", "]", ":", ",", "x", "'", "/", "\\", "#", "+", ".", "<", "=", "?", "@", "`", "|", "~", "T", "N", "I", "u",
  "\u000b", "\u000c", "\u007f", "\u0080", "\u0085", NBSP, "\u00e9", "\u00ff", "\u0100", "\u1680", "\u2028",
  "\u2029", "\u200b", "\u3000", BOM, "\u20ac", "\ufffd", "\uffff",
];
for (let c = 0; c < 0x20; c++) if (![0x09, 0x0a, 0x0d].includes(c)) TOKEN_CHARS.push(String.fromCharCode(c));
for (const t of TOKEN_CHARS) {
  add("token-char", t, `[${t}]`, `{"a":${t}}`, tokenAt(30, 15, t), tokenAt(30, 3, t), tokenAt(30, 27, t));
}
add("token-char", "{\"a\":}", "[1,]", "[,]", "[,1]", "{\"a\":1,\"b\":]", "[:]", ":", ",", "}", "]", "[}", "{\"a\":[}");

// Unexpected number / string (a digit or quote where a literal or a lone 0 ended).
add("number-token", "01", "-01", "00", "[00]", "{\"a\":01}", "0123", "-00", "nul1", "tr0", "fa1se", "t-", "n9", "nu-1");
add("string-token", 'tr"', 'n"', 'fa"x"', '[t""]', 'nul"l"');
add("literal", "trux", "tr ue", "nulL", "True", "FALSE", "nil", "tru\u00e9", "nul" + EMOJI, "t\r\n", "f\t", "trues", "nullx");
add("literal", "[tru]", "[fals,1]", "{\"a\":nu}", "true false", "nul\u0000");

// Objects.
add("object", "{", "{ ", "{\n", "{,", "{,}", "{1:2}", "{'a':1}", "{a:1}", "{]", "{" + NBSP + "}", "{\u2028}", "{" + BOM + "}");
add("object", '{"a"', '{"a" 1', '{"a",', '{"a"}', '{"a"\n=1}', '{"a" "b"}', '{"a"::1}', '{"a";1}', '{"a" ');
add("object", '{"a":1', '{"a":1 ', '{"a":1]', '{"a":1 "b":2}', '{"a":{}', '{"a":1;"b":2}', '{"a":1,"b":2', '{"a":[1,2]');
add("object", '{"a":1,', '{"a":1,}', "{\"a\":1,'b':2}", '{"a":1, b:2}', '{"a":1,,"b":2}', '{"a":1, }', '{"a":1,\n}');
// Arrays.
add("array", "[1", "[1 ", "[1 2]", "[1}", "[1:", '["a""b"]', "[[]", "[[1]", "[1,2", "[1,[2,3]", "[{}", "[1;2]", "[1\n\n");

// Strings.
add("unterminated", '"', '"abc', '["a', '{"a', '{"a":"b', '"\\u0041', '"\\"', '"\\\\', '"a\\"b', '[' + '"' + seq(40));
for (let c = 0; c < 0x20; c++) {
  const ch = String.fromCharCode(c);
  add("control", `"${ch}"`, `"ab${ch}cd"`, `["${seq(30)}${ch}"]`, `{"${ch}":1}`, `{"a":"b${ch}"}`);
}
add("control", '"\u007f"', '"\u0080\u009f"');

// Escapes: every Latin-1 character after a backslash, and some beyond.
for (let c = 0; c <= 0xff; c++) add("escape", `"\\${String.fromCharCode(c)}"`);
for (const ch of ["\u0100", "\u20ac", "\u2028", BOM, "\uffff", EMOJI]) add("escape", `"\\${ch}"`, `["${seq(25)}\\${ch}x"]`);
add("escape", '"\\', '"\\\\\\', '{"\\x":1}', '{"a\\q":1}', '"\\U0041"', '"\\x41"', '"\\0"', '"\\\'"', '"\\a"');

// \u escapes: a bad digit at each position, and the end of input.
for (const bad of ["g", "G", "x", '"', " ", "-", "\u00e9", "\u0660", EMOJI]) {
  for (let k = 0; k < 4; k++) add("unicode-escape", `"\\u${"0041".slice(0, k)}${bad}${"0041".slice(k + 1)}"`);
}
for (let k = 0; k <= 4; k++) add("unicode-escape", `"\\u${"00e9".slice(0, k)}`);
add("unicode-escape", '"\\u"', '"\\u{41}"', '{"\\u12":1}', '{"\\u003x":1}', '{"1\\u003":1}', '{"\\u0030":1, "\\u00g0":2}');

// Numbers.
add("number", "1.", "1.x", "-1.", "0.", "0.e1", "[1.]", "1..2", "1.]", "-0.", "1.e5", "1.-");
add("number", "1e", "1E", "1e+", "1e-", "1ex", "1.5e", "-1e", "0e", "0E+", "[1e]", "1e+-1", "1e.5", "1ee5", "1e\u0661");
add("number", "-", "-x", "--1", "-.5", "- 1", "[-]", '{"a":-}', "-\u00e9", "-" + EMOJI, "-Infinity", "-NaN", "-e");
add("number", "+1", ".5", "0x10", "1_000", "0b1", "1/2", "1e5.5");

// Garbage after the value.
add("after-json", "1 2", "{}x", "[]]", '"a""b"', "null null", "true1", "1x", "{} //c", "[] ,", "0-", "1-2", "1+");
add("after-json", "1" + NBSP, "1" + BOM, "1\u2028", "{}\u000b", "{}\u000c", "1\u0000", '"a"' + EMOJI, "[1,2,3]]", "{\"a\":1} ");
add("after-json", `{"a":${seq(40, "0123456789")}}x`, `${" ".repeat(30)}1 ${seq(30)}`, "0 0", "-0 1", "1\n2", "1\r\n\r\n2");

// The short form: the whole source is one of V8's special strings.
add("special", "NaN", "undefined", "Infinity", "[object Object]", " NaN", "NaN ", "nan", "Undefined", "infinity");
add("special", "undefined\n", "[object Object] ", "[object Array]", "[object  Object]", "Infinity1", "NaN\u0000");

// Line and column: LF, CRLF, lone CR, LF CR, CR CR LF, tabs, astral characters.
for (const sep of ["\n", "\r\n", "\r", "\n\r", "\r\r\n", "\n\n", "\r\n\r\n"]) {
  add("lines", `{${sep}"a": 1,${sep}"b": [1, 2${sep}  3}`);
  add("lines", `[${sep}1,${sep}2 x${sep}]`);
  add("lines", `{${sep}"a": 1,${sep}}`, `[1${sep}`, `[1,${sep}${sep}2${sep}`, `${sep}${sep}"abc`, `${sep}1.${sep}`);
  add("lines", `{"a":${sep}${sep}\t\t"b\u0001"}`, `[${sep}\t${EMOJI}${sep}]`, `["${EMOJI}${EMOJI}",${sep}  1 2]`, `${sep}01`);
  add("lines", `[1,${sep}2,${sep}3${sep}${sep}`, `{${sep}"k"${sep}`, `{${sep}"k":1${sep},${sep}'x'}`);
}
add("lines", "[1,\r\n2,\r3,\n4\r\n 5]", "[1,\r\r\r\n\n\r2 3]", "\r\n\t-", "\t\t\t1.", "\r", "\n", "[\r", "[1\r", "[1\r\n", "[1\n\r");

// Non-ASCII and astral characters before the error position (positions count UTF-16 units).
add("nonascii", `["\u00e9", 1 2]`, `["${EMOJI}${EMOJI}", 1 2]`, `"${EMOJI}\u0001"`, `{"${EMOJI}":1,}`, `["\u20ac\u20ac\u20ac",01]`);
add("nonascii", `["${EMOJI.repeat(12)}",x]`, `["\u00e9\u00e9\u00e9\u00e9\u00e9\u00e9\u00e9\u00e9\u00e9\u00e9\u00e9\u00e9",x]`);
add("nonascii", EMOJI, `[${EMOJI}]`, `${EMOJI}${seq(30)}`, `[${seq(5)}${EMOJI}`, `"${EMOJI}`, `"a${EMOJI}\\x"`);

// Window cuts through surrogate pairs: an astral character straddling the
// start or end of the +-10 window, or the token itself being one.
{
  const p = 20;
  const len = 40;
  const at = (target) => {
    // a prefix of `p` units: `["` + content + `",` with the emoji's high half at `target`
    const content = seq(target - 2) + EMOJI + seq(p - 4 - (target - 2) - 2);
    return `["${content}",`;
  };
  add("surrogate-window", at(9) + "x" + seq(len - p - 1)); // low half at the window start (p-10)
  add("surrogate-window", at(10) + "x" + seq(len - p - 1)); // the pair starts at the window start
  add("surrogate-window", at(8) + "x" + seq(len - p - 1));
  const suffixAt = (k) => seq(k) + EMOJI + seq(len - p - 1 - k - 2);
  add("surrogate-window", valuePrefix(p) + "x" + suffixAt(8)); // high half at p+9, the window's last unit
  add("surrogate-window", valuePrefix(p) + "x" + suffixAt(9)); // pair at p+10..p+11, just outside
  add("surrogate-window", valuePrefix(p) + "x" + suffixAt(7));
  add("surrogate-window", valuePrefix(p) + EMOJI + seq(len - p - 2)); // the token is a high surrogate
  add("surrogate-window", valuePrefix(4) + "x" + seq(8) + EMOJI + seq(20)); // start form: high half at p+9 = 13
  add("surrogate-window", valuePrefix(4) + "x" + seq(7) + EMOJI + seq(20));
  add("surrogate-window", valuePrefix(30) + "x" + seq(9)); // end form, plain
  add("surrogate-window", `["${seq(20)}${EMOJI}${seq(7)}",x${seq(4)}`); // end form: the cut at p-10 splits the pair
  add("surrogate-window", `["${seq(20)}${EMOJI}${seq(6)}",x${seq(4)}`);
  add("surrogate-window", valuePrefix(len - 2) + EMOJI); // end form, token is the last pair
  add("surrogate-window", valuePrefix(9) + EMOJI + seq(20)); // start form, token is a pair at p = 9
  add("surrogate-window", EMOJI.repeat(5) + "x".repeat(15));
  add("surrogate-window", valuePrefix(1) + EMOJI.repeat(15));
  add("surrogate-window", valuePrefix(1) + "x" + EMOJI.repeat(10)); // start form: the cut at 11 splits a pair
}

// BOM and the whitespace JSON doesn't allow.
for (const ws of [BOM, NBSP, "\u2028", "\u2029", "\u3000", "\u000b", "\u000c", "\u0085", "\u1680", "\u200b", "\u205f"]) {
  add("bom-whitespace", `${ws}{}`, `{${ws}}`, `[1,${ws}2]`, `{"a"${ws}:1}`, `{"a":1${ws}}`, `1${ws}`, `${ws}`);
}
add("bom-whitespace", BOM + BOM + "{}", BOM + seq(30), `["${seq(20)}",${BOM}${seq(20)}]`);

// Deep nesting (V8's parser is iterative; there is no depth limit).
add("deep", "[".repeat(2000) + "x", "[".repeat(2000) + "1,", '{"a":'.repeat(300) + "1" + "}".repeat(299), "[".repeat(50) + "]".repeat(51));
add("deep", "[".repeat(129) + "]".repeat(128) + ",", '{"a":['.repeat(200) + "}");

// Valid documents (and lone-surrogate escapes, which V8 accepts).
add(
  "valid",
  "0", "-0", "1", "-1", "1.5", "1e400", "-1e400", "1E+2", "1.5e-3", "1e-400", "123456789012345678901234567890", "0e0",
  "1.7976931348623157e308", "1.7976931348623158e308", "1.7976931348623159e308", "4.9e-324", "0.1", "100", "1e21",
  "true", "false", "null", '""', '"a"', "[]", "{}", " [ ] ", "\t\n\r null \r\n", '{"a":1,"a":2}', '{"b":1,"2":2,"1":3}',
  '"\\ud800"', '"\\udc00"', '"\\ud800\\ud800"', '"\\udbff\\udfff"', '"\\uD83D\\uDE00"', '"\\ud83d"', '"x\\ud83dy"',
  '{"\\ud800":1,"\\udbff":2}', '["\\udc00\\ud800", "\\ud800\\u0041"]', '"\\u0000"', '"\\"\\\\\\/\\b\\f\\n\\r\\t"',
  `"${EMOJI}"`, '"\u007f\u0080\u00ff"', '"\u2028\u2029"', `"${BOM}"`, '{"__proto__":1}', '{"":""}', '[1,[2,[3,{"a":[]}]]]',
  '  {"a" : [ 1 , 2 ] , "b" : { "c" : null } }  ', '{\r\n  "x": "y"\r\n}\r\n', "[" + "1,".repeat(500) + "1]",
  '{"userMessageId":"abc","dryRun":true}', '{"x":1e400,"y":[-1e999]}', '"\\\\ud800"', '"\\\\\\ud800"',
  "[".repeat(127) + "]".repeat(127), "[".repeat(128) + "]".repeat(128), "[".repeat(2000) + "]".repeat(2000),
  '{"a":'.repeat(150) + "1" + "}".repeat(150),
);

// ---- raw lone surrogates (inputs a Rust `&str` can't hold) ---------------------

const jsOnly = [
  '"\ud800"', '"a\udc00b"', '["\ud83d", 1]', "\ud800", "\udc00", "[\ud800]", `["\ud800",x]`, `"\ud800\u0001"`,
  `["${seq(15)}\ud800${seq(5)}",x${seq(20)}]`, `[${seq(5)}\udfff${seq(20)}`, "\ud800" + seq(25), "1\ud800",
  '{"\ud800":1}', '{"a":1\udc00}', `"\\\ud800"`, `"\\u12\ud800"`, "-\udc00", "tr\ud800",
];

// ---- seeded fuzz ----------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(0x1a14);
const pick = (xs) => xs[Math.floor(rand() * xs.length)];
const int = (n) => Math.floor(rand() * n);

const SEEDS = [
  '{"userMessageId":"msg_01","dryRun":true}',
  '{"to":"/Users/me/project"}',
  '{\n  "env": {\n    "ANTHROPIC_MODEL": "claude",\n    "N": 12\n  },\n  "permissions": {"allow": ["Bash(ls:*)"]}\n}',
  '{\r\n\t"a": [1, -2.5e+3, 0, true, false, null],\r\n\t"b": "x\\ny\\u00e9"\r\n}',
  `["${EMOJI}", "caf\u00e9", "\\uD83D\\uDE00", {"k\u20ac": [[], {}]}]`,
  '[0.5,-0,1e-7,123456789,"\\"quoted\\"","\\\\back\\/slash"]',
  '{"a":{"b":{"c":{"d":[1,2,{"e":"f"}]}}},"g":-1.25E-2}',
  "  null  ",
  '"just a string with spaces and \\t escapes"',
  `{"long":"${seq(60)}","n":[${Array.from({ length: 20 }, (_, i) => i * 7).join(",")}]}`,
];
const INSERTS = [
  "{", "}", "[", "]", ":", ",", '"', "\\", " ", "\t", "\n", "\r", "\r\n", "0", "1", "9", "-", "+", ".", "e", "E", "t",
  "f", "n", "u", "l", "s", "a", "x", "'", "/", "\u0000", "\u0001", "\u001f", "\u007f", NBSP, "\u00e9", BOM, "\u2028", EMOJI,
  "\\u", "\\ud800", "true", "null", "01", "1.", "1e", '""', "[]", "{}",
];
function mutate(doc) {
  const ops = 1 + int(3);
  let s = doc;
  for (let k = 0; k < ops; k++) {
    const i = int(s.length + 1);
    switch (int(5)) {
      case 0:
        s = s.slice(0, i) + s.slice(i + 1); // delete one unit
        break;
      case 1:
        s = s.slice(0, i) + pick(INSERTS) + s.slice(i); // insert
        break;
      case 2:
        s = s.slice(0, i) + pick(INSERTS) + s.slice(i + 1); // replace one unit
        break;
      case 3:
        s = s.slice(0, i); // truncate
        break;
      default: {
        const j = Math.min(s.length, i + 1 + int(6));
        s = s.slice(0, i) + s.slice(j); // delete a run
      }
    }
  }
  return s;
}
const SOUP = [
  "{", "}", "[", "]", ":", ",", '"a"', '"', "1", "-", ".", "e", "0", "12", "true", "nu", "null", " ", "\n", "\r\n",
  "\r", "\t", '"\\', "\\u12", "\\n", EMOJI, NBSP, "x", "'b'", '"k":', "-0", "1.5", "1e+", '"\u0001"', BOM,
];
const fuzz = [];
for (let n = 0; n < 500; n++) fuzz.push(["fuzz-mutate", mutate(pick(SEEDS))]);
for (let n = 0; n < 300; n++) {
  const len = 1 + int(14);
  fuzz.push(["fuzz-soup", Array.from({ length: len }, () => pick(SOUP)).join("")]);
}

// ---- Body.json() over raw bytes ---------------------------------------------------

const B = [0xef, 0xbb, 0xbf];
const ascii = (s) => Array.from(s, (c) => c.charCodeAt(0));
const BODIES = [
  [], ascii(" "), ascii("\r\n"), B, [...B, ...B], [...B, ...ascii("{}")], [...B, ...B, ...ascii("{}")],
  [...B, ...B, ...B, ...ascii("{}")], [...B, 0xef, 0xbb, ...ascii("{}")], [0x20, ...B, ...ascii("{}")],
  [...ascii("{}"), ...B], [...B, ...ascii(" x")], [...B, ...B, ...ascii("x")], [...B, ...ascii('{"a":1')],
  ascii('{"a":1}'), ascii('{"a":'), ascii("nope"), ascii("{'a':1}"), ascii('{"a":1} x'), ascii("null"),
  [0x22, 0xf0, 0x9f, 0x98, 0x22, 0x78], [0xf0, 0x9f, 0x98, 0x78], [0x5b, 0xff, 0xfe, 0x5d], [0xed, 0xa0, 0x80],
  [0x22, 0xed, 0xa0, 0x80, 0x22], [0x22, 0xc0, 0x80, 0x22, 0x20, 0x31], [0x22, 0xe0, 0x80, 0x22, 0x20, 0x31],
  [0x22, 0xf4, 0x90, 0x80, 0x80, 0x22, 0x20, 0x31], [0x22, 0xf8, 0x88, 0x80, 0x80, 0x80, 0x22, 0x20, 0x31],
  [0x22, 0xe2, 0x82, 0x22, 0x20, 0x31], [0x22, 0xf0, 0x9f, 0x22, 0x20, 0x31], [0x22, 0x80, 0xbf, 0x22, 0x20, 0x31],
  [0x22, 0xc3, 0x22, 0x20, 0x31], [...ascii('{"a":"x'), 0xff, ...ascii('y"}')], [...ascii('["'), 0xf0, 0x9f, 0x98, 0x80, ...ascii('", 1 2]')],
  [...ascii('{"k":1'), 0xe2, 0x80, 0xa8, ...ascii("}")], [...ascii("[1,"), 0xc2, 0xa0, ...ascii("2]")],
  [...ascii(`["${seq(20)}",`), 0xff, ...ascii(seq(20))], [0xf0, 0x9f, 0x98, 0x80], [0xf0, 0x9f, 0x98, 0x80, 0x31],
  [...ascii('"\\ud800"')], [...ascii('{"dryRun":1e400}')], [0xfe, 0xff, 0x00, 0x7b], [0xff, 0xfe, 0x7b, 0x00],
];
async function body(bytes) {
  const rec = { bytes: Buffer.from(bytes).toString("hex") };
  try {
    const v = await new Response(new Uint8Array(bytes)).json();
    rec.message = null;
    rec.value = JSON.stringify(wellFormed(v));
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
    const r = rustable(e.message);
    rec.message = r.text;
    if (r.lone) {
      rec.lone = r.lone;
      rec.messageUnits = units(e.message);
    }
  }
  return rec;
}

// ---- write -------------------------------------------------------------------------

const seen = new Set();
const recorded = [];
for (const [group, input] of [...cases, ...fuzz]) {
  if (seen.has(input)) continue;
  seen.add(input);
  if (!input.isWellFormed()) {
    jsOnly.push(input); // a fuzz cut through a surrogate pair
    continue;
  }
  recorded.push({ group, input, ...outcome(input) });
}
const jsOnlySeen = new Set();
const jsOnlyRecorded = [];
for (const input of jsOnly) {
  if (input.isWellFormed()) throw new Error(`not a lone-surrogate input: ${JSON.stringify(input)}`);
  if (jsOnlySeen.has(input)) continue;
  jsOnlySeen.add(input);
  const m = message(input);
  const rec = { input: units(input), message: m === null ? null : rustable(m).text };
  if (m !== null) rec.messageUnits = units(m);
  jsOnlyRecorded.push(rec);
}
const bodies = [];
for (const b of BODIES) bodies.push(await body(b));

const malformed = recorded.filter((c) => c.message !== null).length;
const lines = [
  "{",
  `"node": ${JSON.stringify(process.version)},`,
  `"v8": ${JSON.stringify(process.versions.v8)},`,
  `"undici": ${JSON.stringify(process.versions.undici)},`,
  '"cases": [',
  recorded.map((c) => JSON.stringify(c)).join(",\n"),
  "],",
  '"jsOnly": [',
  jsOnlyRecorded.map((c) => JSON.stringify(c)).join(",\n"),
  "],",
  '"bodies": [',
  bodies.map((c) => JSON.stringify(c)).join(",\n"),
  "]",
  "}",
];
writeFileSync(out, lines.join("\n") + "\n");
console.log(
  `${recorded.length} cases (${malformed} malformed, ${recorded.length - malformed} valid), ` +
    `${jsOnlyRecorded.length} lone-surrogate inputs, ${bodies.length} bodies -> ${out}`,
);
