#!/usr/bin/env node
// Golden fixture for the design tokens (U03a): what Chromium computes for
// app/globals.css (compiled by Tailwind's own compiler) and what the client's
// theme / chat-size / prompt-color logic does.
//
//   node rust/scripts/theme-golden.mjs     (node@22)
//
// Re-runs itself under `--experimental-transform-types` with HOME in a temp
// dir, twice; both recordings must agree byte for byte. Each run:
//
// 1. Compiles app/globals.css with `@tailwindcss/node` (the compiler
//    `@tailwindcss/postcss` wraps), scanning app/, components/ and lib/ (the
//    React UI) with `@tailwindcss/oxide`, into the temp dir. The theme
//    variables Tailwind emits are the ones the UI uses (`themeVars`).
// 2. Loads a static page that inlines that CSS (a file:// URL in the temp dir:
//    no dev server, no port) in Playwright's Chromium at 1280x800, with the
//    two variables next/font sets on <html> (`--font-geist-sans` /
//    `--font-geist-mono`, as its generated CSS writes them), and reads
//    `getComputedStyle` per theme:
//    - colors: the custom property's computed text (`value`), the computed
//      `color` (`computed`), Chromium's own sRGB conversion through
//      `rgb(from var(--x) r g b / alpha)` (`srgb`, unclamped) and the pixel a
//      2D canvas paints (`px`, clipped and rounded);
//    - every `color-mix(in oklab, var(--x) N%, transparent)` the compiled
//      utilities use (Tailwind's `/N` opacity modifier), the scrollbar hover
//      mix, a few general mixes (sums off 100%, colors with alpha) and color
//      literals in each syntax the crate parses;
//    - lengths (spacing steps, radii, type scale and line heights, tracking,
//      leading, containers, blur), the weights and the font stacks;
//    - `--chat-col` / `--chat-text` (as `max-width` / `font-size`) at a range
//      of viewport widths;
//    - the composer frame in each state (PromptInput's `cn(...)` classes and
//      inline `borderColor`), a few border color utilities, `::selection` and
//      `--titlebar-height` with and without `data-electron`.
// 3. Imports the real lib/client/theme.ts, lib/client/chat-size.ts and
//    lib/shared/prompt-colors.ts (a load hook appends one `export { ... }`
//    line for their private helpers), runs app/layout.tsx's inline bootstrap
//    script (cut out of the source and run with `new Function`), and the
//    `/theme` and `/color` cases of ChatSurface.tsx's slash handler (cut out
//    of the source into a small module), with stub window / storage / DOM;
//    and node's `Number()` / `parseFloat` on the saved-size strings.
//
// Written to rust/crates/claudius-theme/tests/fixtures/theme_golden.json and
// replayed by crates/claudius-theme/tests/theme_golden.rs.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "crates/claudius-theme/tests/fixtures/theme_golden.json");

if (!process.env.THEME_GOLDEN_CHILD) {
  const browsers =
    process.env.PLAYWRIGHT_BROWSERS_PATH ??
    join(homedir(), process.platform === "darwin" ? "Library/Caches/ms-playwright" : ".cache/ms-playwright");
  const runs = [0, 1].map(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "theme-golden-")));
    try {
      const r = spawnSync(
        process.execPath,
        ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url)],
        {
          cwd: repo,
          encoding: "utf8",
          maxBuffer: 1 << 26,
          env: {
            PATH: process.env.PATH,
            HOME: root,
            TMPDIR: root,
            PLAYWRIGHT_BROWSERS_PATH: browsers,
            THEME_GOLDEN_CHILD: root,
          },
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
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, runs[0]);
  const f = JSON.parse(runs[0]);
  console.log(
    `wrote ${out.slice(repo.length + 1)} (stable): chromium ${f.chromium}, tailwind ${f.tailwind}, ` +
      `${f.themeVars.length} theme vars, ${f.mixes.length} mixes, ${f.chatColumn.length} viewports, ` +
      `${Object.keys(f.client).length} client sections`,
  );
  process.exit(0);
}

const ROOT_DIR = process.env.THEME_GOLDEN_CHILD;
const require_ = (await import("node:module")).createRequire(join(repo, "package.json"));
const THEMES = ["dark", "light", "midnight", "paper", "tui", "tui-light", "synthwave"];
// What next/font/google writes for `Geist({ variable: "--font-geist-sans" })`
// and `Geist_Mono({ variable: "--font-geist-mono" })` (its generated
// `.variable` classes, which app/layout.tsx puts on <html>).
const NEXT_FONT_VARS = `--font-geist-sans: "Geist", "Geist Fallback"; --font-geist-mono: "Geist Mono", "Geist Mono Fallback";`;

// ------------------------------ 1. compile ------------------------------

