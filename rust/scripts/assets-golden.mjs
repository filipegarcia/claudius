#!/usr/bin/env node
// Golden fixture for the Files page's asset store and routes and for
// `GET /api/local-image` (D17), recorded from the real TS sources:
// `lib/server/asset-store.ts`, `asset-list.ts`, `asset-ingest.ts`, the
// `image-size` package they use, and `app/api/assets/route.ts`,
// `app/api/assets/[hash]/route.ts`, `app/api/assets/[hash]/uses/route.ts`
// and `app/api/local-image/route.ts`:
//
//   node rust/scripts/assets-golden.mjs     (node@22: better-sqlite3)
//
// Re-runs itself under `--experimental-transform-types` with HOME and
// CLAUDE_CONFIG_DIR in a temp root, TZ pinned, a resolve hook for the `@/`
// imports and `Date.now` stubbed. Paths under the temp root are written as
// `{PH}` (its encoded project-dir form as `{PHENC}`), the scratch dir under
// `/tmp` as `{TP}`, and the core part's state home as `{HOME}`. Parts:
// * `imageSize`: `imageSize(buffer)` (a Buffer of exactly the bytes) for
//   hand-built images of every type the package knows, odd ones, and
//   seeded mutations of them: `w`/`h` are `String(width/height)`, or
//   `threw`, or `hang` (the call never returned: a worker was stopped).
// * `base64`: `Buffer.from(s, "base64")` as hex.
// * `dateParse`: `String(Date.parse(s))` under `tz`.
// * `extFor`: the store's file extension per media type.
// * `core`: the library functions called directly, in order, each with its
//   result (`record`: `recordSendUses`; `list`: `listAssets`; `uses`,
//   `meta`, `delrow`; `write`/`read`/`del`: the store; `backfill` at a
//   pinned clock), interleaved with setup (`sql`, `jsonl` transcripts,
//   `mkdir`/`file` under the state home) and dumps (`rows`: every column's
//   SQLite type and value; `files`: the store's files; `ls`: a folder).
//   `rustRefuses` marks a read the port refuses (the path leaves the store).
// * `assets`: one world of route steps for the server: setup (`file`,
//   `mkdir`, `rm`, `jsonl`, `bigjsonl`, `sql`) and `req` (method, url,
//   `got`: status, content type, content length, cache control and the
//   body: text, hex, or `len`+`sha` past 4 KiB; or `threw`, Next's empty
//   500), with `tz` for the server's local time.
// * `localImage`: worlds of `GET /api/local-image` steps, each with its
//   temp-dir env (`TMPDIR`, `TMP`, `TEMP`; null is unset) and fs setup
//   (`file`, `dir`, `link`, `fifo`, `big`, `locked`); `darwin` marks a step
//   whose answer needs macOS's `/tmp -> /private/tmp`.
//
// Written to rust/crates/claudius-core/tests/fixtures/assets_golden.json;
// replayed by crates/claudius-core/tests/assets_golden.rs (all but the
// routes) and crates/claudius-server/tests/assets.rs (`assets` and
// `localImage`, against the real binary).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "crates/claudius-core/tests/fixtures/assets_golden.json");
const TZ = "America/New_York";

