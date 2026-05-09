"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Bot, FilePlus, RefreshCw, Save, Trash2 } from "lucide-react";
import { SideNav } from "@/components/nav/SideNav";
import { ScopeToggle, type Scope as IaScope } from "@/components/nav/ScopeToggle";
import { useActiveCwd } from "@/lib/client/useActiveCwd";
import type { AgentFile, AgentScope } from "@/lib/server/agents";
import { cn } from "@/lib/utils/cn";

const SCOPE_LABELS: Record<AgentScope, string> = {
  user: "User (~/.claude/agents)",
  project: "Project (.claude/agents)",
};

const TEMPLATE = `---
name: my-agent
description: One-line description of when to use this agent
tools: [Read, Grep, Glob, Bash]
model: claude-opus-4-7
---

You are a focused subagent. Describe how it should behave here.
`;

export default function AgentsPage() {
  const cwd = useActiveCwd();
  const [scopes, setScopes] = useState<{ scope: AgentScope; files: AgentFile[] }[]>([]);
  const [active, setActive] = useState<{ scope: AgentScope; name: string } | null>(null);
  const [draft, setDraft] = useState<string>("");
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [iaScope, setIaScope] = useState<IaScope>("workspace");

  const refresh = useCallback(async () => {
    if (cwd == null) return;
    setLoading(true);
    setError(null);
    try {
      const qs = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
      const res = await fetch(`/api/agents${qs}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = (await res.json()) as { scopes: { scope: AgentScope; files: AgentFile[] }[] };
      setScopes(d.scopes);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Reset selection / draft state on workspace switch — a stale selection
  // from a different cwd would either render a missing file or, worse,
  // pretend an unrelated workspace's agent belongs to this one.
  useEffect(() => {
    setActive(null);
    setDirty(false);
    setError(null);
  }, [cwd]);

  // When the active agent changes, populate the draft from the loaded file.
  useEffect(() => {
    if (!active) {
      setDraft("");
      setDirty(false);
      return;
    }
    const file = scopes
      .find((s) => s.scope === active.scope)
      ?.files.find((f) => f.name === active.name);
    setDraft(file?.raw ?? "");
    setDirty(false);
  }, [active, scopes]);

  const onSave = async () => {
    if (!active || !cwd) return;
    const res = await fetch("/api/agents", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: active.scope, cwd, name: active.name, raw: draft }),
    });
    if (res.ok) {
      setDirty(false);
      await refresh();
    } else {
      setError(`save failed: ${res.status}`);
    }
  };

  const onDelete = async (scope: AgentScope, name: string) => {
    if (!cwd) return;
    if (!confirm(`Delete agent "${name}" from ${SCOPE_LABELS[scope]}?`)) return;
    const params = new URLSearchParams({ scope, cwd });
    const res = await fetch(`/api/agents/${encodeURIComponent(name)}?${params}`, {
      method: "DELETE",
    });
    if (res.ok) {
      if (active && active.scope === scope && active.name === name) setActive(null);
      await refresh();
    }
  };

  const onCreate = async (scope: AgentScope) => {
    const name = prompt("New agent name (filename, no extension):", "my-agent");
    if (!name || !cwd) return;
    if (!/^[\w.\-]+$/.test(name)) {
      alert("Name must be alphanumeric, dots, dashes, underscores.");
      return;
    }
    const res = await fetch("/api/agents", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope,
        cwd,
        name,
        raw: TEMPLATE.replace("name: my-agent", `name: ${name}`),
      }),
    });
    if (res.ok) {
      await refresh();
      setActive({ scope, name });
    }
  };

  // IA filter: "workspace" → project agents only; "account" → user agents only.
  const visibleScopes = useMemo(
    () => scopes.filter((s) => (iaScope === "account" ? s.scope === "user" : s.scope === "project")),
    [scopes, iaScope],
  );
  const totalFiles = useMemo(() => visibleScopes.reduce((n, s) => n + s.files.length, 0), [visibleScopes]);

  return (
    <div className="flex h-full">
      <SideNav running={false} />
      <main data-pane-name="agents-main" className="flex h-full flex-1 flex-col overflow-hidden">
        <header className="flex h-9 shrink-0 items-center gap-3 border-b border-[var(--border)] bg-[var(--panel)] px-4 text-xs">
          <Link href="/" className="flex items-center gap-1 text-[var(--muted)] hover:text-[var(--foreground)]">
            <ArrowLeft className="h-3.5 w-3.5" /> Chat
          </Link>
          <span className="opacity-50">·</span>
          <Bot className="h-3.5 w-3.5 text-[var(--muted)]" />
          <span className="font-medium">Agents</span>
          <ScopeToggle value={iaScope} onChange={setIaScope} />
          <span className="text-[var(--muted)]">({totalFiles})</span>
          {loading && <span className="text-[var(--muted)]">loading…</span>}
          {error && <span className="text-red-400">{error}</span>}
          <button
            onClick={refresh}
            className="ml-auto flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-0.5 hover:bg-[var(--panel)]"
          >
            <RefreshCw className="h-3 w-3" /> Refresh
          </button>
        </header>

        <div className="flex flex-1 overflow-hidden">
          <aside className="flex w-72 shrink-0 flex-col border-r border-[var(--border)] bg-[var(--panel)]/60">
            {visibleScopes.map(({ scope, files }) => (
              <div key={scope} className="border-b border-[var(--border)]">
                <div className="flex items-center gap-2 px-3 py-2 text-xs">
                  <span className="font-medium">{SCOPE_LABELS[scope]}</span>
                  <span className="text-[var(--muted)]">({files.length})</span>
                  <button
                    onClick={() => onCreate(scope)}
                    title="New agent"
                    className="ml-auto rounded p-0.5 text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)]"
                  >
                    <FilePlus className="h-3.5 w-3.5" />
                  </button>
                </div>
                <ul>
                  {files.length === 0 ? (
                    <li className="px-3 py-2 text-[11px] italic text-[var(--muted)]">No agents yet.</li>
                  ) : (
                    files.map((f) => {
                      const isActive = active?.scope === f.scope && active?.name === f.name;
                      const fm = f.frontmatter as { description?: string; tools?: string[]; model?: string };
                      return (
                        <li key={f.name}>
                          <button
                            onClick={() => setActive({ scope: f.scope, name: f.name })}
                            className={cn(
                              "block w-full px-3 py-2 text-left",
                              "hover:bg-[var(--panel-2)]",
                              isActive && "bg-[var(--panel-2)]",
                            )}
                          >
                            <div className="flex items-baseline justify-between">
                              <span className="font-mono text-xs">{f.name}</span>
                              {fm.model && (
                                <span className="font-mono text-[10px] text-[var(--muted)]">{fm.model}</span>
                              )}
                            </div>
                            {fm.description && (
                              <div className="mt-0.5 line-clamp-2 text-[10px] text-[var(--muted)]">
                                {fm.description}
                              </div>
                            )}
                            {Array.isArray(fm.tools) && fm.tools.length > 0 && (
                              <div className="mt-0.5 flex flex-wrap gap-1">
                                {fm.tools.slice(0, 5).map((t) => (
                                  <span
                                    key={t}
                                    className="rounded-md bg-[var(--panel)]/60 px-1 py-0.5 font-mono text-[9px] text-[var(--muted)]"
                                  >
                                    {t}
                                  </span>
                                ))}
                                {fm.tools.length > 5 && (
                                  <span className="text-[9px] text-[var(--muted)]">
                                    +{fm.tools.length - 5}
                                  </span>
                                )}
                              </div>
                            )}
                          </button>
                        </li>
                      );
                    })
                  )}
                </ul>
              </div>
            ))}
          </aside>

          <div className="flex flex-1 flex-col">
            {active ? (
              <>
                <div className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--panel)]/40 px-3 py-2">
                  <span className="text-xs font-medium">{active.name}</span>
                  <span className="text-[10px] text-[var(--muted)]">{SCOPE_LABELS[active.scope]}</span>
                  <button
                    onClick={() => onDelete(active.scope, active.name)}
                    title="Delete agent"
                    className="ml-auto flex items-center gap-1 rounded-md border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-[11px] text-red-300 hover:bg-red-500/20"
                  >
                    <Trash2 className="h-3 w-3" /> Delete
                  </button>
                  <button
                    onClick={onSave}
                    disabled={!dirty}
                    className="flex items-center gap-1 rounded-md bg-[var(--accent)] px-2 py-0.5 text-[11px] text-white hover:opacity-90 disabled:opacity-40"
                  >
                    <Save className="h-3 w-3" /> Save
                  </button>
                </div>
                <textarea
                  value={draft}
                  onChange={(e) => {
                    setDraft(e.target.value);
                    setDirty(true);
                  }}
                  spellCheck={false}
                  className="flex-1 resize-none bg-[var(--background)] p-4 font-mono text-xs leading-5 focus:outline-none scroll-thin"
                />
              </>
            ) : (
              <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-[var(--muted)]">
                Pick an agent on the left, or create a new one.
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
