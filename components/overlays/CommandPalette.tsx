"use client";

/**
 * Cross-cut command palette.
 *
 * Phase 5 of docs/electron-conversion/PLAN.md.
 *
 * Triggered by `nav.commandPalette` (default Cmd+K). Searches across:
 *  - Navigation destinations — every workspace-scoped route, plus
 *    global routes (settings, plugins, customize, …)
 *  - Slash commands — informational rows pulled from
 *    `lib/shared/slash-commands.ts`
 *  - Keyboard shortcuts — informational rows pulled from
 *    `lib/client/shortcuts.ts`
 *
 * The palette is mounted in `app/layout.tsx` (portal pattern via
 * `fixed inset-0` overlay) so Cmd+K works from every route.
 *
 * Browser parity: no Electron-only code paths — the same component
 * runs in both runtimes. `useElectronAction` is a no-op in the
 * browser, so the keydown listener carries the load there.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  Keyboard as KeyboardIcon,
  Navigation,
  Search,
  Terminal,
} from "lucide-react";

import {
  formatBinding,
  isTypingTarget,
  matchBinding,
  SHORTCUT_ACTIONS,
  useShortcut,
  type ShortcutAction,
  type ShortcutBinding,
} from "@/lib/client/shortcuts";
import { useElectronAction } from "@/lib/client/useElectron";
import { SLASH_COMMANDS } from "@/lib/shared/slash-commands";

import { Overlay } from "./Overlay";

type ItemKind = "nav" | "slash" | "shortcut";

type Item = {
  id: string;
  kind: ItemKind;
  label: string;
  /** Secondary line — description / argsHint / shortcut binding. */
  detail?: string;
  /** When set, Enter activates this href (Link-style navigation). */
  href?: string;
  /** Free-form action — Enter calls this if `href` isn't set. */
  run?: () => void;
};

// ── Nav catalog ──────────────────────────────────────────────────────────
// Workspace-scoped routes. The palette prefixes each href with the active
// workspace id from the URL at runtime so links resolve to the right
// workspace. Listed by the same labels users already see in SideNav so
// search terms match what's on screen.
const WORKSPACE_NAV: Array<{ label: string; path: string; detail?: string }> = [
  { label: "Chat", path: "" },
  { label: "Sessions", path: "/sessions" },
  { label: "Files", path: "/files" },
  { label: "Git", path: "/git" },
  { label: "Memory", path: "/memory" },
  { label: "Assets", path: "/assets" },
  { label: "Cost", path: "/cost" },
  { label: "Agents", path: "/agents" },
  { label: "Skills", path: "/skills" },
  { label: "MCP", path: "/mcp" },
  { label: "Hooks", path: "/hooks" },
  { label: "Schedule", path: "/schedule" },
  { label: "Permissions", path: "/permissions" },
  { label: "Docker", path: "/docker" },
  { label: "Tracker", path: "/tracker" },
  { label: "Database", path: "/database" },
  { label: "Notebooks", path: "/notebooks" },
  { label: "Workspace settings", path: "/workspace" },
  { label: "Keybindings", path: "/keybindings" },
];

const GLOBAL_NAV: Array<{ label: string; path: string }> = [
  { label: "Settings", path: "/settings" },
  { label: "Plugins", path: "/plugins" },
  { label: "Customize", path: "/customize" },
  { label: "Community", path: "/community" },
  { label: "Usage / Billing", path: "/usage" },
  { label: "Doctor", path: "/doctor" },
  { label: "Release notes", path: "/release-notes" },
  { label: "Updater", path: "/updater" },
];

const WORKSPACE_ID_RE = /^\/(wks_[a-f0-9]{12})(\/|$)/;

function extractWorkspaceId(pathname: string): string | null {
  const m = WORKSPACE_ID_RE.exec(pathname);
  return m ? m[1] : null;
}

