"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { MessageSquare, Network, Webhook, BookText, ShieldCheck, FolderTree, Bot, Calendar, BarChart3, Image as ImageIcon, Folder, Briefcase, GitBranch, Sparkles, WandSparkles, Container, CircleDot, Database as DatabaseIcon, BookOpen } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import { useWorkspaces } from "@/lib/client/useWorkspaces";
import type { Customization, PublishRecord } from "@/lib/server/customizations-store";
import {
  formatBinding,
  isTypingTarget,
  matchBinding,
  useShortcutRegistry,
  type ShortcutBinding,
} from "@/lib/client/shortcuts";

type Item = {
  label: string;
  icon: typeof MessageSquare;
  href?: string;
  /**
   * Registry action id (e.g. "nav.chat"). The actual key binding — and its
   * display label — is resolved from `lib/client/shortcuts.ts`, which the
   * settings page lets users override. Items without an actionId have no
   * default shortcut (none currently, but kept optional for future tiles).
   */
  actionId?: string;
  /**
   * If set, this tile is gated on a customization being currently published
   * (at least one publish without `revertedAt`). The string is matched
   * case-insensitively against `customization.name`. Built-in tiles leave
   * this undefined and always render.
   */
  customizationName?: string;
};

// Workspace-scoped items only. System-global tiles (Plugins, Settings,
// Account/Usage) live in WorkspaceSwitcher below the divider — see the IA
// review note in TODO.md.
const items: Item[] = [
  // The Chat button just routes to "/" — boot resumes the last-active tab
  // (persisted in `ui_state.active_tab`) so coming back to the chat view
  // from another page lands you on the conversation you left, instead of
  // spawning a brand-new session on top of the persisted strip.
  { label: "Chat", icon: MessageSquare, href: "/", actionId: "nav.chat" },
  { label: "Sessions", icon: FolderTree, href: "/sessions", actionId: "nav.sessions" },
  { label: "Files", icon: Folder, href: "/files", actionId: "nav.files" },
  { label: "Git", icon: GitBranch, href: "/git", actionId: "nav.git" },
  { label: "Memory", icon: BookText, href: "/memory", actionId: "nav.memory" },
  // Assets uses ⌥I (Images) because ⌥A is taken by Agents — A/I picks the
  // mnemonic with the higher hit rate.
  { label: "Assets", icon: ImageIcon, href: "/assets", actionId: "nav.assets" },
  { label: "Cost", icon: BarChart3, href: "/cost", actionId: "nav.cost" },
  { label: "Agents", icon: Bot, href: "/agents", actionId: "nav.agents" },
  { label: "Skills", icon: Sparkles, href: "/skills", actionId: "nav.skills" },
  { label: "MCP", icon: Network, href: "/mcp", actionId: "nav.mcp" },
  { label: "Hooks", icon: Webhook, href: "/hooks", actionId: "nav.hooks" },
  { label: "Schedule", icon: Calendar, href: "/schedule", actionId: "nav.schedule" },
  { label: "Permissions", icon: ShieldCheck, href: "/permissions", actionId: "nav.permissions" },
  // Docker — read-only `docker ps` view. Ships as a customization
  // ("Docker Monitoring") so users who don't want to wire up a daemon
  // don't see the tile. Hidden until at least one un-reverted publish of
  // that customization exists.
  {
    label: "Docker",
    icon: Container,
    href: "/docker",
    actionId: "nav.docker",
    customizationName: "Docker Monitoring",
  },
  // Tracker — demo "GitHub issues" page rendered from local fixtures.
  // Gated on the "Tracker" customization being on so the rail doesn't
  // show a marketing demo on a user's normal install.
  {
    label: "Tracker",
    icon: CircleDot,
    href: "/tracker",
    actionId: "nav.tracker",
    customizationName: "Tracker",
  },
  // Database — mocked DataGrip-style SQL console. Gated so it only appears
  // when the "Database Console" customization is published, mirroring the
  // Docker/Tracker pattern.
  {
    label: "Database",
    icon: DatabaseIcon,
    href: "/database",
    actionId: "nav.database",
    customizationName: "Database Console",
  },
  // Notebooks — mocked Jupyter-style notebook runner. Gated on the
  // "Notebooks" customization. No real kernel; the cells are fixtures.
  {
    label: "Notebooks",
    icon: BookOpen,
    href: "/notebooks",
    actionId: "nav.notebooks",
    customizationName: "Notebooks",
  },
  // Workspace settings — defaults that apply to new chats in this workspace.
  { label: "Workspace", icon: Briefcase, href: "/workspace", actionId: "nav.workspace" },
];

const OLD_ITALIC = [
  "\u{10300}", "\u{10301}", "\u{10302}", "\u{10303}", "\u{10304}",
  "\u{10305}", "\u{10306}", "\u{10307}", "\u{10308}", "\u{10309}",
  "\u{1030A}", "\u{1030B}", "\u{1030C}", "\u{1030D}", "\u{1030E}",
  "\u{1030F}", "\u{10310}", "\u{10311}", "\u{10312}", "\u{10313}",
  "\u{10314}", "\u{10315}", "\u{10316}", "\u{10317}", "\u{10318}",
  "\u{10319}", "\u{1031A}",
];

