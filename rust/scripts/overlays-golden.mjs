#!/usr/bin/env node
// Golden fixture for the overlays the native app ports (U10a):
// components/overlays/CommandPalette.tsx (WORKSPACE_NAV, GLOBAL_NAV,
// fuzzyMatch, the `items` and `filtered` memos, `clampedActive`, `activate`
// and the input's key handler: all private, read from the source and run
// as written), components/overlays/HelpOverlay.tsx (the `grouped` memo and
// the usage card's condition, read from the source), lib/shared/
// slash-commands.ts (SLASH_COMMANDS, CATEGORY_LABELS, the private
// CATEGORY_ORDER, mergeSuggestions), lib/shared/slash-help.ts
// (findHelpTopic, usageLine), lib/client/shortcuts.ts (SHORTCUT_ACTIONS,
// formatBinding), components/settings/ShortcutsSection.tsx (the private
// CATEGORY_LABEL / CATEGORY_ORDER the cheatsheet groups by) and
// lib/shared/route-params.ts (workspaceIdFromPathname).
//
//   node rust/scripts/overlays-golden.mjs     (node@22)
//
// Re-runs itself under `--experimental-transform-types` with HOME in a temp
// dir and a resolve hook for the `@/` and extensionless imports, twice; both
// recordings must agree byte for byte. The file is ASCII: every other
// character is a \u escape.
//
// Written to rust/app/crates/claudius-overlays/tests/fixtures/overlays_golden.json
// and replayed by app/crates/claudius-overlays/tests/overlays_golden.rs and
// app/crates/claudius-app/tests/palette_golden.rs.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "app/crates/claudius-overlays/tests/fixtures/overlays_golden.json");

