#!/usr/bin/env node
// Golden fixture for `claudius_core::js_date::date_parse` (S27c): what node
// 22's own `Date.parse` (V8's `DateParser`: the ES date-time format, then
// the legacy fallback) returns for many strings.
//
//   node rust/scripts/date-parse-golden.mjs      (node@22)
//
// Re-runs itself twice with `TZ` pinned (a time without a zone is local);
// both recordings must agree byte for byte. The strings:
// - hand-written ones: every ES form and its failures, the legacy forms
//   (month names and prefixes, two-digit years, day / month / year orders,
//   am / pm, the US zone names, `+hhmm` / `+hh:` / `GMT-8` offsets, words,
//   parentheses, signs and `)` after a number), JS whitespace and line
//   terminators, a NUL, far years and the edges of the time range, offsets
//   past what a Smi holds;
// - what `Date`'s own formatters print (`toString`, `toUTCString`,
//   `toISOString`, `toDateString`, `toLocaleString("en-US")`, ...) for
//   seeded times across the whole range;
// - seeded token soups and field templates, and seeded one- and two-edit
//   mutations of the hand-written strings.
// No string holds a lone surrogate (the fixture is read as Rust strings).
//
// Written to rust/crates/claudius-core/tests/fixtures/date_parse_golden.json
// (one `[string, ms or null]` per line) and replayed by
// crates/claudius-core/tests/date_parse_golden.rs.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "crates/claudius-core/tests/fixtures/date_parse_golden.json");
// New York has DST, and its earliest offset is LMT (-4:56:02).
const TZ = "America/New_York";

if (!process.env.DATE_PARSE_GOLDEN_CHILD) {
  const runs = [0, 1].map(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "date-parse-golden-")));
    try {
      const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
        encoding: "utf8",
        maxBuffer: 1 << 26,
        env: { PATH: process.env.PATH, HOME: root, TZ, DATE_PARSE_GOLDEN_CHILD: root },
      });
      if (r.status !== 0) {
        process.stderr.write(r.stderr);
        process.exit(r.status ?? 1);
      }
      return readFileSync(join(root, "out.json"), "utf8");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  if (runs[0] !== runs[1]) {
    writeFileSync(join(tmpdir(), "date-parse-golden-run0.json"), runs[0]);
    writeFileSync(join(tmpdir(), "date-parse-golden-run1.json"), runs[1]);
    throw new Error("the two recordings differ (both written to the temp dir)");
  }
  writeFileSync(out, runs[0]);
  const fixture = JSON.parse(runs[0]);
  const parsed = fixture.cases.filter(([, ms]) => ms !== null).length;
  console.log(
    `wrote ${out.slice(repo.length + 1)}: ${fixture.cases.length} strings, ${parsed} parse (node ${fixture.node}, TZ ${fixture.tz})`,
  );
  process.exit(0);
}

// --------------------------------- child ---------------------------------

// Non-ASCII without escapes in this file.
const cp = (...n) => String.fromCodePoint(...n);
const NUL = cp(0);
const NBSP = cp(0xa0);
const NEL = cp(0x85);
const EM_SPACE = cp(0x2003);
const NNBSP = cp(0x202f);
const IDEO_SPACE = cp(0x3000);
const OGHAM_SPACE = cp(0x1680);
const MONGOLIAN_VS = cp(0x180e);
const ZWSP = cp(0x200b);
const BOM = cp(0xfeff);
const LS = cp(0x2028);
const PS = cp(0x2029);
const E_ACUTE = cp(0xe9);
const KELVIN = cp(0x212a);
const LONG_S = cp(0x17f);
const FULLWIDTH_2 = cp(0xff12);
const EMOJI = cp(0x1f600);

