"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, BookText, FileText, Plus, Save, X } from "lucide-react";
import { SideNav } from "@/components/nav/SideNav";
import { ScopeToggle, type Scope as IaScope } from "@/components/nav/ScopeToggle";
import { useActiveCwd } from "@/lib/client/useActiveCwd";
import { useClaudeMd, type Scope } from "@/lib/client/useClaudeMd";
import { useAutoMemory } from "@/lib/client/useAutoMemory";
import { cn } from "@/lib/utils/cn";

const SCOPE_META: Record<Scope, { label: string; hint: string }> = {
  user: { label: "User", hint: "~/.claude/CLAUDE.md" },
  project: { label: "Project", hint: "<cwd>/CLAUDE.md" },
  "project-claude": { label: "Project (.claude)", hint: "<cwd>/.claude/CLAUDE.md" },
  local: { label: "Local", hint: "<cwd>/CLAUDE.local.md (gitignored)" },
};

const SCOPE_ORDER: Scope[] = ["user", "project", "project-claude", "local"];

export default function MemoryPage() {
  const cwd = useActiveCwd();
  const [iaScope, setIaScope] = useState<IaScope>("workspace");

  return (
    <div className="flex h-full">
      <SideNav running={false} />
      <main data-pane-name="memory-main" className="flex h-full flex-1 flex-col overflow-hidden">
        <header className="flex h-9 shrink-0 items-center gap-3 border-b border-[var(--border)] bg-[var(--panel)] px-4 text-xs">
          <Link href="/" className="flex items-center gap-1 text-[var(--muted)] hover:text-[var(--foreground)]">
            <ArrowLeft className="h-3.5 w-3.5" /> Chat
          </Link>
          <span className="opacity-50">·</span>
          <BookText className="h-3.5 w-3.5 text-[var(--muted)]" />
          <span className="font-medium">Memory</span>
          <ScopeToggle value={iaScope} onChange={setIaScope} />
          {cwd && <span className="ml-2 truncate font-mono text-[var(--muted)]">{cwd}</span>}
        </header>
        <div className="flex flex-1 overflow-hidden">
          <ClaudeMdSection key={iaScope} cwd={cwd} iaScope={iaScope} />
          <AutoMemorySection cwd={cwd} iaScope={iaScope} />
        </div>
      </main>
    </div>
  );
}

function ClaudeMdSection({ cwd, iaScope }: { cwd: string | null; iaScope: IaScope }) {
  const { scopes, resolved, loading, error, save } = useClaudeMd(cwd);
  // IA filter: "account" → only the user CLAUDE.md; "workspace" → project / project-claude / local.
  const visibleScopes: Scope[] =
    iaScope === "account" ? ["user"] : ["project", "project-claude", "local"];
  const [active, setActive] = useState<Scope>(iaScope === "account" ? "user" : "project");
  const [draft, setDraft] = useState<string>("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showResolved, setShowResolved] = useState(false);

  useEffect(() => {
    const s = scopes.find((s) => s.scope === active);
    setDraft(s?.content ?? "");
    setDirty(false);
  }, [active, scopes]);

  const onSave = async () => {
    setSaving(true);
    try {
      await save(active, draft);
      setDirty(false);
    } finally {
      setSaving(false);
    }
  };

  const totalChars = resolved?.totalChars ?? 0;

  return (
    <section className="flex min-w-0 flex-1 flex-col border-r border-[var(--border)]">
      <div className="flex items-center gap-1 border-b border-[var(--border)] bg-[var(--panel)]/40 px-3 py-2">
        {SCOPE_ORDER.filter((s) => visibleScopes.includes(s)).map((s) => {
          const f = scopes.find((x) => x.scope === s);
          return (
            <button
              key={s}
              onClick={() => setActive(s)}
              className={cn(
                "rounded-md border border-transparent px-2 py-1 text-xs",
                active === s
                  ? "border-[var(--border)] bg-[var(--panel-2)]"
                  : "text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)]",
              )}
              title={SCOPE_META[s].hint}
            >
              {SCOPE_META[s].label}
              <span
                className={cn(
                  "ml-1 inline-block h-1.5 w-1.5 rounded-full",
                  f?.exists ? "bg-emerald-400" : "bg-[var(--muted)]/40",
                )}
              />
            </button>
          );
        })}
        <span className="ml-auto flex items-center gap-2">
          <button
            onClick={() => setShowResolved((s) => !s)}
            className={cn(
              "rounded-md border border-[var(--border)] px-2 py-1 text-xs",
              showResolved ? "bg-[var(--panel)]" : "bg-[var(--panel-2)] hover:bg-[var(--panel)]",
            )}
          >
            {showResolved ? "Editor" : `Resolved (${totalChars.toLocaleString()} chars)`}
          </button>
          <button
            onClick={onSave}
            disabled={!dirty || saving}
            className="flex items-center gap-1 rounded-md bg-[var(--accent)] px-2 py-1 text-xs text-white hover:opacity-90 disabled:opacity-40"
          >
            <Save className="h-3 w-3" />
            {saving ? "Saving…" : "Save"}
          </button>
        </span>
      </div>
      <div className="border-b border-[var(--border)] bg-[var(--panel-2)]/30 px-3 py-1 font-mono text-[11px] text-[var(--muted)]">
        {scopes.find((s) => s.scope === active)?.path ?? "—"}
      </div>
      {error && (
        <div className="border-b border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</div>
      )}
      {loading ? (
        <div className="flex flex-1 items-center justify-center text-sm text-[var(--muted)]">Loading…</div>
      ) : showResolved ? (
        <ResolvedView resolved={resolved} />
      ) : (
        <textarea
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setDirty(true);
          }}
          spellCheck={false}
          placeholder="(empty — start typing to create the file)"
          className="flex-1 resize-none bg-[var(--background)] p-4 font-mono text-xs leading-5 focus:outline-none scroll-thin"
        />
      )}
    </section>
  );
}

