// KaTeX vs RaTeX: lays each formula out with KaTeX (the React UI's renderer)
// in headless Chromium and compares its box with RaTeX's.
//   gpui-transcript --math-report > /tmp/u00a-math/ratex.json
//   node scripts/katex-compare.mjs /tmp/u00a-math/ratex.json [shot.png]
// RaTeX SVGs (from --math-report) are placed next to KaTeX's output in the
// screenshot. Uses the repo's katex + playwright-core from node_modules.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const katex = require("katex");
const { chromium } = require("playwright-core");

const [ratexJson, shot] = process.argv.slice(2);
const ratex = JSON.parse(readFileSync(ratexJson, "utf8"));
const cssPath = require.resolve("katex/dist/katex.min.css");
const EM = 40; // RaTeX --math-report renders at 40 px/em; KaTeX's .katex is 1.21em, so base 40/1.21.
const rows = ratex.map((r) => {
  const svg = readFileSync(`/tmp/u00a-math/ratex-${r.i}.svg`, "utf8");
  return `<tr><td class=k id=k${r.i}>${katex.renderToString(r.tex, { displayMode: true, throwOnError: false })}</td><td class=r>${svg}</td></tr>`;
}).join("");
const html = `<!doctype html><meta charset=utf-8><link rel=stylesheet href="file://${cssPath}"><style>body{margin:16px;font-size:${EM / 1.21}px;background:#fff}
td{padding:6px 16px;border-bottom:1px solid #eee;vertical-align:middle} .r svg{display:block} .katex-display{margin:0;text-align:left} .katex-display>.katex{text-align:left}</style>
<table><tr><th>KaTeX ${katex.version}</th><th>RaTeX (SVG)</th></tr>${rows}</table>`;
const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 2 });
const file = "/tmp/u00a-math/compare.html";
writeFileSync(file, html);
await page.goto(`file://${file}`);
await page.evaluate(() => document.fonts.ready);
const out = [];
for (const r of ratex) {
  const k = await page.evaluate((i) => {
    // Union of the .katex-base boxes (KaTeX sizes them exactly: height + depth).
    const rs = [...document.querySelectorAll(`#k${i} .katex-html .katex-base`)].map((b) => b.getBoundingClientRect());
    const l = Math.min(...rs.map((r) => r.left)), rt = Math.max(...rs.map((r) => r.right));
    const t = Math.min(...rs.map((r) => r.top)), bt = Math.max(...rs.map((r) => r.bottom));
    return { width_px: rt - l, height_px: bt - t };
  }, r.i);
  const kw = k.width_px / EM;
  const kh = k.height_px / EM;
  out.push({ i: r.i, tex: r.tex, katex_width_em: +kw.toFixed(3), ratex_width_em: +r.width_em.toFixed(3),
    width_diff_pct: +(100 * (r.width_em - kw) / kw).toFixed(1),
    katex_total_height_em: +(k.height_px / EM).toFixed(3), ratex_total_height_em: +(r.height_em + r.depth_em).toFixed(3),
    height_diff_pct: +(100 * (r.height_em + r.depth_em - kh) / kh).toFixed(1),
    ratex_us: r.us });
}
if (shot) await page.screenshot({ path: shot, fullPage: true });
await browser.close();
console.log(JSON.stringify(out, null, 1));
