#!/usr/bin/env node
// Vendors the React UI's Lucide drawings for the native UI (U03d).
//
//   node rust/scripts/lucide-icons.mjs [gpui-kit-assets icons dir]   (node@22)
//
// The React UI draws its icons with lucide-react (bun.lock pins 1.14.0); the
// native UI's IconAssets serves GPUI Kit's bundled Lucide catalog
// (gpui-kit-assets, Lucide 1.43.0), which redrew some of them. This script
// compares the two and writes lucide-react's drawing of every icon that
// differs, so IconAssets can serve it in the catalog's place:
//
// 1. The icons: `ICONS` in claudius-gpui-theme's src/icons.rs, each a
//    lucide-react import name and its catalog `IconName` (whose kebab-case
//    name is the catalog file). lucide-react's index names the module of
//    each import (aliases included).
// 2. The drawings: lucide-react's `__iconNode` (imported from the module) and
//    the catalog SVG's child elements, both as sets of (tag, attributes),
//    without lucide-react's React `key`.
// 3. For each icon whose sets differ it writes `assets/icons/<name>.svg` in
//    Lucide's own SVG layout (the catalog's), from `__iconNode`, and removes
//    any other SVG there. Then lucide-react's LICENSE (ISC, with Feather's MIT
//    notice) next to them, and `src/icons/lucide_1_14.rs`, the table of the
//    vendored files.
//
// The catalog defaults to gpui-kit-assets in the cargo registry, at the
// version rust/app/Cargo.lock pins. ASCII only; no network.

import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const crate = join(root, "rust/app/crates/claudius-gpui-theme");
const lucide = join(root, "node_modules/lucide-react");
const outDir = join(crate, "assets/icons");
const tablePath = join(crate, "src/icons/lucide_1_14.rs");

function catalogDir() {
  if (process.argv[2]) return resolve(process.argv[2]);
  const lock = readFileSync(join(root, "rust/app/Cargo.lock"), "utf8");
  const m = /name = "gpui-kit-assets"\nversion = "([^"]+)"/.exec(lock);
  if (!m) throw new Error("gpui-kit-assets is not in rust/app/Cargo.lock");
  const registry = join(process.env.CARGO_HOME || join(homedir(), ".cargo"), "registry/src");
  for (const index of readdirSync(registry)) {
    const dir = join(registry, index, `gpui-kit-assets-${m[1]}`, "assets/icons");
    if (existsSync(dir)) return dir;
  }
  throw new Error(`gpui-kit-assets ${m[1]} is not in ${registry}: run cargo fetch in rust/app`);
}

// `IconName::CircleQuestionMark` is `circle-question-mark.svg`, `Building2`
// is `building-2.svg`.
function kebab(variant) {
  return variant
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Za-z])([0-9])/g, "$1-$2")
    .toLowerCase();
}

// `[(react name, catalog name)]` from `ICONS`.
function icons() {
  const src = readFileSync(join(crate, "src/icons.rs"), "utf8");
  const out = [...src.matchAll(/\("(\w+)", IconName::(\w+)\)/g)].map((m) => [m[1], kebab(m[2])]);
  if (out.length === 0) throw new Error("no ICONS in src/icons.rs");
  return out;
}

// `export { default as AlertCircle, ... } from './icons/circle-alert.mjs';`
function moduleOf() {
  const index = readFileSync(join(lucide, "dist/esm/lucide-react.mjs"), "utf8");
  const out = new Map();
  for (const m of index.matchAll(/^export \{([^}]*)\} from '\.\/icons\/([\w-]+)\.mjs';$/gm)) {
    for (const part of m[1].split(",")) {
      const alias = part.split(" as ")[1];
      if (alias) out.set(alias.trim(), m[2]);
    }
  }
  return out;
}

const key = (tag, attrs) =>
  JSON.stringify([tag, Object.entries(attrs).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))]);

// An element's attributes without lucide-react's React `key`.
function withoutKey(attrs) {
  const out = { ...attrs };
  delete out.key;
  return out;
}

function reactDrawing(node) {
  return new Set(node.map(([tag, attrs]) => key(tag, withoutKey(attrs))));
}

function svgDrawing(svg) {
  const body = svg.slice(svg.indexOf(">", svg.indexOf("<svg")) + 1);
  const out = new Set();
  for (const el of body.matchAll(/<(\w+)([^>]*?)\/?>/g)) {
    const attrs = {};
    for (const a of el[2].matchAll(/([\w-]+)="([^"]*)"/g)) attrs[a[1]] = a[2];
    out.add(key(el[1], attrs));
  }
  return out;
}

const same = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

// Lucide's SVG layout, as the catalog files are written.
function svgOf(node) {
  const head = [
    "<svg",
    '  xmlns="http://www.w3.org/2000/svg"',
    '  width="24"',
    '  height="24"',
    '  viewBox="0 0 24 24"',
    '  fill="none"',
    '  stroke="currentColor"',
    '  stroke-width="2"',
    '  stroke-linecap="round"',
    '  stroke-linejoin="round"',
    ">",
  ];
  const children = node.map(([tag, attrs]) => {
    const list = Object.entries(withoutKey(attrs)).map(([k, v]) => `${k}="${v}"`);
    return `  <${tag} ${list.join(" ")} />`;
  });
  return [...head, ...children, "</svg>", ""].join("\n");
}

function table(names) {
  const lines = [
    "//! Generated by rust/scripts/lucide-icons.mjs from lucide-react 1.14.0 (ISC,",
    "//! `assets/icons/LICENSE`): do not edit.",
    "//!",
    "//! The icons whose lucide-react drawing differs from GPUI Kit's Lucide 1.43.0",
    "//! catalog, as lucide-react draws them.",
    "",
    "macro_rules! drawings {",
    "    ($($name:literal),* $(,)?) => {",
    '        [$(($name, include_bytes!(concat!("../../assets/icons/", $name, ".svg")))),*]',
    "    };",
    "}",
    "",
    "/// `(catalog name, SVG)`, sorted by name.",
    `pub const DRAWINGS: [(&str, &[u8]); ${names.length}] = drawings![`,
    ...names.map((n) => `    "${n}",`),
    "];",
    "",
  ];
  return lines.join("\n");
}

const version = JSON.parse(readFileSync(join(lucide, "package.json"), "utf8")).version;
if (version !== "1.14.0") throw new Error(`lucide-react is ${version}: update the table's docs`);
const catalog = catalogDir();
const files = moduleOf();
const redrawn = new Map();
for (const [react, name] of icons()) {
  const file = files.get(react);
  if (!file) throw new Error(`${react} is not a lucide-react export`);
  const url = pathToFileURL(join(lucide, "dist/esm/icons", `${file}.mjs`)).href;
  const { __iconNode: node } = await import(url);
  const svg = readFileSync(join(catalog, `${name}.svg`), "utf8");
  if (!same(reactDrawing(node), svgDrawing(svg))) redrawn.set(name, node);
}
const names = [...redrawn.keys()].sort();
mkdirSync(outDir, { recursive: true });
mkdirSync(dirname(tablePath), { recursive: true });
for (const f of readdirSync(outDir)) {
  if (f.endsWith(".svg") && !redrawn.has(f.slice(0, -4))) unlinkSync(join(outDir, f));
}
for (const name of names) writeFileSync(join(outDir, `${name}.svg`), svgOf(redrawn.get(name)));
writeFileSync(join(outDir, "LICENSE"), readFileSync(join(lucide, "LICENSE")));
writeFileSync(tablePath, table(names));
console.log(`${names.length} icons drawn differently in the catalog; wrote ${outDir}`);