function ResolvedView({ resolved }: { resolved: ReturnType<typeof useClaudeMd>["resolved"] }) {
  if (!resolved) return null;
  return (
    <div className="flex-1 overflow-y-auto scroll-thin">
      {resolved.scopes.map((s) => (
        <div key={s.scope} className="border-b border-[var(--border)]">
          <div className="flex items-center justify-between bg-[var(--panel-2)]/40 px-3 py-1.5 text-[11px]">
            <span className="font-medium">{SCOPE_META[s.scope].label}</span>
            <span className="font-mono text-[var(--muted)]">{s.path}</span>
          </div>
          {!s.exists ? (
            <div className="px-3 py-2 text-[11px] italic text-[var(--muted)]">(file does not exist)</div>
          ) : s.segments.length === 0 ? (
            <div className="px-3 py-2 text-[11px] italic text-[var(--muted)]">(empty)</div>
          ) : (
            s.segments.map((seg, i) => (
              <div key={i} className="border-t border-[var(--border)]/50">
                {seg.source !== "(inline)" && (
                  <div className="bg-[var(--panel)]/40 px-3 py-1 font-mono text-[10px] text-[var(--muted)]">
                    {seg.source} {seg.depth > 0 && <span className="opacity-60">depth {seg.depth}</span>}
                  </div>
                )}
                <pre className="overflow-x-auto px-3 py-2 font-mono text-[11px] leading-5 whitespace-pre-wrap scroll-thin">
                  {seg.content}
                </pre>
              </div>
            ))
          )}
        </div>
      ))}
    </div>
  );
}