const { compile } = await import(pathToFileURL(require_.resolve("@tailwindcss/node")).href);
const { Scanner } = await import(pathToFileURL(require_.resolve("@tailwindcss/oxide")).href);
const tailwindVersion = JSON.parse(readFileSync(require_.resolve("tailwindcss/package.json"), "utf8")).version;
const cssPath = join(repo, "app/globals.css");
const compiler = await compile(readFileSync(cssPath, "utf8"), { base: dirname(cssPath), onDependency: () => {} });
if (compiler.root !== null) throw new Error("globals.css now sets a @source root: update the recorder");
const sources = ["app", "components", "lib"]
  .map((d) => ({ base: realpathSync(join(repo, d)), pattern: "**/*", negated: false }))
  .concat(compiler.sources);
const compiled = compiler.build(new Scanner({ sources }).scan());
writeFileSync(join(ROOT_DIR, "globals.compiled.css"), compiled);

const themeLayer = compiled.match(/@layer theme \{\s*:root, :host \{([^}]*)\}/);
if (!themeLayer) throw new Error("no `@layer theme { :root, :host { ... } }` in the compiled CSS");
const themeVars = [...themeLayer[1].matchAll(/^\s*(--[a-z0-9-]+):/gm)].map((m) => m[1]);
const spacingSteps = [...new Set([...compiled.matchAll(/calc\(var\(--spacing\) \* (-?[0-9.]+)\)/g)].map((m) => m[1]))]
  .map(Number)
  .sort((a, b) => a - b);
const mixExprs = [...new Set([...compiled.matchAll(/color-mix\(in oklab, var\((--[a-z0-9-]+)\) ([0-9.]+)%, transparent\)/g)].map((m) => `${m[1]} ${m[2]}`))]
  .map((s) => s.split(" "))
  .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : Number(a[1]) - Number(b[1])))
  .map(([v, p]) => ({ var: v, pct: Number(p) }));

// ------------------------------ 2. chromium ------------------------------