// mulberry32: a seeded generator, so both runs see the same strings.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HAND = [
  // The ES date-time format.
  "2026",
  "2026-01",
  "2026-01-02",
  "2026-1",
  "2026-01-2",
  "2026-02-29",
  "2026-02-30",
  "2026-02-31",
  "2026-04-31",
  "2024-02-29T12:00:00.5Z",
  "2026-13-01",
  "2026-00-01",
  "2026-01-32",
  "2026-01-00",
  "2026-01-02T03:04:05.000Z",
  "2026-01-02T03:04:05Z",
  "2026-01-02T03:04Z",
  "2026-01-02T03:04:05.6Z",
  "2026-01-02T03:04:05.67Z",
  "2026-01-02T03:04:05.6789Z",
  "2026-01-02T03:04:05.000123456789123Z",
  "2026-01-02T03:04:05.999999999Z",
  "2026-01-02T03:04:05.Z",
  "2026-01-02T03:04:05,5Z",
  "2026-01-02t03:04:05z",
  "2026-01-02T03:04:05",
  "2026-01-02T03:04",
  "2026-01-02T03",
  "2026-01-02T3:04",
  "2026-01-02T03:4",
  "2026-01-02T03:04:5",
  "2026-01-02T24:00",
  "2026-01-02T24:00Z",
  "2026-01-02T24:00:00.000Z",
  "2026-01-02T24:00:01Z",
  "2026-01-02T24:01Z",
  "2026-01-02T24:00:00.001Z",
  "2026-01-02T25:00Z",
  "2026-01-02T23:60Z",
  "2026-01-02T23:59:60Z",
  "2026-01-02T03:04:05+05:30",
  "2026-01-02T03:04:05-05:30",
  "2026-01-02T03:04:05+0530",
  "2026-01-02T03:04:05+05",
  "2026-01-02T03:04:05+5:30",
  "2026-01-02T03:04:05+23:59",
  "2026-01-02T03:04:05+24:00",
  "2026-01-02T03:04:05+2400",
  "2026-01-02T03:04:05+0060",
  "2026-01-02T03:04:05+05:60",
  "2026-01-02T03:04:05ZZ",
  "2026-01-02T03:04:05Z ",
  "2026-01-02T03:04:05 Z",
  "2026-01-02T03:04:05UTC",
  "2026-01-02T03:04:05GMT",
  "2026-01-02Tx",
  "2026-01-02T",
  "2026T10:00Z",
  "2026-01T10:00Z",
  "2026-01-02T03:04:05.000Zjunk",
  "+002026-01-02T03:04:05Z",
  "-002026-01-02T03:04:05Z",
  "+002026",
  "-000001-01-01T00:00:00Z",
  "-000000-01-01T00:00:00Z",
  "+000000-01-01T00:00:00Z",
  "0000-01-01T00:00:00Z",
  "0000-01-01",
  "0001-01-01T00:00:00",
  "1900-01-01T00:00:00",
  "1883-11-18T12:00:00",
  "1883-11-18T11:59:59",
  "+275760-09-13T00:00:00.000Z",
  "+275760-09-13T00:00:00.001Z",
  "+275760-09-13",
  "+275760-09-12T20:00:00",
  "+275760-09-12T19:59:59.999",
  "-271821-04-20T00:00:00Z",
  "-271821-04-19T23:59:59.999Z",
  "-271821-04-20",
  "-271821-04-19T19:03:58",
  "-271821-04-19T19:03:57",
  "+999999-12-31T23:59:59Z",
  "+1000000-01-01",
  "20260",
  "202",
  "2026-",
  "2026--01",
  // New York's DST gap and fold, and a non-DST date.
  "2026-03-08T02:30:00",
  "2026-03-08T01:59:59",
  "2026-03-08T03:00:00",
  "2026-11-01T01:30:00",
  "2026-11-01T00:59:59",
  "2026-11-01T02:00:00",
  "2026-07-04T12:00:00",
  "Mar 8 2026 2:30 AM",
  "Nov 1 2026 1:30 AM",
  // The legacy fallback.
  "Jan 2 2026 03:04:05",
  "Jan 2 2026",
  "Jan 2",
  "Jan 2026",
  "January 2, 2026",
  "2 January 2026",
  "2026 January 2",
  "Janx 2 2026",
  "Ja 2 2026",
  "Juni 2 2026",
  "jUn 2 2026",
  "Sept 30 2026",
  "Sep 31 2026",
  "Feb 30 2026",
  "Feb 29 2025",
  "2026 Feb 29",
  "29 Feb 2024",
  "Jan-2-2026",
  "2-Jan-2026",
  "2026-Jan-02",
  "Jan 2 26",
  "Jan 2 49",
  "Jan 2 50",
  "Jan 2 99",
  "Jan 2 100",
  "Jan 2 0",
  "Jan 2 00",
  "Jan 2 000",
  "Jan 2 2026 10:00 AM",
  "Jan 2 2026 10:00 PM",
  "Jan 2 2026 12:00 AM",
  "Jan 2 2026 12:00 PM",
  "Jan 2 2026 00:00 PM",
  "Jan 2 2026 13:00 PM",
  "Jan 2 2026 10 PM",
  "Jan 2 2026 PM 10:00",
  "Jan 2 2026 10:00 a.m.",
  "Jan 2 2026 10:00:00.5",
  "Jan 2 2026 10:00:00.123456",
  "Jan 2 2026 10:00:00.",
  "Jan 2 2026 10:00:00.x",
  "Jan 2 2026 10:00.5",
  "Jan 2 2026 10::",
  "Jan 2 2026 10::30",
  "Jan 2 2026 10:30::",
  "Jan 2 2026 10:30:",
  "Jan 2 2026 10:30:.5",
  "Jan 2 2026 10:30:40:50",
  "Jan 2 2026 10:30:40:50:60",
  "Jan 2 2026 24:00",
  "Jan 2 2026 24:00:01",
  "Jan 2 2026 23:59:59.999",
  "Jan 2 2026 10:00 GMT",
  "Jan 2 2026 10:00 UTC",
  "Jan 2 2026 10:00 UT",
  "Jan 2 2026 10:00 Z",
  "Jan 2 2026 10:00Z",
  "Jan 2 2026 10:00 z",
  "Jan 2 2026 10:00 EST",
  "Jan 2 2026 10:00 EDT",
  "Jan 2 2026 10:00 CST",
  "Jan 2 2026 10:00 CDT",
  "Jan 2 2026 10:00 MST",
  "Jan 2 2026 10:00 MDT",
  "Jan 2 2026 10:00 PST",
  "Jan 2 2026 10:00 PDT",
  "Jan 2 2026 10:00 CET",
  "Jan 2 2026 10:00 GMTx",
  "Jan 2 2026 10:00 utcx",
  "GMT Jan 2 2026 10:00",
  "Jan 2 2026 GMT 10:00",
  "Jan 2 2026 10:00 GMT+1",
  "Jan 2 2026 10:00 GMT+01",
  "Jan 2 2026 10:00 GMT+013",
  "Jan 2 2026 10:00 GMT+0130",
  "Jan 2 2026 10:00 GMT+01300",
  "Jan 2 2026 10:00 GMT+01:30",
  "Jan 2 2026 10:00 GMT+1:30",
  "Jan 2 2026 10:00 GMT+",
  "Jan 2 2026 10:00 GMT-",
  "Jan 2 2026 10:00 GMT-8",
  "Jan 2 2026 10:00 GMT-0800",
  "Jan 2 2026 10:00 GMT+0099",
  "Jan 2 2026 10:00 GMT+9999",
  "Jan 2 2026 10:00 +0100",
  "Jan 2 2026 10:00 -0100",
  "Jan 2 2026 10:00 +01:00",
  "Jan 2 2026 10:00 +01",
  "Jan 2 2026 +0100",
  "Jan 2 2026 10:00 GMT+0100 GMT",
  "Jan 2 2026 10:00 GMT+0100 +0200",
  "Jan 2 2026 10:00 GMT+0100junk",
  "Jan 2 2026 10:00 GMT+0100xyz",
  "Jan 2 2026 GMT+0100",
  "Jan 2 2026 UTC-5",
  "Jan 2 2026 UT+05:30",
  "Jan 2 2026 EST+0100",
  "Jan 2 2026 10:00 EST+0100",
  "Jan 2 2026 10:00 PST-0100",
  "Jan 1 270000 00:00 GMT+596523:",
  "Jan 1 270000 00:00 GMT+596524:",
  "Jan 1 270000 00:00 GMT+298262:",
  "Jan 1 2026 00:00 GMT+1193047:",
  "Jan 1 2026 00:00 GMT+1193046:",
  "Jan 1 2026 00:00 GMT+1193047:30",
  "Jan 1 2026 00:00 GMT+99:99",
  "Jan 1 2026 00:00 GMT+01:",
  "Jan 1 2026 00:00 GMT+01:x",
  // Only 9 significant digits count (an offset hour has no range check).
  "Jan 1 2026 00:00 GMT+123456789:00",
  "Jan 1 2026 00:00 GMT-123456789:00",
  "Jan 1 2026 00:00 GMT+000123456789:00",
  "Jan 1 2026 00:00 GMT+1193047123:00",
  "Jan 1 2026 00:00 GMT+12345678:00",
  "Jan 1 2026 00:00 +0:123456789",
  "Jan 1 2026 00:00 GMT+0:1234567890",
  "Jan 1 2026 00:00 GMT+1:4294967296",
  // Milliseconds after a third colon.
  "Jan 1 2026 12:34:56:789",
  "Jan 1 2026 12:34:56:99",
  "Jan 1 2026 12:34:56:100",
  "Jan 1 2026 12:34:56:999",
  "Jan 1 2026 12:34:56:1000",
  "1/1/2026 12:34:56:789",
  "12:34:56:789 Jan 1 2026",
  "Jan 1 12:34:56:500 2026",
  "Jan 1 2026 10:.30",
  "Jan 1 2026 10:..30",
  "Jan 1 2026 10:30:.5",
  // Hour 24's fraction is checked by value, before it's cut to 3 digits.
  "2026-01-02T24:00:00.0001Z",
  "2026-01-02T24:00:00.0009Z",
  "2026-01-02T24:00:00.00001",
  "2026-01-02T24:00:00.0000000001Z",
  "2026-01-02T24:00:00.0000Z",
  "Jan 2 2026 24:00:00.0001",
  "Jan 2 2026 (comment) 10:00",
  "Jan 2 2026 10:00 (Eastern Standard Time)",
  "(Fri) Jan 2 2026",
  "Jan 2 2026 (unclosed",
  "Jan 2 2026 ((nested) still) 10:00",
  "Jan 2 2026 ) 10:00",
  ") Jan 2 2026",
  "Jan 2 2026 10:00 )",
  "Jan 2 2026 + 1",
  "+Jan 2 2026",
  "-Jan 2 2026",
  "- 1 2 2026",
  "Fri, 02 Jan 2026 03:04:05 GMT",
  "Fri, 02 Jan 2026 03:04:05 +0000",
  "Thu Jan 01 2026 22:04:05 GMT-0500 (Eastern Standard Time)",
  "Friday, January 2, 2026 3:04:05 AM",
  "Fri Jan 02 2026",
  "Fri Jan 02 2026 03:04:05 GMT+0000 (Coordinated Universal Time)",
  "Fri2 Jan 2026",
  "Fri 2Jan 2026",
  "Fri,2 Jan 2026",
  "Fri. 2 Jan 2026",
  "on Jan 2 2026",
  "Jan 2 2026 at 10:00",
  "Jan 2 2026 10:00 sharp",
  "Jan 2 2026 noon",
  "today",
  "now",
  "garbage",
  "Z",
  "T",
  "GMT",
  "PM",
  "Jan",
  "",
  " ",
  "1",
  "12",
  "123",
  "1/2",
  "1/2/3",
  "1/2/2026",
  "12/31/2025",
  "12/31/2025 11:59 PM",
  "12/31/2025 23:59:59",
  "31/12/2025",
  "13/1/2026",
  "2026/01/02",
  "2026/1/2",
  "2026/13/02",
  "2026/01/32",
  "2026/02/30",
  "02/01/2026",
  "1.2.2026",
  "1.-2",
  "1.-2-2026",
  "1.2.-2026",
  "Jan 2. 2026",
  "2026-01-02 10.30",
  "2.1.2026 10:00",
  "2026.01.02",
  "2026 01 02",
  "2026-1-01",
  "2026-1-1",
  "2026-01-1",
  "2026-1",
  "2026-01-01 00:00Z",
  "2026-01-01 00:00:00Z",
  "2026-01-01 00:00:00",
  "2026-01-01 10:00",
  "2026-01-01 10:00 PM",
  "2026-01-01T",
  " 2026-01-02",
  "2026-01-02 ",
  "2026-01-02 03:04:05.678 +05:30",
  "2026-01-02 03:04:05 -0800",
  "2026-01-02 03:04:05 GMT",
  "2026-01-02 03:04:05 PST",
  "2026-01-02 3:4:5",
  "2026-01-02X03:04",
  "2026-01-02 T 03:04",
  "1 2 3 4",
  "1 2 2026 4",
  "10:00",
  "10:00 Jan 2 2026",
  "10:00:00 2026-01-02",
  "10:00 2026",
  "10:00 PM",
  "2026 10:00",
  "275760-09-13",
  "275760-09-12",
  "Sep 13 275760",
  "Sep 13 275760 GMT",
  "Sep 12 275760 20:00",
  "Sep 12 275760 19:59:59.999",
  "Sat Sep 13 275760 00:00:00 GMT+0000",
  "Sat Sep 13 275760 00:00:00 GMT-0001",
  "Sat Sep 13 275760 00:00:01 GMT+0000",
  "Apr 20 271821 GMT",
  "Jan 1 999999 GMT",
  "Jan 1 1000000 GMT",
  "Jan 1 1000001 GMT",
  "Jan 1 999999999 GMT",
  "Jan 1 9999999999 GMT",
  "Jan 1 0001234567890 GMT",
  "-271821-04-19 20:00",
  "-271821-04-20 00:00 GMT",
  "-271821-04-19 23:59 GMT",
  "-002026-01-01 10:00",
  "+002026-01-01 10:00",
  "-1 Jan 2026",
  // Units: whitespace, line terminators, NUL, non-ASCII.
  `Jan${NBSP}2${NBSP}2026`,
  `Jan${EM_SPACE}2${IDEO_SPACE}2026`,
  `Jan${OGHAM_SPACE}2 2026`,
  `Jan${MONGOLIAN_VS}2 2026`,
  `Jan${ZWSP}2 2026`,
  `Jan${BOM}2 2026`,
  `Jan${LS}2 2026`,
  `Jan ${LS}2 2026`,
  `Jan${PS} 2 2026`,
  `Jan${NEL}2 2026`,
  `Jan ${NEL} 2 2026`,
  "Jan\t2\n2026\r10:00",
  "Jan\v2\f2026",
  `${BOM}2026-01-02`,
  `2026-01-02${BOM}`,
  `2026-01-02${NUL}`,
  `2026-01-02${NUL}T10:00`,
  `2026-01-02${NUL} junk`,
  `Jan 2 2026${NUL}xyz`,
  `${NUL}Jan 2 2026`,
  `Jan 2 2026 (${NUL}) 10:00`,
  `Jan 2 2026 10:00${NNBSP}PM`,
  `J${E_ACUTE}n 2 2026`,
  `Jan${E_ACUTE} 2 2026`,
  `Jan 2 2026 ${E_ACUTE}`,
  `${E_ACUTE} Jan 2 2026`,
  `Jan 2 2026 10:00 ${KELVIN}`,
  `${LONG_S}ep 2 2026`,
  `Jan ${FULLWIDTH_2} 2026`,
  `Jan 2 2026 ${EMOJI}`,
  `${EMOJI} Jan 2 2026`,
  `Jan${EMOJI} 2 2026`,
  `ut${EMOJI} Jan 2 2026`,
  // What may follow a final time component.
  "Jan 2 2026 10:00\nGMT",
  "Jan 2 2026 10:00\rGMT",
  "Jan 2 2026 10:00\tGMT",
  "Jan 2 2026 10:00\vGMT",
  `Jan 2 2026 10:00${NBSP}GMT`,
  `Jan 2 2026 10:00${IDEO_SPACE}GMT`,
  `Jan 2 2026 10:00${BOM}GMT`,
  `Jan 2 2026 10:00${LS}GMT`,
  `Jan 2 2026 10:00${NEL}GMT`,
  "Jan 2 2026 10:00(x)",
  "Jan 2 2026 10:00,GMT",
  "Jan 2 2026 10:00/GMT",
  "Jan 2 2026 10:00-0100",
  "Jan 2 2026 10:00+0100",
  "Jan 2 2026 10:00Z",
  "Jan 2 2026 10:00ZZ",
  "Jan 2 2026 10:00GMT",
  "Jan 2 2026 10:00:00\n",
  "Jan 2 2026 10:00:00.5\nPM",
  "Jan 2 2026 10:00:00.5 PM",
  "2026-01-02 10:00\nZ",
  "2026-01-02 10:00\r\n",
  // The S27c replay stamps.
  "not a date",
  "Jan 2 2026 03:04:05",
  "2026/01/02",
  "Sat Sep 13 275760 00:00:00 GMT+0000",
];

