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
import { CustomizationsDrawer } from "@/components/nav/CustomizationsDrawer";
import {
  getLastPath,
  setLastPath,
} from "@/lib/client/workspace-route-memory";
import { cn } from "@/lib/utils/cn";

export function WorkspaceSwitcher() {
  const { items, activeId, select, create, uploadIcon, reorder, refresh } = useWorkspaces();
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

  useEffect(() => {
    function isTyping(target: EventTarget | null): boolean {
      const el = target as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
    }
    function onKey(e: KeyboardEvent) {
      // Use Cmd+Shift on macOS, Ctrl+Shift elsewhere — these don't conflict
      // with browser tab-switching shortcuts.
      const metaOrCtrl = e.metaKey || e.ctrlKey;
      if (!metaOrCtrl || !e.shiftKey || e.altKey) return;
      const ws = itemsRef.current;
      if (ws.length === 0) return;
      // Cycle: Cmd/Ctrl+Shift+] → next, Cmd/Ctrl+Shift+[ → prev. Pass the
      // target workspace's last-known URL so cycling drops the user back
      // where they were inside the next workspace, not at chat home.
      if (e.key === "]" || e.code === "BracketRight") {
        e.preventDefault();
        const cur = ws.findIndex((w) => w.id === activeIdRef.current);
        const next = ws[(cur + 1 + ws.length) % ws.length];
        if (next && next.id !== activeIdRef.current) {
          void select(next.id, getLastPath(next.id) ?? "/");
        }
        return;
      }
      if (e.key === "[" || e.code === "BracketLeft") {
        e.preventDefault();
        const cur = ws.findIndex((w) => w.id === activeIdRef.current);
        const prev = ws[(cur - 1 + ws.length) % ws.length];
        if (prev && prev.id !== activeIdRef.current) {
          void select(prev.id, getLastPath(prev.id) ?? "/");
        }
        return;
      }
    }
    function guarded(e: KeyboardEvent) {
      if (isTyping(e.target)) return;
      onKey(e);
    }
    window.addEventListener("keydown", guarded);
    return () => window.removeEventListener("keydown", guarded);
  }, [select]);

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

  return (
    <>
      <aside data-pane-name="workspace-switcher" className="flex h-full w-14 shrink-0 flex-col items-center gap-2 border-r border-[var(--border)] bg-[var(--background)] py-3">
        {projectItems.map((w) => {
          const active = w.id === activeId;
          const dimmed = draggingId && draggingId !== w.id;
          const isOver = overId === w.id && draggingId && draggingId !== w.id;
          return (
            <div
              key={w.id}
              draggable
              onDragStart={onDragStart(w.id)}
              onDragOver={onDragOver(w.id)}
              onDrop={onDrop(w.id)}
              onDragEnd={onDragEnd}
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
                  // visited inside it (workspace-route-memory). Clicking
                  // the tile takes them back to that place rather than
                  // dumping them on chat — which is what they were
                  // already doing, but lost on the previous click. For
                  // the active tile this is usually a no-op (already
                  // there); for an inactive tile it triggers a workspace
                  // switch + navigation to the new workspace's last URL.
                  const target = getLastPath(w.id) ?? "/";
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
          onSelect={select}
          onOpen={refresh}
          unreadCounts={counts}
        />
        <button
          onClick={() => setShowForm({ kind: "new" })}
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
        />
        <SystemTile
          href="/plugins"
          label="Plugins"
          active={pathname?.startsWith("/plugins") ?? false}
          icon={<Plug className="h-4 w-4" />}
        />
        <SystemTile
          href="/settings"
          label="Settings"
          active={pathname?.startsWith("/settings") ?? false}
          icon={<Settings className="h-4 w-4" />}
        />
        <SystemTile
          href="/usage"
          label="Account"
          active={pathname?.startsWith("/usage") ?? false}
          icon={<UserCircle className="h-4 w-4" />}
        />
        {projectItems.length > 1 && (
          <span className="mt-auto px-1 text-center text-[8px] leading-tight text-[var(--muted)]/60">
            {shortcutPrefix()}⇧[ ]
          </span>
        )}
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
    </>
  );
}

function shortcutPrefix(): string {
  if (typeof navigator === "undefined") return "Ctrl";
  return /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";
}

function SystemTile({
  href,
  label,
  icon,
  active,
  accent,
  badge,
  badgeTestId,
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
    </Link>
  );
}