const pw = await import(pathToFileURL(require_.resolve("playwright")).href);
const chromium = pw.chromium ?? pw.default.chromium;
const page = join(ROOT_DIR, "page.html");
writeFileSync(
  page,
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>${compiled}</style>` +
    `<style>html { ${NEXT_FONT_VARS} }</style></head>` +
    `<body><div id="probe"></div><canvas id="cv" width="1" height="1"></canvas><div id="host"></div>` +
    `<div class="font-sans" id="fsans"></div><div class="font-mono" id="fmono"></div><code id="code"></code>` +
    `<div class="shiki-host"><pre id="shiki"></pre></div></body></html>`,
);

const PALETTE = ["--background", "--foreground", "--panel", "--panel-2", "--border", "--muted", "--accent"];
const SERIES = ["--series-1", "--series-2", "--series-3", "--series-4", "--series-5", "--series-6", "--series-other"];
const INLINE = PALETTE.map((v) => `--color-${v.slice(2)}`);
const colorVars = themeVars.filter((v) => v.startsWith("--color-") && !INLINE.includes(v));
const lengthVars = themeVars.filter((v) => /^--(spacing|container-|text-[a-z0-9]+$|radius-|blur-)/.test(v));
const textSizes = themeVars.filter((v) => /^--text-[a-z0-9]+$/.test(v)).map((v) => v.slice(7));

const browser = await chromium.launch();
const chromiumVersion = browser.version();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
const tab = await ctx.newPage();
await tab.goto(pathToFileURL(page).href);
await tab.evaluate(() => document.fonts.ready);

/** Runs in the page: the four readings of one color expression. */
const readColors = (exprs) => {
  const probe = document.getElementById("probe");
  const cv = document.getElementById("cv").getContext("2d", { colorSpace: "srgb", willReadFrequently: true });
  const root = getComputedStyle(document.documentElement);
  return exprs.map((e) => {
    const value = e.startsWith("--") ? root.getPropertyValue(e).trim() : null;
    const expr = e.startsWith("--") ? `var(${e})` : e;
    probe.style.color = "";
    probe.style.color = expr;
    const computed = getComputedStyle(probe).color;
    probe.style.color = `rgb(from ${expr} r g b / alpha)`;
    const srgb = getComputedStyle(probe).color;
    cv.clearRect(0, 0, 1, 1);
    cv.fillStyle = "#000";
    cv.fillStyle = computed;
    cv.fillRect(0, 0, 1, 1);
    const px = Array.from(cv.getImageData(0, 0, 1, 1).data);
    return value === null ? { expr: e, computed, srgb, px } : { var: e, value, computed, srgb, px };
  });
};

const setTheme = (t) =>
  tab.evaluate((t) => {
    if (t === null) delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
  }, t);

const themes = {};
const mixes = [];
const composer = [];
const chrome = {};
// PromptInput.tsx's composer frame: its `cn(...)` call (tailwind-merge drops
// the base `bg-[var(--panel-2)]` when the drag-over class brings its own
// background) and its inline `borderColor` rule, as the component writes them.
const promptInput = readFileSync(join(repo, "components/chat/PromptInput.tsx"), "utf8");
const FRAME_BASE = "flex items-end gap-2 rounded-2xl border bg-[var(--panel-2)] px-3 py-2 transition";
const FRAME_DRAG = "border-[var(--accent)] bg-[var(--accent)]/5";
const FRAME_BASH = "border-amber-500/60 focus-within:border-amber-500";
const FRAME_IDLE = "border-[var(--border)] focus-within:border-[var(--accent)]/60";
const FRAME_INLINE = "promptColor && !(!wideDropTarget && dragOver) && !isBashMode";
for (const piece of [FRAME_BASE, FRAME_DRAG, FRAME_BASH, FRAME_IDLE, FRAME_INLINE]) {
  if (promptInput.split(piece).length !== 2) throw new Error(`PromptInput.tsx no longer has \`${piece}\` once: update the recorder`);
}
const { cn } = await import(pathToFileURL(join(repo, "lib/utils/cn.ts")).href);
const COMPOSER = [];
for (const promptColor of [null, "#8b5cf6"]) {
  for (const wideDropTarget of [false, true]) {
    for (const dragOver of [false, true]) {
      for (const isBashMode of [false, true]) {
        for (const focus of [false, true]) {
          if (wideDropTarget && !dragOver) continue;
          const cls = cn(FRAME_BASE, !wideDropTarget && dragOver ? FRAME_DRAG : isBashMode ? FRAME_BASH : FRAME_IDLE);
          const inline = promptColor && !(!wideDropTarget && dragOver) && !isBashMode ? promptColor : null;
          COMPOSER.push({ promptColor, wideDropTarget, dragOver, isBashMode, focus, cls, inline });
        }
      }
    }
  }
}
// Border color utilities elsewhere in the UI, against globals.css's
// unlayered `* { border-color: var(--border) }`.
const BORDER_UTILITIES = ["border border-red-500", "border border-[var(--accent)]", "border-2 border-amber-500/60", "border border-emerald-500/30"];
// `null`: no data-theme attribute; "toString": the value layout.tsx's
// bootstrap lets through (see the client section).
for (const t of [...THEMES, null, "toString"]) {
  await setTheme(t);
  const key = t === null ? "(none)" : t;
  // (`@theme inline`'s `--color-*` aliases aren't emitted: no utility
  // the UI writes uses them.)
  const vars = [...PALETTE, ...SERIES];
  themes[key] = await tab.evaluate(readColors, vars);
  if (!THEMES.includes(t)) continue;
  const exprs = mixExprs.map((m) => `color-mix(in oklab, var(${m.var}) ${m.pct}%, transparent)`);
  exprs.push("color-mix(in oklab, var(--border) 60%, var(--foreground) 40%)");
  for (const r of await tab.evaluate(readColors, exprs)) mixes.push({ theme: t, ...r });
  for (const c of COMPOSER) {
    const r = await tab.evaluate((c) => {
      const host = document.getElementById("host");
      host.innerHTML = "";
      const box = document.createElement("div");
      box.className = c.cls;
      // No transition: the end state is what's read.
      box.style.transition = "none";
      if (c.inline) box.style.borderColor = c.inline;
      const input = document.createElement("textarea");
      box.appendChild(input);
      host.appendChild(box);
      if (c.focus) input.focus();
      const cs = getComputedStyle(box);
      const probe = document.getElementById("probe");
      const srgb = (v) => {
        probe.style.color = `rgb(from ${v} r g b / alpha)`;
        return getComputedStyle(probe).color;
      };
      const out = {
        focusWithin: box.matches(":focus-within"),
        border: cs.borderTopColor,
        borderSrgb: srgb(cs.borderTopColor),
        background: cs.backgroundColor,
        backgroundSrgb: srgb(cs.backgroundColor),
      };
      input.blur();
      host.innerHTML = "";
      return out;
    }, c);
    composer.push({ theme: t, ...c, ...r });
  }
  chrome[t] = await tab.evaluate((utilities) => {
    const probe = document.getElementById("probe");
    const host = document.getElementById("host");
    const srgb = (v) => {
      probe.style.color = `rgb(from ${v} r g b / alpha)`;
      return getComputedStyle(probe).color;
    };
    const borders = utilities.map((cls) => {
      host.innerHTML = `<div class="${cls}"></div>`;
      const c = getComputedStyle(host.firstChild).borderTopColor;
      host.innerHTML = "";
      return { class: cls, computed: c, srgb: srgb(c) };
    });
    const sel = getComputedStyle(probe, "::selection").backgroundColor;
    const root = document.documentElement;
    const titlebar = getComputedStyle(root).getPropertyValue("--titlebar-height").trim();
    root.dataset.electron = "1";
    const titlebarElectron = getComputedStyle(root).getPropertyValue("--titlebar-height").trim();
    const bodyPad = getComputedStyle(document.body).paddingTop;
    delete root.dataset.electron;
    return {
      borders,
      selection: { computed: sel, srgb: srgb(sel) },
      titlebar,
      titlebarElectron,
      bodyPaddingElectron: bodyPad,
    };
  }, BORDER_UTILITIES);
}
await setTheme("dark");
const tailwindColors = await tab.evaluate(readColors, colorVars);
// color-mix beyond the `/N` shape: sums under and over 100%, colors with
// alpha, both transparent.
const EXTRA_MIXES = [
  "color-mix(in oklab, var(--accent) 30%, var(--panel) 20%)",
  "color-mix(in oklab, var(--accent) 80%, var(--panel) 40%)",
  "color-mix(in oklab, var(--accent) 25%, var(--foreground) 75%)",
  "color-mix(in oklab, rgba(217, 119, 87, 0.35) 50%, var(--foreground) 50%)",
  "color-mix(in oklab, rgba(217, 119, 87, 0.35) 40%, transparent 60%)",
  "color-mix(in oklab, transparent 50%, transparent 50%)",
  "color-mix(in oklab, var(--color-red-500) 50%, var(--color-sky-400) 50%)",
  "color-mix(in oklab, #000 50%, #fff 50%)",
];
const extraMixes = await tab.evaluate(readColors, EXTRA_MIXES);
// Literal colors in every syntax color::parse reads, valid or not.
const LITERALS = [
  "#f00", "#F00", "#f008", "#ff000080", "#12345", "#gg0000", "rgb(10, 20, 30)", "rgba(10, 20, 30, 0.5)",
  "rgba(10,20,30,.333)", "rgb(100%, 0%, 50%)", "rgba(100%, 0%, 50%, 0.35)", "rgba(10.5, 20.4, 30, 0.35)", "rgb(10%, 20, 30)", "rgba(255, 106, 213, 0.4)", "rgba(1, 2, 3, 0.5, 9)", "rgb(300, -5, 20)",
  "rgba(1, 2, 3, 2)", "transparent", "TRANSPARENT", "oklch(50% 0.1 30)", "oklch(0.5 0.1 30 / 0.5)",
  "oklch(50% 25% 30)", "oklch(50% 0.1)", "oklch(62% 0.3 145 / 40%)", "oklab(0.5 0.1 0.1)", "red",
];
const literals = await tab.evaluate((list) => {
  const probe = document.getElementById("probe");
  const cv = document.getElementById("cv").getContext("2d", { colorSpace: "srgb", willReadFrequently: true });
  return list.map((c) => {
    // color::parse reads only the token syntaxes: a named color or oklab()
    // is out of scope even though the browser takes it.
    if (!CSS.supports("color", c)) return { text: c, valid: false };
    probe.style.color = `rgb(from ${c} r g b / alpha)`;
    const srgb = getComputedStyle(probe).color;
    cv.clearRect(0, 0, 1, 1);
    cv.fillStyle = c;
    cv.fillRect(0, 0, 1, 1);
    return { text: c, valid: true, srgb, px: Array.from(cv.getImageData(0, 0, 1, 1).data) };
  });
}, LITERALS);