const cases = new Set();
const add = (s) => {
  // Skip any lone surrogate.
  if (/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s)) return;
  cases.add(s);
};
for (const s of HAND) add(s);

// What `Date` itself prints, across the range.
const fmt = rng(0x5eed0001);
const MAX = 8.64e15;
for (let i = 0; i < 400; i++) {
  const pick = fmt();
  let t;
  if (pick < 0.5) t = Math.round((fmt() * 2 - 1) * 4e12); // ~1843..2096
  else if (pick < 0.8) t = Math.round((fmt() * 2 - 1) * MAX);
  else t = Math.round(MAX - fmt() * 4e9) * (fmt() < 0.5 ? 1 : -1); // near the edges
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) continue;
  for (const s of [
    d.toString(),
    d.toUTCString(),
    d.toISOString(),
    d.toDateString(),
    d.toTimeString(),
    d.toLocaleString("en-US"),
    d.toLocaleDateString("en-US"),
    d.toLocaleString("en-GB"),
    d.toJSON(),
  ]) {
    if (s !== null) add(s);
  }
}

// Seeded token soups.
const SOUP = [
  "1", "2", "9", "01", "02", "10", "12", "13", "23", "24", "29", "30", "31", "32", "59", "60", "99",
  "100", "999", "1000", "0130", "0099", "2026", "1970", "0000", "10000", "123456", "275760", "000000",
  "1234567890", "99999999999",
  "-", "/", ":", ".", ",", " ", "  ", "T", "t", "Z", "z", "+", "(", ")", "(x)", "((a)", "::",
  "Jan", "January", "jan", "FEB", "Sept", "Dec", "Mon", "Tuesday", "Thu", "AM", "PM", "am", "pm",
  "GMT", "UTC", "UT", "EST", "EDT", "CST", "PDT", "junk", "xyz", "at", "of",
  NBSP, EM_SPACE, BOM, LS, NEL, E_ACUTE, NUL, "\t", "\n", "\r", EMOJI,
];
const soup = rng(0x5eed0002);
const pickFrom = (r, list) => list[Math.floor(r() * list.length)];
for (let i = 0; i < 4000; i++) {
  const n = 1 + Math.floor(soup() * 9);
  let s = "";
  for (let k = 0; k < n; k++) s += pickFrom(soup, SOUP);
  add(s);
}