if (!process.env.AG_CHILD) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "assets-golden-")));
  const tp = mkdtempSync("/tmp/assets-golden-tmp-");
  let status = 1;
  try {
    const r = spawnSync(
      process.execPath,
      ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url)],
      {
        cwd: repo,
        stdio: "inherit",
        env: {
          PATH: process.env.PATH,
          HOME: join(root, "home"),
          CLAUDE_CONFIG_DIR: join(root, "config"),
          TZ,
          AG_CHILD: "1",
          AG_ROOT: root,
          AG_TMP: tp,
        },
      },
    );
    status = r.status ?? 1;
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(tp, { recursive: true, force: true });
  }
  process.exit(status);
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
  try {
    return await next(s, ctx);
  } catch (e) {
    // A bare CJS subpath without an exports map (\`next/server\`).
    if (e?.code === "ERR_MODULE_NOT_FOUND" && !s.includes(":") && !s.startsWith(".")) return next(s + ".js", ctx);
    throw e;
  }
}
export async function load(url, ctx, next) {
  if (url.endsWith(".json")) {
    return next(url, { ...ctx, importAttributes: { ...ctx.importAttributes, type: "json" } });
  }
  return next(url, ctx);
}`;
register(`data:text/javascript,${encodeURIComponent(hook)}`);

const PH = process.env.AG_ROOT;
const TP = process.env.AG_TMP;
const enc = (abs) => abs.replace(/[^a-zA-Z0-9]/g, "-");
const PHENC = enc(PH);
const HOME = process.env.HOME;
const TPNAME = TP.slice("/tmp/".length);
const uq = encodeURIComponent;
/** Temp paths as placeholders, in any recorded string (`Q`: URI-component encoded). */
const scrub = (s) =>
  s
    .split(HOME)
    .join("{HOME}")
    .split(PH)
    .join("{PH}")
    .split(uq(PH))
    .join("{PHQ}")
    .split(PHENC)
    .join("{PHENC}")
    .split(TP)
    .join("{TP}")
    .split(uq(TP))
    .join("{TPQ}")
    .split(TPNAME)
    .join("{TPNAME}");
const unscrub = (s) => s.split("{HOME}").join(HOME).split("{PHENC}").join(PHENC).split("{PH}").join(PH).split("{TP}").join(TP);

const BASE = 1_700_000_000_000;
let clock = BASE;
Date.now = () => clock;

const { default: Database } = await import("better-sqlite3");
const { openDb } = await import(join(repo, "lib/server/db.ts"));
const store = await import(join(repo, "lib/server/asset-store.ts"));
const ingest = await import(join(repo, "lib/server/asset-ingest.ts"));
const list = await import(join(repo, "lib/server/asset-list.ts"));
const IMAGE_SIZE = pathToFileURL(join(repo, "node_modules/image-size/dist/index.mjs")).href;

// The warnings recordSendUses prints are not part of the fixture.
console.warn = () => {};

// ------------------------------- bytes -------------------------------

/** Numbers (one byte each), latin1 strings and arrays, concatenated. */
function bytesOf(...parts) {
  const o = [];
  const add = (p) => {
    if (typeof p === "number") o.push(p & 255);
    else if (typeof p === "string") for (const c of Buffer.from(p, "latin1")) o.push(c);
    else for (const x of p) add(x);
  };
  for (const p of parts) add(p);
  return Uint8Array.from(o);
}
const be16 = (n) => [n >>> 8, n];
const be32 = (n) => [n >>> 24, n >>> 16, n >>> 8, n];
const le16 = (n) => [n, n >>> 8];
const le32 = (n) => [n, n >>> 8, n >>> 16, n >>> 24];
const zeros = (n) => new Array(n).fill(0);
const utf8 = (s) => [...Buffer.from(s, "utf8")];
const hex = (b) => Buffer.from(b).toString("hex");
const sha = (b) => createHash("sha256").update(b).digest("hex");
/** Little-endian bit fields `[value, bits]`, as the JXL reader takes them. */
function bitsLE(fields) {
  const o = [];
  let cur = 0;
  let pos = 0;
  for (const [v, n] of fields) {
    for (let i = 0; i < n; i++) {
      cur |= ((v >>> i) & 1) << pos;
      pos += 1;
      if (pos === 8) {
        o.push(cur);
        cur = 0;
        pos = 0;
      }
    }
  }
  if (pos) o.push(cur);
  return o;
}
const box = (name, ...body) => {
  const b = bytesOf(...body);
  return [...be32(8 + b.length), ...Buffer.from(name, "latin1"), ...b];
};

const PNG_SIG = [0x89, ..."PNG\r\n\x1a\n".split("").map((c) => c.charCodeAt(0))];
const png = (w, h) => bytesOf(PNG_SIG, be32(13), "IHDR", be32(w), be32(h), 8, 6, 0, 0, 0, be32(0x1234abcd));
const ifdLE = (entries) => [...le16(entries.length), ...entries.flatMap(([t, ty, c, v]) => [...le16(t), ...le16(ty), ...le32(c), ...(ty === 3 ? [...le16(v), 0, 0] : le32(v))]), ...le32(0)];
const ifdBE = (entries) => [...be16(entries.length), ...entries.flatMap(([t, ty, c, v]) => [...be16(t), ...be16(ty), ...be32(c), ...(ty === 3 ? [...be16(v), 0, 0] : be32(v))]), ...be32(0)];
const icoEntry = (w, h) => [w, h, 0, 0, ...le16(1), ...le16(32), ...le32(40), ...le32(22)];
const jpeg = (marker, w, h, extra = []) =>
  bytesOf(0xff, 0xd8, extra, 0xff, 0xe0, be16(16), "JFIF\0", 1, 1, 0, be16(1), be16(1), 0, 0, 0xff, marker, be16(17), 8, be16(h), be16(w), 3, zeros(9), 0xff, 0xd9);
const exif = (bigEndian, orientation, count = 1, format = 3) => {
  const b16 = bigEndian ? be16 : le16;
  const b32 = bigEndian ? be32 : le32;
  const tiff = [...(bigEndian ? [0x4d, 0x4d] : [0x49, 0x49]), ...b16(42), ...b32(8), ...b16(1), ...b16(274), ...b16(format), ...b32(count), ...b16(orientation), 0, 0, ...b32(0)];
  const payload = [...Buffer.from("Exif\0\0", "latin1"), ...tiff];
  return [0xff, 0xe1, ...be16(payload.length + 2), ...payload];
};
const jpegExif = (bigEndian, orientation, w, h, count, format) =>
  bytesOf(0xff, 0xd8, exif(bigEndian, orientation, count, format), 0xff, 0xc0, be16(17), 8, be16(h), be16(w), 3, zeros(9), 0xff, 0xd9);
const jxlStream = (fields) => bytesOf(0xff, 0x0a, bitsLE(fields), zeros(4));
const ftyp = (brand) => box("ftyp", brand, be32(0), brand);
const heif = (brand, ipco) => bytesOf(box("ftyp", brand, be32(0), "mif1", brand), box("meta", be32(0), box("hdlr", zeros(4)), box("iprp", box("ipco", ...ipco))));
const ispe = (w, h) => box("ispe", be32(0), be32(w), be32(h));
const svg = (s) => bytesOf(utf8(s));

const SEEDS = {
  png: png(640, 480),
  pngHuge: png(0xffffffff, 1),
  pngZero: png(0, 0),
  pngFried: bytesOf(PNG_SIG, be32(4), "CgBI", 0x50, 0, 0x20, 2, be32(0), be32(13), "IHDR", be32(57), be32(114), 8, 6, 0, 0, 0, be32(0)),
  pngNoIhdr: bytesOf(PNG_SIG, be32(0), "IEND", be32(0xae426082)),
  gif89: bytesOf("GIF89a", le16(320), le16(200), 0xf7, 0, 0, ";"),
  gif87: bytesOf("GIF87a", le16(1), le16(65535), 0, 0, 0),
  gif88: bytesOf("GIF88a", le16(5), le16(5), 0, 0, 0),
  bmp: bytesOf("BM", le32(70), 0, 0, 0, 0, le32(54), le32(40), le32(123), le32(45), le16(1), le16(24), zeros(24)),
  bmpNeg: bytesOf("BM", le32(70), 0, 0, 0, 0, le32(54), le32(40), le32(7), le32(-45), le16(1), le16(24), zeros(24)),
  bmpMin: bytesOf("BM", le32(70), 0, 0, 0, 0, le32(54), le32(40), le32(0xffffffff), le32(0x80000000), le16(1), le16(24)),
  dds: bytesOf("DDS ", le32(124), le32(0x1007), le32(256), le32(512), zeros(108)),
  psd: bytesOf("8BPS", be16(1), zeros(6), be16(3), be32(300), be32(400), be16(8), be16(3)),
  ico1: bytesOf(le16(0), le16(1), le16(1), icoEntry(16, 16), zeros(8)),
  ico3: bytesOf(le16(0), le16(1), le16(3), icoEntry(16, 16), icoEntry(0, 0), icoEntry(48, 64), zeros(8)),
  icoShort: bytesOf(le16(0), le16(1), le16(4), icoEntry(32, 32)),
  cur: bytesOf(le16(0), le16(2), le16(2), icoEntry(32, 32), icoEntry(64, 16), zeros(4)),
  tiffLE: bytesOf("II", le16(42), le32(8), ifdLE([[256, 3, 1, 1024], [257, 4, 1, 768], [259, 3, 1, 5]]), zeros(16)),
  tiffBE: bytesOf("MM", be16(42), be32(8), ifdBE([[256, 4, 1, 77], [257, 3, 1, 33]]), zeros(16)),
  tiffNoHeight: bytesOf("II", le16(42), le32(8), ifdLE([[256, 3, 1, 10], [258, 3, 1, 8]]), zeros(16)),
  tiffCount2: bytesOf("II", le16(42), le32(8), ifdLE([[256, 3, 2, 10], [257, 3, 1, 8], [256, 3, 1, 9]]), zeros(16)),
  bigtiff: bytesOf("II", le16(43), le16(8), le16(0), le32(16), le32(0), le32(2), le32(0), le16(256), le16(16), le32(1), le32(0), le32(4000), le32(0), le16(257), le16(4), le32(1), le32(0), le32(3000), le32(0), zeros(24)),
  bigtiffBad: bytesOf("MM", be16(43), be16(4), be16(0), zeros(16)),
  webpLossy: bytesOf("RIFF", le32(40), "WEBP", "VP8 ", le32(20), 0x30, 1, 0, 0x9d, 1, 0x2a, le16(550), le16(368), zeros(6)),
  webpLossyTag47: bytesOf("RIFF", le32(40), "WEBP", "VP8 ", le32(20), 47, 1, 0, 0x9d, 1, 0x2a, le16(550), le16(368), zeros(6)),
  webpLossless: bytesOf("RIFF", le32(40), "WEBP", "VP8L", le32(20), 0x2f, 0xff, 0xc3, 0x55, 0x0a, zeros(10)),
  webpExtended: bytesOf("RIFF", le32(40), "WEBP", "VP8X", le32(10), 0x10, 0, 0, 0, 0x1f, 3, 0, 0xc7, 1, 0, zeros(10)),
  webpExtendedBad: bytesOf("RIFF", le32(40), "WEBP", "VP8X", le32(10), 0xc0, 0, 0, 0, 1, 0, 0, 1, 0, 0),
  webpUnknown: bytesOf("RIFF", le32(40), "WEBP", "VP8Z", le32(10), zeros(12)),
  jpeg: jpeg(0xc0, 1920, 1080),
  jpegProgressive: jpeg(0xc2, 33, 44),
  jpegC1: jpeg(0xc1, 5, 6),
  jpegNoSof: bytesOf(0xff, 0xd8, 0xff, 0xe0, be16(16), "JFIF\0", 1, 1, 0, be16(1), be16(1), 0, 0, 0xff, 0xd9),
  jpegExifBE: jpegExif(true, 6, 400, 300),
  jpegExifLE: jpegExif(false, 3, 7, 9),
  jpegExifCount2: jpegExif(true, 6, 11, 12, 2),
  jpegExifFormat4: jpegExif(false, 8, 13, 14, 1, 4),
  jpegExifZero: jpegExif(true, 0, 15, 16),
  jpegPadded: bytesOf(0xff, 0xd8, 0xff, 0xe0, be16(4), 0, 0, 0, 0, 0, 0xff, 0xc0, be16(17), 8, be16(21), be16(22), zeros(10)),
  jxlSmall: jxlStream([[1, 1], [7, 5], [0, 3], [3, 5]]),
  jxlRatio: jxlStream([[1, 1], [2, 5], [5, 3]]),
  jxlRatio7: jxlStream([[0, 1], [1, 2], [999, 13], [7, 3]]),
  jxlLarge: jxlStream([[0, 1], [3, 2], [123456789, 30], [0, 3], [2, 2], [70000, 18]]),
  jxlBox: bytesOf(box("JXL ", 0x0d, 0x0a, 0x87, 0x0a), ftyp("jxl "), box("jxlc", 0xff, 0x0a, bitsLE([[1, 1], [3, 5], [1, 3]]), zeros(2))),
  jxlParts: bytesOf(box("JXL ", 0x0d, 0x0a, 0x87, 0x0a), ftyp("jxl "), box("jxlp", be32(0), 0xff, 0x0a), box("jxlp", be32(0x80000001), bitsLE([[1, 1], [9, 5], [0, 3], [4, 5]]), 0)),
  jxlNoStream: bytesOf(box("JXL ", 0x0d, 0x0a, 0x87, 0x0a), ftyp("jxl "), box("free", zeros(4))),
  jxlShortStream: bytesOf(box("JXL ", 0x0d, 0x0a, 0x87, 0x0a), ftyp("jxl "), box("jxlc", 0xff, 0x0a)),
  jp2: bytesOf(box("jP  ", 0x0d, 0x0a, 0x87, 0x0a), ftyp("jp2 "), box("jp2h", box("ihdr", be32(250), be32(350), be16(3), 7, 7, 0, 0))),
  jp2NoIhdr: bytesOf(box("jP  ", 0x0d, 0x0a, 0x87, 0x0a), ftyp("jp2 "), box("jp2h", box("colr", zeros(7)))),
  jp2Brand: bytesOf(box("jP  ", 0x0d, 0x0a, 0x87, 0x0a), ftyp("jpx "), box("jp2h")),
  j2c: bytesOf(0xff, 0x4f, 0xff, 0x51, be16(41), be16(0), be32(1000), be32(2000), zeros(16)),
  avif: heif("avif", [ispe(1200, 800)]),
  heicMulti: heif("heic", [ispe(100, 50), box("clap", be32(30), be32(1), be32(20)), ispe(300, 200)]),
  heicClapBig: heif("heix", [ispe(10, 10), box("clap", be32(25), be32(1))]),
  heifNoIpco: bytesOf(box("ftyp", "mif1", be32(0), "mif1"), box("meta", be32(0), box("iprp", box("xxxx")))),
  heifNoIspe: heif("msf1", [box("pixi", zeros(4))]),
  heifBrand: bytesOf(box("ftyp", "isom", be32(0), "isom"), zeros(8)),
  // A 512-byte ftyp starts `00 00 02 00 'f' 't'`, which CUR's validator also
  // takes: only the first-byte shortcut makes it HEIF.
  heifCurPrefix: bytesOf(box("ftyp", "mif1", be32(0), "mif1", "avif", zeros(512 - 24)), box("meta", be32(0), box("hdlr", zeros(4)), box("iprp", box("ipco", ispe(64, 48))))),
  // A clap box right after ipco ends is not ipco's: no crop.
  heifClapAfterIpco: bytesOf(box("ftyp", "heic", be32(0), "mif1", "heic"), box("meta", be32(0), box("hdlr", zeros(4)), box("iprp", box("ipco", ispe(40, 30)), box("clap", be32(7), be32(5))))),
  icns: bytesOf("icns", be32(8 + 16 + 12), "ic08", be32(16), zeros(8), "is32", be32(12), zeros(4)),
  icnsUnknown: bytesOf("icns", be32(8 + 12), "zzzz", be32(12), zeros(4)),
  icnsOne: bytesOf("icns", be32(8 + 8), "ic10", be32(8)),
  icnsEmpty: bytesOf("icns", be32(8)),
  ktx1: bytesOf(0xab, "KTX 11", 0xbb, 0x0d, 0x0a, 0x1a, 0x0a, le32(0x04030201), zeros(20), le32(128), le32(64), zeros(8)),
  ktx2: bytesOf(0xab, "KTX 20", 0xbb, 0x0d, 0x0a, 0x1a, 0x0a, zeros(8), le32(17), le32(19), zeros(8)),
  pnmP6: svg("P6\n640 480\n255\n"),
  pnmP1: svg("P1\n# a comment\n#another\n3 2\n1 0 1\n"),
  pnmCRLF: svg("P5\r\n\r\n12 34\r\n255"),
  pnmBad: svg("P2\n1 2 3\n"),
  pnmNaN: svg("P3\nabc def\n"),
  pnmDouble: svg("P4\n10  20\n"),
  pnmEmpty: svg("P6"),
  pnmSigOnly: svg("P6\n"),
  pam: svg("P7\nWIDTH 4\nHEIGHT 2\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n"),
  pamLower: svg("P7\nwidth 9\nheight 0\nheight 3\n"),
  pamLong: svg("P7\nWIDTH 12345678901234567\nHEIGHT 5\nWIDTH 6\n"),
  pamNone: svg("P7\nDEPTH 4\n"),
  pfm: svg("PF\n7 8\n-1.0\n"),
  tga: bytesOf(0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, le16(800), le16(600), 32, 8),
  svgDims: svg('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"></svg>'),
  svgViewBox: svg("<svg viewBox='0 0 300 150'></svg>"),
  svgViewBoxW: svg('<svg width="60" viewBox="0 0 300 150">'),
  svgViewBoxH: svg('<svg height="7" viewbox="0 0 300 150">'),
  svgUnits: svg('<svg width="2in" height="3cm">'),
  svgUnits2: svg('<svg width="10px" height="5pt"><g/></svg>'),
  svgUnits3: svg('<svg width="1.5em" height="2ex">'),
  svgUnits4: svg('<svg width="1m" height="3mm" >'),
  svgUnits5: svg('<svg width="4pc" height="1e2">'),
  svgPercent: svg('<svg width="100%" height="50" viewBox="0 0 10 20">'),
  svgNaN: svg('<svg width="1.2.3" height="5">'),
  svgInf: svg("<svg width='10' height='1e400'>"),
  svgComma: svg('<svg viewBox="0,0,100,50">'),
  svgUpper: svg('<SVG width="1" height="1">'),
  // width / height are case-sensitive (only viewBox's regex has `i`).
  svgUpperWidth: svg('<svg WIDTH="7" height="3" viewBox="0 0 20 10">'),
  svgUpperHeight: svg('<svg width="7" HEIGHT="3" viewBox="0 0 20 10">'),
  svgXml: svg('<?xml version="1.0"?>\n<!-- a > b -->\n<svg\n  width="12"\n  height="13">'),
  svgNbsp: svg('<svg\u00a0width="21" height="22">'),
  svgDataAttr: svg('<svg data-width="99" width="5" height="6">'),
  svgBom: svg('\ufeff<svg width="31" height="32">'),
  svgFar: svg(`<!--${"x".repeat(990)}--><svg width="41" height="42">`),
  svgQuoted: svg(`<svg title="a>b" width="51" height="52" alt='c>d'>`),
  svgMixedQuote: svg(`<svg width="61' height="62">`),
  svgEmptyWidth: svg('<svg width="" height="5" viewBox="0 0 2 4">'),
  svgZero: svg('<svg width="0" height="0" viewBox="0 0 0 0">'),
  svgSpaceUnit: svg('<svg width="10 px" height="3">'),
  svgLeadingDot: svg('<svg width=".5" height="2.5">'),
  svgNegative: svg('<svg width="-5" height="5" viewBox="0 0 -4 2">'),
  empty: bytesOf(),
  oneByte: bytesOf(0),
  hello: bytesOf("hello world, not an image"),
  bmOnly: bytesOf("BM"),
  zeros16: bytesOf(zeros(16)),
  ffd8Only: bytesOf(0xff, 0xd8),
  riffOnly: bytesOf("RIFF", le32(4), "WEBP"),
};
/** The package's three loops that never end on a zero-size entry. */
// Also a valid SVG, which comes before webp in the validators' order: only
// the first-byte shortcut ("R" is webp) makes these webp. Not mutated (kept
// out of SEEDS so the seeded mutations stay the same).
const SHORTCUT = {
  webpAlsoSvg: bytesOf("RIFF", le32(40), "WEBP", "VP8 ", le32(20), 0x30, 1, 0, 0x9d, 1, 0x2a, le16(550), le16(368), zeros(6), '<svg width="7" height="9">'),
  webpBadAlsoSvg: bytesOf("RIFF", le32(40), "WEBP", "VP8Z", le32(10), zeros(12), '<svg width="7" height="9">'),
};

