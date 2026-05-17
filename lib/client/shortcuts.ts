"use client";

/**
 * Web-app keyboard shortcut registry.
 *
 * This is the in-browser counterpart to `app/keybindings/page.tsx` — that
 * page edits Claude Code's server-side `keybindings.json` (which the CLI
 * input area reads). The shortcuts in *this* file fire inside the Next.js
 * app: tab switching, side-nav navigation, workspace cycling. They are
 * persisted to localStorage with the same `useSyncExternalStore` pattern
 * as `theme.ts` / `ide.ts`, so SSR is safe and multiple components stay
 * in sync without prop drilling.
 *
 * Why a registry?
 *   Before this file each shortcut handler hard-coded its keys (⌘⇧← in
 *   `SessionTabs`, ⌥<letter> in `SideNav`, ⌘⇧[ in `WorkspaceSwitcher`).
 *   The settings UI cannot offer "change it" / "show collisions" without a
 *   single source of truth, so call-sites now read bindings from here.
 *
 * Why `event.code` and not `event.key`?
 *   macOS Option emits a combining dead-key character for `event.key`
 *   (Alt+C → "ç" on US layouts), so layout-independence requires `code`.
 *   This is the same reason `SideNav.tsx` already does it that way — we
 *   carry the convention through.
 *
 * Why a "mod" abstraction instead of explicit meta/ctrl?
 *   The pre-registry handlers treated `e.metaKey || e.ctrlKey` as one
 *   logical modifier so the bindings worked on both macOS and Windows
 *   without per-platform definitions. We keep that affordance: `mod:
 *   true` matches Cmd on macOS and Ctrl elsewhere.
 */

import { useCallback, useMemo, useSyncExternalStore } from "react";

// ── Types ────────────────────────────────────────────────────────────────

export type ShortcutBinding = {
  /** Primary modifier — matches Cmd OR Ctrl, depending on platform. */
  mod?: boolean;
  /** ⌥ / Alt. */
  alt?: boolean;
  /** ⇧ / Shift. */
  shift?: boolean;
  /**
   * The `KeyboardEvent.code` value (e.g. "KeyC", "ArrowLeft", "BracketLeft").
   * `null` is a modifier-only binding — matched against a code range that
   * the action's handler decides (e.g. tab.selectByNumber matches Digit1..9).
   */
  code: string | null;
};

export type ShortcutCategory = "tabs" | "workspaces" | "navigation";

export type ShortcutAction = {
  id: string;
  label: string;
  description?: string;
  category: ShortcutCategory;
  /** Default binding shipped with the app. `null` = no default (off). */
  default: ShortcutBinding | null;
  /**
   * When true, the binding has `code: null` and the handler combines the
   * modifiers with a key range it owns (e.g. Digit1..9). Used by the tab
   * numeric selector. Surfaces in the settings UI as "(+ 1–9)" hint.
   */
  modifierOnly?: boolean;
};

// ── Registry ─────────────────────────────────────────────────────────────
//
// Order matters for display — the settings UI groups by category and keeps
// items in this declared order. Keep IDs stable: they're the localStorage
// key suffix.