const lengths = await tab.evaluate(
  ({ lengthVars, textSizes, spacingSteps, themeVars }) => {
    const probe = document.getElementById("probe");
    const read = (prop, value, extra = {}) => {
      probe.removeAttribute("style");
      for (const [k, v] of Object.entries(extra)) probe.style.setProperty(k, v);
      probe.style.setProperty(prop, value);
      return getComputedStyle(probe).getPropertyValue(prop);
    };
    const root = getComputedStyle(document.documentElement);
    const raw = Object.fromEntries(themeVars.filter((v) => !v.startsWith("--color-")).map((v) => [v, root.getPropertyValue(v).trim()]));
    const len = Object.fromEntries(lengthVars.map((v) => [v, read("margin-left", `var(${v})`)]));
    const text = textSizes.map((s) => ({
      size: s,
      fontSize: read("font-size", `var(--text-${s})`),
      lineHeight: read("line-height", `var(--text-${s}--line-height)`, { "font-size": `var(--text-${s})` }),
    }));
    const weights = themeVars.filter((v) => v.startsWith("--font-weight-")).map((v) => ({ var: v, computed: read("font-weight", `var(${v})`) }));
    const tracking = themeVars.filter((v) => v.startsWith("--tracking-")).map((v) => ({ var: v, computed: read("letter-spacing", `var(${v})`, { "font-size": "16px" }) }));
    const leading = themeVars.filter((v) => v.startsWith("--leading-")).map((v) => ({ var: v, computed: read("line-height", `var(${v})`, { "font-size": "16px" }) }));
    const spacing = spacingSteps.map((n) => ({ step: n, computed: read("margin-left", `calc(var(--spacing) * ${n})`) }));
    const radii = ["rounded", "rounded-sm", "rounded-md", "rounded-lg", "rounded-xl", "rounded-2xl", "rounded-full", "rounded-none"].map((cls) => {
      probe.removeAttribute("style");
      probe.className = cls;
      const r = getComputedStyle(probe).borderTopLeftRadius;
      probe.className = "";
      return { class: cls, computed: r };
    });
    const ff = (id) => getComputedStyle(document.getElementById(id)).fontFamily;
    const fonts = {
      html: getComputedStyle(document.documentElement).fontFamily,
      body: getComputedStyle(document.body).fontFamily,
      sans: ff("fsans"),
      mono: ff("fmono"),
      code: ff("code"),
      shiki: ff("shiki"),
    };
    const html = getComputedStyle(document.documentElement);
    const rootFont = { fontSize: html.fontSize, lineHeight: html.lineHeight };
    return { raw, len, text, weights, tracking, leading, spacing, radii, fonts, rootFont };
  },
  { lengthVars, textSizes, spacingSteps, themeVars },
);

