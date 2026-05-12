"use client";

/**
 * Shared chat-window chrome for the /dev/chat-* preview pages. Hand-rolled so
 * the screenshot specs can capture chat-state visuals without the real
 * useSession / SSE / workspace plumbing.
 *
 * Lays out:
 *   - left workspace rail (3 letter tiles + customize wand + new + system icons)
 *   - side nav rail (chat / sessions / files / git / memory / ...)
 *   - tab strip
 *   - children (status line + body)
 *   - right activity panel (context + todos + tools)
 */

import {
  MessageSquare,
  Network,
  Webhook,
  BookText,
  ShieldCheck,
  FolderTree,
  Bot,
  Calendar,
  BarChart3,
  Image as ImageIcon,
  Folder,
  Briefcase,
  GitBranch,
  Sparkles,
  WandSparkles,
  Plus,
  Plug,
  Settings,
  UserCircle,
  Radio,
  Container,
  X,
} from "lucide-react";

type Tab = { id: string; label: string; active?: boolean };

export function PreviewChrome({
  activeTab,
  tabs,
  children,
  todos,
}: {
  activeTab: string;
  tabs: Tab[];
  children: React.ReactNode;
  todos?: { label: string; status: "pending" | "in_progress" | "completed" }[];
}) {
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[var(--background)] text-[var(--foreground)]">
      {/* Workspace rail */}
      <aside className="flex w-14 shrink-0 flex-col items-center gap-2 border-r border-[var(--border)] bg-[var(--background)] py-3">
        <Letter letter="A" color="#d97757" />
        <Letter letter="C" color="#cc5577" active />
        <Letter letter="E" color="#33aabb" />
        <WandTile />
        <button className="mt-1 flex h-10 w-10 items-center justify-center rounded-lg border border-dashed border-[var(--border)] text-[var(--muted)]">
          <Plus className="h-4 w-4" />
        </button>
        <div className="mt-3 h-px w-8 bg-[var(--border)]" />
        <SystemIcon icon={Radio} />
        <SystemIcon icon={Plug} />
        <SystemIcon icon={Settings} />
        <SystemIcon icon={UserCircle} />
      </aside>

      {/* Side nav rail */}
      <aside className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-[var(--border)] bg-[var(--panel)] py-3">
        <NavIcon icon={MessageSquare} active />
        <NavIcon icon={FolderTree} />
        <NavIcon icon={Folder} />
        <NavIcon icon={GitBranch} />
        <NavIcon icon={BookText} />
        <NavIcon icon={ImageIcon} />
        <NavIcon icon={BarChart3} />
        <NavIcon icon={Bot} />
        <NavIcon icon={Sparkles} />
        <NavIcon icon={Network} />
        <NavIcon icon={Webhook} />
        <NavIcon icon={Calendar} />
        <NavIcon icon={ShieldCheck} />
        <NavIcon icon={Container} />
        <NavIcon icon={Briefcase} />
      </aside>

      {/* Main column */}
      <main className="flex min-w-0 flex-1 flex-col">
        {/* Tab strip */}
        <div className="flex h-9 shrink-0 items-center gap-1 border-b border-[var(--border)] bg-[var(--panel)] px-2 text-[11px] text-[var(--muted)]">
          {tabs.map((t) => (
            <div
              key={t.id}
              className={
                "flex items-center gap-1.5 rounded-t-md border-b-2 px-2 py-1 " +
                (t.id === activeTab
                  ? "border-[var(--accent)] bg-[var(--background)] text-[var(--foreground)]"
                  : "border-transparent")
              }
            >
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />
              <span className="font-mono">{t.label}</span>
              <X className="h-3 w-3 opacity-60" />
            </div>
          ))}
          <button className="ml-1 flex h-5 w-5 items-center justify-center rounded text-[var(--muted)]">
            <Plus className="h-3.5 w-3.5" />
          </button>
          <button className="ml-auto flex h-5 w-5 items-center justify-center rounded text-[var(--muted)]">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        {children}
      </main>

      {/* Activity panel */}
      <aside className="flex w-72 shrink-0 flex-col gap-3 border-l border-[var(--border)] bg-[var(--background)] px-3 py-3 text-xs">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1.5 font-medium text-[var(--foreground)]">
            <span className="inline-block h-2 w-2 rounded-full bg-[var(--accent)]" />
            Activity
          </span>
          <span className="text-[10px] text-[var(--muted)]">0</span>
        </div>
        <div className="rounded-md border border-[var(--border)] bg-[var(--panel)] p-2">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[10px] text-[var(--muted)]">—</span>
            <span className="rounded border border-[var(--border)] bg-[var(--panel-2)] px-1.5 py-0.5 text-[9px] uppercase tracking-wide">
              default
            </span>
          </div>
          <div className="mt-1 font-mono text-[10px] text-[var(--muted)]">
            0 turns &middot; -1s
          </div>
        </div>
        <Section title="Context">
          <div className="grid grid-cols-4 gap-1.5 text-center">
            <Stat label="IN" value="0" />
            <Stat label="OUT" value="0" />
            <Stat label="CACHE" value="0" />
            <Stat label="$" value="$0.00" />
          </div>
        </Section>
        <Section title={`To-dos (${todos?.length ?? 0})`}>
          {todos && todos.length > 0 ? (
            <ul className="space-y-1.5">
              {todos.map((t, i) => (
                <li key={i} className="flex items-center gap-2 text-[var(--foreground)]">
                  {t.status === "completed" ? (
                    <span className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full border border-emerald-400/60 text-emerald-300">
                      ✓
                    </span>
                  ) : t.status === "in_progress" ? (
                    <span className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full border border-sky-400/60 text-sky-300 animate-pulse">
                      ●
                    </span>
                  ) : (
                    <span className="inline-block h-3.5 w-3.5 rounded-full border border-[var(--border)]" />
                  )}
                  <span className={t.status === "completed" ? "line-through opacity-60" : ""}>
                    {t.label}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="text-[var(--muted)]">No tasks yet. Click + to add.</div>
          )}
        </Section>
        <Section title="Tools">
          <div className="text-[var(--muted)]">No tools used yet.</div>
        </Section>
      </aside>
    </div>
  );
}

function Letter({ letter, color, active }: { letter: string; color: string; active?: boolean }) {
  return (
    <div className="relative">
      {active && (
        <span className="pointer-events-none absolute left-[-8px] top-1/2 h-8 w-1 -translate-y-1/2 rounded-r bg-[var(--accent)]" />
      )}
      <div
        className={
          "flex h-10 w-10 items-center justify-center rounded-lg font-semibold text-white " +
          (active ? "ring-2 ring-[var(--accent)] ring-offset-2 ring-offset-[var(--background)]" : "")
        }
        style={{ backgroundColor: color }}
      >
        {letter}
      </div>
    </div>
  );
}

function WandTile() {
  return (
    <button className="flex h-10 w-10 items-center justify-center rounded-lg text-[var(--muted)] hover:bg-[var(--panel-2)]">
      <WandSparkles className="h-4 w-4" />
    </button>
  );
}

function NavIcon({ icon: Icon, active }: { icon: typeof MessageSquare; active?: boolean }) {
  return (
    <button
      className={
        "flex h-9 w-9 items-center justify-center rounded-md " +
        (active
          ? "bg-[var(--accent)]/15 text-[var(--accent)]"
          : "text-[var(--muted)] hover:bg-[var(--panel-2)]")
      }
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}

function SystemIcon({ icon: Icon }: { icon: typeof MessageSquare }) {
  return (
    <button className="flex h-9 w-9 items-center justify-center rounded-md text-[var(--muted)] hover:bg-[var(--panel-2)]">
      <Icon className="h-4 w-4" />
    </button>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-[var(--border)] bg-[var(--panel)] p-2.5">
      <div className="mb-1.5 flex items-center justify-between text-[10px] font-medium uppercase tracking-wide text-[var(--muted)]">
        <span>▾ {title}</span>
      </div>
      {children}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-[var(--border)] bg-[var(--panel-2)] py-1">
      <div className="text-[9px] uppercase tracking-wide text-[var(--muted)]">{label}</div>
      <div className="font-mono text-[11px] text-[var(--foreground)]">{value}</div>
    </div>
  );
}