export const SHORTCUT_ACTIONS: ShortcutAction[] = [
  // Tabs — chat session tabs at the top of the chat pane.
  {
    id: "tab.next",
    label: "Next tab",
    description: "Cycle to the next session tab. Wraps at the end.",
    category: "tabs",
    default: { mod: true, shift: true, code: "ArrowRight" },
  },
  {
    id: "tab.prev",
    label: "Previous tab",
    description: "Cycle to the previous session tab. Wraps at the start.",
    category: "tabs",
    default: { mod: true, shift: true, code: "ArrowLeft" },
  },
  {
    id: "tab.selectByNumber",
    label: "Select tab by number",
    description:
      "Pressed with 1–9 selects that tab (or the last tab when 9 is pressed and >9 tabs are open).",
    category: "tabs",
    default: { mod: true, shift: true, code: null },
    modifierOnly: true,
  },

  // Workspaces — the rail tiles on the far left.
  {
    id: "workspace.next",
    label: "Next workspace",
    description: "Cycle to the next workspace in the rail.",
    category: "workspaces",
    default: { mod: true, shift: true, code: "BracketRight" },
  },
  {
    id: "workspace.prev",
    label: "Previous workspace",
    description: "Cycle to the previous workspace in the rail.",
    category: "workspaces",
    default: { mod: true, shift: true, code: "BracketLeft" },
  },

  // Navigation — the icon strip immediately right of the workspace rail.
  // The defaults mirror the Alt+<letter> mnemonics declared in SideNav.tsx.
  ...navAction("nav.chat", "Open Chat", "KeyC"),
  ...navAction("nav.sessions", "Open Sessions", "KeyS"),
  ...navAction("nav.files", "Open Files", "KeyF"),
  ...navAction("nav.git", "Open Git", "KeyG"),
  ...navAction("nav.memory", "Open Memory", "KeyM"),
  ...navAction("nav.assets", "Open Assets", "KeyI"),
  ...navAction("nav.cost", "Open Cost", "KeyB"),
  ...navAction("nav.agents", "Open Agents", "KeyA"),
  ...navAction("nav.skills", "Open Skills", "KeyK"),
  ...navAction("nav.mcp", "Open MCP", "KeyN"),
  ...navAction("nav.hooks", "Open Hooks", "KeyH"),
  ...navAction("nav.schedule", "Open Schedule", "KeyL"),
  ...navAction("nav.permissions", "Open Permissions", "KeyP"),
  ...navAction("nav.docker", "Open Docker", "KeyD"),
  ...navAction("nav.tracker", "Open Tracker", "KeyT"),
  ...navAction("nav.database", "Open Database", "KeyE"),
  ...navAction("nav.notebooks", "Open Notebooks", "KeyJ"),
  ...navAction("nav.workspace", "Open Workspace settings", "KeyW"),
];

function navAction(id: string, label: string, code: string): ShortcutAction[] {
  return [
    {
      id,
      label,
      category: "navigation",
      default: { alt: true, code },
    },
  ];
}

export const SHORTCUT_BY_ID: Record<string, ShortcutAction> = Object.fromEntries(
  SHORTCUT_ACTIONS.map((a) => [a.id, a]),
);

// ── Persistence ──────────────────────────────────────────────────────────
//
// We store the overrides as a single JSON object so the storage event +
// re-render flow lights up every consumer in one tick, no matter how many
// individual actions are remapped.

const STORAGE_KEY = "claudius.shortcuts.v1";
const SAME_TAB_EVENT = "claudius.shortcuts.changed";

type Overrides = Record<string, ShortcutBinding | null>;

function readOverrides(): Overrides {
  if (typeof window === "undefined") return EMPTY_OVERRIDES;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY_OVERRIDES;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return EMPTY_OVERRIDES;
    // Shallow-validate each value. Anything malformed is dropped.
    const out: Overrides = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (v === null) {
        out[k] = null; // explicit "disabled" override
      } else if (v && typeof v === "object") {
        const b = v as Partial<ShortcutBinding>;
        out[k] = {
          mod: Boolean(b.mod),
          alt: Boolean(b.alt),
          shift: Boolean(b.shift),
          code: typeof b.code === "string" ? b.code : null,
        };
      }
    }
    return out;
  } catch {
    return EMPTY_OVERRIDES;
  }
}

const EMPTY_OVERRIDES: Overrides = Object.freeze({}) as Overrides;

// `useSyncExternalStore` requires snapshot reads to be referentially stable
// when nothing changed. We memoize the parsed overrides by the raw JSON
// string so two reads of an unchanged storage value return the same object.
let snapshotCache: { raw: string; value: Overrides } | null = null;

function getSnapshot(): Overrides {
  if (typeof window === "undefined") return EMPTY_OVERRIDES;
  let raw = "";
  try {
    raw = window.localStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return EMPTY_OVERRIDES;
  }
  if (snapshotCache && snapshotCache.raw === raw) return snapshotCache.value;
  const value = readOverrides();
  snapshotCache = { raw, value };
  return value;
}

function getServerSnapshot(): Overrides {
  return EMPTY_OVERRIDES;
}

function subscribe(cb: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("storage", cb);
  window.addEventListener(SAME_TAB_EVENT, cb);
  return () => {
    window.removeEventListener("storage", cb);
    window.removeEventListener(SAME_TAB_EVENT, cb);
  };
}

function writeOverrides(next: Overrides): void {
  try {
    if (Object.keys(next).length === 0) {
      window.localStorage.removeItem(STORAGE_KEY);
    } else {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    }
  } catch {
    // Quota / private-mode — swallow.
  }
  window.dispatchEvent(new Event(SAME_TAB_EVENT));
}

// ── Resolution & matching ────────────────────────────────────────────────

