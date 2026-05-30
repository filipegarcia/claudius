"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Bot, ChevronDown, ChevronRight, FilePlus, RefreshCw, Save, Search, Trash2, X } from "lucide-react";
import { SideNav } from "@/components/nav/SideNav";
import { ScopeToggle, type Scope as IaScope } from "@/components/nav/ScopeToggle";
import { useActiveCwd } from "@/lib/client/useActiveCwd";
import { hasIsolationWorktree, setIsolationWorktree } from "@/lib/client/agent-frontmatter";
import type { AgentFile, AgentScope } from "@/lib/server/agents";
import { cn } from "@/lib/utils/cn";

const SCOPE_LABELS: Record<AgentScope, string> = {
  user: "User (~/.claude/agents)",
  project: "Project (.claude/agents)",
};

/**
 * Minimal mirror of the SDK's `AgentInfo`. Kept local rather than imported
 * so this client page doesn't pull a type from the server-only SDK surface.
 * This is the *live* list the SDK reports via `supportedAgents()` — file-based
 * agents, plugin-injected agents, and the built-in general-purpose / Explore
 * agents — which is a superset of the `.claude/agents/*.md` files this editor
 * manages.
 */
type LoadedAgent = {
  name: string;
  description?: string;
  model?: string;
};

const TEMPLATE = `---
name: my-agent
description: One-line description of when to use this agent
tools: [Read, Grep, Glob, Bash]
model: claude-opus-4-7
# Optional advanced fields (uncomment as needed):
# effort: high                 # low | medium | high | xhigh | max
# maxTurns: 20                 # cap agentic round-trips before stopping
# background: false            # run as a non-blocking background task when invoked
# memory: project              # user | project | local — auto-load agent memory
# isolation: worktree         # run the agent in a temporary git worktree (isolated copy of the repo)
# permissionMode: default      # default | acceptEdits | bypassPermissions | plan | dontAsk
# skills: [pdf, docx]          # preload these skills into the agent's context
# disallowedTools: [Bash]      # explicitly remove tools from the inherited set
# mcpServers:                  # object form (or a flat list of server names)
#   my-server:
#     command: node
#     args: [./server.js]
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
  // Search — Chrome/Firefox-style filter over the agent list by name/description/tools/model.
  const [query, setQuery] = useState("");

  // Live SDK-loaded agents for the active session (file + plugin + built-in).
  // `sessionId` is discovered from the in-memory session list by matching the
  // workspace cwd — the same approach the /mcp page uses — because this page
  // is cwd-scoped while the SDK call is session-scoped.
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [loadedAgents, setLoadedAgents] = useState<LoadedAgent[] | null>(null);
  const [loadedError, setLoadedError] = useState<string | null>(null);
  const [showLoaded, setShowLoaded] = useState(false);

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
    // Fetch on mount and whenever cwd changes (refresh is memoized on it).
    // Standard React data-fetching pattern; the setState calls inside refresh
    // are the data load itself, not an effect chain. Without this the page
    // stays stuck on its initial `loading = true` forever.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  // Discover the live session for this workspace and fetch the SDK's loaded
  // agent list. Two-step (sessions → agents) because the page is cwd-scoped
  // but `supportedAgents()` is session-scoped — same approach as the /mcp
  // page. A network fetch can't live in the render-phase reset pattern used
  // above, so this is a deliberate effect. Re-runs on cwd change.
  useEffect(() => {
    if (cwd == null) return;
    let cancelled = false;
    (async () => {
      try {
        const sres = await fetch("/api/sessions");
        const arr = (await sres.json()) as Array<{ id?: string; cwd?: string }>;
        const match = Array.isArray(arr) ? arr.find((s) => s.cwd === cwd) : undefined;
        const sid = match?.id ?? null;
        if (cancelled) return;
        setSessionId(sid);
        if (!sid) return; // no live session → banner shows the "start a chat" hint
        const ares = await fetch(`/api/sessions/${encodeURIComponent(sid)}/agents`);
        if (!ares.ok) {
          const body = (await ares.json().catch(() => ({}))) as { error?: string };
          if (!cancelled) setLoadedError(body.error ?? `HTTP ${ares.status}`);
          return;
        }
        const d = (await ares.json()) as { agents?: LoadedAgent[] };
        if (!cancelled) setLoadedAgents(Array.isArray(d.agents) ? d.agents : []);
      } catch (err) {
        if (!cancelled) setLoadedError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  // Reset selection / draft state on workspace switch — a stale selection
  // from a different cwd would either render a missing file or, worse,
  // pretend an unrelated workspace's agent belongs to this one. Reset
  // happens during render via the "store previous props" pattern; React
  // 19 prefers this over the prior `useEffect([cwd])` form.
  // https://react.dev/reference/react/useState#storing-information-from-previous-renders
  const [lastCwd, setLastCwd] = useState(cwd);
  if (lastCwd !== cwd) {
    setLastCwd(cwd);
    setActive(null);
    setDirty(false);
    setError(null);
    // Clear the previous workspace's loaded-agents view here (render phase)
    // rather than synchronously inside the fetch effect — the effect then
    // only performs the network read, avoiding cascading-render warnings.
    setLoadedAgents(null);
    setLoadedError(null);
    setSessionId(null);
    setShowLoaded(false);
  }

  // When the active agent changes, populate the draft from the loaded file.
  // Same "store previous props" pattern — the dependency is the (active,
  // scopes) pair, encoded as a stable signature so an array-identity
  // change in `scopes` (which happens after every refresh) doesn't
  // gratuitously wipe `draft`.
  const draftKey = active ? `${active.scope}:${active.name}` : "";
  const [lastDraftKey, setLastDraftKey] = useState(draftKey);
  if (lastDraftKey !== draftKey) {
    setLastDraftKey(draftKey);
    if (!active) {
      setDraft("");
      setDirty(false);
    } else {
      const file = scopes
        .find((s) => s.scope === active.scope)
        ?.files.find((f) => f.name === active.name);
      setDraft(file?.raw ?? "");
      setDirty(false);
    }
  }

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

  const q = query.trim().toLowerCase();

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
          <div className="flex-1 px-3">
            <div className="relative mx-auto max-w-md">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--muted)]" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search agents"
                aria-label="Search agents"
                className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] py-1 pl-8 pr-7 text-xs focus:outline-none"
              />
              {query && (
                <button
                  onClick={() => setQuery("")}
                  title="Clear search"
                  aria-label="Clear search"
                  className="absolute right-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-[var(--muted)] hover:text-[var(--foreground)]"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          </div>
          <button
            onClick={refresh}
            className="flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-0.5 hover:bg-[var(--panel)]"
          >
            <RefreshCw className="h-3 w-3" /> Refresh
          </button>
        </header>

        {/* Loaded-agents banner: the SDK's live view (file + plugin + built-in),
            distinct from the .claude/agents/*.md files edited below. */}
        <div className="shrink-0 border-b border-[var(--border)] bg-[var(--panel)]/40 px-4 py-1.5 text-[11px]">
          {sessionId == null ? (
            <span className="text-[var(--muted)]">
              Start a chat session in this workspace to see the agents the SDK has loaded.
            </span>
          ) : loadedError ? (
            <span className="text-amber-400">SDK agents unavailable: {loadedError}</span>
          ) : loadedAgents == null ? (
            <span className="text-[var(--muted)]">Loading SDK-reported agents…</span>
          ) : (
            <>
              <button
                onClick={() => setShowLoaded((v) => !v)}
                className="flex items-center gap-1 text-[var(--muted)] hover:text-[var(--foreground)]"
                aria-expanded={showLoaded}
              >
                {showLoaded ? (
                  <ChevronDown className="h-3 w-3" />
                ) : (
                  <ChevronRight className="h-3 w-3" />
                )}
                SDK reports {loadedAgents.length} agent{loadedAgents.length === 1 ? "" : "s"} loaded
                for this session
              </button>
              {showLoaded && (
                <ul className="mt-1.5 flex flex-col gap-1 pl-4">
                  {loadedAgents.length === 0 ? (
                    <li className="italic text-[var(--muted)]">None.</li>
                  ) : (
                    loadedAgents.map((a) => (
                      <li key={a.name} className="flex items-baseline gap-2">
                        <span className="font-mono text-[var(--foreground)]">{a.name}</span>
                        {a.model && (
                          <span className="font-mono text-[10px] text-[var(--muted)]">{a.model}</span>
                        )}
                        {a.description && (
                          <span className="truncate text-[10px] text-[var(--muted)]">
                            {a.description}
                          </span>
                        )}
                      </li>
                    ))
                  )}
                </ul>
              )}
            </>
          )}
        </div>

        <div className="flex flex-1 overflow-hidden">
          <aside className="flex w-72 shrink-0 flex-col border-r border-[var(--border)] bg-[var(--panel)]/60">
            {visibleScopes.map(({ scope, files }) => {
              const shown = q
                ? files.filter((f) => {
                    const fm = f.frontmatter as { description?: string; tools?: string[]; model?: string };
                    const tools = Array.isArray(fm.tools) ? fm.tools : [];
                    return `${f.name} ${fm.description ?? ""} ${fm.model ?? ""} ${tools.join(" ")}`
                      .toLowerCase()
                      .includes(q);
                  })
                : files;
              return (
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
                  {shown.length === 0 ? (
                    <li className="px-3 py-2 text-[11px] italic text-[var(--muted)]">
                      {q ? "No agents match." : "No agents yet."}
                    </li>
                  ) : (
                    shown.map((f) => {
                      const isActive = active?.scope === f.scope && active?.name === f.name;
                      const fm = f.frontmatter as {
                        description?: string;
                        tools?: string[];
                        model?: string;
                        effort?: string | number;
                        background?: boolean;
                        memory?: string;
                        maxTurns?: number;
                        permissionMode?: string;
                        skills?: string[];
                        mcpServers?: string[] | Record<string, unknown>;
                        isolation?: string;
                      };
                      // Compact badges for the advanced AgentDefinition fields
                      // so the list conveys an agent's shape at a glance.
                      const metaBadges: string[] = [];
                      if (fm.effort != null) metaBadges.push(`effort ${fm.effort}`);
                      if (fm.background === true) metaBadges.push("background");
                      if (fm.memory) metaBadges.push(`mem:${fm.memory}`);
                      if (fm.isolation === "worktree") metaBadges.push("worktree");
                      if (typeof fm.maxTurns === "number") metaBadges.push(`≤${fm.maxTurns} turns`);
                      if (fm.permissionMode) metaBadges.push(fm.permissionMode);
                      if (Array.isArray(fm.skills) && fm.skills.length > 0)
                        metaBadges.push(`${fm.skills.length} skill${fm.skills.length === 1 ? "" : "s"}`);
                      if (fm.mcpServers) {
                        const n = Array.isArray(fm.mcpServers)
                          ? fm.mcpServers.length
                          : Object.keys(fm.mcpServers).length;
                        if (n > 0) metaBadges.push(`${n} mcp`);
                      }
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
                            {metaBadges.length > 0 && (
                              <div className="mt-0.5 flex flex-wrap gap-1">
                                {metaBadges.map((b) => (
                                  <span
                                    key={b}
                                    className="rounded-md border border-[var(--border)] bg-[var(--panel-2)]/60 px-1 py-0.5 text-[9px] text-[var(--muted)]"
                                  >
                                    {b}
                                  </span>
                                ))}
                              </div>
                            )}
                          </button>
                        </li>
                      );
                    })
                  )}
                </ul>
              </div>
              );
            })}
          </aside>

          <div className="flex flex-1 flex-col">
            {active ? (
              <>
                <div className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--panel)]/40 px-3 py-2">
                  <span className="text-xs font-medium">{active.name}</span>
                  <span className="text-[10px] text-[var(--muted)]">{SCOPE_LABELS[active.scope]}</span>
                  <label
                    title="Run this agent in a temporary git worktree (isolation: worktree)"
                    className="ml-auto flex cursor-pointer items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-0.5 text-[11px] text-[var(--muted)] hover:text-[var(--foreground)]"
                  >
                    <input
                      type="checkbox"
                      checked={hasIsolationWorktree(draft)}
                      onChange={(e) => {
                        setDraft(setIsolationWorktree(draft, e.target.checked));
                        setDirty(true);
                      }}
                      className="h-3 w-3 accent-[var(--accent)]"
                    />
                    Isolated worktree
                  </label>
                  <button
                    onClick={() => onDelete(active.scope, active.name)}
                    title="Delete agent"
                    className="flex items-center gap-1 rounded-md border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-[11px] text-red-300 hover:bg-red-500/20"
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