const HANGS = {
  icnsZero: bytesOf("icns", be32(64), "ic08", be32(0), zeros(8)),
  heifZeroIspe: heif("avif", [box("ispe", be32(0), be32(1), be32(1)).map((b, i) => (i < 4 ? 0 : b))]),
  jxlpZero: bytesOf(box("JXL ", 0x0d, 0x0a, 0x87, 0x0a), ftyp("jxl "), [0, 0, 0, 0, ..."jxlp".split("").map((c) => c.charCodeAt(0)), 0, 0, 0, 0]),
};

// ------------------------------- imageSize -------------------------------

const WORKER = `
const { parentPort } = require("node:worker_threads");
let mod;
parentPort.on("message", async (m) => {
  mod ??= import(${JSON.stringify(IMAGE_SIZE)});
  const { imageSize } = await mod;
  const bytes = Buffer.from(m, "hex");
  const b = Buffer.alloc(bytes.length);
  b.set(bytes);
  try {
    const r = imageSize(b);
    parentPort.postMessage({ w: String(r.width), h: String(r.height) });
  } catch {
    parentPort.postMessage({ threw: true });
  }
});`;
let worker = null;
let pending = null;
function startWorker() {
  const w = new Worker(WORKER, { eval: true, resourceLimits: { maxOldGenerationSizeMb: 128 } });
  w.on("message", (m) => {
    const p = pending;
    pending = null;
    p?.(m);
  });
  w.on("error", () => {
    if (worker === w) worker = null;
    const p = pending;
    pending = null;
    p?.({ hang: true });
  });
  worker = w;
}
function sizeOf(bytes) {
  if (!worker) startWorker();
  return new Promise((done) => {
    const timer = setTimeout(() => {
      pending = null;
      const w = worker;
      worker = null;
      void w?.terminate();
      done({ hang: true });
    }, 3000);
    pending = (m) => {
      clearTimeout(timer);
      done(m);
    };
    worker.postMessage(hex(bytes));
  });
}