/**
 * Resolve the effective binding for an action: override if present (and not
 * explicitly disabled via `null`), otherwise the registered default. Returns
 * `null` for "no binding — action is off".
 */
export function resolveBinding(
  id: string,
  overrides: Overrides,
): ShortcutBinding | null {
  if (id in overrides) return overrides[id] ?? null;
  return SHORTCUT_BY_ID[id]?.default ?? null;
}

/**
 * Compare a binding against a live KeyboardEvent. Treats `mod` as "either
 * Cmd or Ctrl is pressed" so a single binding works on macOS and other
 * platforms — same convention the pre-registry handlers used inline.
 *
 * `modifierOnly` bindings (code: null) match purely on modifier shape and
 * leave the key check to the handler.
 */
export function matchBinding(
  binding: ShortcutBinding | null,
  e: KeyboardEvent,
): boolean {
  if (!binding) return false;
  if (Boolean(binding.mod) !== (e.metaKey || e.ctrlKey)) return false;
  if (Boolean(binding.alt) !== e.altKey) return false;
  if (Boolean(binding.shift) !== e.shiftKey) return false;
  if (binding.code != null && e.code !== binding.code) return false;
  return true;
}

/** True when the event target is a text input the user is typing into. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
}

// ── Hooks ────────────────────────────────────────────────────────────────

/**
 * Read the resolved binding for a single action. Re-renders when overrides
 * change. Use in handler-effects: read once at top of effect, then `matchBinding`.
 */
export function useShortcut(id: string): ShortcutBinding | null {
  const overrides = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return useMemo(() => resolveBinding(id, overrides), [id, overrides]);
}

/**
 * Full registry-aware hook for the settings UI. Returns all actions with
 * their current bindings plus mutation helpers and a precomputed collision
 * map. The collision map keys are the canonical binding string; the values
 * are the lists of action IDs sharing that key.
 */
export function useShortcutRegistry() {
  const overrides = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const items = useMemo(
    () =>
      SHORTCUT_ACTIONS.map((a) => ({
        action: a,
        binding: resolveBinding(a.id, overrides),
        isCustom: a.id in overrides,
      })),
    [overrides],
  );

  const collisions = useMemo(() => {
    const byKey = new Map<string, string[]>();
    for (const { action, binding } of items) {
      if (!binding) continue;
      const key = canonicalKey(binding);
      const list = byKey.get(key) ?? [];
      list.push(action.id);
      byKey.set(key, list);
    }
    // Only keep keys with more than one action.
    const out: Record<string, string[]> = {};
    for (const [k, v] of byKey) if (v.length > 1) out[k] = v;
    return out;
  }, [items]);

  const setBinding = useCallback((id: string, binding: ShortcutBinding | null) => {
    const cur = readOverrides();
    const next: Overrides = { ...cur };
    // Heuristic: if the new binding deep-equals the default, drop the
    // override so the storage doesn't accumulate dead entries.
    const def = SHORTCUT_BY_ID[id]?.default ?? null;
    if (bindingsEqual(binding, def)) {
      delete next[id];
    } else {
      next[id] = binding;
    }
    writeOverrides(next);
  }, []);

  const resetAll = useCallback(() => {
    writeOverrides({});
  }, []);

  const resetOne = useCallback((id: string) => {
    const cur = readOverrides();
    if (!(id in cur)) return;
    const { [id]: _drop, ...rest } = cur;
    void _drop;
    writeOverrides(rest);
  }, []);

  return { items, collisions, setBinding, resetAll, resetOne };
}

// ── Formatting & comparison ──────────────────────────────────────────────

/** A canonical string used as the collision-map key. Format: `mod+alt+shift+CODE`. */
export function canonicalKey(b: ShortcutBinding): string {
  const parts: string[] = [];
  if (b.mod) parts.push("mod");
  if (b.alt) parts.push("alt");
  if (b.shift) parts.push("shift");
  parts.push(b.code ?? "(modifier-only)");
  return parts.join("+");
}

export function bindingsEqual(
  a: ShortcutBinding | null,
  b: ShortcutBinding | null,
): boolean {
  if (a === null || b === null) return a === b;
  return (
    Boolean(a.mod) === Boolean(b.mod) &&
    Boolean(a.alt) === Boolean(b.alt) &&
    Boolean(a.shift) === Boolean(b.shift) &&
    (a.code ?? null) === (b.code ?? null)
  );
}