const chatColumn = [];
for (const w of [320, 768, 1024, 1280, 1440, 1535, 1536, 1537, 1600, 1680, 1707, 1792, 1800, 1919, 1920, 1999, 2048, 2133, 2400, 2560, 3000, 3200, 3440, 3840, 4000, 5120, 6016, 7680]) {
  await tab.setViewportSize({ width: w, height: 800 });
  chatColumn.push({
    viewport: w,
    ...(await tab.evaluate(() => {
      const probe = document.getElementById("probe");
      probe.removeAttribute("style");
      probe.style.maxWidth = "var(--chat-col)";
      probe.style.fontSize = "var(--chat-text)";
      const cs = getComputedStyle(probe);
      return { innerWidth: window.innerWidth, col: cs.maxWidth, text: cs.fontSize };
    })),
  });
}
await browser.close();

// ------------------------------ 3. client ------------------------------

const themePath = join(repo, "lib/client/theme.ts");
const chatSizePath = join(repo, "lib/client/chat-size.ts");
const EXTRA = {
  [pathToFileURL(realpathSync(themePath)).href]: "\nexport { readSnapshot, applyTheme, subscribe, STORAGE_KEY, DEFAULT, SAME_TAB_EVENT };\n",
  [pathToFileURL(realpathSync(chatSizePath)).href]:
    "\nexport { readSnapshot, getSnapshot, clampCol, clampText, applyToDom, subscribe, COL_KEY, TEXT_KEY, SAME_TAB_EVENT };\n",
};
const hook = `
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
const ROOT = ${JSON.stringify(pathToFileURL(repo + "/").href)};
const EXTRA = ${JSON.stringify(EXTRA)};
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
}
export async function load(url, ctx, next) {
  const r = await next(url, ctx);
  if (!EXTRA[url]) return r;
  return { ...r, source: String(r.source) + EXTRA[url] };
}`;
register(`data:text/javascript,${encodeURIComponent(hook)}`);

// Stub browser: a storage whose keys can be made to throw, an event log and
// a documentElement with `dataset` and `style`.
const log = [];
const store = new Map();
const throwing = new Set();
const storage = {
  getItem(k) {
    if (throwing.has(k) || throwing.has("*")) throw new Error("SecurityError");
    log.push(["getItem", k]);
    return store.has(k) ? store.get(k) : null;
  },
  setItem(k, v) {
    if (throwing.has("set:" + k) || throwing.has("*")) throw new Error("QuotaExceededError");
    log.push(["setItem", k, String(v)]);
    store.set(k, String(v));
  },
  removeItem(k) {
    if (throwing.has("remove:" + k) || throwing.has("*")) throw new Error("SecurityError");
    log.push(["removeItem", k]);
    store.delete(k);
  },
};
const docEl = {
  dataset: {},
  style: {
    setProperty(k, v) {
      log.push(["setProperty", k, v]);
    },
    removeProperty(k) {
      log.push(["removeProperty", k]);
    },
  },
};
const win = {
  localStorage: storage,
  addEventListener: (t) => log.push(["addEventListener", t]),
  removeEventListener: (t) => log.push(["removeEventListener", t]),
  dispatchEvent: (e) => log.push(["dispatchEvent", e.type]),
  innerWidth: 1280,
};
const withBrowser = (fn) => {
  globalThis.window = win;
  globalThis.document = { documentElement: docEl };
  try {
    return fn();
  } finally {
    delete globalThis.window;
    delete globalThis.document;
  }
};
const reset = (values = {}, throws = []) => {
  log.length = 0;
  store.clear();
  throwing.clear();
  for (const [k, v] of Object.entries(values)) if (v !== null) store.set(k, v);
  for (const k of throws) throwing.add(k);
  docEl.dataset = {};
};

