"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, FilePlus, RefreshCw, Save, Search, Sparkles, Trash2, X } from "lucide-react";
import { SideNav } from "@/components/nav/SideNav";
import { ScopeToggle, type Scope as IaScope } from "@/components/nav/ScopeToggle";
import { useActiveCwd } from "@/lib/client/useActiveCwd";
import type { SkillFile, SkillScope } from "@/lib/server/skills";
import { cn } from "@/lib/utils/cn";

const SCOPE_LABELS: Record<SkillScope, string> = {
  user: "User (~/.claude/skills)",
  project: "Project (.claude/skills)",
};

const TEMPLATE = `---
name: my-skill
description: One-line description of when this skill applies. Be specific — Claude reads this to decide when to invoke it.
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
---

# My skill

What this skill does, when to invoke it, and the steps to follow. Keep it
short and opinionated — long skill docs get skipped.
`;

/**
 * Browse, edit, create, and delete skills loaded into the current
 * workspace. Storage shape: \`<scope>/<name>/SKILL.md\` with YAML
 * frontmatter (name, description, allowed-tools) and a markdown body.
 */
export default function SkillsPage() {
  const cwd = useActiveCwd();
  const [scopes, setScopes] = useState<{ scope: SkillScope; files: SkillFile[] }[]>([]);
  const [active, setActive] = useState<{ scope: SkillScope; name: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [iaScope, setIaScope] = useState<IaScope>("workspace");
  // Search — Chrome/Firefox-style filter over the skill list by name/description/tools.
  const [query, setQuery] = useState("");

  useEffect(() => {
    // Drop the active selection on workspace switch so a stale skill from
    // a different project doesn't appear to belong to this one. This is
    // the canonical "external state changed → reset local UI state" use
    // of useEffect; the rule's preferred alternatives don't fit.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActive(null);
    setError(null);
  }, [cwd]);

  const refresh = useCallback(async () => {
    if (cwd == null) return;
    setLoading(true);
    setError(null);
    try {
      const qs = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
      const res = await fetch(`/api/skills${qs}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = (await res.json()) as { scopes: { scope: SkillScope; files: SkillFile[] }[] };
      setScopes(d.scopes);
      // Auto-select the first skill in the visible scope so the right
      // pane isn't empty on page load. Done here (after fetch) rather
      // than in an effect, so we avoid the React rule against
      // setState-in-effect cascades.
      setActive((current) => {
        if (current) return current;
        for (const { scope, files } of d.scopes) {
          if (iaScope === "account" && scope !== "user") continue;
          if (iaScope === "workspace" && scope !== "project") continue;
          if (files.length > 0) return { scope, name: files[0].name };
        }
        return current;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [cwd, iaScope]);

  useEffect(() => {
    // Fetch on mount and whenever cwd / iaScope changes (refresh is
    // memoized on those). Standard React data-fetching pattern; the
    // setState calls inside refresh are the data load itself, not an
    // effect chain — Suspense / external store would be overkill here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const visibleScopes = useMemo(
    () => scopes.filter((s) => (iaScope === "account" ? s.scope === "user" : s.scope === "project")),
    [scopes, iaScope],
  );
  const totalFiles = useMemo(
    () => visibleScopes.reduce((n, s) => n + s.files.length, 0),
    [visibleScopes],
  );

  const onSave = async (scope: SkillScope, name: string, raw: string) => {
    if (!cwd) return false;
    setError(null);
    const res = await fetch("/api/skills", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope, cwd, name, raw }),
    });
    if (res.ok) {
      await refresh();
      return true;
    }
    const err = (await res.json().catch(() => null)) as { error?: string } | null;
    setError(`save failed: ${err?.error ?? res.status}`);
    return false;
  };

  const onDelete = async (scope: SkillScope, name: string) => {
    if (!cwd) return;
    if (!confirm(`Delete skill "${name}" and its directory from ${SCOPE_LABELS[scope]}?`)) return;
    const params = new URLSearchParams({ scope, cwd });
    const res = await fetch(`/api/skills/${encodeURIComponent(name)}?${params}`, {
      method: "DELETE",
    });
    if (res.ok) {
      if (active && active.scope === scope && active.name === name) setActive(null);
      await refresh();
    } else {
      const err = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(`delete failed: ${err?.error ?? res.status}`);
    }
  };

  const onCreate = async (scope: SkillScope) => {
    const name = prompt("New skill name (directory name, no spaces):", "my-skill");
    if (!name || !cwd) return;
    if (!/^[\w.\-]+$/.test(name)) {
      alert("Name must be alphanumeric, dots, dashes, underscores.");
      return;
    }
    const res = await fetch("/api/skills", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope,
        cwd,
        name,
        raw: TEMPLATE.replace("name: my-skill", `name: ${name}`),
      }),
    });
    if (res.ok) {
      await refresh();
      setActive({ scope, name });
    } else {
      const err = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(`create failed: ${err?.error ?? res.status}`);
    }
  };

  const activeFile = useMemo(() => {
    if (!active) return null;
    return scopes
      .find((s) => s.scope === active.scope)
      ?.files.find((f) => f.name === active.name) ?? null;
  }, [active, scopes]);

  const q = query.trim().toLowerCase();

  return (
    <div className="flex h-full">
      <SideNav running={false} />
      <main data-pane-name="skills-main" className="flex h-full flex-1 flex-col overflow-hidden">
        <header className="flex h-9 shrink-0 items-center gap-3 border-b border-[var(--border)] bg-[var(--panel)] px-4 text-xs">
          <Link href="/" className="flex items-center gap-1 text-[var(--muted)] hover:text-[var(--foreground)]">
            <ArrowLeft className="h-3.5 w-3.5" /> Chat
          </Link>
          <span className="opacity-50">·</span>
          <Sparkles className="h-3.5 w-3.5 text-[var(--muted)]" />
          <span className="font-medium">Skills</span>
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
                placeholder="Search skills"
                aria-label="Search skills"
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

        <div className="flex flex-1 overflow-hidden">
          <aside className="flex w-72 shrink-0 flex-col overflow-y-auto border-r border-[var(--border)] bg-[var(--panel)]/60 scroll-thin">
            {visibleScopes.map(({ scope, files }) => {
              const shown = q
                ? files.filter((f) => {
                    const fm = f.frontmatter as { description?: string; "allowed-tools"?: string[] };
                    const tools = Array.isArray(fm["allowed-tools"]) ? fm["allowed-tools"] : [];
                    return `${f.name} ${fm.description ?? ""} ${tools.join(" ")}`.toLowerCase().includes(q);
                  })
                : files;
              return (
              <div key={scope} className="border-b border-[var(--border)]">
                <div className="flex items-center gap-2 px-3 py-2 text-xs">
                  <span className="font-medium">{SCOPE_LABELS[scope]}</span>
                  <span className="text-[var(--muted)]">({files.length})</span>
                  <button
                    onClick={() => onCreate(scope)}
                    title="New skill"
                    className="ml-auto rounded p-0.5 text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)]"
                  >
                    <FilePlus className="h-3.5 w-3.5" />
                  </button>
                </div>
                <ul>
                  {shown.length === 0 ? (
                    <li className="px-3 py-2 text-[11px] italic text-[var(--muted)]">
                      {q ? "No skills match." : "No skills here."}
                    </li>
                  ) : (
                    shown.map((f) => {
                      const isActive = active?.scope === f.scope && active?.name === f.name;
                      const fm = f.frontmatter as {
                        description?: string;
                        "allowed-tools"?: string[];
                      };
                      const tools = Array.isArray(fm["allowed-tools"]) ? fm["allowed-tools"] : [];
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
                            <div className="font-mono text-xs">{f.name}</div>
                            {fm.description && (
                              <div className="mt-0.5 line-clamp-2 text-[10px] text-[var(--muted)]">
                                {fm.description}
                              </div>
                            )}
                            {tools.length > 0 && (
                              <div className="mt-1 flex flex-wrap gap-1">
                                {tools.slice(0, 5).map((t) => (
                                  <span
                                    key={t}
                                    className="rounded-md bg-[var(--panel)]/60 px-1 py-0.5 font-mono text-[9px] text-[var(--muted)]"
                                  >
                                    {t}
                                  </span>
                                ))}
                                {tools.length > 5 && (
                                  <span className="text-[9px] text-[var(--muted)]">+{tools.length - 5}</span>
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
              );
            })}
          </aside>

          <div className="flex flex-1 flex-col">
            {active && activeFile ? (
              <SkillEditor
                key={`${active.scope}/${active.name}`}
                file={activeFile}
                onSave={(raw) => onSave(active.scope, active.name, raw)}
                onDelete={() => onDelete(active.scope, active.name)}
              />
            ) : (
              <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-[var(--muted)]">
                Pick a skill on the left, or create a new one.
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

/**
 * Editor for a single skill. State is owned here, initialized from the
 * active file's raw content; the parent passes a fresh `key` whenever
 * the active skill changes, so this component remounts and the draft
 * resets cleanly. Avoids the "setState in effect" anti-pattern the
 * top-level page would otherwise need.
 */
function SkillEditor({
  file,
  onSave,
  onDelete,
}: {
  file: SkillFile;
  onSave: (raw: string) => Promise<boolean>;
  onDelete: () => Promise<void> | void;
}) {
  const [draft, setDraft] = useState(file.raw);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  return (
    <>
      <div className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--panel)]/40 px-3 py-2">
        <span className="text-xs font-medium">{file.name}</span>
        <span className="text-[10px] text-[var(--muted)]">{SCOPE_LABELS[file.scope]}</span>
        <span className="ml-2 truncate font-mono text-[10px] text-[var(--muted)]">{file.path}</span>
        <button
          onClick={() => void onDelete()}
          title="Delete skill"
          className="ml-auto flex items-center gap-1 rounded-md border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-[11px] text-red-300 hover:bg-red-500/20"
        >
          <Trash2 className="h-3 w-3" /> Delete
        </button>
        <button
          onClick={async () => {
            setSaving(true);
            const ok = await onSave(draft);
            setSaving(false);
            if (ok) setDirty(false);
          }}
          disabled={!dirty || saving}
          className="flex items-center gap-1 rounded-md bg-[var(--accent)] px-2 py-0.5 text-[11px] text-white hover:opacity-90 disabled:opacity-40"
        >
          <Save className="h-3 w-3" /> {saving ? "Saving…" : "Save"}
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
  );
}