/** mulberry32: a seeded PRNG, so every run fuzzes the same bytes. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = prng(0xa55e7);
const ri = (n) => Math.floor(rand() * n);
function mutate(b) {
  const x = Array.from(b);
  switch (ri(5)) {
    case 0: {
      const k = 1 + ri(3);
      for (let i = 0; i < k && x.length; i++) x[ri(x.length)] = ri(256);
      return x;
    }
    case 1:
      return x.slice(0, ri(x.length + 1));
    case 2: {
      const k = 1 + ri(8);
      for (let i = 0; i < k; i++) x.push(ri(256));
      return x;
    }
    case 3: {
      if (x.length < 4) return x;
      const at = ri(x.length - 3);
      const v = [0, 255, 1, 128][ri(4)];
      for (let i = 0; i < 4; i++) x[at + i] = v;
      return x;
    }
    default: {
      if (!x.length) return x;
      const at = ri(x.length);
      x.splice(at, 1 + ri(4));
      return x;
    }
  }
}

const imageCases = [];
for (const [name, b] of [...Object.entries(SEEDS), ...Object.entries(SHORTCUT), ...Object.entries(HANGS)]) {
  imageCases.push({ name, hex: hex(b), ...(await sizeOf(b)) });
}
const seen = new Set(imageCases.map((c) => c.hex));
for (const [name, b] of Object.entries(SEEDS)) {
  for (let k = 0; k < 24; k++) {
    let m = mutate(b);
    if (rand() < 0.3) m = mutate(m);
    const h = hex(m);
    if (seen.has(h)) continue;
    seen.add(h);
    imageCases.push({ name: `${name}~${k}`, hex: h, ...(await sizeOf(Uint8Array.from(m))) });
  }
}
void worker?.terminate();

// ------------------------------- base64 -------------------------------

const B64 = [
  "",
  "aGVsbG8=",
  "aGVsbG8",
  "aGVsbA==",
  "aGVsbA=",
  "aGVsbA",
  "aGVs",
  "a",
  "ab",
  "abc",
  "abcd",
  "abcde",
  "====",
  "=abc",
  "ab=cd",
  "ab==cd",
  "a=b=c",
  "aGVs bG8=",
  "aGVs\nbG8=\n",
  "\taGVsbG8=\r\n",
  "aGV-bG8_",
  "+/+/",
  "-_-_",
  "!!!!",
  "a!b@c#d$",
  "aGVsbG8=aGVsbG8=",
  "aGVsbG8=!!",
  "QUJD\u00e9REVG",
  "QUJD\u0141\u0141",
  "\u4e41\u4e42\u4e43\u4e44",
  "QUJD\ud83d\ude00RA==",
  "\u00ff\u00fe\u00fd\u00fc",
  "AAAA".repeat(64),
  "/w==",
  "//8=",
  "///",
  "\u0000AAAA",
];
const B64_ALPHABET = "ABCDxyz0129+/-_=  \t\n\r.!*\u00e9\u0141";
for (let i = 0; i < 300; i++) {
  let s = "";
  const n = ri(40);
  for (let j = 0; j < n; j++) s += B64_ALPHABET[ri(B64_ALPHABET.length)];
  B64.push(s);
}
const base64 = B64.map((s) => ({ s, hex: Buffer.from(s, "base64").toString("hex") }));

// ------------------------------- Date.parse -------------------------------

const DATES = [
  "2026-01-01T00:00:00.000Z",
  "2026-01-01T00:00:00Z",
  "2026-01-01T00:00:00",
  "2026-07-01T12:34:56.789",
  "2026-01-01T00:00",
  "2026-01-01",
  "2026-01",
  "2026",
  "2026-02-30",
  "2026-02-29T00:00:00Z",
  "2026-12-31T23:59:59.999Z",
  "2026-01-01T24:00:00Z",
  "2026-01-01T24:00:00.000Z",
  "2026-01-01T24:00:00.001Z",
  "2026-01-01T24:01Z",
  "2026-01-01T23:60:00Z",
  "2026-01-01T23:59:60Z",
  "2026-01-01T00:00:00.1Z",
  "2026-01-01T00:00:00.12Z",
  "2026-01-01T00:00:00.123456Z",
  "2026-01-01T00:00:00.0001234567891Z",
  "2026-01-01T00:00:00.Z",
  "2026-01-01T00:00:00+05:30",
  "2026-01-01T00:00:00-0800",
  "2026-01-01T00:00:00+23:59",
  "2026-01-01T00:00:00+24:00",
  "2026-01-01T00:00:00+5:30",
  "2026-01-01T00:00+0130",
  "2026-01-01t00:00:00z",
  "2026-01-01 00:00:00Z",
  "2026-01-01 10:00",
  " 2026-01-01",
  "2026-01-01T00:00:00Z ",
  "+002026-01-01T00:00:00Z",
  "-000001-01-01T00:00:00Z",
  "-000000-01-01T00:00:00Z",
  "+275760-09-13T00:00:00.000Z",
  "+275760-09-13T00:00:00.001Z",
  "-271821-04-20T00:00:00.000Z",
  "-271821-04-19T23:59:59.999Z",
  "+275760-09-13",
  "275760-09-13T00:00:00.001Z",
  "0000-01-01T00:00:00Z",
  "1969-12-31T23:59:59.999Z",
  "1970-01-01",
  "1900-06-01T00:00:00",
  "1883-11-18T12:00:00",
  "2026-13-01",
  "2026-00-10",
  "2026-01-32",
  "2026-01-00",
  "2026-1-1",
  "26-01-01",
  "2026-03-08T02:30:00",
  "2026-03-08T01:59:59",
  "2026-03-08T03:00:00",
  "2026-11-01T01:30:00",
  "2026-11-01T00:59:59",
  "2026-11-01T02:00:00",
  "2026-11-01T01:00:00",
  "2026-11-01T01:59:59.999",
  "2026-11-01T02:00:00.001",
  "2026-11-01T02:30:00",
  "2026-03-08T02:00:00",
  "2026-03-08T02:59:59.999",
  "2026-01-01T00:00:00.1234Z",
  "2026-01-01T00:00:00.12345678Z",
  "1883-11-18T11:59:59",
  "-009999-06-01T12:00:00",
  "9999-06-01T12:00:00",
  "9999-12-31T22:00:00",
  "+010000-07-04T12:00:00",
  "+020000-01-15T00:00:00",
  "+275760-09-12T19:00:00",
  "+275760-09-12T20:00:00",
  "+275760-09-22T20:00:00",
  "-010000-07-04T12:00:00",
  "-271821-04-20T00:00:00",
  "-271821-04-19T19:03:58",
  "-271821-04-19T19:03:57.999",
  "2026-06-15T12:00:00.5",
  "Thu, 01 Jan 2026 00:00:00 GMT",
  "January 1, 2026",
  "2026/01/01",
  "yesterday",
  "",
  "Z",
  "T",
  "2026-01-01T",
  "2026-01-01T00",
  "2026-01-01T00:00:00ZZ",
  "2026-01-01T00:00:00.000+00:00",
  "2026-01-01T00:00:00.000-00:00",
  "\u20132026-01-01",
  "\uff12026-01-01",
  "2026-01-01T00:00:00\u00a0",
  "999999999-01-01",
  "+999999-01-01",
  "2026-01-01T00:00:00.000000000000000000001Z",
  "2026-01-01T00:00:00.00000000000000000000099Z",
];
const dateParse = { tz: TZ, cases: DATES.map((s) => ({ s, ms: String(Date.parse(s)) })) };

// ------------------------------- extFor -------------------------------

const EXTS = [
  "image/png",
  "IMAGE/PNG",
  "Image/Jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "image/heic",
  "image/avif",
  "application/pdf",
  "image/x-icon",
  "image/png ",
  "",
  "constructor",
  "CONSTRUCTOR",
  "__proto__",
  "toString",
  "tostring",
  "hasOwnProperty",
  "valueOf",
  "\u0130MAGE/PNG",
  "image/png\u0000",
];
// `String()`: a template literal is how the store uses it.
const extFor = EXTS.map((m) => ({ m, ext: String(store.extFor(m)) }));

// ------------------------------- core -------------------------------

const CWD = { a: "/claudius-golden/a", aSlash: "/claudius-golden/a/", b: "/claudius-golden/b", c: "/claudius-golden/c", d: "/claudius-golden/broken", e: "" };
const b64 = (b) => Buffer.from(b).toString("base64");
const IMG = {
  png: b64(SEEDS.png),
  png2: b64(png(2, 3)),
  png3: b64(png(4, 5)),
  gif: b64(SEEDS.gif89),
  svg: b64(SEEDS.svgDims),
  svgNaN: b64(SEEDS.svgNaN),
  svgInf: b64(SEEDS.svgInf),
  svgNone: b64(SEEDS.svgComma),
  jpeg: b64(SEEDS.jpegExifBE),
  webp: b64(SEEDS.webpLossless),
  ico: b64(SEEDS.ico3),
  heic: b64(SEEDS.heicMulti),
  garbage: b64(bytesOf("this is certainly not an image file")),
  pdf: b64(bytesOf("%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n1 0 obj\n<<>>\nendobj\n")),
  big: b64(bytesOf(png(9999, 8888), Array.from({ length: 10000 }, (_, i) => (i * 7 + 3) & 255))),
};
const I = (data, mediaType, ordinal) => (ordinal === undefined ? { data, mediaType } : { data, mediaType, ordinal });
const REC = (cwd, sessionId, messageUuid, occurredMs, images) => ({ op: "record", cwd, sessionId, messageUuid, occurredMs, images });
const L = (opts) => ({ op: "list", opts });
const hashOf = (data) => sha(Buffer.from(data, "base64"));
const H = Object.fromEntries(Object.entries(IMG).map(([k, v]) => [k, hashOf(v)]));
const userLine = (o) =>
  JSON.stringify({
    type: "user",
    ...o,
    message: o.message ?? { role: "user", content: o.content },
    content: undefined,
  });
const imgBlock = (data, media_type = "image/png", extra = {}) => ({ type: "image", source: { type: "base64", media_type, data, ...extra } });

const C = [
  // No images: nothing opened. A cwd that encodes to "": the DB opens at
  // the projects root, the store refuses.
  REC(CWD.e, "s0", "m0", 1, []),
  { op: "ls", rel: ".claude/projects" },
  REC(CWD.e, "s0", "m0", 1, [I(IMG.png, "image/png")]),
  { op: "ls", rel: ".claude/projects" },
  // Two images, then the same send again.
  REC(CWD.a, "s1", "m1", 1000, [I(IMG.png, "image/png"), I(IMG.gif, "image/gif")]),
  { op: "rows", cwd: CWD.a },
  { op: "files", cwd: CWD.a },
  REC(CWD.a, "s1", "m1", 1000, [I(IMG.png, "image/png"), I(IMG.gif, "image/gif")]),
  REC(CWD.a, "s1", "m1", 900, [I(IMG.png, "image/png")]),
  { op: "rows", cwd: CWD.a },
  // Every kind of image and not-an-image; dims only for image/* types.
  REC(CWD.a, "s2", "m2", 500, [
    I(IMG.png, "image/png", 7),
    I(IMG.svg, "image/svg+xml"),
    I(IMG.jpeg, "image/jpeg"),
    I(IMG.garbage, "image/png"),
    I(IMG.pdf, "application/pdf"),
    I(IMG.png2, "IMAGE/PNG"),
    I(IMG.webp, "image/webp"),
    I(IMG.ico, "image/x-icon"),
    I(IMG.heic, "image/heic"),
    I(IMG.svgNaN, "image/svg+xml"),
    I(IMG.svgInf, "image/svg+xml"),
    I(IMG.svgNone, "image/svg+xml"),
  ]),
  // Ordinals as given (any number), else the 1-based position.
  REC(CWD.a, "s3", "m3", 2000, [I(IMG.png, "image/png", 0), I(IMG.png, "image/png", -1.5), I(IMG.png, "image/png", 1e300), I(IMG.png, "image/png"), I(IMG.png, "image/png", 2 ** 53 + 2)]),
  // A type that names Object.prototype members, and the same bytes under
  // another type: the row keeps its first type, the file is per type.
  REC(CWD.a, "s1", "m4", 3000, [I(IMG.png3, "constructor"), I(IMG.png3, "__proto__"), I(IMG.png3, ""), I(IMG.png3, "text/plain")]),
  // Odd base64.
  REC(CWD.a, "s4", "m5", 1500, [
    I("", "image/png"),
    I("!!!!", "image/gif"),
    I(`${IMG.png.slice(0, 10)}\n ${IMG.png.slice(10)}`, "image/png"),
    I(IMG.gif.replace(/\+/g, "-").replace(/\//g, "_"), "image/gif"),
    I(`${IMG.png}=${IMG.gif}`, "image/png"),
  ]),
  // Past Node's pool size, and the same bytes twice in one send.
  REC(CWD.a, "s5", "m6", 4000, [I(IMG.big, "image/png"), I(IMG.big, "image/png")]),
  REC(CWD.a, "s6", "m7", 2500, []),
  // A trailing slash is another project.
  REC(CWD.aSlash, "s7", "m8", 10, [I(IMG.png, "image/png")]),
  { op: "rows", cwd: CWD.a },
  { op: "files", cwd: CWD.a },
  { op: "ls", rel: ".claude/projects" },
  // Listing.
  L({ scope: "project", cwd: CWD.a }),
  L({ scope: "project", cwd: CWD.a, type: "image" }),
  L({ scope: "project", cwd: CWD.a, type: "file" }),
  L({ scope: "project", cwd: CWD.a, type: "bogus" }),
  L({ scope: "project", cwd: CWD.a, q: H.png.slice(0, 4) }),
  L({ scope: "project", cwd: CWD.a, q: "s2" }),
  L({ scope: "project", cwd: CWD.a, q: "%" }),
  L({ scope: "project", cwd: CWD.a, q: "_" }),
  L({ scope: "project", cwd: CWD.a, q: "zz" }),
  L({ scope: "project", cwd: CWD.a, q: H.png.toUpperCase().slice(0, 6) }),
  L({ scope: "project", cwd: CWD.a, limit: 1 }),
  L({ scope: "project", cwd: CWD.a, limit: 2, cursor: 3000 }),
  L({ scope: "project", cwd: CWD.a, limit: 2, cursor: 1000 }),
  L({ scope: "project", cwd: CWD.a, limit: 2.5 }),
  L({ scope: "project", cwd: CWD.a, limit: -5 }),
  L({ scope: "project", cwd: CWD.a, limit: 0 }),
  L({ scope: "project", cwd: CWD.a, limit: 1e9 }),
  L({ scope: "project", cwd: CWD.a, limit: 500.5 }),
  L({ scope: "project", cwd: CWD.a, cursor: Number.NaN }),
  L({ scope: "project", cwd: CWD.a, cursor: 1e20 }),
  L({ scope: "project", cwd: CWD.a, cursor: 0 }),
  L({ scope: "project", cwd: CWD.a, type: "image", q: "s", limit: 3, cursor: 2500 }),
  L({ scope: "project", cwd: CWD.c }),
  L({ scope: "account", cwd: CWD.a }),
  L({ scope: "bogus", cwd: CWD.a, limit: 3 }),
  L({ scope: "account", cwd: CWD.a, q: H.png.slice(0, 2) }),
  L({ scope: "account", cwd: CWD.a, q: "s2" }),
  L({ scope: "account", cwd: CWD.a, limit: 2, cursor: 2000 }),
  L({ scope: "account", cwd: CWD.a, limit: 2.5 }),
  L({ scope: "account", cwd: CWD.a, cursor: Number.NaN }),
  L({ scope: "account", cwd: CWD.a, type: "file" }),
  // Uses, meta, delete.
  { op: "uses", cwd: CWD.a, hash: H.png },
  { op: "uses", cwd: CWD.a, hash: "nope" },
  { op: "uses", cwd: CWD.b, hash: H.png },
  { op: "meta", cwd: CWD.a, hash: H.png },
  { op: "meta", cwd: CWD.a, hash: H.svgNaN },
  { op: "meta", cwd: CWD.a, hash: "nope" },
  { op: "meta", cwd: CWD.a, hash: "" },
  { op: "delrow", cwd: CWD.a, hash: H.gif },
  { op: "delrow", cwd: CWD.a, hash: H.gif },
  { op: "uses", cwd: CWD.a, hash: H.gif },
  { op: "rows", cwd: CWD.a },
  // The store directly.
  { op: "write", cwd: CWD.b, hex: hex(SEEDS.png), mediaType: "image/png" },
  { op: "write", cwd: CWD.b, hex: hex(SEEDS.png), mediaType: "image/png" },
  { op: "write", cwd: CWD.b, hex: hex(SEEDS.png), mediaType: "IMAGE/JPG" },
  { op: "write", cwd: CWD.b, hex: "", mediaType: "" },
  { op: "write", cwd: CWD.e, hex: "00", mediaType: "image/png" },
  { op: "read", cwd: CWD.b, hash: sha(SEEDS.png), mediaType: "image/png" },
  { op: "read", cwd: CWD.b, hash: sha(SEEDS.png), mediaType: "image/gif" },
  { op: "read", cwd: CWD.b, hash: "nope", mediaType: "image/png" },
  { op: "read", cwd: CWD.e, hash: "nope", mediaType: "image/png" },
  { op: "del", cwd: CWD.b, hash: sha(SEEDS.png), mediaType: "image/jpeg" },
  { op: "del", cwd: CWD.b, hash: sha(SEEDS.png), mediaType: "image/jpeg" },
  { op: "read", cwd: CWD.b, hash: sha(SEEDS.png), mediaType: "image/jpeg" },
  { op: "del", cwd: CWD.e, hash: "nope", mediaType: "image/png" },
  { op: "files", cwd: CWD.b },
  // Something already at an asset path: kept (a folder counts).
  { op: "mkdir", rel: `.claude/projects/-claudius-golden-b/assets/${sha(SEEDS.gif89).slice(0, 2)}/${sha(SEEDS.gif89)}.gif` },
  { op: "write", cwd: CWD.b, hex: hex(SEEDS.gif89), mediaType: "image/gif" },
  { op: "read", cwd: CWD.b, hash: sha(SEEDS.gif89), mediaType: "image/gif" },
  // A file where the shard folder goes: the write fails, so does the send.
  { op: "file", rel: `.claude/projects/-claudius-golden-b/assets/${sha(SEEDS.bmp).slice(0, 2)}`, text: "x" },
  { op: "write", cwd: CWD.b, hex: hex(SEEDS.bmp), mediaType: "image/bmp" },
  REC(CWD.b, "s1", "m1", 77, [I(b64(SEEDS.bmp), "image/bmp"), I(IMG.png, "image/png")]),
  { op: "rows", cwd: CWD.b },
  // Hashes another writer stored: escaping ones read outside the store in
  // TS (the port refuses), odd ones are just names.
  { op: "file", rel: ".claude/projects/-claudius-golden-b/escape.png", text: "outside the store" },
  { op: "read", cwd: CWD.b, hash: "./../escape", mediaType: "image/png", rustRefuses: true },
  { op: "read", cwd: CWD.b, hash: "../-claudius-golden-b/escape", mediaType: "image/png", rustRefuses: true },
  { op: "read", cwd: CWD.b, hash: "../../nothing-here", mediaType: "image/png" },
  { op: "read", cwd: CWD.b, hash: "a/b", mediaType: "image/png" },
  { op: "read", cwd: CWD.b, hash: "\u00e91", mediaType: "image/png" },
  { op: "write", cwd: CWD.b, hex: hex(bytesOf("\u00e9")), mediaType: "image/png" },
  { op: "del", cwd: CWD.b, hash: "../../nothing-here", mediaType: "image/png" },
  { op: "del", cwd: CWD.b, hash: "./../escape", mediaType: "image/png", rustRefuses: true },
  { op: "read", cwd: CWD.b, hash: "./../escape", mediaType: "image/png" },
  { op: "files", cwd: CWD.b },
  // Rows from another writer (any column type SQLite keeps).
  {
    op: "sql",
    cwd: CWD.b,
    sql: [
      "INSERT INTO assets VALUES ('t-text', 'image/png', 3, 'w', X'00', 5, 'abc');",
      "INSERT INTO assets VALUES ('t-blob', X'696d6167652f706e67', 4.5, 1.5, NULL, 6, X'3132');",
      "INSERT INTO assets VALUES ('t-real', 'application/x', 9007199254740993, 2.5, 7, 7, 1500.5);",
      "INSERT INTO assets VALUES ('t-big', 'image/gif', 1, 1e300, -0.0, 8, 9007199254740993);",
      "INSERT INTO assets VALUES ('t-neg', 'image/gif', -1, -2, -3, 9, -100);",
      "INSERT INTO assets VALUES ('t-inf', 'IMAGE/GIF', 0, 9e999, -9e999, 10, 9e999);",
      "INSERT INTO assets VALUES ('t-str', 'image/jpeg', 2, 3, 4, 11, '2000');",
      "INSERT INTO assets VALUES (X'6d79', 'image/png', 2, 3, 4, 12, 1200);",
      "INSERT INTO asset_uses VALUES (X'6d79', X'7378', 'm', 1, 1);",
      "INSERT INTO asset_uses VALUES ('t-neg', X'7379', 'm', 1, 1);",
      "INSERT INTO asset_uses VALUES ('t-text', 'sx', 'mx', 1, 'when');",
      "INSERT INTO asset_uses VALUES ('t-text', 'sy', 'my', 1.5, 3.25);",
      "INSERT INTO asset_uses VALUES ('t-text', 'sz', 'mz', X'01', X'02');",
    ].join("\n"),
  },
  { op: "rows", cwd: CWD.b },
  L({ scope: "project", cwd: CWD.b }),
  L({ scope: "project", cwd: CWD.b, type: "image" }),
  L({ scope: "project", cwd: CWD.b, type: "file" }),
  L({ scope: "account", cwd: CWD.b, type: "image" }),
  L({ scope: "account", cwd: CWD.b, type: "file", limit: 4 }),
  L({ scope: "project", cwd: CWD.b, q: "6d" }),
  L({ scope: "account", cwd: CWD.b, q: "6d" }),
  L({ scope: "project", cwd: CWD.b, q: "x" }),
  L({ scope: "project", cwd: CWD.b, q: "s" }),
  L({ scope: "project", cwd: CWD.b, cursor: 1500 }),
  L({ scope: "project", cwd: CWD.b, limit: 3 }),
  L({ scope: "project", cwd: CWD.b, q: "t-" }),
  L({ scope: "account", cwd: CWD.b }),
  L({ scope: "account", cwd: CWD.b, cursor: 1500 }),
  L({ scope: "account", cwd: CWD.b, cursor: 100, limit: 4 }),
  L({ scope: "account", cwd: CWD.b, limit: 3 }),
  { op: "uses", cwd: CWD.b, hash: "t-text" },
  { op: "meta", cwd: CWD.b, hash: "t-blob" },
  { op: "meta", cwd: CWD.b, hash: "t-inf" },
  { op: "meta", cwd: CWD.b, hash: "t-text" },
  // A DB from a newer schema, without the tables.
  { op: "sql", cwd: CWD.d, fresh: true, sql: "CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO schema_meta VALUES ('version', '9999');" },
  REC(CWD.d, "s1", "m1", 5, [I(IMG.png, "image/png")]),
  { op: "files", cwd: CWD.d },
  L({ scope: "project", cwd: CWD.d }),
  { op: "uses", cwd: CWD.d, hash: H.png },
  { op: "meta", cwd: CWD.d, hash: H.png },
  { op: "delrow", cwd: CWD.d, hash: H.png },
  L({ scope: "account", cwd: CWD.d }),
  // Other folders under projects: a file, a folder without a DB, a DB
  // folder named like a file.
  { op: "file", rel: ".claude/projects/zz-file", text: "x" },
  { op: "mkdir", rel: ".claude/projects/zz-empty" },
  { op: "mkdir", rel: ".claude/projects/zz-dbdir/.claudius.db" },
  L({ scope: "account", cwd: CWD.a, limit: 500 }),
];

// Backfill: transcripts next to the DB.
const T = (cwd, name, text) => ({ op: "jsonl", cwd, name, text });
const C_LINES = [
  userLine({ uuid: "u1", timestamp: "2026-01-02T03:04:05.678Z", content: [imgBlock(IMG.png), { type: "text", text: "hi" }, imgBlock(IMG.gif, "image/gif")] }),
  JSON.stringify({ type: "assistant", uuid: "a1", message: { content: [imgBlock(IMG.png3)] } }),
  "not json",
  "{not json either",
  ` ${userLine({ uuid: "u-space", timestamp: "2026-01-01T00:00:00Z", content: [imgBlock(IMG.png2)] })}`,
  userLine({ uuid: "u2", timestamp: "2026-03-08T02:30:00", content: [imgBlock(IMG.jpeg, "image/jpeg")] }),
  userLine({ uuid: "u3", timestamp: "yesterday", content: [imgBlock(IMG.svg, "image/svg+xml")] }),
  userLine({ uuid: "u4", timestamp: 12345, content: [imgBlock(IMG.webp, "image/webp")] }),
  userLine({ timestamp: "2026-05-05T05:05:05+02:00", content: [imgBlock(IMG.ico, "image/x-icon")] }),
  userLine({ timestamp: "2026-05-05T05:05:05+02:00", content: [imgBlock(IMG.ico, "image/x-icon")] }),
  userLine({ uuid: "u5", timestamp: "2026-06-01T00:00:00Z", content: "plain text" }),
  userLine({ uuid: "u6", timestamp: "2026-06-01T00:00:00Z", message: "not an object" }),
  userLine({ uuid: "u7", timestamp: "2026-06-01T00:00:00Z", message: { content: { 0: imgBlock(IMG.png) } } }),
  userLine({
    uuid: "u8",
    timestamp: "2026-06-02T00:00:00Z",
    content: [
      null,
      7,
      { type: "image", source: { type: "url", url: "https://x/y.png" } },
      { type: "image", source: { type: "base64", data: 5 } },
      { type: "image", source: { type: "base64", data: IMG.png2 } },
      { type: "image", source: { type: "base64", media_type: null, data: IMG.png3 } },
      { type: "image", source: { type: "base64", media_type: 5, data: IMG.png } },
      imgBlock(IMG.heic, "image/heic"),
      { type: "Image", source: { type: "base64", media_type: "image/png", data: IMG.png } },
    ],
  }),
  userLine({ uuid: "u9", timestamp: "2026-11-01T01:30:00", content: [] }),
  `${userLine({ uuid: "u10", timestamp: "2026-11-01T01:30:00", content: [imgBlock(IMG.garbage)] })}\r`,
  JSON.stringify({ type: "user", uuid: "u11", timestamp: "2026-07-07T07:07:07Z", message: { content: [imgBlock(IMG.pdf, "application/pdf")] } }),
  "",
  "[1,2,3]",
];
C.push(
  { op: "backfill", cwd: CWD.c },
  { op: "ls", rel: ".claude/projects" },
  { op: "mkdir", rel: ".claude/projects/-claudius-golden-c" },
  { op: "backfill", cwd: CWD.c },
  T(CWD.c, "sess-a.jsonl", `${C_LINES.join("\n")}\n`),
  T(CWD.c, "sess-b.jsonl", `${userLine({ uuid: "b1", timestamp: "2026-02-02T02:02:02.002Z", content: [imgBlock(IMG.png), imgBlock(IMG.big)] })}\n`),
  T(CWD.c, "sess-bom.jsonl", `\ufeff${userLine({ uuid: "bom1", timestamp: "2026-02-03T00:00:00Z", content: [imgBlock(IMG.png2)] })}\n${userLine({ uuid: "bom2", timestamp: "2026-02-03T00:00:01Z", content: [imgBlock(IMG.png3)] })}`),
  { op: "jsonl", cwd: CWD.c, name: "sess-bad-utf8.jsonl", hex: hex(bytesOf(utf8(userLine({ uuid: "x\u00e9", timestamp: "2026-02-04T00:00:00Z", content: [imgBlock(IMG.gif, "image/gif")] }).replace("x\u00e9", "x\u00e9\u00e9")), 0x0a)).replace("c3a9c3a9", "c3ffa9") },
  T(CWD.c, "notes.txt", userLine({ uuid: "n1", timestamp: "2026-01-01T00:00:00Z", content: [imgBlock(IMG.png)] })),
  T(CWD.c, "empty.jsonl", ""),
  { op: "mkdir", rel: ".claude/projects/-claudius-golden-c/folder.jsonl" },
  { op: "backfill", cwd: CWD.c },
  { op: "rows", cwd: CWD.c },
  { op: "files", cwd: CWD.c },
  { op: "metaKeys", cwd: CWD.c },
  { op: "backfill", cwd: CWD.c },
  T(CWD.c, "sess-b.jsonl", `${userLine({ uuid: "b1", timestamp: "2026-02-02T02:02:02.002Z", content: [imgBlock(IMG.png), imgBlock(IMG.big)] })}\n${userLine({ uuid: "b2", timestamp: "2026-02-02T02:02:03Z", content: [imgBlock(IMG.png)] })}\n`),
  { op: "sql", cwd: CWD.c, sql: "UPDATE schema_meta SET value = 'garbage' WHERE key = 'last_jsonl_scan_sess-a';" },
  { op: "sql", cwd: CWD.c, sql: "UPDATE schema_meta SET value = 5 WHERE key = 'last_jsonl_scan_sess-bom';" },
  { op: "sql", cwd: CWD.c, sql: "UPDATE schema_meta SET value = '{\"mtimeMs\":\"1\",\"size\":1}' WHERE key = 'last_jsonl_scan_empty';" },
  { op: "backfill", cwd: CWD.c },
  { op: "rows", cwd: CWD.c },
  { op: "metaKeys", cwd: CWD.c },
  { op: "backfill", cwd: CWD.c },
  L({ scope: "project", cwd: CWD.c }),
  { op: "uses", cwd: CWD.c, hash: H.png },
  // Backfill into a DB without the tables: every image fails, the cursors stick.
  { op: "mkdir", rel: ".claude/projects/-claudius-golden-broken" },
  T(CWD.d, "s9.jsonl", `${userLine({ uuid: "d1", timestamp: "2026-01-01T00:00:00Z", content: [imgBlock(IMG.png)] })}\n`),
  { op: "backfill", cwd: CWD.d },
  { op: "metaKeys", cwd: CWD.d },
  { op: "backfill", cwd: CWD.d },
);

// Edges the first mutation run showed uncovered: a database that can't
// open, store paths shaped by an astral hash or a link, the account sort's
// short runs, ties and merge (64+ rows), and pinned transcript mtimes.
const CWD2 = {
  dbdir: "/claudius-golden/dbdir",
  link: "/claudius-golden/link",
  s1: "/claudius-golden/s1",
  s2: "/claudius-golden/s2",
  s3: "/claudius-golden/s3",
  m: "/claudius-golden/m",
};
const PNG_HASH = sha(SEEDS.png);
const GIF_HASH = sha(SEEDS.gif89);
if (PNG_HASH.slice(0, 2) === GIF_HASH.slice(0, 2)) throw new Error("shard clash");
const LINK_DIR = ".claude/projects/-claudius-golden-link/assets";
const assetRow = (hash, last) => `INSERT INTO assets VALUES ('${hash}', 'image/png', 1, NULL, NULL, 1, ${last});`;
const pad2 = (n) => String(n).padStart(2, "0");
const sdRows = (p) => Array.from({ length: 40 }, (_, i) => assetRow(`sd-${p}-${pad2(i)}`, 1000 + i));
const mLine = (uuid, data) => userLine({ uuid, timestamp: "2026-08-08T08:08:08Z", content: [imgBlock(data)] });
C.push(
  // `.claudius.db` is a folder: every open fails.
  { op: "mkdir", rel: ".claude/projects/-claudius-golden-dbdir/.claudius.db" },
  REC(CWD2.dbdir, "s1", "m1", 5, [I(IMG.png, "image/png")]),
  { op: "files", cwd: CWD2.dbdir },
  L({ scope: "project", cwd: CWD2.dbdir }),
  { op: "uses", cwd: CWD2.dbdir, hash: H.png },
  { op: "meta", cwd: CWD2.dbdir, hash: H.png },
  { op: "delrow", cwd: CWD2.dbdir, hash: H.png },
  { op: "backfill", cwd: CWD2.dbdir },
  // A hash whose shard splits an astral character: Node writes the lone
  // surrogate as U+FFFD.
  { op: "file", rel: ".claude/projects/-claudius-golden-b/assets/a\ufffd/a\ud83d\ude00.png", text: "split" },
  { op: "file", rel: ".claude/projects/-claudius-golden-b/assets/\ud83d\ude00/\ud83d\ude00b.png", text: "whole" },
  { op: "read", cwd: CWD.b, hash: "a\ud83d\ude00", mediaType: "image/png" },
  { op: "read", cwd: CWD.b, hash: "\ud83d\ude00b", mediaType: "image/png" },
  { op: "del", cwd: CWD.b, hash: "a\ud83d\ude00", mediaType: "image/png" },
  { op: "read", cwd: CWD.b, hash: "a\ud83d\ude00", mediaType: "image/png" },
  // A dangling link at the asset path: `access` misses it and the `wx`
  // write fails with EEXIST, which counts as written.
  { op: "link", rel: `${LINK_DIR}/${PNG_HASH.slice(0, 2)}/${PNG_HASH}.png`, target: "nowhere.png" },
  { op: "write", cwd: CWD2.link, hex: hex(SEEDS.png), mediaType: "image/png" },
  { op: "read", cwd: CWD2.link, hash: PNG_HASH, mediaType: "image/png" },
  // A shard folder that can't be written to: the open fails.
  { op: "mkdir", rel: `${LINK_DIR}/${GIF_HASH.slice(0, 2)}` },
  { op: "chmod", rel: `${LINK_DIR}/${GIF_HASH.slice(0, 2)}`, mode: 0o555 },
  { op: "write", cwd: CWD2.link, hex: hex(SEEDS.gif89), mediaType: "image/gif", locked: true },
  { op: "chmod", rel: `${LINK_DIR}/${GIF_HASH.slice(0, 2)}`, mode: 0o755 },
  // The account sort over rows from several projects, each project's
  // newest first: two rows to swap (`sa`), a run that breaks at its third
  // row (`sb`), a tie after a rising pair (`sc`), and 80 rows with ties
  // across projects (`sd`, V8's merge sort).
  { op: "sql", cwd: CWD2.s1, sql: [assetRow("sa-1", 1), assetRow("sb-1", 5), assetRow("sb-2", 3), assetRow("sc-1", 1), ...sdRows(1)].join("\n") },
  { op: "sql", cwd: CWD2.s2, sql: [assetRow("sa-2", 2), assetRow("sb-3", 4), assetRow("sc-2", 2), ...sdRows(2)].join("\n") },
  { op: "sql", cwd: CWD2.s3, sql: assetRow("sc-3", 2) },
  L({ scope: "account", cwd: CWD.a, q: "sa" }),
  L({ scope: "account", cwd: CWD.a, q: "sb" }),
  L({ scope: "account", cwd: CWD.a, q: "sc" }),
  L({ scope: "account", cwd: CWD.a, q: "sd", limit: 500 }),
  L({ scope: "account", cwd: CWD.a, q: "sd", limit: 3, cursor: 1039 }),
  L({ scope: "account", cwd: CWD.a, q: "s", limit: Number.NaN }),
  // Pinned transcript mtimes: the cursor holds Node's `mtimeMs`, and a
  // file is scanned again when its mtime or its size changed.
  T(CWD2.m, "m1.jsonl", `${mLine("m1", IMG.png)}\n`),
  { op: "mtime", cwd: CWD2.m, name: "m1.jsonl", t: 1767225600.123456 },
  T(CWD2.m, "m2.jsonl", `${mLine("m2", IMG.gif)}\n`),
  { op: "mtime", cwd: CWD2.m, name: "m2.jsonl", t: 1767225700.5 },
  { op: "backfill", cwd: CWD2.m },
  { op: "cursors", cwd: CWD2.m },
  { op: "backfill", cwd: CWD2.m },
  T(CWD2.m, "m1.jsonl", `${mLine("m1", IMG.png)}\n${mLine("m1b", IMG.png2)}\n`),
  { op: "mtime", cwd: CWD2.m, name: "m1.jsonl", t: 1767225600.123456 },
  { op: "mtime", cwd: CWD2.m, name: "m2.jsonl", t: 1767225800.25 },
  { op: "backfill", cwd: CWD2.m },
  { op: "cursors", cwd: CWD2.m },
  { op: "rows", cwd: CWD2.m },
);

// ------------------------------- core runner -------------------------------

const ROW_DUMP = (table, cols, order) =>
  `SELECT ${cols.map((c) => `typeof(${c}), CASE typeof(${c}) WHEN 'integer' THEN CAST(${c} AS TEXT) WHEN 'blob' THEN hex(${c}) ELSE ${c} END`).join(", ")} FROM ${table} ORDER BY ${order}`;
const ASSETS_SQL = ROW_DUMP("assets", ["hash", "media_type", "size_bytes", "width", "height", "first_seen_ms", "last_seen_ms"], "hash");
const USES_SQL = ROW_DUMP("asset_uses", ["asset_hash", "session_id", "message_uuid", "ordinal", "occurred_ms"], "asset_hash, session_id, message_uuid, ordinal");
const threw = (e) => ({ threw: scrub(e instanceof Error ? e.message : String(e)) });
const dbFile = (cwd) => join(HOME, ".claude", "projects", enc(cwd), ".claudius.db");
/** Every file under `dir`, as `[relative path, size, sha256]` by path. */
function walk(dir) {
  if (!existsSync(dir)) return null;
  const found = [];
  const go = (d, rel) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = lstatSync(p);
      if (st.isDirectory()) go(p, r);
      else found.push([r, st.size, sha(readFileSync(p))]);
    }
  };
  go(dir, "");
  return found.sort((x, y) => Buffer.compare(Buffer.from(x[0]), Buffer.from(y[0])));
}