const React = await import(pathToFileURL(require_.resolve("react")).href);
const { renderToString } = await import(pathToFileURL(require_.resolve("react-dom/server.node")).href);
/** The hook's return value from a server render (setters keep working after). */
const capture = (useHook) => {
  let got;
  renderToString(
    React.createElement(() => {
      got = useHook();
      return null;
    }),
  );
  return got;
};

const theme = await import(pathToFileURL(themePath).href);
const chat = await import(pathToFileURL(chatSizePath).href);
const colors = await import(pathToFileURL(join(repo, "lib/shared/prompt-colors.ts")).href);
const client = {};

// The saved values the readers see. Strings that only differ in case or
// whitespace, Object.prototype names, and every theme id.
const SAVED_THEMES = [
  null, "", "dark", "light", "midnight", "paper", "tui", "tui-light", "synthwave", "Dark", " dark", "dark ",
  "tui_light", "toString", "constructor", "__proto__", "hasOwnProperty", "valueOf", "bogus", "undefined", "null",
  "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__", "isPrototypeOf",
  "propertyIsEnumerable", "toLocaleString", "toJSON", "__count__", "prototype",
];
client.theme = {
  themes: theme.THEMES,
  storageKey: theme.STORAGE_KEY,
  default: theme.DEFAULT,
  sameTabEvent: theme.SAME_TAB_EVENT,
  readNoWindow: theme.readSnapshot(),
  read: SAVED_THEMES.map((saved) => {
    reset({ [theme.STORAGE_KEY]: saved });
    return { saved, out: withBrowser(() => theme.readSnapshot()) };
  }),
  readThrows: (() => {
    reset({}, ["*"]);
    return withBrowser(() => theme.readSnapshot());
  })(),
  apply: ["dark", "synthwave", "bogus"].map((id) => {
    reset();
    withBrowser(() => theme.applyTheme(id));
    return { id, dataTheme: docEl.dataset.theme ?? null };
  }),
  applyNoDocument: (() => {
    reset();
    theme.applyTheme("light");
    return docEl.dataset.theme ?? null;
  })(),
  subscribe: (() => {
    reset();
    const off = withBrowser(() => theme.subscribe(() => {}));
    withBrowser(() => off());
    return log.slice();
  })(),
  ssr: withBrowser(() => capture(theme.useTheme).theme),
  set: [
    { id: "light", throws: [] },
    { id: "tui-light", throws: [] },
    { id: "bogus", throws: [] },
    { id: "paper", throws: ["set:claudius.theme"] },
  ].map(({ id, throws }) => {
    reset();
    const { setTheme } = withBrowser(() => capture(theme.useTheme));
    reset({}, throws);
    withBrowser(() => setTheme(id));
    return { id, throws, log: log.slice() };
  }),
};

// app/layout.tsx's beforeInteractive bootstrap, as the page runs it.
const layout = readFileSync(join(repo, "app/layout.tsx"), "utf8");
const bootStart = layout.indexOf("const themeBootstrap = `");
const bootEnd = layout.indexOf("})();`;", bootStart);
if (bootStart < 0 || bootEnd < 0 || layout.indexOf("const themeBootstrap = `", bootStart + 1) >= 0) {
  throw new Error("app/layout.tsx no longer declares `const themeBootstrap = `...`` once: update the recorder");
}
const bootstrapSrc = layout.slice(bootStart + "const themeBootstrap = `".length, bootEnd + "})();".length);
if (bootstrapSrc.includes("${")) throw new Error("the bootstrap template now interpolates: update the recorder");
const bootstrap = new Function("localStorage", "document", "navigator", bootstrapSrc);
const SAVED_SIZES = [
  null, "", " ", "40", "40.5", " 50 ", "40rem", "0x30", "1e3", "-5", "35.99", "36", "400", "400.5", "12", "13", "48",
  "48.25", "100", "Infinity", "-Infinity", "NaN", "1e400", "-0", "0", "\u00a040", "4e1", ".5e2", "50.", "+45", "1_0",
  "0b101010", "12px", "abc", "\u000b20", "0o17", "0X3c", "-0x10", "1e", "1e+2", ".", "+.5", "Infinityx", "0x",
  "-.5e1", "0B11", "0O7", "45e-1", "\ufeff42", "\u008542", "42\u0085", "\u202842", "1e-7", "0x1g",
];
const runBoot = (values, throws, ua) => {
  reset(values, throws);
  bootstrap(storage, { documentElement: docEl }, { userAgent: ua });
  return { dataTheme: docEl.dataset.theme ?? null, electron: docEl.dataset.electron ?? null, log: log.slice() };
};
client.bootstrap = [
  ...SAVED_THEMES.map((t) => ({ theme: t, col: null, text: null, throws: [], ua: "Chrome" })),
  ...SAVED_SIZES.map((s) => ({ theme: "light", col: s, text: s, throws: [], ua: "Chrome" })),
  { theme: "paper", col: "60", text: "17", throws: [], ua: "Mozilla/5.0 Claudius Electron/42.0.0" },
  { theme: "paper", col: "60", text: "17", throws: ["*"], ua: "Electron" },
  { theme: "paper", col: "60", text: "17", throws: ["claudius.theme"], ua: "Chrome" },
  { theme: "paper", col: "60", text: "17", throws: ["claudius.chatColRem"], ua: "Chrome" },
  { theme: "paper", col: "60", text: "17", throws: ["claudius.chatTextPx"], ua: "Chrome" },
].map((c) => ({
  ...c,
  ...runBoot({ "claudius.theme": c.theme, "claudius.chatColRem": c.col, "claudius.chatTextPx": c.text }, c.throws, c.ua),
}));