// ── Fuzzy match ──────────────────────────────────────────────────────────
// Simple "every character of the query appears in the target in order"
// match. Score is the proportion of matched characters per target length
// — higher is better. Captures the matched index ranges so callers can
// highlight (we don't bother in v1 — keep the chrome lean).
function fuzzyMatch(target: string, query: string): number | null {
  if (query === "") return 0; // empty query matches everything with neutral score
  const t = target.toLowerCase();
  const q = query.toLowerCase();
  let qi = 0;
  let matched = 0;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      qi += 1;
      matched += 1;
    }
  }
  if (qi < q.length) return null;
  return matched / Math.max(t.length, 1);
}

function shortcutDetail(action: ShortcutAction): string {
  const binding: ShortcutBinding | null = action.default;
  return binding ? formatBinding(binding) : "no default";
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement | null>(null);

  // ── Open / close wiring ────────────────────────────────────────────────
  // Centralized so the keyboard chord, OS menu, and any other call site
  // all reset query + selection (and focus the input) the same way.
  const togglePalette = useCallback(() => {
    setOpen((wasOpen) => {
      const next = !wasOpen;
      if (next) {
        setQuery("");
        setActiveIndex(0);
      }
      return next;
    });
  }, []);

  const binding = useShortcut("nav.commandPalette");
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (isTypingTarget(e.target) && !open) return;
      if (matchBinding(binding, e)) {
        e.preventDefault();
        togglePalette();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [binding, open, togglePalette]);

  // OS menu in Electron (View → Command Palette…) — same toggle.
  useElectronAction("nav.commandPalette", togglePalette);

  // Focus the input once the overlay actually mounts. Pure DOM side
  // effect, no state writes — keeps the rule happy.
  useEffect(() => {
    if (!open) return undefined;
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  // ── Items ──────────────────────────────────────────────────────────────
  const pathname = typeof window === "undefined" ? "" : window.location.pathname;
  const workspaceId = useMemo(() => extractWorkspaceId(pathname), [pathname]);

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];

    if (workspaceId) {
      for (const n of WORKSPACE_NAV) {
        out.push({
          id: `nav:${workspaceId}${n.path}`,
          kind: "nav",
          label: n.label,
          detail: n.detail,
          href: `/${workspaceId}${n.path}`,
        });
      }
    } else {
      // No workspace in URL — surface the bare paths anyway; the middleware
      // resolves them via cookie.
      for (const n of WORKSPACE_NAV) {
        out.push({
          id: `nav:${n.path}`,
          kind: "nav",
          label: n.label,
          detail: n.detail,
          href: n.path || "/",
        });
      }
    }
    for (const n of GLOBAL_NAV) {
      out.push({
        id: `nav:${n.path}`,
        kind: "nav",
        label: n.label,
        href: n.path,
      });
    }

    // Slash commands — informational; activating navigates to chat with
    // the command pre-typed (not yet wired — falls back to copying the
    // command name in the toast). For now we just surface the entry.
    for (const c of SLASH_COMMANDS) {
      out.push({
        id: `slash:${c.id}`,
        kind: "slash",
        label: `/${c.name}`,
        detail: c.argsHint ? `${c.argsHint} — ${c.description}` : c.description,
      });
    }

    // Shortcuts — informational rows show the chord alongside the action
    // label so users can discover what's bindable. Activating closes the
    // palette and focuses the chat (the actual chord fire is up to the
    // user to press).
    for (const a of SHORTCUT_ACTIONS) {
      out.push({
        id: `shortcut:${a.id}`,
        kind: "shortcut",
        label: a.label,
        detail: shortcutDetail(a),
      });
    }

    return out;
  }, [workspaceId]);

  const filtered = useMemo(() => {
    const q = query.trim();
    const scored: { item: Item; score: number }[] = [];
    for (const item of items) {
      const target = `${item.label} ${item.detail ?? ""}`;
      const s = fuzzyMatch(target, q);
      if (s != null) scored.push({ item, score: s });
    }
    // Stable sort: higher score first, then nav before slash before shortcut
    const kindRank: Record<ItemKind, number> = { nav: 0, slash: 1, shortcut: 2 };
    scored.sort(
      (a, b) =>
        b.score - a.score ||
        kindRank[a.item.kind] - kindRank[b.item.kind] ||
        a.item.label.localeCompare(b.item.label),
    );
    return scored.slice(0, 60).map((s) => s.item);
  }, [items, query]);

  // Clamp the active index at read time so we don't need a follow-up
  // effect that React 19's `set-state-in-effect` rule flags. The stored
  // value can drift past `filtered.length`, but every render sees the
  // clamped one, and every setter takes the clamp into account.
  const clampedActive =
    filtered.length === 0 ? 0 : Math.min(activeIndex, filtered.length - 1);

  const activate = useCallback(
    (item: Item) => {
      setOpen(false);
      if (item.href) {
        router.push(item.href);
      } else if (item.run) {
        item.run();
      }
    },
    [router],
  );

  const onInputKey = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex(Math.min(filtered.length - 1, clampedActive + 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex(Math.max(0, clampedActive - 1));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const it = filtered[clampedActive];
        if (it) activate(it);
      }
    },
    [filtered, clampedActive, activate],
  );

  if (!open) return null;

  return (
    <Overlay title="Command palette" subtitle="Cmd+K" onClose={() => setOpen(false)} width={680}>
      <div className="flex flex-col">
        <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2.5">
          <Search className="h-4 w-4 shrink-0 text-[var(--muted)]" />
          <input
            ref={inputRef}
            type="text"
            placeholder="Type to search nav, slash commands, shortcuts…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKey}
            className="w-full bg-transparent text-sm text-[var(--foreground)] placeholder:text-[var(--muted)] focus:outline-none"
            aria-label="Command palette search"
          />
          <kbd className="rounded border border-[var(--border)] bg-[var(--panel-2)] px-1.5 py-0.5 text-[10px] uppercase text-[var(--muted)]">
            Esc
          </kbd>
        </div>

        <ul
          role="listbox"
          aria-label="Command palette results"
          className="max-h-[60vh] overflow-y-auto py-1"
          data-testid="command-palette-results"
        >
          {filtered.length === 0 ? (
            <li className="px-4 py-6 text-center text-xs text-[var(--muted)]">
              No matches.
            </li>
          ) : (
            filtered.map((it, i) => (
              <PaletteRow
                key={it.id}
                item={it}
                active={i === clampedActive}
                onHover={() => setActiveIndex(i)}
                onActivate={() => activate(it)}
              />
            ))
          )}
        </ul>
      </div>
    </Overlay>
  );
}