const core = [];
let opIndex = 0;
for (const op of C) {
  opIndex += 1;
  clock = BASE + opIndex * 1009;
  // JSON has no NaN or Infinity: a non-finite option goes as its String().
  const step = op.opts ? { ...op, opts: Object.fromEntries(Object.entries(op.opts).map(([k, v]) => [k, typeof v === "number" && !Number.isFinite(v) ? String(v) : v])) } : { ...op };
  try {
    switch (op.op) {
      case "record":
        step.got = JSON.stringify(await ingest.recordSendUses({ cwd: op.cwd, sessionId: op.sessionId, messageUuid: op.messageUuid, occurredMs: op.occurredMs, images: op.images }));
        break;
      case "rows": {
        const db = await openDb(op.cwd);
        step.got = { assets: db.prepare(ASSETS_SQL).raw().all(), uses: db.prepare(USES_SQL).raw().all() };
        break;
      }
      case "metaKeys": {
        const db = await openDb(op.cwd);
        step.got = db.prepare("SELECT key, typeof(value) FROM schema_meta WHERE key LIKE 'last_jsonl_scan_%' ORDER BY key").raw().all();
        break;
      }
      case "files":
        step.got = walk(join(HOME, ".claude", "projects", enc(op.cwd), "assets"));
        break;
      case "ls":
        step.got = existsSync(join(HOME, op.rel)) ? readdirSync(join(HOME, op.rel)) : null;
        break;
      case "list":
        try {
          step.got = JSON.stringify(await list.listAssets(op.opts));
        } catch (e) {
          step.got = threw(e);
        }
        break;
      case "uses":
        try {
          step.got = JSON.stringify(await list.listUses(op.cwd, op.hash));
        } catch (e) {
          step.got = threw(e);
        }
        break;
      case "meta":
        try {
          step.got = JSON.stringify(await list.getAssetMeta(op.cwd, op.hash));
        } catch (e) {
          step.got = threw(e);
        }
        break;
      case "delrow":
        try {
          step.got = await list.deleteAssetRow(op.cwd, op.hash);
        } catch (e) {
          step.got = threw(e);
        }
        break;
      case "write":
        try {
          step.got = scrub(JSON.stringify(await store.writeIfAbsent(op.cwd, Buffer.from(op.hex, "hex"), op.mediaType)));
        } catch (e) {
          step.got = threw(e);
        }
        break;
      case "read": {
        const b = await store.readAsset(op.cwd, op.hash, op.mediaType);
        step.got = b ? hex(b) : null;
        break;
      }
      case "del":
        try {
          step.got = await store.deleteAsset(op.cwd, op.hash, op.mediaType);
        } catch (e) {
          step.got = threw(e);
        }
        break;
      case "backfill":
        step.clock = clock;
        try {
          step.got = JSON.stringify(await ingest.backfillProject(op.cwd));
        } catch (e) {
          step.got = threw(e);
        }
        break;
      case "sql":
        if (op.fresh) {
          mkdirSync(dirname(dbFile(op.cwd)), { recursive: true });
          const db = new Database(dbFile(op.cwd));
          db.pragma("journal_mode = WAL");
          db.exec(op.sql);
          db.close();
        } else {
          (await openDb(op.cwd)).exec(op.sql);
        }
        break;
      case "jsonl": {
        const p = join(HOME, ".claude", "projects", enc(op.cwd), op.name);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, op.hex !== undefined ? Buffer.from(op.hex, "hex") : op.text);
        break;
      }
      case "mkdir":
        mkdirSync(join(HOME, op.rel), { recursive: true });
        break;
      case "link":
        mkdirSync(dirname(join(HOME, op.rel)), { recursive: true });
        symlinkSync(op.target, join(HOME, op.rel));
        break;
      case "chmod":
        chmodSync(join(HOME, op.rel), op.mode);
        break;
      case "mtime": {
        // The exact time Node set, for the port to set the same.
        const p = join(HOME, ".claude", "projects", enc(op.cwd), op.name);
        utimesSync(p, op.t, op.t);
        const ns = statSync(p, { bigint: true }).mtimeNs;
        step.sec = Number(ns / 1_000_000_000n);
        step.nsec = Number(ns % 1_000_000_000n);
        break;
      }
      case "cursors": {
        const db = await openDb(op.cwd);
        step.got = db.prepare("SELECT key, value FROM schema_meta WHERE key LIKE 'last_jsonl_scan_%' ORDER BY key").raw().all();
        break;
      }
      case "file":
        mkdirSync(dirname(join(HOME, op.rel)), { recursive: true });
        writeFileSync(join(HOME, op.rel), op.text);
        break;
      default:
        throw new Error(`unknown op ${op.op}`);
    }
  } catch (e) {
    throw new Error(`core op #${opIndex} ${op.op}: ${e.stack ?? e}`);
  }
  core.push(step);
}