const C_INDEX = 2; // 𐌂 (U+10302)

function AnimatedGlyph({ running }: { running: boolean }) {
  const [i, setI] = useState(C_INDEX);
  // Snap back to the static C glyph whenever the agent stops — runs in
  // render via the "store previous props" pattern so setState stays out
  // of the interval-setup effect body.
  // https://react.dev/reference/react/useState#storing-information-from-previous-renders
  const [wasRunning, setWasRunning] = useState(running);
  if (wasRunning !== running) {
    setWasRunning(running);
    if (!running) setI(C_INDEX);
  }
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setI((n) => (n + 1) % OLD_ITALIC.length), 350);
    return () => clearInterval(id);
  }, [running]);
  return (
    <div className="mb-2 flex h-8 w-8 items-center justify-center rounded-md bg-[var(--accent)] text-white">
      <span
        key={running ? i : "idle"}
        className={cn("block text-base leading-none", running && "animate-glyph-fade")}
        style={{ fontFamily: "'Noto Sans Old Italic', 'Segoe UI Historic', serif" }}
      >
        {OLD_ITALIC[i]}
      </span>
    </div>
  );
}

export function SideNav({ running = false }: { running?: boolean }) {
  const pathname = usePathname();
  const router = useRouter();

  // Customize tile lives outside the static `items` map because its href is
  // dynamic. When the active workspace is a customization workspace we
  // resolve the linked customization id and link straight to its detail
  // page — the publish / revert UX lives there and the old path (wand
  // drawer → "Manage all" → click row) was three clicks for a destination
  // the user wants in one. Falls back to the list page when no
  // customization is active or while the lookup is in flight.
  const { items: workspaces, activeId } = useWorkspaces();
  const activeWorkspace = workspaces.find((w) => w.id === activeId) ?? null;
  const isCustomizationWs = activeWorkspace?.kind === "customization";
  // Cached resolution carries the workspace id it was computed for, so on
  // render we can tell whether the cache is still valid for the current
  // workspace. This avoids a synchronous setState in the effect body (which
  // would trip react-hooks/set-state-in-effect) — the state only ever
  // changes from the async fetch callback.
  const [resolution, setResolution] = useState<{ workspaceId: string; customizationId: string } | null>(null);
  // Set of customization names (lowercased) that have at least one
  // un-reverted publish. Items tagged with `customizationName` are hidden
  // until their entry appears here. `null` = not yet fetched (during the
  // initial render); items with `customizationName` hide in that state too,
  // so the rail doesn't flash a tile that's about to disappear.
  const [enabledCustNames, setEnabledCustNames] = useState<Set<string> | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/customizations");
        if (!res.ok) return;
        const d = (await res.json()) as {
          customizations: Customization[];
          publishes?: PublishRecord[];
        };
        if (cancelled) return;
        // Detail-page resolution for the Customize tile href — only when
        // the active workspace is a customization. Same fetch covers both
        // jobs so the rail makes one network call instead of two.
        if (isCustomizationWs && activeWorkspace) {
          const match = d.customizations.find((c) => c.workspaceId === activeWorkspace.id);
          if (match) {
            setResolution({ workspaceId: activeWorkspace.id, customizationId: match.id });
          }
        }
        // Enabled set: any customization with at least one un-reverted
        // publish counts as "on". Stored by lowercased name for the
        // case-insensitive lookup in `items.filter` below.
        const liveIds = new Set(
          (d.publishes ?? [])
            .filter((p) => p.revertedAt == null)
            .map((p) => p.customizationId),
        );
        const names = new Set(
          d.customizations
            .filter((c) => liveIds.has(c.id))
            .map((c) => c.name.toLowerCase()),
        );
        setEnabledCustNames(names);
      } catch {
        // Network failed (offline, server restart) — leave items in the
        // hidden state rather than flashing them all. The rail still
        // renders, just without the customization-gated tiles.
        if (!cancelled) setEnabledCustNames(new Set());
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isCustomizationWs, activeWorkspace]);

  // Apply the customizationName gate. Built-in tiles (no `customizationName`)
  // always render; gated tiles need their customization to be enabled.
  const visibleItems = items.filter(
    (it) =>
      !it.customizationName ||
      (enabledCustNames?.has(it.customizationName.toLowerCase()) ?? false),
  );
  const customizationDetailId =
    isCustomizationWs && resolution?.workspaceId === activeWorkspace?.id ? resolution.customizationId : null;
  const customizeHref = customizationDetailId ? `/customize/${customizationDetailId}` : "/customize";
  const customizeActive = pathname?.startsWith("/customize") ?? false;
  const customizeTitle = customizationDetailId
    ? "Customize · publish / revert this customization"
    : "Customize Claudius";

  // Resolve nav bindings from the user-overridable registry. Each item's
  // `actionId` maps to a binding (default Alt+<letter>) that the user can
  // remap in Settings → Web app shortcuts. The handler iterates `visibleItems`
  // and calls `matchBinding` for each; the per-binding work is trivial
  // (modifier compare + code compare) so an O(items) sweep on every keydown
  // is fine versus building an index, and it keeps the code obvious.
  //
  // We use `event.code` so the mapping is layout-independent and unaffected
  // by macOS Option's dead-key composition (Alt+C → `event.key === "ç"` on
  // US layouts). The `isTypingTarget` guard mirrors the WorkspaceSwitcher
  // pattern — typing in an input must never trigger navigation.
  // Bindings: a Map<actionId, binding> derived from the registry. The
  // tooltip path below reads from this too, so a remap in Settings updates
  // both the keyboard handler AND the hint glyph in one re-render.
  const { items: registryItems } = useShortcutRegistry();
  const bindingByActionId = useMemo(() => {
    const out = new Map<string, ShortcutBinding | null>();
    for (const it of registryItems) out.set(it.action.id, it.binding);
    return out;
  }, [registryItems]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (isTypingTarget(e.target)) return;
      for (const item of visibleItems) {
        if (!item.actionId || !item.href) continue;
        const binding = bindingByActionId.get(item.actionId) ?? null;
        if (!binding) continue;
        if (!matchBinding(binding, e)) continue;
        e.preventDefault();
        router.push(item.href);
        return;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router, visibleItems, bindingByActionId]);

  return (
    <>
      <WorkspaceSwitcher />
      <aside data-pane-name="left-nav" className="flex h-full w-14 shrink-0 flex-col items-center gap-1 border-r border-[var(--border)] bg-[var(--panel)] py-3">
        <AnimatedGlyph running={running} />
        {visibleItems.map(({ label, icon: Icon, href, actionId }) => {
          // Tooltip hint mirrors the live binding. When the user disables a
          // shortcut in Settings the hint disappears; when they remap it,
          // the new chord shows up here without a code edit.
          const binding = actionId ? bindingByActionId.get(actionId) ?? null : null;
          const shortcutLabel = binding ? formatBinding(binding) : undefined;
          // Strip query string when computing active state — Chat's href is
          // "/?new=1" but the displayed pathname is just "/".
          const hrefPath = href ? href.split("?")[0] : undefined;
          const active = hrefPath ? pathname === hrefPath : false;
          // Active state uses the accent color + a left-edge bar (same
          // visual idiom as the workspace switcher's active tile) so the
          // current view is obvious from across the screen.
          const cls = cn(
            "group relative flex h-9 w-9 items-center justify-center rounded-md text-[var(--muted)]",
            "hover:bg-[var(--panel-2)] hover:text-[var(--foreground)]",
            active &&
              "bg-[var(--accent)]/15 text-[var(--accent)] ring-1 ring-[var(--accent)]/40 hover:text-[var(--accent)]",
          );
          // Tooltip: include the shortcut hint if there is one.
          const tooltip = shortcutLabel ? `${label}  ${shortcutLabel}` : label;
          const body = (
            <>
              {active && (
                <span
                  aria-hidden
                  className="pointer-events-none absolute left-[-12px] top-1/2 h-5 w-1 -translate-y-1/2 rounded-r bg-[var(--accent)]"
                />
              )}
              <Icon className="h-4.5 w-4.5" />
            </>
          );
          if (href) {
            return (
              <Link key={label} href={href} title={tooltip} className={cls}>
                {body}
              </Link>
            );
          }
          return (
            <button key={label} title={tooltip} className={cls} disabled>
              {body}
            </button>
          );
        })}
        {/* Customize tile — kept outside `items.map` because its href is
            workspace-aware (see the lookup hook above). The active rule is
            permissive on purpose: both /customize and /customize/<id> light
            up the tile, matching how Schedule/Permissions handle nested
            routes.

            Only rendered when the active workspace is itself a customization
            (or the user happens to already be on /customize, so the tile
            doesn't pop out from under them after a workspace switch). From
            a normal project workspace the entry point is the
            WorkspaceSwitcher's wand drawer → "Manage all". */}
        {(isCustomizationWs || customizeActive) && (
          <Link
            href={customizeHref}
            title={customizeTitle}
            className={cn(
              "group relative flex h-9 w-9 items-center justify-center rounded-md text-[var(--muted)]",
              "hover:bg-[var(--panel-2)] hover:text-[var(--foreground)]",
              customizeActive &&
                "bg-[var(--accent)]/15 text-[var(--accent)] ring-1 ring-[var(--accent)]/40 hover:text-[var(--accent)]",
            )}
          >
            {customizeActive && (
              <span
                aria-hidden
                className="pointer-events-none absolute left-[-12px] top-1/2 h-5 w-1 -translate-y-1/2 rounded-r bg-[var(--accent)]"
              />
            )}
            <WandSparkles className="h-4.5 w-4.5" />
          </Link>
        )}
      </aside>
    </>
  );
}