/**
 * Pretty-print a binding for display. Uses platform-appropriate glyphs on
 * macOS (⌘ ⇧ ⌥ ↩︎) and spelled-out names elsewhere.
 */
export function formatBinding(b: ShortcutBinding | null, opts?: { platform?: "mac" | "other" }): string {
  if (!b) return "—";
  const mac =
    opts?.platform === "mac" ||
    (opts?.platform == null &&
      typeof navigator !== "undefined" &&
      /Mac|iPhone|iPad/.test(navigator.platform));
  const parts: string[] = [];
  if (b.mod) parts.push(mac ? "⌘" : "Ctrl");
  if (b.alt) parts.push(mac ? "⌥" : "Alt");
  if (b.shift) parts.push(mac ? "⇧" : "Shift");
  if (b.code) parts.push(formatCode(b.code, mac));
  else parts.push(mac ? "1…9" : "1-9");
  return mac ? parts.join("") : parts.join("+");
}

function formatCode(code: string, mac: boolean): string {
  // Letters: KeyA → "A".
  if (code.startsWith("Key")) return code.slice(3);
  // Digits: Digit1 → "1".
  if (code.startsWith("Digit")) return code.slice(5);
  // Arrows.
  if (code === "ArrowLeft") return mac ? "←" : "Left";
  if (code === "ArrowRight") return mac ? "→" : "Right";
  if (code === "ArrowUp") return mac ? "↑" : "Up";
  if (code === "ArrowDown") return mac ? "↓" : "Down";
  // Brackets.
  if (code === "BracketLeft") return "[";
  if (code === "BracketRight") return "]";
  // Common punctuation.
  if (code === "Comma") return ",";
  if (code === "Period") return ".";
  if (code === "Slash") return "/";
  if (code === "Backslash") return "\\";
  if (code === "Semicolon") return ";";
  if (code === "Quote") return "'";
  if (code === "Minus") return "-";
  if (code === "Equal") return "=";
  if (code === "Backquote") return "`";
  if (code === "Space") return mac ? "Space" : "Space";
  if (code === "Enter") return mac ? "↩︎" : "Enter";
  if (code === "Escape") return "Esc";
  if (code === "Tab") return "Tab";
  if (code === "Backspace") return mac ? "⌫" : "Backspace";
  return code;
}

/**
 * Build a binding from a live KeyboardEvent — for the "press to record"
 * widget. Returns `null` if the event is a bare modifier press (the user
 * hasn't completed the chord yet).
 */
export function bindingFromEvent(e: KeyboardEvent): ShortcutBinding | null {
  // Modifier-only keypresses arrive with code === "ShiftLeft", etc. Treat
  // those as "still building the chord" so the recorder doesn't fire on a
  // bare Shift press.
  if (
    e.code === "ShiftLeft" ||
    e.code === "ShiftRight" ||
    e.code === "ControlLeft" ||
    e.code === "ControlRight" ||
    e.code === "AltLeft" ||
    e.code === "AltRight" ||
    e.code === "MetaLeft" ||
    e.code === "MetaRight"
  ) {
    return null;
  }
  return {
    mod: e.metaKey || e.ctrlKey,
    alt: e.altKey,
    shift: e.shiftKey,
    code: e.code,
  };
}

/**
 * Reserved browser combos that the page cannot reliably intercept. We
 * surface these in the recorder as a "this won't fire — your browser will
 * eat it" warning rather than block, because some browsers do let the page
 * preventDefault depending on profile / extensions.
 */
const RESERVED_BROWSER_KEYS: ReadonlyArray<{ binding: ShortcutBinding; label: string }> = [
  { binding: { mod: true, code: "KeyW" }, label: "Close tab" },
  { binding: { mod: true, code: "KeyT" }, label: "New tab" },
  { binding: { mod: true, code: "KeyN" }, label: "New window" },
  { binding: { mod: true, code: "KeyR" }, label: "Reload" },
  { binding: { mod: true, code: "KeyL" }, label: "Focus address bar" },
  { binding: { mod: true, code: "KeyQ" }, label: "Quit (macOS)" },
  { binding: { mod: true, shift: true, code: "KeyT" }, label: "Reopen closed tab" },
];

export function reservedConflictFor(binding: ShortcutBinding | null): string | null {
  if (!binding || binding.code == null) return null;
  const hit = RESERVED_BROWSER_KEYS.find((r) => bindingsEqual(r.binding, binding));
  return hit?.label ?? null;
}
