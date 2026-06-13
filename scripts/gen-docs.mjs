#!/usr/bin/env node
// Documentation generator for Claudius — `make documentation`.
//
// Produces and *maintains* `docs/SITEMAP.md`: a sitemap of every UI
// interface, screen, and menu in the app, with a short description of each.
//
// How it works
// ------------
// 1. Discover every `app/**/page.tsx` (UI screens) and `app/api/**/route.ts`
//    (HTTP endpoints) from the filesystem — so the structure is always an
//    exact reflection of the routes that actually exist.
// 2. Pull human labels + keyboard shortcuts from the live nav registry
//    (`components/nav/SideNav.tsx`) so screen names match what's on screen.
// 3. For each interface, ask Claude (via the same `@anthropic-ai/claude-agent-sdk`
//    `query()` path the app already uses for commit messages / recaps) to read
//    the source and write a 2-4 sentence description.
// 4. Cache each description keyed by a hash of its source in
//    `docs/.sitemap-cache.json`, so regenerating only re-asks Claude for the
//    interfaces whose code actually changed. This is what makes the doc cheap
//    to keep up to date.
//
// Flags
// -----
//   --force          ignore the cache; regenerate every description
//   --no-ai          skip Claude entirely; emit the structure with placeholder
//                    descriptions (fast, offline, deterministic)
//   --concurrency N  max parallel Claude calls (default 4)
//
// Auth: uses the machine's existing Claude Code credentials (the agent SDK
// resolves them the same way the running app does) — no API key required.

import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_DIR = path.join(REPO_ROOT, "app");
const OUT_FILE = path.join(REPO_ROOT, "docs", "SITEMAP.md");
const CACHE_FILE = path.join(REPO_ROOT, "docs", ".sitemap-cache.json");
const SIDENAV_FILE = path.join(REPO_ROOT, "components", "nav", "SideNav.tsx");

const args = process.argv.slice(2);
const FORCE = args.includes("--force");
const NO_AI = args.includes("--no-ai");
const CONCURRENCY = (() => {
  const i = args.indexOf("--concurrency");
  const n = i >= 0 ? Number(args[i + 1]) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 4;
})();

const MAX_SOURCE_CHARS = 12_000;
const PLACEHOLDER = "_(description pending — run `make documentation` with Claude access)_";

// ── route discovery ───────────────────────────────────────────────────────

/** Recursively collect files named `target` under `dir`. */
async function collect(dir, target, out = []) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await collect(full, target, out);
    else if (e.name === target) out.push(full);
  }
  return out;
}

/** `app/[workspaceId]/git/page.tsx` -> `/[workspaceId]/git` (root -> `/`). */
function routeFromPage(file) {
  const rel = path.relative(APP_DIR, path.dirname(file));
  const r = "/" + rel.split(path.sep).join("/");
  return r === "/." || rel === "" ? "/" : r;
}

/** `app/api/sessions/[id]/stream/route.ts` -> `/api/sessions/[id]/stream`. */
function routeFromApi(file) {
  const rel = path.relative(APP_DIR, path.dirname(file));
  return "/" + rel.split(path.sep).join("/");
}

function categorize(route) {
  if (route === "/") return "global"; // app root: entry point / workspace redirect
  const isWorkspace = route.startsWith("/[workspaceId]");
  const isDev = /(^|\/)dev(\/|$)/.test(route);
  if (isDev) return "dev";
  if (isWorkspace) return "workspace";
  return "global";
}

// ── nav labels (parsed from the live SideNav registry) ──────────────────────