// ------------------------------- routes -------------------------------

// The route part runs in its own state home (the server test's is fresh)
// with the trusted default cwd at {PH}/project.
process.env.HOME = join(PH, "rhome");
const RHOME = process.env.HOME;
mkdirSync(join(PH, "project"), { recursive: true });
process.chdir(join(PH, "project"));

const assetsRoute = await import(join(repo, "app/api/assets/route.ts"));
const hashRoute = await import(join(repo, "app/api/assets/[hash]/route.ts"));
const usesRoute = await import(join(repo, "app/api/assets/[hash]/uses/route.ts"));

/** Status, headers and body of a handler's answer (or its throw). */
async function answer(fn) {
  let res;
  try {
    res = await fn();
  } catch {
    return { threw: true };
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const got = {
    status: res.status,
    type: res.headers.get("content-type"),
    length: res.headers.get("content-length"),
    cache: res.headers.get("cache-control"),
  };
  const isText = (got.type ?? "").startsWith("application/json");
  if (isText) got.body = scrub(buf.toString("utf8"));
  else if (buf.length <= 4096) got.hex = hex(buf);
  else Object.assign(got, { len: buf.length, sha: sha(buf) });
  return got;
}

const WS = { a: `${PH}/ws/a`, b: `${PH}/ws/b`, c: `${PH}/ws/c` };
const pdir = (cwd) => `rhome/.claude/projects/${enc(cwd)}`;
const qs = (o) =>
  Object.entries(o)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");
const BIG_SEED = png(4000, 3000);
const BIG_N = 1_500_000;
const bigBytes = () => {
  const b = Buffer.alloc(BIG_SEED.length + BIG_N);
  b.set(BIG_SEED);
  for (let i = 0; i < BIG_N; i++) b[BIG_SEED.length + i] = (i * 7 + 3) & 255;
  return b;
};
const assetFile = (cwd, hash, ext) => `${pdir(cwd)}/assets/${hash.slice(0, 2)}/${hash}.${ext}`;
const R = (method, path, query) => ({ op: "req", method, url: query ? `${path}?${query}` : path });
const G = (path, query) => R("GET", path, query);
const D = (path, query) => R("DELETE", path, query);
const A = "/api/assets";
// [hash, media type ("BLOB": the bytes of image/png), the file's extension].
const FOREIGN = [
  ["c0ffee01", " image/png\t"],
  ["c0ffee02", "image/png\n"],
  ["c0ffee03", "image/\npng"],
  ["c0ffee04", "imag\u00e9/png"],
  ["c0ffee05", "\u65e5/png"],
  ["c0ffee06", ""],
  ["c0ffee07", "BLOB"],
  ["c0ffee08", "image/png\u0001x"],
  ["c0ffee09", "IMAGE/PNG"],
].map(([hash, type]) => [hash, type, type === "BLOB" ? "png" : store.extFor(type)]);
/** Headers the handler builds but Node's http refuses to write (Next answers 500). */
const WIRE_REFUSED = new Set(["c0ffee08"]);

const ASSET_STEPS = [
  {
    op: "file",
    path: "rhome/.claude/.claudius/workspaces.json",
    text: JSON.stringify({
      version: 1,
      workspaces: [
        ["wks_a", WS.a],
        ["wks_b", WS.b],
        ["wks_c", WS.c],
      ].map(([id, rootPath]) => ({ id, name: id, rootPath, icon: { kind: "letter", letter: "W", color: "#d97757" }, createdAt: 1, updatedAt: 1, defaults: {} })),
    }),
  },
  { op: "mkdir", path: "ws/a" },
  { op: "mkdir", path: "ws/b" },
  { op: "mkdir", path: "ws/c" },
  {
    op: "jsonl",
    path: `${pdir(WS.a)}/s1.jsonl`,
    text: `${userLine({ uuid: "a-u1", timestamp: "2026-01-02T03:04:05.678Z", content: [imgBlock(IMG.png), imgBlock(IMG.gif, "image/gif")] })}\n`,
  },
  {
    op: "jsonl",
    path: `${pdir(WS.a)}/s2.jsonl`,
    text: `${userLine({ uuid: "a-u2", timestamp: "2026-03-08T02:30:00", content: [imgBlock(IMG.png), imgBlock(IMG.jpeg, "image/jpeg")] })}\n${userLine({ uuid: "a-u3", timestamp: "2026-11-01T01:30:00", content: [imgBlock(IMG.pdf, "application/pdf")] })}\n`,
  },
  {
    op: "jsonl",
    path: `${pdir(WS.a)}/s3.jsonl`,
    text: `${userLine({ uuid: "a-u4", timestamp: "2026-01-01T00:00:00+05:30", content: [imgBlock(IMG.svg, "image/svg+xml"), imgBlock(IMG.png, "image/png")] })}\n`,
  },
  { op: "bigjsonl", path: `${pdir(WS.a)}/big.jsonl`, uuid: "a-big", timestamp: "2026-04-04T04:04:04Z", seed: hex(BIG_SEED), n: BIG_N },
  {
    op: "jsonl",
    path: `${pdir(WS.b)}/s1.jsonl`,
    text: `${userLine({ uuid: "b-u1", timestamp: "2026-05-05T00:00:00Z", content: [imgBlock(IMG.png), imgBlock(IMG.webp, "image/webp")] })}\n`,
  },
  G(A, qs({ cwd: "/etc" })),
  G(A, qs({ cwd: `${PH}/ws` })),
  G(A, qs({ cwd: WS.a })),
  G(A, qs({ cwd: WS.a, backfill: "true" })),
  G(A, qs({ cwd: WS.a, backfill: "1", scope: "account" })),
  G(A, qs({ cwd: WS.a, backfill: "1" })),
  G(A, qs({ cwd: `${WS.a}/`, backfill: "1" })),
  G(A, qs({ cwd: `${WS.a}/../a` })),
  G(A, qs({ cwd: WS.b, backfill: "1", type: "image" })),
  G(A, qs({ cwd: WS.a, type: "file" })),
  G(A, qs({ cwd: WS.a, type: "image", q: H.png.slice(0, 3) })),
  G(A, qs({ cwd: WS.a, q: "s2" })),
  G(A, qs({ cwd: WS.a, limit: "1" })),
  G(A, qs({ cwd: WS.a, limit: "2", cursor: "1767323045678" })),
  G(A, qs({ cwd: WS.a, limit: "abc" })),
  G(A, qs({ cwd: WS.a, limit: "0" })),
  G(A, qs({ cwd: WS.a, limit: "-3" })),
  G(A, qs({ cwd: WS.a, limit: "2.5" })),
  G(A, qs({ cwd: WS.a, limit: "1e9" })),
  G(A, qs({ cwd: WS.a, limit: " 2 " })),
  G(A, qs({ cwd: WS.a, limit: "0x2" })),
  G(A, qs({ cwd: WS.a, cursor: "abc" })),
  G(A, qs({ cwd: WS.a, cursor: "" })),
  G(A, qs({ cwd: WS.a, cursor: "1e400" })),
  G(A, `cwd=${encodeURIComponent(WS.a)}&cwd=%2Fetc`),
  G(A, `cwd=%2Fetc&cwd=${encodeURIComponent(WS.a)}`),
  G(A, qs({ cwd: WS.a, scope: "account" })),
  G(A, qs({ cwd: WS.b, scope: "account", type: "image", limit: "2" })),
  G(A, qs({ cwd: WS.b, scope: "account", cursor: "1767323045678" })),
  G(A, qs({ cwd: WS.b, scope: "nope" })),
  // The bytes.
  G(`${A}/${H.png}`, qs({ cwd: WS.a })),
  G(`${A}/${H.gif}`, qs({ cwd: WS.a })),
  G(`${A}/${H.jpeg}`, qs({ cwd: WS.a })),
  G(`${A}/${H.svg}`, qs({ cwd: WS.a })),
  G(`${A}/${H.pdf}`, qs({ cwd: WS.a })),
  G(`${A}/${sha(bigBytes())}`, qs({ cwd: WS.a })),
  G(`${A}/${H.png}`, qs({ cwd: WS.b })),
  G(`${A}/${H.png}`, qs({ cwd: "/etc" })),
  G(`${A}/${H.png}`),
  G(`${A}/${H.png.toUpperCase()}`, qs({ cwd: WS.a })),
  G(`${A}/${H.png.slice(0, 10)}`, qs({ cwd: WS.a })),
  G(`${A}/nope`, qs({ cwd: WS.a })),
  // Uses.
  G(`${A}/${H.png}/uses`, qs({ cwd: WS.a })),
  G(`${A}/${H.png}/uses`, qs({ cwd: WS.b })),
  G(`${A}/nope/uses`, qs({ cwd: WS.a })),
  G(`${A}/${H.png}/uses`, qs({ cwd: "/etc" })),
  G(`${A}/${H.png}/uses`),
  // Bytes gone from disk, then the row.
  { op: "rm", path: assetFile(WS.a, H.gif, "gif") },
  G(`${A}/${H.gif}`, qs({ cwd: WS.a })),
  D(`${A}/${H.gif}`, qs({ cwd: "/etc" })),
  D(`${A}/${H.gif}`, qs({ cwd: WS.a })),
  G(`${A}/${H.gif}`, qs({ cwd: WS.a })),
  D(`${A}/${H.gif}`, qs({ cwd: WS.a })),
  G(`${A}/${H.gif}/uses`, qs({ cwd: WS.a })),
  // A folder where the file was: not served, the delete still drops the row.
  { op: "rm", path: assetFile(WS.a, H.jpeg, "jpg") },
  { op: "mkdir", path: assetFile(WS.a, H.jpeg, "jpg") },
  G(`${A}/${H.jpeg}`, qs({ cwd: WS.a })),
  D(`${A}/${H.jpeg}`, qs({ cwd: WS.a })),
  G(`${A}/${H.jpeg}`, qs({ cwd: WS.a })),
  { op: "exists", path: assetFile(WS.a, H.jpeg, "jpg") },
  // A plain delete removes the file.
  D(`${A}/${H.svg}`, qs({ cwd: WS.a })),
  { op: "exists", path: assetFile(WS.a, H.svg, "svg") },
  G(A, qs({ cwd: WS.a })),
  // Rows another writer stored: the type goes out as the header.
  G(A, qs({ cwd: WS.c })),
  ...FOREIGN.map(([hash, , ext]) => ({ op: "file", path: assetFile(WS.c, hash, ext), text: `bytes of ${hash}` })),
  {
    op: "sql",
    cwd: WS.c,
    sql: FOREIGN.map(([hash, type], i) => {
      const lit = type === "BLOB" ? "X'696d6167652f706e67'" : `'${[...type].map((c) => (c === "\n" ? "' || char(10) || '" : c === "\u0001" ? "' || char(1) || '" : c)).join("")}'`;
      return `INSERT INTO assets VALUES ('${hash}', ${lit}, ${`bytes of ${hash}`.length}, NULL, NULL, ${i + 1}, ${100 + i});`;
    }).join("\n"),
  },
  ...FOREIGN.map(([hash]) => ({ ...G(`${A}/${hash}`, qs({ cwd: WS.c })), ...(WIRE_REFUSED.has(hash) ? { wireRefused: true } : {}) })),
  ...FOREIGN.map(([hash]) => D(`${A}/${hash}`, qs({ cwd: WS.c }))),
  G(A, qs({ cwd: WS.c, scope: "account" })),
  G(A),
];

async function runAssetSteps() {
  const steps = [];
  for (const s of ASSET_STEPS) {
    clock += 1009;
    const p = s.path && join(PH, s.path);
    switch (s.op) {
      case "file":
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, s.text);
        steps.push({ ...s, path: scrub(s.path), text: scrub(s.text) });
        continue;
      case "mkdir":
        mkdirSync(p, { recursive: true });
        break;
      case "rm":
        rmSync(p);
        break;
      case "exists":
        steps.push({ ...s, path: scrub(s.path), got: existsSync(p) });
        continue;
      case "jsonl":
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, s.text);
        break;
      case "bigjsonl":
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, `${userLine({ uuid: s.uuid, timestamp: s.timestamp, content: [imgBlock(bigBytes().toString("base64"))] })}\n`);
        break;
      case "sql":
        (await openDb(s.cwd)).exec(s.sql);
        steps.push({ ...s, cwd: scrub(s.cwd) });
        continue;
      case "req": {
        const url = new URL(`http://localhost${s.url}`);
        const parts = url.pathname.split("/").filter(Boolean);
        const req = new Request(url, { method: s.method });
        let got;
        if (parts.length === 2) got = await answer(() => assetsRoute.GET(req));
        else if (parts.length === 3) {
          const ctx = { params: Promise.resolve({ hash: decodeURIComponent(parts[2]) }) };
          got = await answer(() => hashRoute[s.method](req, ctx));
        } else {
          const ctx = { params: Promise.resolve({ hash: decodeURIComponent(parts[2]) }) };
          got = await answer(() => usesRoute.GET(req, ctx));
        }
        steps.push({ ...s, url: scrub(s.url), got });
        continue;
      }
      default:
        throw new Error(`unknown step ${s.op}`);
    }
    steps.push({ ...s, path: scrub(s.path) });
  }
  return steps;
}
const assets = { tz: TZ, steps: await runAssetSteps() };
if (!existsSync(RHOME)) throw new Error("route state home missing");