function PaletteRow({
  item,
  active,
  onHover,
  onActivate,
}: {
  item: Item;
  active: boolean;
  onHover: () => void;
  onActivate: () => void;
}) {
  const Icon = item.kind === "nav" ? Navigation : item.kind === "slash" ? Terminal : KeyboardIcon;

  // For nav items, render as Link so middle-click / cmd-click opens in a
  // new context; activation via Enter is handled by `onActivate` which
  // uses `router.push`.
  const body = (
    <div
      className={
        "flex items-center gap-2 px-3 py-2 text-sm " +
        (active
          ? "bg-[var(--accent)]/12 text-[var(--foreground)]"
          : "text-[var(--foreground)]/90 hover:bg-[var(--panel-2)]")
      }
      onMouseEnter={onHover}
      onClick={onActivate}
      data-testid="command-palette-row"
      data-kind={item.kind}
    >
      <Icon className="h-3.5 w-3.5 shrink-0 text-[var(--muted)]" />
      <span className="min-w-0 truncate font-medium">{item.label}</span>
      {item.detail && (
        <span className="ml-auto truncate text-[11px] text-[var(--muted)]">
          {item.detail}
        </span>
      )}
      {item.href && active && (
        <ArrowRight className="ml-1 h-3 w-3 shrink-0 text-[var(--muted)]" />
      )}
    </div>
  );

  if (item.href) {
    return (
      <li>
        <Link href={item.href} className="block" tabIndex={-1}>
          {body}
        </Link>
      </li>
    );
  }
  return (
    <li>
      <button type="button" className="block w-full text-left" tabIndex={-1}>
        {body}
      </button>
    </li>
  );
}