// Seeded field templates: mostly plausible dates with odd values and
// separators, so the arithmetic is exercised too.
const tpl = rng(0x5eed0003);
const num = (r, lo, hi, pad = 0) => String(lo + Math.floor(r() * (hi - lo + 1))).padStart(pad, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "January", "Sept", "dec", "MAY"];
const ZONES = ["", " GMT", " UTC", " Z", "Z", " EST", " PDT", " +0530", " -0800", " GMT+1", " GMT-11", " +05:30", " GMT+0100 (CET)", " (x)"];
const AMPM = ["", "", "", " AM", " PM", " am", " pm"];
for (let i = 0; i < 3000; i++) {
  const r = tpl;
  const year = pickFrom(r, [num(r, 0, 99), num(r, 1900, 2100), num(r, 1, 9999, 4), num(r, 100, 999), "275760", "271821", num(r, 10000, 300000)]);
  const month = num(r, 0, 13, r() < 0.5 ? 2 : 0);
  const day = num(r, 0, 32, r() < 0.5 ? 2 : 0);
  const time =
    r() < 0.25
      ? ""
      : ` ${num(r, 0, 25, 2)}:${num(r, 0, 60, 2)}${r() < 0.6 ? `:${num(r, 0, 60, 2)}` : ""}${r() < 0.3 ? `.${num(r, 0, 9999)}` : ""}`;
  const ampm = pickFrom(r, AMPM);
  const zone = pickFrom(r, ZONES);
  const sep = pickFrom(r, ["-", "/", " ", ".", "-"]);
  let s;
  switch (Math.floor(r() * 6)) {
    case 0:
      s = `${year}${sep}${month}${sep}${day}`;
      break;
    case 1:
      s = `${month}${sep}${day}${sep}${year}`;
      break;
    case 2:
      s = `${pickFrom(r, MONTHS)} ${day} ${year}`;
      break;
    case 3:
      s = `${day} ${pickFrom(r, MONTHS)} ${year}`;
      break;
    case 4:
      s = `${year} ${pickFrom(r, MONTHS)} ${day}`;
      break;
    default:
      s = `${year.padStart(4, "0")}-${month.padStart(2, "0")}-${day.padStart(2, "0")}${r() < 0.5 ? "T" : " "}`;
  }
  add(`${s}${time}${ampm}${zone}`.trimEnd());
}