// ------------------------------- local-image -------------------------------

const P = (path) => `path=${encodeURIComponent(path)}`;
const LI = "/api/local-image";
const Q = (query, extra = {}) => ({ op: "req", url: query === null ? LI : `${LI}?${query}`, ...extra });
const PNGHEX = hex(SEEDS.png);
const SETUP_T1 = [
  ["file", "t1/a.png", PNGHEX],
  ["file", "t1/UP.PNG", hex(SEEDS.gif89)],
  ["file", "t1/a b.png", hex(SEEDS.jpeg)],
  ...["jpg", "jpeg", "gif", "svg", "webp", "ico", "bmp", "avif", "tiff", "tif", "constructor", "__proto__", "tostring", "valueof", "PnG"].map((e) => ["file", `t1/x.${e}`, hex(bytesOf(`x.${e}`))]),
  ["file", "t1/y.Constructor", hex(bytesOf("y"))],
  ["file", "t1/.png", hex(bytesOf("dotfile"))],
  ["file", "t1/a.", hex(bytesOf("dot"))],
  ["file", "t1/noext", hex(bytesOf("noext"))],
  ["file", "outside.png", hex(bytesOf("outside"))],
  ["file", "t1.png", hex(bytesOf("sibling"))],
  ["dir", "t1/sub"],
  ["file", "t1/sub/c.jpg", hex(SEEDS.jpegExifLE)],
  ["dir", "t1/%2e%2e"],
  ["dir", "t1/dir.png"],
  ["fifo", "t1/fifo.png"],
  ["big", "t1/big.png", 10 * 1024 * 1024],
  ["big", "t1/huge.png", 10 * 1024 * 1024 + 1],
  ["file", "t1/empty.png", ""],
  ["locked", "t1/locked.png", PNGHEX],
  ["link", "t1/in.png", "a.png"],
  ["link", "t1/tolink.png", "in.png"],
  ["link", "t1/out.png", "{PH}/outside.png"],
  ["link", "t1/uplink.png", "../outside.png"],
  ["link", "t1/dangling.png", "missing.png"],
  ["link", "t1/loop.png", "loop.png"],
  ["link", "t1/dirlink", "sub"],
  ["link", "t1/totmp.png", "{TP}/a.png"],
  ["link", "t1/root.png", "/"],
  ["file", "{TP}/a.png", PNGHEX],
  ["dir", "{TP}/nested"],
  ["file", "{TP}/nested/n.png", hex(SEEDS.gif87)],
  ["dir", "t2"],
  ["file", "t2/a.png", hex(SEEDS.bmp)],
  ["link", "tlink", "t2"],
  ["dir", "t3"],
  ["file", "t3/a.png", hex(SEEDS.tga)],
  ["link", "rootlink", "/"],
  ["dir", "project/rel/tmp"],
  ["file", "project/rel/tmp/a.png", hex(SEEDS.psd)],
];
const T1 = `${PH}/t1`;
const WORLDS = [
  {
    name: "plain",
    env: { TMPDIR: `${PH}/t1/`, TMP: null, TEMP: null },
    steps: [
      Q(null),
      Q("path="),
      Q("path=a.png"),
      Q(P("~/a.png")),
      Q(P("/etc/hosts")),
      Q(P("/etc/passwd.png")),
      Q(P(`${T1}/a.png`)),
      Q(P(`${T1}/UP.PNG`)),
      ...["jpg", "jpeg", "gif", "svg", "webp", "ico", "bmp", "avif", "tiff", "tif", "constructor", "__proto__", "tostring", "valueof", "PnG"].map((e) => Q(P(`${T1}/x.${e}`))),
      Q(P(`${T1}/y.Constructor`)),
      Q(P(`${T1}/.png`)),
      Q(P(`${T1}/a.`)),
      Q(P(`${T1}/noext`)),
      Q(`path=${encodeURIComponent(T1)}/a+b.png`),
      Q(P(`${T1}/a b.png`)),
      Q(P(`${T1}/sub/../a.png`)),
      Q(P(`${T1}/./a.png`)),
      Q(`path=${encodeURIComponent(PH)}//t1//a.png`),
      Q(P(`${T1}/../outside.png`)),
      Q(`path=${encodeURIComponent(T1)}/%2e%2e/outside.png`),
      Q(`path=${encodeURIComponent(T1)}/%252e%252e/outside.png`),
      Q(P(`${PH}/t1.png`)),
      Q(P(`${T1}/missing.png`)),
      Q(P(`${T1}/a.png/b.png`)),
      Q(P(`${T1}/dir.png`)),
      Q(P(`${T1}/sub`)),
      Q(P(`${T1}/fifo.png`)),
      Q(P(`${T1}/big.png`)),
      Q(P(`${T1}/huge.png`)),
      Q(P(`${T1}/empty.png`)),
      Q(P(`${T1}/locked.png`), { locked: true }),
      Q(P(`${T1}/in.png`)),
      Q(P(`${T1}/tolink.png`)),
      Q(P(`${T1}/out.png`)),
      Q(P(`${T1}/uplink.png`)),
      Q(P(`${T1}/dangling.png`)),
      Q(P(`${T1}/loop.png`)),
      Q(P(`${T1}/dirlink/c.jpg`)),
      Q(P(`${T1}/dirlink/../a.png`)),
      Q(P(`${T1}/totmp.png`)),
      Q(P(`${T1}/root.png`)),
      Q(P(`${T1}/root.png/etc/hosts.png`)),
      Q(`path=${encodeURIComponent(T1)}/a%00.png`),
      Q(`path=${encodeURIComponent(T1)}/a.png%00`),
      Q(`path=${encodeURIComponent(T1)}/%ff.png`),
      Q(P(`${T1}/${"x".repeat(300)}.png`)),
      Q(P(`${T1}/${"d/".repeat(600)}a.png`)),
      Q(`${P(`${T1}/a.png`)}&${P("/etc/x.png")}`),
      Q(`${P("/etc/x.png")}&${P(`${T1}/a.png`)}`),
      Q(`PATH=${encodeURIComponent(`${T1}/a.png`)}`),
      Q(`path=${encodeURIComponent(`${T1}/a.png`)}&x=%zz`),
      Q(P(`${TP}/a.png`)),
      Q(P(`/private${TP}/a.png`), { darwin: true }),
      Q(P(`/TMP/${TPNAME}/a.png`)),
      Q(P(`/tmp/./${TPNAME}/a.png`)),
      Q(P("/tmp.png")),
      Q(P("/tmp/../etc/passwd.png")),
      Q(P(`${TP}/nested/n.png`)),
      Q(P(`${PH}/t2/a.png`)),
    ],
  },
  {
    name: "linked",
    env: { TMPDIR: `${PH}/tlink`, TMP: null, TEMP: null },
    steps: [Q(P(`${PH}/tlink/a.png`)), Q(P(`${PH}/t2/a.png`)), Q(P(`${PH}/tlink/../t1/a.png`)), Q(P(`${T1}/a.png`)), Q(P(`${TP}/a.png`))],
  },
  {
    name: "temp-env",
    env: { TMPDIR: "", TMP: "", TEMP: `${PH}/t3/` },
    steps: [Q(P(`${PH}/t3/a.png`)), Q(P(`${T1}/a.png`)), Q(P(`${TP}/a.png`))],
  },
  {
    name: "tmp-env",
    env: { TMPDIR: null, TMP: `${PH}/t3`, TEMP: `${PH}/t2` },
    steps: [Q(P(`${PH}/t3/a.png`)), Q(P(`${PH}/t2/a.png`))],
  },
  {
    name: "unset",
    env: { TMPDIR: null, TMP: null, TEMP: null },
    steps: [Q(P(`${TP}/a.png`)), Q(P(`/private${TP}/a.png`), { darwin: true }), Q(P(`${T1}/a.png`))],
  },
  {
    name: "missing",
    env: { TMPDIR: `${PH}/nope`, TMP: null, TEMP: null },
    steps: [Q(P(`${PH}/nope/a.png`)), Q(P(`${TP}/a.png`))],
  },
  {
    name: "rootlink",
    env: { TMPDIR: `${PH}/rootlink`, TMP: null, TEMP: null },
    steps: [Q(P(`${PH}/rootlink/etc/hosts.png`)), Q(P(`${PH}/rootlink${T1}/a.png`)), Q(P("/etc/hosts.png")), Q(P(`${TP}/a.png`)), Q(P(`${T1}/a.png`))],
  },
  {
    name: "slash",
    env: { TMPDIR: "/", TMP: null, TEMP: null },
    steps: [Q(P(`${TP}/a.png`)), Q(P(`${T1}/a.png`)), Q(P("/etc/hosts.png"))],
  },
  {
    name: "nested",
    env: { TMPDIR: `${TP}/nested`, TMP: null, TEMP: null },
    steps: [Q(P(`${TP}/nested/n.png`)), Q(P(`${TP}/a.png`)), Q(P(`/private${TP}/nested/n.png`), { darwin: true })],
  },
  {
    name: "relative",
    env: { TMPDIR: "rel/tmp", TMP: null, TEMP: null },
    steps: [Q(P(`${PH}/project/rel/tmp/a.png`)), Q(P(`${TP}/a.png`))],
  },
  {
    name: "double-slash",
    env: { TMPDIR: `${PH}/t1//`, TMP: null, TEMP: null },
    steps: [Q(P(`${T1}/a.png`)), Q(P(`${T1}//a.png`))],
  },
];