// lib/client/chat-size.ts.
const NUMBERS = [
  { $num: "NaN" }, { $num: "Infinity" }, { $num: "-Infinity" }, { $num: "-0" }, 0, 13, 12.5, 35.9, 36, 36.5, 47.99, 48,
  60, 100.25, 400, 400.1, 1e308, 5e-324, -1,
];
const num = (n) => (typeof n === "object" ? Number(n.$num === "-0" ? "-0" : n.$num) : n);
const enc = (n) =>
  Number.isNaN(n) ? { $num: "NaN" } : n === Infinity ? { $num: "Infinity" } : n === -Infinity ? { $num: "-Infinity" } : Object.is(n, -0) ? { $num: "-0" } : n;
// The two string-to-number readings (the hook's `Number()`, the
// bootstrap's `parseFloat`) on their own.
client.numbers = SAVED_SIZES.filter((v) => v !== null).map((v) => ({ in: v, number: enc(Number(v)), parseFloat: enc(parseFloat(v)) }));
client.chatSize = {
  bounds: chat.CHAT_SIZE_BOUNDS,
  keys: [chat.COL_KEY, chat.TEXT_KEY, chat.SAME_TAB_EVENT],
  clampCol: NUMBERS.map((n) => ({ in: n, out: enc(chat.clampCol(num(n))) })),
  clampText: NUMBERS.map((n) => ({ in: n, out: enc(chat.clampText(num(n))) })),
  readNoWindow: chat.readSnapshot(),
  read: SAVED_SIZES.map((s) => {
    reset({ [chat.COL_KEY]: s, [chat.TEXT_KEY]: s });
    return { saved: s, out: withBrowser(() => chat.readSnapshot()) };
  }),
  readThrows: [[chat.COL_KEY], [chat.TEXT_KEY], ["*"]].map((throws) => {
    reset({ [chat.COL_KEY]: "50", [chat.TEXT_KEY]: "20" }, throws);
    return { throws, out: withBrowser(() => chat.readSnapshot()) };
  }),
  // getSnapshot hands back the previous object while the key string is the
  // same. `prev` starts as the module's initial cache (`{null, null}` under
  // the key ":"), which an empty storage gets back.
  snapshots: (() => {
    reset();
    let prev = withBrowser(() => chat.getSnapshot());
    return [
      [null, null], [null, null], ["50", null], ["50", null], ["50.0", null], ["50", "20"], ["5e1", "2e1"], ["", ""],
      ["abc", "abc"], [null, null], ["36", "13"], ["1", "1"],
    ].map(([c, t]) => {
      reset({ [chat.COL_KEY]: c, [chat.TEXT_KEY]: t });
      const s = withBrowser(() => chat.getSnapshot());
      const same = s === prev;
      prev = s;
      return { col: c, text: t, out: s, same };
    });
  })(),
  apply: [
    { colRem: null, textPx: null }, { colRem: 40, textPx: null }, { colRem: null, textPx: 13.5 }, { colRem: 400, textPx: 48 },
  ].map((size) => {
    reset();
    withBrowser(() => chat.applyToDom(size));
    return { size, log: log.slice() };
  }),
  set: [
    ...NUMBERS.map((n) => ({ op: "setColRem", arg: n, throws: [] })),
    ...NUMBERS.map((n) => ({ op: "setTextPx", arg: n, throws: [] })),
    { op: "setColRem", arg: 50, throws: ["set:claudius.chatColRem"] },
    { op: "reset", arg: null, throws: [] },
    { op: "reset", arg: null, throws: ["*"] },
    { op: "reset", arg: null, throws: ["remove:claudius.chatColRem"] },
    { op: "reset", arg: null, throws: ["remove:claudius.chatTextPx"] },
  ].map(({ op, arg, throws }) => {
    reset();
    const hookOut = withBrowser(() => capture(chat.useChatSize));
    reset({ [chat.COL_KEY]: "50", [chat.TEXT_KEY]: "20" }, throws);
    withBrowser(() => (op === "reset" ? hookOut.reset() : hookOut[op](num(arg))));
    return { op, arg, throws, log: log.slice() };
  }),
  ssr: withBrowser(() => capture(chat.useChatSize).size),
};