// Seeded one- and two-edit mutations of the hand-written strings.
const mut = rng(0x5eed0004);
const ALPHABET = ["0", "1", "5", "9", "-", "/", ":", ".", " ", "T", "Z", "+", "(", ")", "a", "J", "M", "P", ",", NBSP, NUL];
for (let i = 0; i < 3000; i++) {
  let chars = Array.from(pickFrom(mut, HAND));
  for (let e = 0; e < 1 + Math.floor(mut() * 2); e++) {
    const at = Math.floor(mut() * (chars.length + 1));
    const op = Math.floor(mut() * 3);
    if (op === 0 && chars.length > 0) chars.splice(Math.min(at, chars.length - 1), 1);
    else if (op === 1) chars.splice(at, 0, pickFrom(mut, ALPHABET));
    else if (chars.length > 0) chars[Math.min(at, chars.length - 1)] = pickFrom(mut, ALPHABET);
  }
  add(chars.join(""));
}

const rows = [...cases].map((s) => {
  const ms = Date.parse(s);
  return JSON.stringify([s, Number.isNaN(ms) ? null : ms]);
});
writeFileSync(
  join(process.env.DATE_PARSE_GOLDEN_CHILD, "out.json"),
  `{"node":${JSON.stringify(process.version)},"tz":${JSON.stringify(process.env.TZ)},"cases":[\n${rows.join(",\n")}\n]}\n`,
);
process.exit(0);
