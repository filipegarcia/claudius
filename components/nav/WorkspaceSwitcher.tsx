"use client";

import { useEffect, useLayoutEffect, useRef, useState, type DragEvent } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Plus, Plug, Settings, UserCircle, Radio } from "lucide-react";
import { useWorkspaces } from "@/lib/client/useWorkspaces";
import { useNotificationsContext } from "@/components/notifications/NotificationsProvider";
import { useCommunityNotifications } from "@/components/community/CommunityNotificationsProvider";
import { WorkspaceIcon } from "@/components/workspaces/WorkspaceIcon";
import { WorkspaceForm } from "@/components/workspaces/WorkspaceForm";
import {
  WorkspaceContextMenu,
  letterFallback,
} from "@/components/workspaces/WorkspaceContextMenu";
import { CustomizationsDrawer } from "@/components/nav/CustomizationsDrawer";
import {
  getLastPath,
  setLastPath,
} from "@/lib/client/workspace-route-memory";
import {
  formatBinding,
  isTypingTarget,
  matchBinding,
  useShortcut,
} from "@/lib/client/shortcuts";
import { cn } from "@/lib/utils/cn";
import { CLAUDIUS_VERSION_DISPLAY } from "@/lib/shared/version";

/**
 * Props for the small-screen overlay behavior.
 *
 * Below the `lg` breakpoint the rail is hidden by default (`hidden lg:flex`)
 * and the hamburger tile in SideNav toggles `mobileOpen`. When true, the rail
 * paints as a fixed-position drawer over the left edge with a click-anywhere
 * backdrop; ESC, backdrop click, and any workspace/system-tile selection all
 * close it (the parent's `pathname` effect also auto-dismisses on nav).
 *
 * Omit both for the desktop default: the rail behaves exactly as before.
 */
type Props = {
  mobileOpen?: boolean;
  onCloseMobile?: () => void;
};