const setupPath = (p) => {
  const u = unscrub(p);
  return u.startsWith("/") ? u : join(PH, u);
};
for (const [kind, rel, arg] of SETUP_T1) {
  const p = setupPath(rel);
  mkdirSync(dirname(p), { recursive: true });
  switch (kind) {
    case "file":
      writeFileSync(p, Buffer.from(arg, "hex"));
      break;
    case "locked":
      writeFileSync(p, Buffer.from(arg, "hex"));
      chmodSync(p, 0);
      break;
    case "dir":
      mkdirSync(p, { recursive: true });
      break;
    case "fifo": {
      const r = spawnSync("mkfifo", [p]);
      if (r.status !== 0) throw new Error("mkfifo failed");
      break;
    }
    case "big":
      writeFileSync(p, "");
      truncateSync(p, arg);
      break;
    case "link":
      symlinkSync(unscrub(arg), p);
      break;
    default:
      throw new Error(kind);
  }
}

const localImage = { setup: SETUP_T1, worlds: [] };
let worldN = 0;
for (const w of WORLDS) {
  worldN += 1;
  for (const [k, v] of Object.entries(w.env)) {
    if (v === null) delete process.env[k];
    else process.env[k] = v;
  }
  const route = await import(`${pathToFileURL(join(repo, "app/api/local-image/route.ts")).href}?world=${worldN}`);
  const steps = [];
  for (const s of w.steps) {
    const got = await answer(() => route.GET(new Request(`http://localhost${s.url}`)));
    steps.push({ ...s, url: scrub(s.url), got });
  }
  localImage.worlds.push({ name: w.name, env: Object.fromEntries(Object.entries(w.env).map(([k, v]) => [k, v === null ? null : scrub(v)])), steps });
}
chmodSync(join(PH, "t1/locked.png"), 0o644);

// ------------------------------- write -------------------------------

const fixture = {
  imageSize: imageCases,
  base64,
  dateParse,
  extFor,
  core: core.map((s) => JSON.parse(scrub(JSON.stringify(s)))),
  assets,
  localImage,
};
const text = `${JSON.stringify(fixture, null, 1)}\n`;
writeFileSync(out, text);
console.log(`wrote ${out}: ${imageCases.length} imageSize, ${base64.length} base64, ${DATES.length} dates, ${core.length} core ops, ${assets.steps.length} asset steps, ${localImage.worlds.length} local-image worlds`);
