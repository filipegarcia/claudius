"use client";

import { useEffect, useRef, useState, type DragEvent } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Plus, Plug, Settings, UserCircle } from "lucide-react";
import { useWorkspaces } from "@/lib/client/useWorkspaces";
import { WorkspaceIcon } from "@/components/workspaces/WorkspaceIcon";
import { WorkspaceForm } from "@/components/workspaces/WorkspaceForm";
import { cn } from "@/lib/utils/cn";
import type { Workspace } from "@/lib/server/workspaces-store";

export function WorkspaceSwitcher() {
  const { items, activeId, select, create, update, uploadIcon, remove, reorder } = useWorkspaces();
  const pathname = usePathname();
  const [showForm, setShowForm] = useState<null | { kind: "new" } | { kind: "edit"; workspace: Workspace }>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  // Refs that the global hotkey handler reads — avoids stale closures.
  const itemsRef = useRef(items);
  const activeIdRef = useRef(activeId);
  itemsRef.current = items;
  activeIdRef.current = activeId;

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
      // Direct: Cmd/Ctrl+Shift+1..9 → workspace at that index.
      if (/^Digit[1-9]$/.test(e.code)) {
        const idx = Number(e.code.slice(5)) - 1;
        const target = ws[idx];
        if (target && target.id !== activeIdRef.current) {
          e.preventDefault();
          void select(target.id);
        }
        return;
      }
      // Cycle: Cmd/Ctrl+Shift+] → next, Cmd/Ctrl+Shift+[ → prev.
      if (e.key === "]" || e.code === "BracketRight") {
        e.preventDefault();
        const cur = ws.findIndex((w) => w.id === activeIdRef.current);
        const next = ws[(cur + 1 + ws.length) % ws.length];
        if (next && next.id !== activeIdRef.current) void select(next.id);
        return;
      }
      if (e.key === "[" || e.code === "BracketLeft") {
        e.preventDefault();
        const cur = ws.findIndex((w) => w.id === activeIdRef.current);
        const prev = ws[(cur - 1 + ws.length) % ws.length];
        if (prev && prev.id !== activeIdRef.current) void select(prev.id);
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
      const ids = items.map((w) => w.id);
      const from = ids.indexOf(sourceId);
      const to = ids.indexOf(targetId);
      if (from === -1 || to === -1) return;
      const next = ids.slice();
      next.splice(from, 1);
      next.splice(to, 0, sourceId);
      void reorder(next);
    };
  }
  function onDragEnd() {
    setDraggingId(null);
    setOverId(null);
  }

  return (
    <>
      <aside className="flex h-full w-14 shrink-0 flex-col items-center gap-2 border-r border-[var(--border)] bg-[var(--background)] py-3">
        {items.map((w, i) => {
          const active = w.id === activeId;
          const dimmed = draggingId && draggingId !== w.id;
          const isOver = overId === w.id && draggingId && draggingId !== w.id;
          const shortcut = i < 9 ? `${shortcutPrefix()}+Shift+${i + 1}` : null;
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
                onClick={() => (active ? setShowForm({ kind: "edit", workspace: w }) : void select(w.id))}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setShowForm({ kind: "edit", workspace: w });
                }}
                title={`${w.name}${active ? " (active — click to edit)" : ""}\n${w.rootPath}${shortcut ? `\nShortcut: ${shortcut}` : ""}\nDrag to reorder`}
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
              </button>
            </div>
          );
        })}
        <button
          onClick={() => setShowForm({ kind: "new" })}
          title="New workspace"
          className="mt-1 flex h-10 w-10 items-center justify-center rounded-lg border border-dashed border-[var(--border)] text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)]"
        >
          <Plus className="h-4 w-4" />
        </button>
        {/* System / global tiles — independent active highlight from the
            workspace tiles above. */}
        <div className="mt-3 h-px w-8 bg-[var(--border)]" />
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
        {items.length > 1 && (
          <span className="mt-auto px-1 text-center text-[8px] leading-tight text-[var(--muted)]/60">
            {shortcutPrefix()}⇧[ ]<br />or {shortcutPrefix()}⇧1–9
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
      {showForm?.kind === "edit" && (
        <WorkspaceForm
          initial={showForm.workspace}
          onCancel={() => setShowForm(null)}
          onIconUpload={async (id, file) => uploadIcon(id, file)}
          onSubmit={async (input) => {
            const ok = await update(showForm.workspace.id, {
              name: input.name,
              rootPath: input.rootPath,
              ...(input.icon ? { icon: input.icon } : {}),
              ...(input.defaults ? { defaults: input.defaults } : {}),
            });
            if (ok) {
              setShowForm(null);
              return { ok: true as const, workspace: { ...showForm.workspace, ...input } };
            }
            return { ok: false as const, error: "save failed" };
          }}
          onDelete={async () => {
            await remove(showForm.workspace.id);
            setShowForm(null);
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
}: {
  href: string;
  label: string;
  icon: React.ReactNode;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      title={label}
      className={cn(
        "flex h-10 w-10 items-center justify-center rounded-lg text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)]",
        active && "bg-[var(--panel-2)] text-[var(--foreground)] ring-1 ring-[var(--border)]",
      )}
    >
      {icon}
    </Link>
  );
}