if (!process.env.OVERLAYS_GOLDEN_CHILD) {
  const runs = [0, 1].map(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "overlays-golden-")));
    try {
      const r = spawnSync(
        process.execPath,
        ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url)],
        {
          cwd: repo,
          encoding: "utf8",
          maxBuffer: 1 << 26,
          env: { PATH: process.env.PATH, HOME: root, TZ: "UTC", OVERLAYS_GOLDEN_CHILD: root },
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

const ROOT_DIR = process.env.OVERLAYS_GOLDEN_CHILD;

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
const sh = await lib("lib/shared/slash-help.ts");
const ks = await lib("lib/client/shortcuts.ts");
const rp = await lib("lib/shared/route-params.ts");

// ------------------------------------------------------------ the sources

const source = (p) => readFileSync(join(repo, p), "utf8");
/** The text from `from` (included) up to `to` (excluded); each once. */
function between(src, file, from, to) {
  const a = src.indexOf(from);
  if (a < 0 || src.indexOf(from, a + 1) >= 0) throw new Error(`${file}: "${from}" isn't there once: update the recorder`);
  const b = src.indexOf(to, a + from.length);
  if (b < 0) throw new Error(`${file}: no "${to}" after "${from}": update the recorder`);
  return src.slice(a, b);
}
/** The text strictly between `from` and `to`. */
const inner = (src, file, from, to) => between(src, file, from, to).slice(from.length);
/** Throws unless `text` is in `src` exactly once. */
function once(src, file, text) {
  const a = src.indexOf(text);
  if (a < 0 || src.indexOf(text, a + 1) >= 0) throw new Error(`${file}: "${text}" isn't there once: update the recorder`);
}

const PALETTE = "components/overlays/CommandPalette.tsx";
const palette = source(PALETTE);
const types = between(palette, PALETTE, "type ItemKind", "// \u2500\u2500 Nav catalog");
const statics = between(palette, PALETTE, "const WORKSPACE_NAV", "export function CommandPalette()");
const itemsMemo = inner(palette, PALETTE, "const items = useMemo<Item[]>(", ", [workspaceId, bindingPlatform]);");
const filteredMemo = inner(palette, PALETTE, "const filtered = useMemo(", ", [items, query]);");
const clampExpr = inner(palette, PALETTE, "const clampedActive =", ";\n");
const activateCb = inner(palette, PALETTE, "const activate = useCallback(\n", ",\n    [router],\n  );");
const keyCb = inner(palette, PALETTE, "const onInputKey = useCallback(\n", ",\n    [filtered, clampedActive, activate],\n  );");
// The open toggle resets the query and the selection (togglePalette).
once(palette, PALETTE, 'if (next) {\n        setQuery("");\n        setActiveIndex(0);\n      }');
// A row: hover selects it, a click activates it.
once(palette, PALETTE, "onHover={() => setActiveIndex(i)}");
once(palette, PALETTE, "onActivate={() => activate(it)}");

const paletteModule = `
import { formatBinding, SHORTCUT_ACTIONS, type ShortcutAction, type ShortcutBinding } from "@/lib/client/shortcuts";
import { SLASH_COMMANDS } from "@/lib/shared/slash-commands";
${types}
${statics}
export function buildItems(workspaceId: string | null, bindingPlatform: "mac" | "other"): Item[] {
  return (${itemsMemo})();
}
export function filterItems(items: Item[], query: string): Item[] {
  return (${filteredMemo})();
}
export function clamp(filtered: Item[], activeIndex: number): number {
  return (${clampExpr});
}
/** One open palette: the steps a user takes, the state after each. */
export function simulate(workspaceId: string | null, bindingPlatform: "mac" | "other", steps: any[]) {
  const items = buildItems(workspaceId, bindingPlatform);
  let query = "";
  let activeIndex = 0;
  let open = true;
  const pushed: string[] = [];
  const setActiveIndex = (v: number) => { activeIndex = v; };
  const setOpen = (v: boolean) => { open = v; };
  const router = { push: (href: string) => { pushed.push(href); } };
  const trace = [];
  for (const step of steps) {
    const filtered = filterItems(items, query);
    const clampedActive = clamp(filtered, activeIndex);
    const activate = ${activateCb};
    const onInputKey = ${keyCb};
    if (step.key !== undefined) onInputKey({ key: step.key, preventDefault() {} } as any);
    else if (step.query !== undefined) query = step.query;
    else if (step.hover !== undefined) setActiveIndex(step.hover);
    else if (step.click !== undefined) activate(filtered[step.click]);
    const now = filterItems(items, query);
    const active = clamp(now, activeIndex);
    trace.push({
      stored: activeIndex,
      active,
      activeId: now[active]?.id ?? null,
      count: now.length,
      open,
      pushed: [...pushed],
    });
  }
  return trace;
}
export { WORKSPACE_NAV, GLOBAL_NAV, fuzzyMatch, shortcutDetail };
`;
writeFileSync(join(ROOT_DIR, "palette.ts"), paletteModule);
const pal = await import(pathToFileURL(join(ROOT_DIR, "palette.ts")).href);

const HELP = "components/overlays/HelpOverlay.tsx";
const help = source(HELP);
const groupedMemo = inner(help, HELP, "const grouped = useMemo(", ", [filter, all]);");
const TOPIC_RULE = "topic && filter.trim().toLowerCase() === topic";
once(help, HELP, `{${TOPIC_RULE} && <TopicUsage topic={topic} cmd={topicCmd} />}`);
once(help, HELP, "subtitle={`Help \u00b7 ${all.length} commands`}");
once(help, HELP, "{CATEGORY_LABELS[cat]} \u00b7 {list.length}");
once(help, HELP, "const [filter, setFilter] = useState(topic ?? \"\");");
once(help, HELP, "const topicCmd = useMemo(() => (topic ? findHelpTopic(all, topic) : undefined), [all, topic]);");

const SLASH = "lib/shared/slash-commands.ts";
const slashOrder = inner(source(SLASH), SLASH, "const CATEGORY_ORDER: SlashCategory[] = ", ";\n");

const SECTION = "components/settings/ShortcutsSection.tsx";
const section = source(SECTION);
const shortcutLabels = inner(section, SECTION, "const CATEGORY_LABEL: Record<ShortcutCategory, string> = ", ";\n");
const shortcutOrder = inner(section, SECTION, "const CATEGORY_ORDER: ShortcutCategory[] = ", ";\n");

const helpModule = `
import { CATEGORY_LABELS, mergeSuggestions, type SlashCategory, type SlashSuggestion } from "@/lib/shared/slash-commands";
import { findHelpTopic, usageLine } from "@/lib/shared/slash-help";
export const SLASH_CATEGORY_ORDER = ${slashOrder};
export const SHORTCUT_CATEGORY_LABEL = ${shortcutLabels};
export const SHORTCUT_CATEGORY_ORDER = ${shortcutOrder};
/** The overlay's lists for its props and a filter text. */
export function helpView(sdkSlashCommands: string[] | undefined, sdkSkills: string[] | undefined, rich: any, topic: string | null, filter: string | null) {
  const all = mergeSuggestions(sdkSlashCommands, sdkSkills, rich);
  if (filter === null) filter = topic ?? "";
  const topicCmd = topic ? findHelpTopic(all, topic) : undefined;
  const grouped = (${groupedMemo})();
  const card = ${TOPIC_RULE}
    ? (topicCmd ? { usage: usageLine(topicCmd), description: topicCmd.description, aliases: topicCmd.aliases ?? [] } : { missing: topic })
    : null;
  return {
    subtitle: \`Help \\u00b7 \${all.length} commands\`,
    filter,
    card,
    groups: Array.from(grouped.entries()).map(([cat, list]) => ({
      category: cat,
      heading: \`\${CATEGORY_LABELS[cat]} \\u00b7 \${list.length}\`,
      ids: list.map((c) => c.id),
    })),
  };
}
`;
writeFileSync(join(ROOT_DIR, "help.ts"), helpModule);
const hv = await import(pathToFileURL(join(ROOT_DIR, "help.ts")).href);

// ------------------------------------------------------------ recording

const fixture = {};
const add = (section, args, out) => (fixture[section] ??= []).push({ args, out });
const W1 = "wks_3f2a9c81d0e4";

// Strings, ASCII-escaped in this file.
const NBSP = "\u00a0";
const BOM = "\ufeff";
const NEL = "\u0085";
const EMOJI = "\u{1f600}";
const SIGMA = "\u03a3";
const DOTTED_I = "\u0130";
const E_ACUTE = "\u00e9";

// The tables, whole.
fixture.workspaceNav = pal.WORKSPACE_NAV;
fixture.globalNav = pal.GLOBAL_NAV;
fixture.slashCommands = sc.SLASH_COMMANDS;
fixture.slashCategoryLabels = sc.CATEGORY_LABELS;
fixture.slashCategoryOrder = hv.SLASH_CATEGORY_ORDER;
fixture.shortcutActions = ks.SHORTCUT_ACTIONS;
fixture.shortcutCategoryLabels = hv.SHORTCUT_CATEGORY_LABEL;
fixture.shortcutCategoryOrder = hv.SHORTCUT_CATEGORY_ORDER;
fixture.formatBinding = ks.SHORTCUT_ACTIONS.map((a) => ({
  id: a.id,
  mac: ks.formatBinding(a.default, { platform: "mac" }),
  other: ks.formatBinding(a.default, { platform: "other" }),
  detailMac: pal.shortcutDetail(a, "mac"),
  detailOther: pal.shortcutDetail(a, "other"),
}));
// Every code formatCode names, as a binding of its own.
for (const code of [
  "KeyA", "Digit0", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "BracketLeft", "BracketRight",
  "Comma", "Period", "Slash", "Backslash", "Semicolon", "Quote", "Minus", "Equal", "Backquote",
  "Space", "Enter", "Escape", "Tab", "Backspace", "F5", "Numpad1",
]) {
  for (const b of [{ code }, { mod: true, alt: true, shift: true, code }]) {
    add("formatCode", [b], { mac: ks.formatBinding(b, { platform: "mac" }), other: ks.formatBinding(b, { platform: "other" }) });
  }
}
add("formatCode", [null], { mac: ks.formatBinding(null, { platform: "mac" }), other: ks.formatBinding(null, { platform: "other" }) });
add("formatCode", [{ mod: true, shift: true, code: null }], {
  mac: ks.formatBinding({ mod: true, shift: true, code: null }, { platform: "mac" }),
  other: ks.formatBinding({ mod: true, shift: true, code: null }, { platform: "other" }),
});

// fuzzyMatch(target, query).
for (const [t, q] of [
  ["Chat ", ""],
  ["Chat ", "c"],
  ["Chat ", "CH"],
  ["Chat ", "ct"],
  ["Chat ", "tc"],
  ["Sessions ", "ss"],
  ["Sessions ", "sessionsx"],
  ["", ""],
  ["", "a"],
  [" ", " "],
  ["Git ", "git "],
  ["Usage / Billing ", "u/b"],
  ["/compact [focus instructions] \u2014 Compact the conversation", "cmp"],
  ["Open command palette \u2318K", "\u2318k"],
  ["Next tab \u2318\u2325\u2192", "\u2325"],
  ["Caf" + E_ACUTE + " ", "caf" + E_ACUTE.toUpperCase()],
  ["x" + EMOJI + "y", EMOJI],
  ["x" + EMOJI + "y", "xy"],
  [DOTTED_I + "stanbul", "istanbul"],
  [DOTTED_I + "stanbul", "i"],
  ["O" + SIGMA, "o" + SIGMA.toLowerCase()],
  ["O" + SIGMA, "o\u03c2"],
  ["ABC", "abc"],
  ["aaa", "aaaa"],
  ["a b c", "abc"],
  ["Stra\u00dfe", "strasse"],
  ["Stra\u00dfe", "STRA\u00dfE"],
]) {
  add("fuzzyMatch", [t, q], pal.fuzzyMatch(t, q));
}

// workspaceIdFromPathname, the palette's workspace.
for (const p of [
  "/" + W1,
  "/" + W1 + "/",
  "/" + W1 + "/sessions",
  "/" + W1 + "x",
  "/" + W1.toUpperCase(),
  "/wks_3f2a9c81d0e",
  "/settings",
  "/customize/cust_abc/chat",
  "/",
  "",
  "//" + W1,
  "/" + W1 + "?session=x",
]) {
  add("workspaceIdFromPathname", [p], rp.workspaceIdFromPathname(p));
}

// The palette's rows: every item, for each workspace and platform.
for (const ws of [W1, null]) {
  for (const platform of ["mac", "other"]) {
    add("items", [ws, platform], pal.buildItems(ws, platform));
  }
}

// What a query shows (ids, in order; at most 60).
const macItems = pal.buildItems(W1, "mac");
for (const q of [
  "", " ", "  git  ", "g", "git", "GIT", "se", "sess", "set", "co", "cmp", "clear", "/cl", "/", "tab",
  "next", "\u2318", "\u2318\u2325", "go to", "workspace", "zzzz", "settings", "u/b", "re", "no default",
  "help", "x", "e", "a", "fork", "Esc",
  NBSP + "git" + NBSP, BOM + "git", NEL + "git",
]) {
  add("filter", [W1, "mac", q], pal.filterItems(macItems, q).map((i) => i.id));
}
const bareItems = pal.buildItems(null, "other");
for (const q of ["", "chat", "ctrl", "ctrl+alt", "1-9", "usage"]) {
  add("filter", [null, "other", q], pal.filterItems(bareItems, q).map((i) => i.id));
}

// One open palette, step by step.
const K = (key) => ({ key });
const Q = (query) => ({ query });
for (const [ws, steps] of [
  [W1, [K("Enter")]],
  [W1, [K("ArrowDown"), K("ArrowDown"), K("Enter")]],
  [W1, [K("ArrowUp"), K("ArrowUp"), K("ArrowDown")]],
  [W1, [Q("git"), K("Enter")]],
  [W1, [Q("sess"), K("ArrowDown"), K("Enter")]],
  [W1, [Q("settings"), K("ArrowDown"), K("ArrowDown"), K("ArrowDown"), K("ArrowDown"), K("Enter")]],
  [W1, [K("ArrowDown"), K("ArrowDown"), K("ArrowDown"), Q("git"), K("Enter")]],
  [W1, [Q("zzzz"), K("ArrowDown"), K("Enter"), Q(""), K("Enter"), K("ArrowDown"), K("Enter")]],
  [W1, [Q("zzzz"), K("ArrowUp"), Q(""), K("Enter")]],
  [W1, [Q("clear"), K("Enter")]],
  [W1, [Q("next tab"), K("Enter")]],
  [W1, [{ hover: 4 }, K("Enter")]],
  [W1, [{ hover: 4 }, K("ArrowDown"), { click: 2 }]],
  [W1, [Q("usage"), { click: 0 }]],
  [W1, [K("Escape"), K("Tab"), K("a"), K("Enter")]],
  [W1, [...Array.from({ length: 70 }, () => K("ArrowDown")), K("Enter")]],
  [null, [K("Enter")]],
  [null, [Q("files"), K("Enter")]],
  [null, [Q("doctor"), K("Enter")]],
]) {
  add("simulate", [ws, "mac", steps], pal.simulate(ws, "mac", steps));
}

// mergeSuggestions(sdk, skills, rich): the merged list's ids, categories
// and sources, in order.
const RICH = [
  { name: "deploy", description: "  Ship it.  ", argumentHint: " <env> ", aliases: ["ship"] },
  { name: "lint", description: "", argumentHint: "  " },
  { name: "clear", description: "SDK clear" },
  { name: "skill-a", description: "Skill A desc" },
  { name: "zeta", builtin: true },
  { name: "Alpha" },
];
for (const [sdk, skills, rich] of [
  [undefined, undefined, undefined],
  [[], [], undefined],
  [["clear", "compact", "deploy", "review", "skill-a", "zz-plugin:run"], ["skill-a", "skill-b"], undefined],
  [["deploy", "skill-a"], ["skill-a"], RICH],
  [undefined, ["only-skill"], RICH],
  [["reset", "new", "continue", "bashes"], undefined, undefined],
]) {
  const all = sc.mergeSuggestions(sdk, skills, rich);
  add(
    "mergeSuggestions",
    [sdk ?? null, skills ?? null, rich ?? null],
    all.map((c) => ({
      id: c.id,
      name: c.name,
      category: c.category,
      handler: c.handler,
      source: c.source,
      description: c.description,
      argsHint: c.argsHint ?? null,
      aliases: c.aliases ?? null,
      builtin: c.builtin ?? null,
    })),
  );
}

// The help overlay: its subtitle, its usage card and its groups.
const SDK = ["deploy", "skill-a", "zz-plugin:run"];
const SKILLS = ["skill-a"];
for (const [sdk, skills, rich, topic, filter] of [
  [[], [], null, null, null],
  [SDK, SKILLS, RICH, null, null],
  [SDK, SKILLS, RICH, null, "clear"],
  [SDK, SKILLS, RICH, null, "  CLEAR  "],
  [SDK, SKILLS, RICH, null, "reset"],
  [SDK, SKILLS, RICH, null, "session"],
  [SDK, SKILLS, RICH, null, "Ship"],
  [SDK, SKILLS, RICH, null, "ship"],
  [SDK, SKILLS, RICH, null, "Alpha"],
  [SDK, SKILLS, RICH, null, "alpha"],
  [SDK, SKILLS, RICH, null, "zzzz"],
  [SDK, SKILLS, RICH, null, "plugin"],
  [SDK, SKILLS, RICH, null, "provided by"],
  [SDK, SKILLS, RICH, null, NBSP + "fork" + NBSP],
  [SDK, SKILLS, RICH, "clear", null],
  [SDK, SKILLS, RICH, "reset", null],
  [SDK, SKILLS, RICH, "deploy", null],
  [SDK, SKILLS, RICH, "ship", null],
  [SDK, SKILLS, RICH, "nope", null],
  [SDK, SKILLS, RICH, "clear", "clea"],
  [SDK, SKILLS, RICH, "clear", " CLEAR "],
  [SDK, SKILLS, RICH, "goal", null],
  [[], [], null, "fast", null],
]) {
  add("help", [sdk, skills, rich, topic, filter], hv.helpView(sdk, skills, rich, topic, filter));
}

// findHelpTopic / usageLine over the registry.
const registry = sc.mergeSuggestions([], [], undefined);
for (const t of ["clear", "CLEAR", "reset", "Reset", "new", "nope", "", "allowed-tools", "app"]) {
  const c = sh.findHelpTopic(registry, t);
  add("findHelpTopic", [t], c ? { id: c.id, usage: sh.usageLine(c) } : null);
}

// ------------------------------------------------------------ the file

const ascii = (s) =>
  s.replace(/[\u007f-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
writeFileSync(join(ROOT_DIR, "out.json"), ascii(JSON.stringify(fixture, null, 1)) + "\n");