function AutoMemorySection({ cwd, iaScope }: { cwd: string | null; iaScope: IaScope }) {
  const { dir, files, loading, error, readFile, createMemory, updateMemory, deleteMemory } = useAutoMemory(cwd);
  const [active, setActive] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // Bumped after each save/refresh so the edit form re-reads the file.
  const [reloadKey, setReloadKey] = useState(0);

  // Callers must clear `content` before they bump `active`/`reloadKey` so the
  // form unmounts into Loading… until the new raw arrives. EditMemoryForm
  // initializes its state from `parsed` exactly once at mount; if it remounts
  // (its key includes active+reloadKey) while `content` still holds the
  // *previous* file's raw — and that raw doesn't parse, e.g. MEMORY.md has
  // no frontmatter — useState locks to defaults. The raw prop then updates,
  // `parsed.name` refreshes via inline recompute, but `type`/`description`/
  // `body` stay stuck. Same race on save (reloadKey++ remounts the form
  // against pre-save content). Click handlers, onDelete, and onSave below all
  // clear content before triggering this effect.
  useEffect(() => {
    if (!active) return;
    void readFile(active).then(setContent);
  }, [active, readFile, reloadKey]);

  // Auto-memory lives under ~/.claude/projects/<encoded-cwd>/ (workspace scope).
  // The "account" IA scope has no auto-memory equivalent today.
  if (iaScope === "account") {
    return (
      <section className="flex w-[44%] min-w-[360px] shrink-0 flex-col items-center justify-center px-6 text-center text-[11px] text-[var(--muted)]">
        Auto-memory is per-workspace. Switch the scope to <span className="font-medium">Workspace</span> to view it.
      </section>
    );
  }

  return (
    <section className="flex w-[44%] min-w-[360px] shrink-0 flex-col">
      <div className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--panel)]/40 px-3 py-2 text-xs">
        <FileText className="h-3.5 w-3.5 text-[var(--muted)]" />
        <span className="font-medium">Auto-memory</span>
        <span className="text-[var(--muted)]">({files.length})</span>
        {loading && <span className="text-[var(--muted)]">loading…</span>}
        {error && <span className="text-red-400">{error}</span>}
        <button
          onClick={() => setCreating((c) => !c)}
          title={creating ? "Cancel" : "Add memory"}
          className="ml-auto flex h-5 w-5 items-center justify-center rounded text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)]"
        >
          {creating ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
        </button>
      </div>
      <div className="border-b border-[var(--border)] bg-[var(--panel-2)]/30 px-3 py-1 font-mono text-[10px] text-[var(--muted)]">
        {dir ?? "—"}
      </div>
      {creating && (
        <CreateMemoryForm
          onCancel={() => setCreating(false)}
          onSubmit={async (input) => {
            const r = await createMemory(input);
            if (r.ok) {
              setCreating(false);
              // Clear before switching active so the new file's form mounts
              // with fresh raw — see the useEffect comment above.
              if (r.name !== active) setContent(null);
              setActive(r.name);
            }
            return r;
          }}
        />
      )}
      <div className="flex flex-1 overflow-hidden">
        <ul className="w-44 shrink-0 overflow-y-auto border-r border-[var(--border)] scroll-thin">
          {files.length === 0 ? (
            <li className="px-3 py-3 text-[11px] text-[var(--muted)]">No memory files.</li>
          ) : (
            files.map((f) => (
              <li key={f.name}>
                <button
                  onClick={() => {
                    if (f.name !== active) setContent(null);
                    setActive(f.name);
                  }}
                  className={cn(
                    "flex w-full items-baseline justify-between gap-2 px-3 py-1.5 text-left text-[11px]",
                    "hover:bg-[var(--panel-2)]",
                    active === f.name && "bg-[var(--panel-2)]",
                    f.name === "MEMORY.md" && "font-semibold",
                  )}
                >
                  <span className="truncate font-mono">{f.name}</span>
                  <span className="text-[10px] text-[var(--muted)]">{Math.round(f.size / 100) / 10}K</span>
                </button>
              </li>
            ))
          )}
        </ul>
        <div className="flex-1 overflow-y-auto scroll-thin">
          {!active ? (
            <div className="flex h-full items-center justify-center px-3 py-6 text-center text-[11px] text-[var(--muted)]">
              Pick a file to view.
            </div>
          ) : content === null ? (
            <div className="px-3 py-3 text-[11px] text-[var(--muted)]">Loading…</div>
          ) : active === "MEMORY.md" ? (
            <pre className="overflow-x-auto p-3 font-mono text-[11px] leading-5 whitespace-pre-wrap scroll-thin">
              {content}
            </pre>
          ) : (
            <EditMemoryForm
              key={`${active}:${reloadKey}`}
              filename={active}
              raw={content}
              onSave={async (input) => {
                const r = await updateMemory(active, input);
                if (r.ok) {
                  // Clear before bumping reloadKey: see the comment on the
                  // useEffect above. Otherwise the form remounts against
                  // pre-save raw and useState locks to old values.
                  setContent(null);
                  setReloadKey((k) => k + 1);
                }
                return r;
              }}
              onDelete={async () => {
                if (!confirm(`Delete ${active}? This cannot be undone.`)) return;
                const r = await deleteMemory(active);
                if (r.ok) {
                  setActive(null);
                  setContent(null);
                }
              }}
            />
          )}
        </div>
      </div>
    </section>
  );
}