const FALLBACK_LABELS = {
  "": "Chat",
  "/git": "Git",
  "/sessions": "Sessions",
  "/files": "Files",
  "/memory": "Memory",
  "/assets": "Assets",
  "/cost": "Cost",
  "/agents": "Agents",
  "/skills": "Skills",
  "/mcp": "MCP",
  "/hooks": "Hooks",
  "/schedule": "Schedule",
  "/permissions": "Permissions",
  "/docker": "Docker",
  "/tracker": "Tracker",
  "/database": "Database",
  "/notebooks": "Notebooks",
  "/workspace": "Workspace",
  "/keybindings": "Keybindings",
  "/pipeline": "Pipeline",
  // System tiles (WorkspaceSwitcher) + other global screens.
  "/settings": "Settings",
  "/plugins": "Plugins",
  "/usage": "Account & Usage",
  "/community": "Community",
  "/doctor": "Doctor",
  "/welcome": "Welcome",
  "/release-notes": "Release notes",
  "/updater": "Updater",
  "/customize": "Customize",
};

/**
 * Parse `{ label: "X", href: "/y", actionId: "nav.z", customizationName: "W" }`
 * entries out of SideNav.tsx so the doc's labels + shortcut hints stay in
 * lock-step with the rail. Falls back to FALLBACK_LABELS on any parse miss.
 */
async function loadNavMeta() {
  const labels = { ...FALLBACK_LABELS };
  const gated = {}; // href -> customizationName
  let src = "";
  try {
    src = await fs.readFile(SIDENAV_FILE, "utf8");
  } catch {
    return { labels, gated };
  }
  const itemRe = /\{\s*label:\s*"([^"]+)"[^}]*?href:\s*"([^"]*)"[^}]*?\}/gs;
  for (const m of src.matchAll(itemRe)) {
    const [, label, href] = m;
    labels[href] = label;
    const cust = m[0].match(/customizationName:\s*"([^"]+)"/);
    if (cust) gated[href] = cust[1];
  }
  return { labels, gated };
}

/** Inner href used by the nav map for a given route. */
function innerHref(route, category) {
  if (route === "/") return "";
  if (category === "workspace") return route.replace(/^\/\[workspaceId\]/, "");
  return route; // global routes are keyed by their own path
}

function titleCase(seg) {
  return seg
    .replace(/^\[+\.*/, "")
    .replace(/\]+$/, "")
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function labelFor(route, category, navLabels) {
  if (route === "/") return "Home (entry / redirect)";
  const inner = innerHref(route, category);
  if (navLabels[inner] != null) return navLabels[inner];
  if (navLabels[route] != null) return navLabels[route];
  const segs = route.split("/").filter(Boolean);
  const last = segs[segs.length - 1] ?? "";
  const parent = segs[segs.length - 2];
  // Dynamic detail pages: name from the parent + "detail".
  if (/^\[.*\]$/.test(last)) return parent ? `${titleCase(parent)} detail` : "Detail";
  // Nested static pages: qualify with the parent so e.g. /customize/settings
  // reads "Customize settings" rather than a bare "Settings".
  if (parent && !/^\[.*\]$/.test(parent)) return `${titleCase(parent)} ${last.replace(/[-_]/g, " ")}`;
  return last ? titleCase(last) : "Home";
}

// ── HTTP method extraction for API routes ───────────────────────────────────

const HTTP_VERBS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
function methodsOf(src) {
  const found = new Set();
  for (const v of HTTP_VERBS) {
    const re = new RegExp(`export\\s+(?:async\\s+)?(?:function\\s+${v}\\b|const\\s+${v}\\b)`);
    if (re.test(src)) found.add(v);
  }
  return [...found];
}

// ── Claude description generation (mirrors lib/server/commit-message.ts) ─────

let queryFn = null;
async function getQuery() {
  if (queryFn) return queryFn;
  const mod = await import("@anthropic-ai/claude-agent-sdk");
  queryFn = mod.query;
  return queryFn;
}

const SCREEN_SYSTEM = `You write concise reference documentation for the screens of a web application (Claudius — a browser UI around the Claude Code agent SDK).

Given a screen's route, its display name, and its React source, write 2-4 plain sentences describing:
- what the interface shows, and
- what the user can do on it.

Rules:
- Output ONLY the description prose. No headings, no bullet points, no markdown, no preamble, no quotes.
- Be specific and grounded in the source — do not invent features.
- Present tense, third person ("Displays…", "Lets the user…").`;

const API_SYSTEM = `You document groups of Next.js API route handlers for the Claudius app.

Given several route handlers that share a URL prefix, write 1-2 plain sentences describing what this group of endpoints does collectively.

Rules:
- Output ONLY the description prose. No headings, no markdown, no preamble.
- Be specific and grounded in the source — do not invent behavior.`;

// The Claude Code CLI sometimes reports auth/setup failures as a *successful*
// result whose text is one of these sentinels (rather than throwing). Treat
// any of them as a hard failure so the preflight aborts instead of stamping
// the sentinel into every description.
const AUTH_SENTINELS = [
  /not logged in/i,
  /please run \/login/i,
  /invalid api key/i,
  /credit balance is too low/i,
  /authentication_error/i,
];

async function askClaude(system, prompt) {
  const query = await getQuery();
  const q = query({
    prompt,
    options: {
      cwd: REPO_ROOT,
      systemPrompt: system,
      tools: [],
      permissionMode: "bypassPermissions",
      maxTurns: 1,
    },
  });
  for await (const msg of q) {
    if (msg.type !== "result") continue;
    if (msg.subtype === "success") {
      const text = stripFences(String(msg.result).trim());
      if (AUTH_SENTINELS.some((re) => re.test(text))) throw new Error(text);
      return text;
    }
    throw new Error(`claude returned ${msg.subtype}`);
  }
  throw new Error("no result from claude");
}

function stripFences(s) {
  const m = s.match(/^```[a-z]*\n([\s\S]*?)\n```$/i);
  return (m ? m[1] : s).trim();
}

function sha(s) {
  return crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);
}