export function WorkspaceSwitcher({ mobileOpen = false, onCloseMobile }: Props = {}) {
  const { items, activeId, select, create, update, remove, uploadIcon, reorder, refresh } =
    useWorkspaces();
  const { counts } = useNotificationsContext();
  const community = useCommunityNotifications();
  const pathname = usePathname();
  const router = useRouter();
  // The rail used to host both "new workspace" and "edit existing" — the
  // edit path moved to /workspace (briefcase tile in SideNav) so the rail
  // is now strictly a navigator. Only the "new" form survives here.
  const [showForm, setShowForm] = useState<null | { kind: "new" }>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  // Right-click context menu. `null` when closed; otherwise the workspace id
  // and the viewport click point that the popover anchors to.
  const [menu, setMenu] = useState<null | { id: string; x: number; y: number }>(null);
  const menuWorkspace = menu ? items.find((w) => w.id === menu.id) ?? null : null;

  // Active account-switcher profile label (account-switcher, see
  // accounts-store.ts). Drives the corner badge on the Account system
  // tile so the user can confirm at a glance which credential new
  // sessions will spawn under. Refetched every time the user leaves
  // /usage (the page where the switch happens) so the rail picks the
  // change up without a hard reload. The async fetch lives inside the
  // effect's IIFE so setState only fires from inside the callback —
  // codebase convention for "fetch on mount + on user navigation".
  const [activeAccountLabel, setActiveAccountLabel] = useState<string | null>(null);
  const leftUsagePath = pathname && !pathname.startsWith("/usage");
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch("/api/accounts");
        if (cancelled || !r.ok) return;
        const data = (await r.json()) as {
          profiles: { id: string; label: string }[];
          activeProfileId: string | null;
        };
        if (cancelled) return;
        const active = data.profiles.find((p) => p.id === data.activeProfileId) ?? null;
        setActiveAccountLabel(active?.label ?? null);
      } catch {
        // Best-effort — a fetch failure just leaves the tile in its bare
        // state, same as "no accounts configured".
      }
    })();
    return () => {
      cancelled = true;
    };
    // `leftUsagePath` re-fires whenever pathname transitions on/off
    // /usage, which is the only place an account switch happens.
  }, [leftUsagePath]);
  const activeAccountChar = activeAccountLabel
    ? activeAccountLabel.trim().charAt(0).toUpperCase() || null
    : null;

  // Customization workspaces live in the drawer, not the main rail loop.
  // Splitting them here keeps the rendered list, the drag-reorder, and the
  // keyboard shortcut handler all consistent — see `reorder` below where the
  // hidden customization ids are appended to preserve `reorderWorkspaces`'s
  // strict length check.
  const projectItems = items.filter((w) => w.kind !== "customization");
  const customizationItems = items.filter((w) => w.kind === "customization");

  // Per-workspace "last visited URL" tracker. Clicking a workspace tile
  // should return the user to wherever they last were *in that workspace*
  // — not the chat home, and not the path they happen to be on under a
  // different workspace's cwd. `setLastPath` no-ops on global routes
  // (/settings, /community, …) so a stop on those pages doesn't clobber
  // the project page the user actually cares about.
  useEffect(() => {
    if (!activeId || !pathname) return;
    setLastPath(activeId, pathname);
  }, [activeId, pathname]);

  // Mobile overlay ESC dismissal. Backdrop click and tile-selection paths
  // call `onCloseMobile` directly; this handles the keyboard case so users
  // can dismiss without grabbing the mouse. Listener is only attached while
  // the overlay is actually open, so it doesn't fight other ESC handlers
  // (overlay modals, context menus) when the rail is in its desktop state.
  useEffect(() => {
    if (!mobileOpen || !onCloseMobile) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCloseMobile?.();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mobileOpen, onCloseMobile]);

  // Refs that the global hotkey handler reads — avoids stale closures.
  // Only project workspaces are reachable via Cmd+Shift+[ / ]; the drawer is
  // the path to customizations. The 1..9 number keys used to live here but
  // moved to session tabs (see SessionTabs.tsx) — having one mnemonic owned
  // by sessions matches the iTerm tab-bar feel the user wanted, and `[`/`]`
  // is a natural pair for "previous/next workspace" alongside it.
  //
  // Refs are written in a useLayoutEffect rather than during render so the
  // react-hooks/refs rule stays happy. The hotkey effect below registers
  // exactly once (deps = [select]) and reads `.current` on each keypress,
  // so the ref values it sees are always the latest committed render.
  const itemsRef = useRef(projectItems);
  const activeIdRef = useRef(activeId);
  useLayoutEffect(() => {
    itemsRef.current = projectItems;
    activeIdRef.current = activeId;
  }, [projectItems, activeId]);

  // Workspace cycle bindings come from the registry — default ⌘⇧[ / ⌘⇧]
  // but the user can remap from Settings → Web app shortcuts. Defaults
  // intentionally don't conflict with the browser's tab-switching shortcuts.
  const bindingNext = useShortcut("workspace.next");
  const bindingPrev = useShortcut("workspace.prev");
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (isTypingTarget(e.target)) return;
      const ws = itemsRef.current;
      if (ws.length === 0) return;
      // Cycle: pass the target workspace's last-known URL so cycling drops
      // the user back where they were inside the next workspace, not at
      // chat home.
      const dir = matchBinding(bindingNext, e) ? 1 : matchBinding(bindingPrev, e) ? -1 : 0;
      if (dir === 0) return;
      e.preventDefault();
      const cur = ws.findIndex((w) => w.id === activeIdRef.current);
      const target = ws[(cur + dir + ws.length) % ws.length];
      if (target && target.id !== activeIdRef.current) {
        // Cycle: pass the target workspace's saved URL (prefixed) so
        // we land where the user last was inside it; fall back to that
        // workspace's chat root when nothing is persisted.
        void select(target.id, getLastPath(target.id) ?? `/${target.id}`);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [select, bindingNext, bindingPrev]);

  function onDragStart(id: string) {
    return (e: DragEvent<HTMLDivElement>) => {
      setDraggingId(id);
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", id);
    };
  }
  function onDragOver(id: string) {
    return (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (overId !== id) setOverId(id);
    };
  }
  function onDrop(targetId: string) {
    return (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      const sourceId = draggingId ?? e.dataTransfer.getData("text/plain");
      setDraggingId(null);
      setOverId(null);
      if (!sourceId || sourceId === targetId) return;
      // Reorder runs over visible project tiles only — customization ids are
      // appended at the end so the server's length check (which requires the
      // payload to include every workspace) still passes. Their relative
      // order is preserved.
      const projectIds = projectItems.map((w) => w.id);
      const from = projectIds.indexOf(sourceId);
      const to = projectIds.indexOf(targetId);
      if (from === -1 || to === -1) return;
      const nextProjects = projectIds.slice();
      nextProjects.splice(from, 1);
      nextProjects.splice(to, 0, sourceId);
      void reorder([...nextProjects, ...customizationItems.map((w) => w.id)]);
    };
  }
  function onDragEnd() {
    setDraggingId(null);
    setOverId(null);
  }

  // Visibility model:
  //   ≥ lg → inline `<aside>` (the historical desktop layout).
  //   < lg → hidden by default; if `mobileOpen` is true, paint as a
  //          fixed-position drawer over the SideNav with a backdrop. The
  //          backdrop captures clicks anywhere outside the rail and calls
  //          `onCloseMobile`, matching the platform convention for slide-out
  //          drawers (and mirroring the dismissal contract used by the rest
  //          of Claudius's overlays).
  //
  // Tailwind utility `flex` is gated by `lg:flex` so the inline state only
  // re-engages above the breakpoint; the mobile-open branch supplies its own
  // `flex` so the layout still works when the user opens the drawer on a
  // narrow viewport.
  const desktopAsideClass =
    "h-full w-14 shrink-0 flex-col items-center gap-2 border-r border-[var(--border)] bg-[var(--background)] py-3 hidden lg:flex";
  const mobileAsideClass =
    "fixed inset-y-0 left-0 z-50 flex h-full w-14 shrink-0 flex-col items-center gap-2 border-r border-[var(--border)] bg-[var(--background)] py-3 shadow-2xl overflow-y-auto scroll-thin lg:hidden";
  // Workspace switching from inside the overlay should close the drawer in
  // the same gesture. Wrapped here so we don't sprinkle null-checks at every
  // click site below.
  const closeMobileIfOpen = () => {
    if (mobileOpen) onCloseMobile?.();
  };
  return (
    <>
      {mobileOpen && (
        <button
          type="button"
          aria-label="Close workspace switcher"
          onClick={() => onCloseMobile?.()}
          className="fixed inset-0 z-40 bg-black/40 lg:hidden"
        />
      )}
      <aside
        data-pane-name="workspace-switcher"
        className={mobileOpen ? mobileAsideClass : desktopAsideClass}
      >
        {projectItems.map((w) => {
          const active = w.id === activeId;
          const dimmed = draggingId && draggingId !== w.id;
          const isOver = overId === w.id && draggingId && draggingId !== w.id;
          return (
            <div
              key={w.id}
              // Disable drag while the context menu is open for this tile —
              // a stray drag would close the popover and could land a drop
              // mid-edit. The handlers themselves stay wired so other tiles
              // remain reorderable.
              draggable={menu?.id !== w.id}
              onDragStart={onDragStart(w.id)}
              onDragOver={onDragOver(w.id)}
              onDrop={onDrop(w.id)}
              onDragEnd={onDragEnd}
              onContextMenu={(e) => {
                // Suppress the native menu and the parent's drag — both would
                // fight the popover otherwise.
                e.preventDefault();
                e.stopPropagation();
                setMenu({ id: w.id, x: e.clientX, y: e.clientY });
              }}
              className={cn(
                "relative cursor-grab transition",
                dimmed && "opacity-40",
                draggingId === w.id && "scale-95 cursor-grabbing",
                isOver && "ring-2 ring-[var(--accent)] rounded-lg",
              )}
            >
              {/* Active-workspace indicator: Slack-style accent bar flush with
                  the aside's left edge. The wrapper div hugs the 40px icon, so
                  -8px places the bar at the aside's left edge (aside is 56px,
                  icon is centered → 8px gutter on each side). */}
              {active && (
                <span
                  aria-hidden
                  className="pointer-events-none absolute left-[-8px] top-1/2 h-8 w-1 -translate-y-1/2 rounded-r bg-[var(--accent)]"
                />
              )}
              <button
                onClick={() => {
                  // Each workspace remembers the last URL the user
                  // visited inside it (workspace-route-memory).
                  // `getLastPath` returns a fully-prefixed URL
                  // (`/<id>/<inner>`) or null; we fall back to the
                  // workspace root `/<id>` when nothing is persisted.
                  // For the active tile this is usually a no-op
                  // (already there); for an inactive tile it triggers
                  // a workspace switch + navigation to the saved URL.
                  const target = getLastPath(w.id) ?? `/${w.id}`;
                  // Selecting from the mobile overlay should always
                  // dismiss it (even the "already active" branch where we
                  // just close the drawer with no navigation — the user
                  // implicitly answered "no, I didn't want to switch").
                  closeMobileIfOpen();
                  if (active) {
                    if (pathname !== target) router.push(target);
                    return;
                  }
                  void select(w.id, target);
                }}
                title={`${w.name}${active ? " (active)" : ""}\n${w.rootPath}\nDrag to reorder`}
                className={cn(
                  "relative block rounded-lg transition",
                  // Second cue: an accent ring + offset glow around the active
                  // tile so it's unmistakable even on themes where the side
                  // bar's left edge is close to the chat background.
                  active && "ring-2 ring-[var(--accent)] ring-offset-2 ring-offset-[var(--background)]",
                  !active && "opacity-80 hover:opacity-100",
                )}
              >
                <WorkspaceIcon workspace={w} size={40} />
                {(counts[w.id] ?? 0) > 0 && (
                  <span
                    aria-label={`${counts[w.id]} unread notifications`}
                    data-testid={`workspace-notification-badge-${w.id}`}
                    className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-[var(--accent)] px-1 text-[9px] font-medium leading-none text-white shadow ring-1 ring-[var(--background)]"
                  >
                    {(counts[w.id] ?? 0) > 99 ? "99+" : counts[w.id]}
                  </span>
                )}
              </button>
            </div>
          );
        })}
        {/* Customizations live behind a single drawer tile instead of getting
            their own rail rows — see CustomizationsDrawer for the popover. */}
        <CustomizationsDrawer
          customizations={customizationItems}
          activeId={activeId}
          onSelect={(id) => {
            // Dismiss the mobile drawer first so the customization workspace
            // page paints without the rail overlapping the chat area on the
            // way out.
            closeMobileIfOpen();
            void select(id);
          }}
          onOpen={refresh}
          unreadCounts={counts}
        />
        <button
          onClick={() => {
            // The "new workspace" form is modal; closing the drawer first
            // gets the underlying overlay backdrop out of the way before
            // the form appears on top, so the form is the only intercept
            // for clicks. Without this the user clicks the form, closes
            // the drawer, and the form vanishes with them.
            closeMobileIfOpen();
            setShowForm({ kind: "new" });
          }}
          title="New workspace"
          className="mt-1 flex h-10 w-10 items-center justify-center rounded-lg border border-dashed border-[var(--border)] text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)]"
        >
          <Plus className="h-4 w-4" />
        </button>
        {/* Notifications used to live here as a bell tile; it now sits at
            the top of the Activity rail (BackgroundTasksPanel) so it's next
            to the session/turn context the user is glancing at. Per-workspace
            unread badges on the workspace tiles above stay. */}
        {/* System / global tiles — independent active highlight from the
            workspace tiles above. */}
        <div className="mt-3 h-px w-8 bg-[var(--border)]" />
        {/* Community lives in the system-tile cluster because it's a
            cross-workspace destination, not something tied to one project.
            See `chat-server/` for the backend; the page renders an empty
            state when NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL is unset. */}
        <SystemTile
          href="/community"
          label={
            community.enabled
              ? `Community${community.unreadCount > 0 ? ` (${community.unreadCount} unread)` : ""}`
              : "Community"
          }
          active={pathname?.startsWith("/community") ?? false}
          icon={<Radio className="h-4 w-4" />}
          badge={community.unreadCount > 0 ? community.unreadCount : undefined}
          badgeTestId="community-notification-badge"
          onClick={closeMobileIfOpen}
        />
        <SystemTile
          href="/plugins"
          label="Plugins"
          active={pathname?.startsWith("/plugins") ?? false}
          icon={<Plug className="h-4 w-4" />}
          onClick={closeMobileIfOpen}
        />
        <SystemTile
          href="/settings"
          label="Settings"
          active={pathname?.startsWith("/settings") ?? false}
          icon={<Settings className="h-4 w-4" />}
          onClick={closeMobileIfOpen}
        />
        <SystemTile
          href="/usage"
          label={
            activeAccountLabel
              ? `Account — ${activeAccountLabel}`
              : "Account"
          }
          active={pathname?.startsWith("/usage") ?? false}
          icon={<UserCircle className="h-4 w-4" />}
          // When the user has configured an account-switcher profile,
          // paint a small initial-chip on the tile so they can confirm
          // at a glance which credential new sessions will spawn under
          // (the canonical "hit limit on A → flipped to B" check). When
          // no profile is configured we render the bare icon — Claudius
          // is then using the ambient credential (keychain / env) and
          // there's no second option to confuse it with.
          cornerChar={activeAccountChar}
          onClick={closeMobileIfOpen}
        />
        {/* Footer cluster pinned to the bottom of the rail. It owns the
            single `mt-auto` so both the (optional) workspace-cycle hint and
            the version tag sit flush at the bottom — previously the hint
            claimed `mt-auto` on its own, and only one flex child can. */}
        <div className="mt-auto flex flex-col items-center gap-1 pt-2">
          {projectItems.length > 1 && (bindingPrev || bindingNext) && (
            // Reflect whatever bindings the user has — if they remapped to
            // ⌥, ⇧ or anything else, the hint here updates with them.
            <span className="px-1 text-center text-[8px] leading-tight text-[var(--muted)]/60">
              {bindingPrev ? formatBinding(bindingPrev) : ""}
              {bindingPrev && bindingNext ? " " : ""}
              {bindingNext ? formatBinding(bindingNext) : ""}
            </span>
          )}
          {/* claudius version — tracks the Claude Agent SDK (see
              lib/shared/version.ts). Stacked over two lines so the 56px rail
              isn't blown out; reuses the muted micro-type of the cycle hint. */}
          <div
            data-testid="claudius-version"
            title={`Claudius ${CLAUDIUS_VERSION_DISPLAY} · version tracks the Claude Agent SDK`}
            className="px-1 text-center text-[8px] leading-tight text-[var(--muted)]/60"
          >
            <div>claudius</div>
            <div className="font-mono">{CLAUDIUS_VERSION_DISPLAY}</div>
          </div>
        </div>
      </aside>
      {showForm?.kind === "new" && (
        <WorkspaceForm
          onCancel={() => setShowForm(null)}
          onIconUpload={async (id, file) => uploadIcon(id, file)}
          onSubmit={async (input) => {
            const r = await create(input);
            if (r.ok) setShowForm(null);
            return r;
          }}
        />
      )}
      {menu && menuWorkspace && (
        <WorkspaceContextMenu
          workspace={menuWorkspace}
          x={menu.x}
          y={menu.y}
          isActive={menuWorkspace.id === activeId}
          onClose={() => setMenu(null)}
          onRename={async (id, name) => {
            await update(id, { name });
          }}
          onChangeColor={async (id, color) => {
            // PATCH expects a full Icon object — when the current icon is an
            // image the workspace has no `letter` field, so we derive one
            // from the name (matches defaultLetterIcon's first-non-space-char
            // rule).
            const { letter } = letterFallback(menuWorkspace);
            await update(id, { icon: { kind: "letter", letter, color } });
          }}
          onSwitchToLetter={async (id) => {
            const { letter } = letterFallback(menuWorkspace);
            // Reuse the existing icon's color if there is one; otherwise let
            // the user pick from the swatches afterwards. We pick the first
            // palette color as a default — same shade ordering as the form.
            const color =
              menuWorkspace.icon.kind === "letter" ? menuWorkspace.icon.color : "#d97757";
            await update(id, { icon: { kind: "letter", letter, color } });
          }}
          onOpenSettings={(id) => {
            // /workspace edits the *active* workspace, so we have to
            // select first when the target tile isn't the active one.
            // `select` reloads the page when the active id changes,
            // which would unmount us before we navigate — pass the
            // inner route ("/workspace") and let `select` build the
            // prefixed URL `/<id>/workspace`. For the already-active
            // case we just navigate client-side.
            if (id === activeId) {
              router.push(`/${id}/workspace`);
            } else {
              void select(id, "/workspace");
            }
          }}
          onDelete={async (id) => {
            const wasActive = id === activeId;
            const ok = await remove(id);
            if (ok && wasActive) {
              // Server clears the cookie + reassigns activeId; reboot
              // the app at "/" so the new active workspace's chat
              // root is resolved server-side (`app/page.tsx`) and the
              // user is 307'd to `/<newActiveId>`. Hitting a deleted
              // workspace's URL directly would 404 once the route
              // disappears.
              if (typeof window !== "undefined") window.location.href = "/";
            }
          }}
        />
      )}
    </>
  );
}