type MemoryType = "user" | "feedback" | "project" | "reference";

function slugFromName(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || "memory";
}

const TYPE_HINTS: Record<MemoryType, string> = {
  user: "Information about the user — role, knowledge, preferences.",
  feedback: "Guidance about how to approach work. Use **Why:** + **How to apply:** lines.",
  project: "Project-specific facts, in-flight work, deadlines. Use **Why:** + **How to apply:** lines.",
  reference: "Pointer to where information lives in external systems.",
};

function CreateMemoryForm({
  onCancel,
  onSubmit,
}: {
  onCancel: () => void;
  onSubmit: (input: {
    filename: string;
    type: MemoryType;
    name: string;
    description: string;
    body: string;
  }) => Promise<{ ok: true; name: string } | { ok: false; status: number; error: string }>;
}) {
  const [type, setType] = useState<MemoryType>("user");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [filename, setFilename] = useState("");
  const [filenameDirty, setFilenameDirty] = useState(false);
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Auto-derive filename from name+type until user overrides.
  useEffect(() => {
    if (filenameDirty) return;
    const slug = slugFromName(name);
    setFilename(`${type}_${slug}.md`);
  }, [type, name, filenameDirty]);

  const validFilename = /^[\w.\-]+\.md$/.test(filename);
  const canSubmit = name.trim() && description.trim() && validFilename && !submitting;

  async function submit() {
    setError(null);
    setSubmitting(true);
    try {
      const r = await onSubmit({ filename, type, name: name.trim(), description: description.trim(), body });
      if (!r.ok) setError(`${r.status}: ${r.error}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (canSubmit) void submit();
      }}
      className="border-b border-[var(--border)] bg-[var(--panel)]/60 p-3"
    >
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="block">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--muted)]">Type</div>
          <select
            value={type}
            onChange={(e) => setType(e.target.value as MemoryType)}
            className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 text-xs focus:outline-none"
          >
            <option value="user">user</option>
            <option value="feedback">feedback</option>
            <option value="project">project</option>
            <option value="reference">reference</option>
          </select>
        </label>
        <label className="block">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--muted)]">Name</div>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="user_role"
            className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 text-xs focus:outline-none"
          />
        </label>
      </div>
      <label className="mt-2 block">
        <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--muted)]">Description</div>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="One-line description used in MEMORY.md"
          className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 text-xs focus:outline-none"
        />
      </label>
      <label className="mt-2 block">
        <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--muted)]">Filename</div>
        <input
          value={filename}
          onChange={(e) => {
            setFilenameDirty(true);
            setFilename(e.target.value);
          }}
          placeholder="user_role.md"
          className={cn(
            "w-full rounded-md border bg-[var(--panel-2)] px-2 py-1.5 font-mono text-xs focus:outline-none",
            validFilename ? "border-[var(--border)]" : "border-amber-500/50",
          )}
        />
      </label>
      <label className="mt-2 block">
        <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--muted)]">Body</div>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={5}
          placeholder={TYPE_HINTS[type]}
          className="w-full resize-y rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 font-mono text-[11px] leading-5 focus:outline-none scroll-thin"
        />
      </label>
      {error && (
        <div className="mt-2 rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1 text-[11px] text-red-300">
          {error}
        </div>
      )}
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-3 py-1.5 text-xs hover:bg-[var(--panel)]"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!canSubmit}
          className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs text-white hover:opacity-90 disabled:opacity-40"
        >
          {submitting ? "Creating…" : "Create"}
        </button>
      </div>
    </form>
  );
}

function parseFrontmatter(raw: string): { name: string; description: string; type: MemoryType; body: string } | null {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?\n?([\s\S]*)$/);
  if (!m) return null;
  const fm = m[1];
  const get = (k: string) => fm.match(new RegExp(`^${k}:\\s*(.*)$`, "m"))?.[1].trim() ?? "";
  const name = get("name");
  if (!name) return null;
  const t = get("type") || "user";
  const type = (["user", "feedback", "project", "reference"] as const).includes(t as MemoryType)
    ? (t as MemoryType)
    : "user";
  return { name, description: get("description"), type, body: m[2] };
}

function EditMemoryForm({
  filename,
  raw,
  onSave,
  onDelete,
}: {
  filename: string;
  raw: string;
  onSave: (input: { description?: string; type?: MemoryType; body?: string }) => Promise<
    { ok: true } | { ok: false; status: number; error: string }
  >;
  onDelete: () => Promise<void>;
}) {
  const parsed = parseFrontmatter(raw);
  // Hooks must be called unconditionally — keep useState above any branch.
  const [type, setType] = useState<MemoryType>(parsed?.type ?? "user");
  const [description, setDescription] = useState(parsed?.description ?? "");
  const [body, setBody] = useState(parsed?.body ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!parsed) {
    return (
      <div className="flex h-full flex-col">
        <div className="border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
          Couldn&apos;t parse frontmatter. Showing raw contents — edit via the file directly.
        </div>
        <pre className="overflow-x-auto p-3 font-mono text-[11px] leading-5 whitespace-pre-wrap scroll-thin">
          {raw}
        </pre>
      </div>
    );
  }

  const dirty =
    type !== parsed.type || description !== parsed.description || body !== parsed.body;

  async function submit() {
    setError(null);
    setSubmitting(true);
    try {
      const patch: { description?: string; type?: MemoryType; body?: string } = {};
      if (type !== parsed!.type) patch.type = type;
      if (description !== parsed!.description) patch.description = description;
      if (body !== parsed!.body) patch.body = body;
      if (Object.keys(patch).length === 0) return;
      const r = await onSave(patch);
      if (!r.ok) setError(`${r.status}: ${r.error}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty && !submitting) void submit();
      }}
      className="flex h-full flex-col p-3"
    >
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="block">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--muted)]">Filename</div>
          <input
            value={filename}
            readOnly
            className="w-full rounded-md border border-[var(--border)] bg-[var(--panel)]/40 px-2 py-1.5 font-mono text-xs text-[var(--muted)] focus:outline-none"
          />
        </label>
        <label className="block">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--muted)]">Name (read-only)</div>
          <input
            value={parsed.name}
            readOnly
            title="Identity is locked. Rename via delete + create."
            className="w-full rounded-md border border-[var(--border)] bg-[var(--panel)]/40 px-2 py-1.5 text-xs text-[var(--muted)] focus:outline-none"
          />
        </label>
      </div>
      <label className="mt-2 block">
        <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--muted)]">Type</div>
        <select
          value={type}
          onChange={(e) => setType(e.target.value as MemoryType)}
          className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 text-xs focus:outline-none"
        >
          <option value="user">user</option>
          <option value="feedback">feedback</option>
          <option value="project">project</option>
          <option value="reference">reference</option>
        </select>
      </label>
      <label className="mt-2 block">
        <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--muted)]">Description</div>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 text-xs focus:outline-none"
        />
      </label>
      <label className="mt-2 flex flex-1 flex-col">
        <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--muted)]">Body</div>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          spellCheck={false}
          className="min-h-[200px] flex-1 resize-none rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 font-mono text-[11px] leading-5 focus:outline-none scroll-thin"
        />
      </label>
      {error && (
        <div className="mt-2 rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1 text-[11px] text-red-300">
          {error}
        </div>
      )}
      <div className="mt-3 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={async () => {
            setDeleting(true);
            try {
              await onDelete();
            } finally {
              setDeleting(false);
            }
          }}
          disabled={deleting || submitting}
          className="mr-auto rounded-md border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs text-red-300 hover:bg-red-500/20 disabled:opacity-40"
        >
          {deleting ? "Deleting…" : "Delete"}
        </button>
        <button
          type="submit"
          disabled={!dirty || submitting}
          className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs text-white hover:opacity-90 disabled:opacity-40"
        >
          {submitting ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}