/** Simple concurrency-limited map. */
async function pMap(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ── markdown rendering ──────────────────────────────────────────────────────

function anchor(route) {
  return route.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "home";
}

function renderTree(screens) {
  // Group workspace + global screens into a readable nested list by first segment.
  const lines = [];
  const byCat = { workspace: [], global: [], dev: [] };
  for (const s of screens) byCat[s.category].push(s);
  const section = (title, list) => {
    if (!list.length) return;
    lines.push(`- **${title}**`);
    for (const s of list.sort((a, b) => a.route.localeCompare(b.route))) {
      const shortcut = s.shortcut ? ` _(${s.shortcut})_` : "";
      const gated = s.gatedBy ? ` _(requires “${s.gatedBy}” customization)_` : "";
      lines.push(`  - [${s.label}](#${anchor(s.route)}) — \`${s.route}\`${shortcut}${gated}`);
    }
  };
  section("Workspace screens", byCat.workspace);
  section("Global screens", byCat.global);
  section("Developer preview routes", byCat.dev);
  return lines.join("\n");
}

const CATEGORY_TITLES = {
  workspace: "Workspace screens",
  global: "Global screens",
  dev: "Developer preview routes",
};

function renderScreenSections(screens) {
  const out = [];
  for (const cat of ["workspace", "global", "dev"]) {
    const list = screens.filter((s) => s.category === cat).sort((a, b) => a.route.localeCompare(b.route));
    if (!list.length) continue;
    out.push(`## ${CATEGORY_TITLES[cat]}\n`);
    if (cat === "workspace")
      out.push("These screens live under `/[workspaceId]/…` and operate on the active workspace.\n");
    if (cat === "dev")
      out.push("Internal fixtures used to preview chat/UI states in isolation. Not part of the normal navigation.\n");
    for (const s of list) {
      out.push(`### ${s.label}\n`);
      const meta = [`\`${s.route}\``];
      if (s.shortcut) meta.push(`shortcut: ${s.shortcut}`);
      if (s.gatedBy) meta.push(`requires the “${s.gatedBy}” customization`);
      out.push(`<a id="${anchor(s.route)}"></a>${meta.join(" · ")}\n`);
      out.push(`${s.description}\n`);
    }
  }
  return out.join("\n");
}

function renderApiSection(groups) {
  const out = ["## API endpoints\n", "HTTP route handlers under `app/api/`, grouped by resource.\n"];
  for (const g of groups.sort((a, b) => a.prefix.localeCompare(b.prefix))) {
    out.push(`### \`/api/${g.prefix}\`\n`);
    out.push(`${g.description}\n`);
    for (const r of g.routes.sort((a, b) => a.route.localeCompare(b.route))) {
      const m = r.methods.length ? r.methods.join(", ") : "—";
      out.push(`- \`${m}\` \`${r.route}\``);
    }
    out.push("");
  }
  return out.join("\n");
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  const navMeta = await loadNavMeta();

  // 1) Discover UI screens.
  const pageFiles = (await collect(APP_DIR, "page.tsx")).filter((f) => !f.includes(`${path.sep}api${path.sep}`));
  const screens = [];
  for (const file of pageFiles) {
    const route = routeFromPage(file);
    const category = categorize(route);
    const inner = innerHref(route, category);
    screens.push({
      route,
      file,
      category,
      label: labelFor(route, category, navMeta.labels),
      gatedBy: navMeta.gated[inner] ?? null,
      shortcut: null,
      description: "",
    });
  }

  // 2) Discover API routes, grouped by first segment under /api.
  const apiFiles = await collect(path.join(APP_DIR, "api"), "route.ts");
  const apiByPrefix = new Map();
  for (const file of apiFiles) {
    const route = routeFromApi(file);
    const prefix = route.split("/").filter(Boolean)[1] ?? "_root";
    const src = await fs.readFile(file, "utf8");
    if (!apiByPrefix.has(prefix)) apiByPrefix.set(prefix, { prefix, routes: [], srcs: [] });
    const g = apiByPrefix.get(prefix);
    g.routes.push({ route, methods: methodsOf(src) });
    g.srcs.push(`// ${route}\n${src.slice(0, 2000)}`);
  }
  const apiGroups = [...apiByPrefix.values()];

  // 3) Load cache.
  let cache = {};
  if (!FORCE) {
    try {
      cache = JSON.parse(await fs.readFile(CACHE_FILE, "utf8"));
    } catch {
      cache = {};
    }
  }
  const nextCache = {};
  let generated = 0;
  let reused = 0;

  // Preflight: confirm Claude is reachable before doing real work, so an
  // auth failure aborts cleanly instead of stamping "Not logged in" into
  // every description and clobbering the committed doc. Skipped when every
  // description is already cached (nothing to generate) or in --no-ai mode.
  const needAi =
    !NO_AI &&
    (screens.some((s) => !cache[`screen:${s.route}`]) ||
      apiGroups.some((g) => !cache[`api:${g.prefix}`]) ||
      FORCE);
  if (needAi) {
    try {
      await askClaude("Reply with exactly: OK", "Say OK");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `\nClaude is not available — aborting without changing docs/SITEMAP.md.\n  ${msg}\n\n` +
          "Fix one of:\n" +
          "  • Log Claude Code in on this machine (run `claude`, then /login), or\n" +
          "  • set ANTHROPIC_API_KEY in the environment, or\n" +
          "  • run `make documentation NO_AI=1` for a structure-only doc.\n",
      );
      process.exit(1);
    }
  }

  // 4) Describe screens (concurrency-limited).
  await pMap(screens, CONCURRENCY, async (s) => {
    const src = await fs.readFile(s.file, "utf8");
    const trimmed = src.length > MAX_SOURCE_CHARS ? src.slice(0, MAX_SOURCE_CHARS) + "\n/* …truncated… */" : src;
    const key = `screen:${s.route}`;
    const h = sha(`${s.label}\n${trimmed}`);
    const cached = cache[key];
    if (cached && cached.hash === h && cached.description) {
      s.description = cached.description;
      nextCache[key] = cached;
      reused++;
      return;
    }
    if (NO_AI) {
      // Don't cache the placeholder — leaving the key absent means a later
      // run with Claude access regenerates a real description for it.
      s.description = PLACEHOLDER;
      return;
    }
    const prompt = `Route: ${s.route}\nScreen name: ${s.label}\nCategory: ${s.category}\n\nReact source:\n\`\`\`tsx\n${trimmed}\n\`\`\``;
    try {
      s.description = await askClaude(SCREEN_SYSTEM, prompt);
      generated++;
      nextCache[key] = { hash: h, description: s.description }; // only cache real output
      process.stderr.write(`  ✓ ${s.route}\n`);
    } catch (err) {
      // Don't cache errors — they retry next run.
      s.description = `_(could not generate description: ${err instanceof Error ? err.message : String(err)})_`;
    }
  });

  // 5) Describe API groups.
  await pMap(apiGroups, CONCURRENCY, async (g) => {
    const blob = g.srcs.join("\n\n").slice(0, MAX_SOURCE_CHARS);
    const key = `api:${g.prefix}`;
    const h = sha(blob);
    const cached = cache[key];
    if (cached && cached.hash === h && cached.description) {
      g.description = cached.description;
      nextCache[key] = cached;
      reused++;
      return;
    }
    if (NO_AI) {
      g.description = `Endpoints under \`/api/${g.prefix}\` _(description pending — run \`make documentation\` with Claude access)_.`;
      return; // not cached — regenerated on a later run with Claude access
    }
    const prompt = `URL prefix: /api/${g.prefix}\nEndpoints: ${g.routes.map((r) => r.route).join(", ")}\n\nHandlers:\n\`\`\`ts\n${blob}\n\`\`\``;
    try {
      g.description = await askClaude(API_SYSTEM, prompt);
      generated++;
      nextCache[key] = { hash: h, description: g.description }; // only cache real output
      process.stderr.write(`  ✓ /api/${g.prefix}\n`);
    } catch (err) {
      g.description = `_(could not generate description: ${err instanceof Error ? err.message : String(err)})_`;
    }
  });

  // 6) Render the document.
  const totalScreens = screens.length;
  const totalApi = apiGroups.reduce((n, g) => n + g.routes.length, 0);
  const md = [
    "# Claudius — interface map",
    "",
    "> **Generated** by `make documentation` (`scripts/gen-docs.mjs`). Do not edit by hand —",
    "> structure is discovered from `app/**`, descriptions are written by Claude and cached in",
    "> `docs/.sitemap-cache.json`. Re-run `make documentation` after changing the UI; only screens",
    "> whose source changed are re-described.",
    "",
    `This catalogs every UI screen, menu, and HTTP endpoint in Claudius: **${totalScreens} screens** and **${totalApi} API endpoints**.`,
    "",
    "## Navigation menus",
    "",
    "Two persistent rails frame every screen:",
    "",
    "- **Left nav rail** (`components/nav/SideNav.tsx`) — workspace-scoped destinations (Chat, Git, Sessions, Files, …). Tiles are drag-reorderable and each has a user-remappable keyboard shortcut. Customization-gated tiles (Docker, Tracker, Database, Notebooks) appear only when their customization is published.",
    "- **Workspace switcher** (`components/nav/WorkspaceSwitcher.tsx`) — switches between workspaces and holds the system-global tiles: Community, Plugins, Settings, and Account & Usage.",
    "- **Command palette** (`components/overlays/CommandPalette.tsx`, ⌘K) — fuzzy-search across every navigation destination, slash command, and keyboard shortcut.",
    "",
    "## Sitemap",
    "",
    renderTree(screens),
    "",
    renderScreenSections(screens),
    renderApiSection(apiGroups),
  ].join("\n");

  await fs.mkdir(path.dirname(OUT_FILE), { recursive: true });
  await fs.writeFile(OUT_FILE, md.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n", "utf8");
  await fs.writeFile(CACHE_FILE, JSON.stringify(nextCache, null, 2) + "\n", "utf8");

  process.stderr.write(
    `\nWrote ${path.relative(REPO_ROOT, OUT_FILE)} — ${totalScreens} screens, ${apiGroups.length} API groups (${generated} generated, ${reused} cached).\n`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