function SystemTile({
  href,
  label,
  icon,
  active,
  accent,
  badge,
  badgeTestId,
  cornerChar,
  onClick,
}: {
  href: string;
  label: string;
  icon: React.ReactNode;
  active: boolean;
  /** When true, render with the accent color so the tile stands out (e.g. Customize). */
  accent?: boolean;
  /** Unread-style counter to render on the top-right of the tile. */
  badge?: number;
  /** Test id for the badge element. */
  badgeTestId?: string;
  /**
   * Single-character identity chip rendered at the top-right of the tile
   * — currently used by the Account tile to indicate which configured
   * account-switcher profile new sessions will spawn under. Mutually
   * exclusive with `badge` (Account doesn't have an unread count anyway).
   */
  cornerChar?: string | null;
  /**
   * Side-effect to run on click in ADDITION to navigation — used by the
   * parent to close the mobile workspace-switcher overlay when the user
   * jumps to a system route. Optional so desktop usage stays a plain
   * navigation link.
   */
  onClick?: () => void;
}) {
  // Idle state is always muted — only when `active && accent` do we paint
  // the tile with the accent color. Previously `accent` showed the colored
  // icon at all times, which made an unselected Customize tile look like
  // it was the active route.
  const accentActive = active && accent;
  return (
    <Link
      href={href}
      title={label}
      onClick={onClick}
      className={cn(
        "relative flex h-10 w-10 items-center justify-center rounded-lg text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)]",
        accentActive
          ? "bg-[var(--accent)]/15 text-[var(--accent)] ring-1 ring-[var(--accent)]/40 hover:text-[var(--accent)]"
          : active &&
              "bg-[var(--panel-2)] text-[var(--foreground)] ring-1 ring-[var(--border)]",
      )}
    >
      {icon}
      {typeof badge === "number" && badge > 0 && (
        <span
          aria-label={`${badge} unread`}
          data-testid={badgeTestId}
          className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-[var(--accent)] px-1 text-[9px] font-medium leading-none text-white shadow ring-1 ring-[var(--background)]"
        >
          {badge > 99 ? "99+" : badge}
        </span>
      )}
      {cornerChar && (!badge || badge === 0) && (
        <span
          aria-hidden
          data-testid="systemtile-corner-char"
          className="absolute -right-0.5 -top-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-[var(--accent)] text-[8.5px] font-semibold leading-none text-white shadow ring-1 ring-[var(--background)]"
        >
          {cornerChar}
        </span>
      )}
    </Link>
  );
}
