"use client";

import { useEffect, useMemo, useState, type DragEvent } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { MessageSquare, Menu, Network, Webhook, BookText, ShieldCheck, FolderTree, Bot, Calendar, BarChart3, Image as ImageIcon, Folder, Briefcase, GitBranch, Sparkles, WandSparkles, Container, CircleDot, Database as DatabaseIcon, BookOpen } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import { useWorkspaces } from "@/lib/client/useWorkspaces";
import { useNotificationsContext } from "@/components/notifications/NotificationsProvider";
import type { Customization, PublishRecord } from "@/lib/server/customizations-store";
import {
  formatBinding,
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
//
// Each item's `href` is an "inner" path — the part of the URL after the
// workspace id. At render time we prepend `/${activeId}` so the link
// points at the canonical `/<wks_xxx>/...` route. Inner-path storage
// keeps the items table portable across workspaces (and survives the
// route-memory hand-off in `WorkspaceSwitcher.tsx`).
const items: Item[] = [
  // Top of the rail: the four tiles you reach for ~daily. Chat then Git
  // (review what's been touched), Sessions (jump between conversations),
  // Files (poke at the tree). Anything below that is intentionally
  // alphabetical-ish by use frequency.
  //
  // The Chat button routes to the workspace root (`/<id>`) — boot resumes
  // the last-active tab (persisted in `ui_state.active_tab`) so coming
  // back to the chat view from another page lands you on the conversation
  // you left, instead of spawning a brand-new session on top of the
  // persisted strip. Inner path "" denotes the workspace root.
  { label: "Chat", icon: MessageSquare, href: "", actionId: "nav.chat" },
  { label: "Git", icon: GitBranch, href: "/git", actionId: "nav.git" },
  { label: "Sessions", icon: FolderTree, href: "/sessions", actionId: "nav.sessions" },
  { label: "Files", icon: Folder, href: "/files", actionId: "nav.files" },
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
  // Mobile workspace-switcher overlay. The rail itself paints below
  // `lg` only when this is true (see WorkspaceSwitcher's mobile branch);
  // toggled by the hamburger tile at the top of this aside. We also
  // auto-dismiss whenever the URL changes so a tap that triggers a route
  // change (workspace switch, system tile, navigation from anywhere else)
  // doesn't leave the drawer hanging on the next page.
  const [switcherOpen, setSwitcherOpen] = useState(false);
  // Track the pathname seen on the last render. When it advances, drop
  // the open flag — done via the "store previous render's value" pattern
  // so the state update doesn't live in an effect (which would still fire
  // a paint with the stale `switcherOpen=true` value).
  // https://react.dev/reference/react/useState#storing-information-from-previous-renders
  const [lastPathnameSeen, setLastPathnameSeen] = useState(pathname);
  if (lastPathnameSeen !== pathname) {
    setLastPathnameSeen(pathname);
    if (switcherOpen) setSwitcherOpen(false);
  }

  // Customize tile lives outside the static `items` map because its href is
  // dynamic. When the active workspace is a customization workspace we
  // resolve the linked customization id and link straight to its detail
  // page — the publish / revert UX lives there and the old path (wand
  // drawer → "Manage all" → click row) was three clicks for a destination
  // the user wants in one. Falls back to the list page when no
  // customization is active or while the lookup is in flight.
  const { items: workspaces, activeId, update } = useWorkspaces();
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
  const gatedItems = items.filter(
    (it) =>
      !it.customizationName ||
      (enabledCustNames?.has(it.customizationName.toLowerCase()) ?? false),
  );

  // Apply the workspace's saved `navOrder` to whatever survived the gate.
  // Optimistic `localOrder` lets a drop reflow the rail before the PATCH
  // round-trips; falling back to the server value keeps the two in sync
  // once `useWorkspaces.refresh()` returns.
  const [localOrder, setLocalOrder] = useState<string[] | null>(null);
  const persistedOrder = activeWorkspace?.navOrder ?? null;
  // Whenever the server hands us a new persistedOrder (workspace switch,
  // refresh after a successful PATCH) drop the optimistic copy so we
  // re-read canonical state. Stored in render-time state via the previous-
  // value pattern so the setState stays out of an effect body.
  // https://react.dev/reference/react/useState#storing-information-from-previous-renders
  const [lastSeenPersisted, setLastSeenPersisted] = useState(persistedOrder);
  if (lastSeenPersisted !== persistedOrder) {
    setLastSeenPersisted(persistedOrder);
    setLocalOrder(null);
  }
  const effectiveOrder = localOrder ?? persistedOrder;
  const visibleItems = applyNavOrder(gatedItems, effectiveOrder);
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
  // US layouts). The chord requires Cmd+Option by default so it can fire
  // even when focus is in the composer — see the `onKey` body below.
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
      // NB: no `isTypingTarget` gate. The nav defaults are Cmd+Option+letter
      // (or whatever the user remapped them to in Settings → Web app
      // shortcuts). Cmd+Option held alongside a letter produces no
      // character in any input on any keyboard layout, so it's safe to
      // grab from inside the composer / search palette / any text field.
      // The chord intentionally takes precedence over the active editor —
      // the whole point of these nav shortcuts is "jump from anywhere".
      // If a user remaps to a chord without a mod-key (e.g. plain F) they
      // re-introduce the typing collision themselves; that's their call.
      //
      // Block keyboard nav until the active workspace has resolved —
      // there's no canonical URL to push to before that, and the same
      // condition already disables the rendered links above.
      if (!activeId) return;
      for (const item of visibleItems) {
        // `href === ""` is the chat-root inner path, which is valid —
        // check for `typeof string` rather than truthiness so we don't
        // accidentally skip Chat.
        if (!item.actionId || typeof item.href !== "string") continue;
        const binding = bindingByActionId.get(item.actionId) ?? null;
        if (!binding) continue;
        if (!matchBinding(binding, e)) continue;
        e.preventDefault();
        // Same URL shape as the rendered Link — workspace prefix +
        // inner path; "" yields the bare workspace root.
        const fullHref = `/${activeId}${item.href}`;
        router.push(fullHref);
        return;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router, visibleItems, bindingByActionId, activeId]);

  // HTML5 drag-to-reorder. Mirrors the WorkspaceSwitcher pattern — same
  // dimmed / scale / ring visual cues, same optimistic+PATCH flow. The
  // drag operates on the rendered `visibleItems` (so what the user sees
  // is what they reorder) but persistence records the underlying
  // actionIds, including those for gated tiles, so toggling a
  // customization off and back on returns its tile to the saved slot.
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  function onDragStart(actionId: string) {
    return (e: DragEvent<HTMLDivElement>) => {
      setDraggingId(actionId);
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", actionId);
    };
  }
  function onDragOver(actionId: string) {
    return (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (overId !== actionId) setOverId(actionId);
    };
  }
  function onDrop(targetActionId: string) {
    return (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      const sourceId = draggingId ?? e.dataTransfer.getData("text/plain");
      setDraggingId(null);
      setOverId(null);
      if (!sourceId || sourceId === targetActionId || !activeId) return;

      // Build the next order from the currently-visible rail. We then
      // merge in any saved actionIds that aren't visible right now (so
      // gated tiles keep their slot) — see `mergeReorderWithHidden`.
      const visibleIds = visibleItems
        .map((it) => it.actionId)
        .filter((x): x is string => !!x);
      const from = visibleIds.indexOf(sourceId);
      const to = visibleIds.indexOf(targetActionId);
      if (from === -1 || to === -1) return;
      const nextVisible = visibleIds.slice();
      nextVisible.splice(from, 1);
      nextVisible.splice(to, 0, sourceId);
      const nextOrder = mergeReorderWithHidden(nextVisible, persistedOrder, visibleIds);

      setLocalOrder(nextOrder);
      void update(activeId, { navOrder: nextOrder });
    };
  }
  function onDragEnd() {
    setDraggingId(null);
    setOverId(null);
  }

  // Cross-workspace unread aggregate for the hamburger badge. Reading
  // `counts` from the notifications context so the badge stays in lock-step
  // with the per-workspace tile dots that the WorkspaceSwitcher renders.
  // Excluding the active workspace mirrors the user expectation: a ping on
  // the workspace you're currently inside is already visible in the chat,
  // so surfacing it on the hamburger too would just nag.
  const { counts: workspaceUnreadCounts } = useNotificationsContext();
  const aggregateOtherWorkspaceUnread = Object.entries(workspaceUnreadCounts).reduce(
    (acc, [wid, n]) => (wid === activeId ? acc : acc + n),
    0,
  );

  return (
    <>
      <WorkspaceSwitcher
        mobileOpen={switcherOpen}
        onCloseMobile={() => setSwitcherOpen(false)}
      />
      <aside data-pane-name="left-nav" className="flex h-full w-14 shrink-0 flex-col items-center gap-1 border-r border-[var(--border)] bg-[var(--panel)] py-3">
        {/* Hamburger — only renders below the `lg` breakpoint, where the
            workspace-switcher rail is hidden. Tap to reveal the workspaces
            drawer; the badge sums unread counts across every workspace EXCEPT
            the active one so the user doesn't miss cross-workspace pings while
            the rail is hidden. On lg+ this tile is `display: none` and the
            full rail is back. */}
        <button
          type="button"
          aria-label="Show workspaces"
          aria-expanded={switcherOpen}
          title="Show workspaces"
          onClick={() => setSwitcherOpen((v) => !v)}
          className={cn(
            "relative mb-1 flex h-9 w-9 items-center justify-center rounded-md text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)] lg:hidden",
            switcherOpen && "bg-[var(--panel-2)] text-[var(--foreground)]",
          )}
          data-testid="sidenav-workspaces-toggle"
        >
          <Menu className="h-4.5 w-4.5" />
          {aggregateOtherWorkspaceUnread > 0 && (
            <span
              aria-label={`${aggregateOtherWorkspaceUnread} unread in other workspaces`}
              data-testid="sidenav-workspaces-toggle-badge"
              className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-[var(--accent)] px-1 text-[9px] font-medium leading-none text-white shadow ring-1 ring-[var(--panel)]"
            >
              {aggregateOtherWorkspaceUnread > 99 ? "99+" : aggregateOtherWorkspaceUnread}
            </span>
          )}
        </button>
        <AnimatedGlyph running={running} />
        {visibleItems.map(({ label, icon: Icon, href, actionId }) => {
          // Tooltip hint mirrors the live binding. When the user disables a
          // shortcut in Settings the hint disappears; when they remap it,
          // the new chord shows up here without a code edit.
          const binding = actionId ? bindingByActionId.get(actionId) ?? null : null;
          const shortcutLabel = binding ? formatBinding(binding) : undefined;
          // `href` in the items table is an *inner* path (e.g. "/git" or
          // "" for the workspace root). The actual <Link> target is built
          // by prefixing the active workspace id; the canonical URL shape
          // is `/<wks_xxx>/...` (empty inner path lands on the chat root
          // for that workspace). While `activeId` is still resolving we
          // render the link as a no-op anchor so the rail can hydrate
          // before workspaces have loaded — click during that window
          // does nothing rather than navigating to a broken URL.
          const fullHref =
            typeof href === "string" && activeId
              ? `/${activeId}${href}`
              : undefined;
          // Active state: strip the workspace prefix from `pathname` and
          // compare against the inner href. Doing the comparison on the
          // inner path means a stale link pointing at the bare URL (which
          // shouldn't exist after this refactor, but defence in depth)
          // still highlights the right tile.
          const hrefPath = typeof href === "string" ? href.split("?")[0] : undefined;
          const innerPath = stripWorkspacePrefix(pathname);
          const active = hrefPath !== undefined ? innerPath === hrefPath : false;
          // Active state uses the accent color + a left-edge bar (same
          // visual idiom as the workspace switcher's active tile) so the
          // current view is obvious from across the screen.
          //
          // Tiles render with a small chord glyph BELOW the icon when a
          // binding is registered — the user asked for the keybinding to
          // be visible on the tile itself, not just in the hover tooltip.
          // We keep the chord muted (text-[var(--muted)]/70) and tiny
          // (text-[9px]) so it teaches without competing with the icon;
          // tiles without bindings keep the historical icon-only height
          // so this is purely additive.
          const cls = cn(
            "group relative flex w-9 flex-col items-center justify-center rounded-md text-[var(--muted)]",
            "hover:bg-[var(--panel-2)] hover:text-[var(--foreground)]",
            shortcutLabel ? "h-11 gap-0.5 py-1" : "h-9",
            active &&
              "bg-[var(--accent)]/15 text-[var(--accent)] ring-1 ring-[var(--accent)]/40 hover:text-[var(--accent)]",
          );
          // Tooltip: include the shortcut hint and a drag affordance so the
          // user knows the tiles are reorderable.
          const baseTooltip = shortcutLabel ? `${label}  ${shortcutLabel}` : label;
          const tooltip = actionId ? `${baseTooltip}\nDrag to reorder` : baseTooltip;
          const body = (
            <>
              {active && (
                <span
                  aria-hidden
                  className="pointer-events-none absolute left-[-12px] top-1/2 h-5 w-1 -translate-y-1/2 rounded-r bg-[var(--accent)]"
                />
              )}
              <Icon className="h-4.5 w-4.5" />
              {shortcutLabel && (
                <span
                  aria-hidden
                  className={cn(
                    "select-none font-mono text-[9px] leading-none tracking-tight",
                    active ? "text-[var(--accent)]/80" : "text-[var(--muted)]/60",
                  )}
                >
                  {shortcutLabel}
                </span>
              )}
            </>
          );
          // Wrap each tile in a draggable container. Items without an
          // actionId aren't reorderable (none today, but future-proofs the
          // case where a future tile has no stable id). The Link/button
          // itself stays non-draggable so the drag handle is the surrounding
          // div — same idiom as WorkspaceSwitcher.
          const dimmed = draggingId && draggingId !== actionId;
          const isOver = overId === actionId && draggingId && draggingId !== actionId;
          const dragWrapClass = cn(
            "relative transition",
            actionId && "cursor-grab",
            actionId && dimmed && "opacity-40",
            actionId && draggingId === actionId && "scale-95 cursor-grabbing",
            actionId && isOver && "ring-2 ring-[var(--accent)] rounded-md",
          );
          const inner = fullHref ? (
            <Link href={fullHref} title={tooltip} className={cls} draggable={false}>
              {body}
            </Link>
          ) : (
            <button title={tooltip} className={cls} disabled>
              {body}
            </button>
          );
          if (!actionId) {
            return (
              <div key={label} className="relative">
                {inner}
              </div>
            );
          }
          return (
            <div
              key={label}
              draggable
              onDragStart={onDragStart(actionId)}
              onDragOver={onDragOver(actionId)}
              onDrop={onDrop(actionId)}
              onDragEnd={onDragEnd}
              className={dragWrapClass}
              data-testid={`sidenav-tile-${actionId}`}
            >
              {inner}
            </div>
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

/**
 * Strip the leading `/<wks_xxxxxxxxxxxx>` segment from a pathname and
 * return the inner path used by the nav items table. Active-state
 * detection compares the stripped pathname against each item's `href`
 * so the comparison stays in inner-path space.
 *
 *   "/wks_abc123def456"          → ""
 *   "/wks_abc123def456/git"      → "/git"
 *   "/wks_abc123def456/sessions" → "/sessions"
 *   "/settings"                  → "/settings"   (no prefix, untouched)
 *   ""  / null                   → "/"
 */
function stripWorkspacePrefix(p: string | null): string {
  if (!p) return "/";
  const m = p.match(/^\/wks_[a-f0-9]+(\/.*)?$/);
  if (!m) return p;
  return m[1] ?? "";
}

/**
 * Reorder rule applied when rendering the rail:
 *   1. Items whose `actionId` appears in `order` render first, in the
 *      array's order.
 *   2. Everything else follows in its default position.
 *   3. Dupes in `order` are ignored after the first hit.
 *
 * Stale ids in `order` (e.g. a gated tile whose customization has been
 * reverted) are simply absent from `items`, so they're naturally skipped
 * here. Persistence keeps them in the saved array — see
 * `mergeReorderWithHidden` — so the slot survives the gating round-trip.
 */
function applyNavOrder(items: Item[], order: string[] | null | undefined): Item[] {
  if (!order || order.length === 0) return items;
  const byId = new Map<string, Item>();
  for (const it of items) {
    if (it.actionId) byId.set(it.actionId, it);
  }
  const taken = new Set<string>();
  const ordered: Item[] = [];
  for (const id of order) {
    if (taken.has(id)) continue;
    const it = byId.get(id);
    if (it) {
      ordered.push(it);
      taken.add(id);
    }
  }
  for (const it of items) {
    if (!it.actionId || !taken.has(it.actionId)) ordered.push(it);
  }
  return ordered;
}

/**
 * Build the next `navOrder` to persist after a drop on the visible rail.
 *
 * We have three inputs:
 *   - `nextVisible`: the reordered actionIds the user just produced
 *   - `prevPersisted`: the previously-saved order (may contain hidden
 *      ids whose tiles are currently gated out)
 *   - `currentlyVisible`: actionIds the user just saw, used to decide
 *      which `prevPersisted` entries are "hidden right now" vs absent
 *
 * The output keeps any hidden id in the same relative position it had
 * in `prevPersisted` so re-enabling a gated tile drops it back where the
 * user left it. Hidden ids that came before the first visible one stay
 * at the front; hidden ids that came after a visible one stay after the
 * corresponding new position of that visible id. The simple rule below
 * (interleave by scanning `prevPersisted` and inserting hidden ids at
 * the relative anchor in `nextVisible`) handles both edges.
 */
function mergeReorderWithHidden(
  nextVisible: string[],
  prevPersisted: string[] | null | undefined,
  currentlyVisible: string[],
): string[] {
  if (!prevPersisted || prevPersisted.length === 0) {
    // No hidden ids to preserve — the visible order IS the saved order.
    return nextVisible;
  }
  const visibleSet = new Set(currentlyVisible);
  const result: string[] = [];
  let visibleCursor = 0;
  // Walk prevPersisted; emit hidden ids in their saved slot, and at each
  // visible id pull the next entry from `nextVisible` (so we use the
  // user's new ordering). Any visible ids that weren't in prevPersisted
  // are appended after the walk.
  for (const id of prevPersisted) {
    if (visibleSet.has(id)) {
      // Visible "anchor" — emit whatever the user has at this position now.
      if (visibleCursor < nextVisible.length) {
        result.push(nextVisible[visibleCursor]);
        visibleCursor++;
      }
    } else {
      result.push(id);
    }
  }
  // Append any visible ids the user reordered into a position past where
  // prevPersisted ran out (e.g. a brand-new tile we never persisted).
  while (visibleCursor < nextVisible.length) {
    result.push(nextVisible[visibleCursor]);
    visibleCursor++;
  }
  // Final dedupe — guards against a `prevPersisted` that already
  // contained the same id twice (shouldn't happen, but cheap to enforce).
  const seen = new Set<string>();
  return result.filter((id) => (seen.has(id) ? false : (seen.add(id), true)));
}