const NAMES = [
  "red", "orange", "yellow", "green", "cyan", "blue", "purple", "pink", "RED", "Red", " red", "", "gray", "magenta",
  "toString", "constructor", "__proto__", "hasOwnProperty", "default", "none",
];
client.promptColors = {
  colors: colors.PROMPT_COLORS,
  names: colors.PROMPT_COLOR_NAMES,
  resetWords: colors.PROMPT_COLOR_RESET_WORDS,
  isName: NAMES.map((n) => ({ in: n, out: colors.isPromptColorName(n) })),
  resolve: [null, undefined, ...NAMES].map((n) => ({ in: n === undefined ? { $undefined: true } : n, out: colors.resolvePromptColor(n) })),
};

// ChatSurface.tsx's `/theme` and `/color` cases, cut out of the slash
// handler's switch into a function with the closure's names as parameters.
const surface = readFileSync(join(repo, "components/chat/ChatSurface.tsx"), "utf8");
const caseStart = surface.indexOf('\n        case "theme": {\n');
const caseEnd = surface.indexOf('\n        case "output-style": {\n', caseStart);
if (caseStart < 0 || caseEnd < 0 || surface.indexOf('\n        case "theme": {\n', caseStart + 1) >= 0) {
  throw new Error('ChatSurface.tsx no longer has the `case "theme"` ... `case "output-style"` run once: update the recorder');
}
const cases = surface.slice(caseStart, caseEnd);
if (!cases.includes('case "color": {')) throw new Error('`case "color"` moved: update the recorder');
const harness = join(ROOT_DIR, "slash-cases.ts");
writeFileSync(
  harness,
  `import { PROMPT_COLOR_NAMES, PROMPT_COLOR_RESET_WORDS, isPromptColorName, type PromptColorName } from "@/lib/shared/prompt-colors";
export function run(cmd: string, args: string, env: any): boolean {
  const { session, showToast, router, setPromptColor, activePromptColor } = env;
  switch (cmd) {${cases}
  }
  return false;
}
`,
);
const slash = await import(pathToFileURL(harness).href);
const runSlash = (cmd, args, { sessionId = "s-1", current = null, random = 0, throws = [] } = {}) => {
  reset({}, throws);
  const calls = [];
  const realRandom = Math.random;
  Math.random = () => random;
  globalThis.fetch = (url, init) => {
    calls.push(["fetch", url, init.method, init.headers, init.body]);
    return Promise.resolve();
  };
  try {
    let handled;
    let error;
    try {
      handled = withBrowser(() =>
      slash.run(cmd, args, {
        session: { sessionId },
        activePromptColor: current,
        showToast: (m) => calls.push(["toast", m]),
        router: { push: (p) => calls.push(["push", p]) },
        setPromptColor: (v) => calls.push(["setPromptColor", v]),
      }),
      );
    } catch (e) {
      error = String(e);
    }
    const outcome = error === undefined ? { handled } : { error };
    return { ...outcome, calls, log: log.slice(), dataTheme: docEl.dataset.theme ?? null };
  } finally {
    Math.random = realRandom;
    delete globalThis.fetch;
  }
};
const THEME_ARGS = [
  "", "dark", "light", "midnight", "paper", " DARK ", "Paper", "tui", "tui-light", "synthwave", "light\n", "dar\u212a",
  "paper\u00a0", "\ufeffmidnight", "midnight\u0085", "dark light", "\u2028light\u3000",
];
const COLOR_ARGS = [
  "red", "RED", " Blue ", "pin\u212a", "purple\t", "default", "none", "off", "clear", "reset", " Reset ", "bogus", "toString",
  "__proto__", "red\u0085", "\ufeffcyan", "gray", "\u0130",
];
client.slash = [
  ...THEME_ARGS.map((a) => ({ cmd: "theme", args: a })),
  // The handler doesn't catch a refused write.
  { cmd: "theme", args: "dark", throws: ["set:claudius.theme"] },
  { cmd: "color", args: "red", sessionId: null },
  { cmd: "color", args: "", sessionId: null },
  { cmd: "color", args: "blue", sessionId: "" },
  ...COLOR_ARGS.map((a) => ({ cmd: "color", args: a })),
  ...[0, 0.124, 0.125, 0.5, 0.875, 0.999999].flatMap((random) =>
    [null, "red", "pink", "cyan"].map((current) => ({ cmd: "color", args: "  ", current, random })),
  ),
].map((c) => ({ ...c, ...runSlash(c.cmd, c.args, c) }));

writeFileSync(
  join(ROOT_DIR, "out.json"),
  `${JSON.stringify(
    {
      chromium: chromiumVersion,
      tailwind: tailwindVersion,
      nextFontVars: NEXT_FONT_VARS,
      themeVars,
      themes,
      tailwindColors,
      mixes,
      extraMixes,
      literals,
      composer,
      chrome,
      lengths,
      chatColumn,
      client,
    },
    null,
    1,
  )}\n`,
);
