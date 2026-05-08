"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Briefcase, Save } from "lucide-react";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { SideNav } from "@/components/nav/SideNav";
import {
  PERMISSION_MODE_META,
  PERMISSION_MODE_ORDER,
} from "@/components/chat/ModeSelector";
import { useWorkspaces } from "@/lib/client/useWorkspaces";
import { cn } from "@/lib/utils/cn";

type ModeChoice = "" | PermissionMode;

export default function WorkspacePage() {
  const { items, activeId, update } = useWorkspaces();
  const active = useMemo(() => items.find((w) => w.id === activeId) ?? null, [items, activeId]);

  const [model, setModel] = useState("");
  const [mode, setMode] = useState<ModeChoice>("");
  const [saving, setSaving] = useState(false);
  const [savedTick, setSavedTick] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Hydrate inputs from server state.
  useEffect(() => {
    if (!active) return;
    setModel(active.defaults?.model ?? "");
    setMode(active.defaults?.permissionMode ?? "");
  }, [active]);

  async function onSave() {
    if (!active) return;
    setSaving(true);
    setError(null);
    try {
      const defaults = { ...(active.defaults ?? {}) };
      if (model.trim()) defaults.model = model.trim();
      else delete defaults.model;
      if (mode) defaults.permissionMode = mode;
      else delete defaults.permissionMode;
      const ok = await update(active.id, { defaults });
      if (ok) setSavedTick((t) => t + 1);
      else setError("Save failed");
    } finally {
      setSaving(false);
    }
  }

  const dirty =
    !!active &&
    ((model.trim() || "") !== (active.defaults?.model ?? "") ||
      (mode || "") !== (active.defaults?.permissionMode ?? ""));

  return (
    <div className="flex h-full">
      <SideNav running={false} />
      <main className="flex h-full flex-1 flex-col overflow-hidden">
        <header className="flex h-9 shrink-0 items-center gap-3 border-b border-[var(--border)] bg-[var(--panel)] px-4 text-xs">
          <Link href="/" className="flex items-center gap-1 text-[var(--muted)] hover:text-[var(--foreground)]">
            <ArrowLeft className="h-3.5 w-3.5" /> Chat
          </Link>
          <span className="opacity-50">·</span>
          <Briefcase className="h-3.5 w-3.5 text-[var(--muted)]" />
          <span className="font-medium">Workspace</span>
          {active && (
            <span className="ml-2 truncate font-mono text-[var(--muted)]">{active.name}</span>
          )}
        </header>

        <div className="flex-1 overflow-y-auto scroll-thin">
          {!active ? (
            <div className="mx-auto max-w-2xl px-6 py-12 text-center text-sm text-[var(--muted)]">
              No active workspace.
            </div>
          ) : (
            <div className="mx-auto max-w-2xl space-y-5 px-6 py-6">
              {/* Identity (read-only) */}
              <section className="rounded-lg border border-[var(--border)] bg-[var(--panel)]/40 p-4">
                <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-[var(--muted)]">
                  Identity
                </h2>
                <dl className="grid grid-cols-[110px_1fr] gap-y-1 text-sm">
                  <dt className="text-[var(--muted)]">Name</dt>
                  <dd>{active.name}</dd>
                  <dt className="text-[var(--muted)]">Root</dt>
                  <dd className="truncate font-mono text-xs" title={active.rootPath}>
                    {active.rootPath}
                  </dd>
                </dl>
                <p className="mt-2 text-[10px] text-[var(--muted)]">
                  Edit name, root, or icon by right-clicking the workspace tile in the left rail.
                </p>
              </section>

              {/* Defaults */}
              <section>
                <header className="mb-3">
                  <h2 className="text-base font-semibold">Defaults for new chats</h2>
                  <p className="mt-1 text-[11px] text-[var(--muted)]">
                    These apply to new sessions started in this workspace. Existing sessions are
                    unaffected. An explicit per-session override (model switcher, mode dropdown) still wins.
                  </p>
                </header>

                <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)]/40 p-4">
                  <label className="block">
                    <div className="mb-1 text-[11px] font-medium">Model</div>
                    <input
                      value={model}
                      onChange={(e) => setModel(e.target.value)}
                      placeholder="(inherit machine default)"
                      className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 font-mono text-xs focus:outline-none"
                    />
                    <div className="mt-1 text-[10px] text-[var(--muted)]">
                      Examples: <code className="font-mono">claude-opus-4-7</code>,{" "}
                      <code className="font-mono">claude-sonnet-4-6</code>,{" "}
                      <code className="font-mono">claude-haiku-4-5-20251001</code>
                    </div>
                  </label>

                  <div className="mt-4">
                    <div className="mb-2 text-[11px] font-medium">Permission mode</div>
                    <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                      <ModeRadio
                        value=""
                        currentValue={mode}
                        onSelect={() => setMode("")}
                        label="Inherit (default)"
                        description="Use the machine-level setting."
                      />
                      {PERMISSION_MODE_ORDER.map((m) => {
                        const meta = PERMISSION_MODE_META[m];
                        const Icon = meta.icon;
                        return (
                          <ModeRadio
                            key={m}
                            value={m}
                            currentValue={mode}
                            onSelect={() => setMode(m)}
                            label={
                              <span className="flex items-center gap-1.5">
                                <Icon className={cn("h-3.5 w-3.5", meta.tone)} />
                                {meta.label}
                              </span>
                            }
                            description={meta.description}
                          />
                        );
                      })}
                    </div>
                  </div>

                  <div className="mt-5 flex items-center justify-end gap-2">
                    {savedTick > 0 && !dirty && (
                      <span className="text-[11px] text-emerald-400">Saved.</span>
                    )}
                    {error && (
                      <span className="text-[11px] text-red-300">{error}</span>
                    )}
                    <button
                      onClick={onSave}
                      disabled={!dirty || saving}
                      className="flex items-center gap-1 rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs text-white hover:opacity-90 disabled:opacity-40"
                    >
                      <Save className="h-3 w-3" /> {saving ? "Saving…" : "Save defaults"}
                    </button>
                  </div>
                </div>

                <p className="mt-2 text-[10px] text-[var(--muted)]">
                  Other defaults — MCP servers, auto-memory, additional directories — round-trip in
                  the workspace JSON but are not yet applied at session-creation time.
                </p>
              </section>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

function ModeRadio({
  value,
  currentValue,
  onSelect,
  label,
  description,
}: {
  value: ModeChoice;
  currentValue: ModeChoice;
  onSelect: () => void;
  label: React.ReactNode;
  description: string;
}) {
  const active = currentValue === value;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onSelect}
      className={cn(
        "rounded-md border px-3 py-2 text-left transition",
        active
          ? "border-[var(--accent)] bg-[var(--accent)]/5"
          : "border-[var(--border)] bg-[var(--panel-2)]/40 hover:bg-[var(--panel-2)]",
      )}
    >
      <div className="flex items-center justify-between gap-2 text-xs font-medium">
        <span>{label}</span>
        {active && <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />}
      </div>
      <div className="mt-0.5 text-[10px] text-[var(--muted)]">{description}</div>
    </button>
  );
}
