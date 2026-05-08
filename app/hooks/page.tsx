"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Plus,
  PowerOff,
  RefreshCw,
  Trash2,
  Webhook,
} from "lucide-react";
import { SideNav } from "@/components/nav/SideNav";
import { ScopeToggle, type Scope as IaScope } from "@/components/nav/ScopeToggle";
import { useHooks } from "@/lib/client/useHooks";
import {
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  HOOK_EVENTS,
  type HookCategory,
  type HookEvent,
  type HookEventSpec,
  type HookGroup,
  type HookHandler,
} from "@/lib/shared/hook-events";
import type { SettingsScope } from "@/lib/server/settings";
import { cn } from "@/lib/utils/cn";

const SCOPE_LABELS: Record<SettingsScope, string> = {
  user: "User",
  project: "Project",
  local: "Local",
};

export default function HooksPage() {
  const [cwd, setCwd] = useState<string | null>(null);
  const [scope, setScope] = useState<SettingsScope>("project");
  const [showAdd, setShowAdd] = useState(false);
  const [iaScope, setIaScope] = useState<IaScope>("workspace");

  // Keep `scope` in the visible set when the IA toggle flips.
  function setIaScopeWithSnap(next: IaScope) {
    setIaScope(next);
    if (next === "account") setScope("user");
    else if (scope === "user") setScope("project");
  }

  useEffect(() => {
    fetch("/api/sessions")
      .then((r) => r.json())
      .then((arr: Array<{ cwd?: string }>) => setCwd((arr?.[0]?.cwd) ?? ""))
      .catch(() => setCwd(""));
  }, []);

  const hooks = useHooks(cwd);
  const active = hooks.scopes.find((s) => s.scope === scope);

  const grouped = useMemo(() => {
    const map = new Map<HookCategory, Array<{ spec: HookEventSpec; groups: HookGroup[] }>>();
    for (const spec of HOOK_EVENTS) {
      const groups = active?.hooks?.[spec.name] ?? [];
      const arr = map.get(spec.category) ?? [];
      arr.push({ spec, groups });
      map.set(spec.category, arr);
    }
    return map;
  }, [active]);

  const totalConfigured = useMemo(() => {
    let n = 0;
    for (const s of hooks.scopes) {
      for (const arr of Object.values(s.hooks)) n += arr?.length ?? 0;
    }
    return n;
  }, [hooks.scopes]);

  return (
    <div className="flex h-full">
      <SideNav running={false} />
      <main className="flex h-full flex-1 flex-col overflow-hidden">
        <header className="flex h-9 shrink-0 items-center gap-3 border-b border-[var(--border)] bg-[var(--panel)] px-4 text-xs">
          <Link href="/" className="flex items-center gap-1 text-[var(--muted)] hover:text-[var(--foreground)]">
            <ArrowLeft className="h-3.5 w-3.5" /> Chat
          </Link>
          <span className="opacity-50">·</span>
          <Webhook className="h-3.5 w-3.5 text-[var(--muted)]" />
          <span className="font-medium">Hooks</span>
          <ScopeToggle value={iaScope} onChange={setIaScopeWithSnap} />
          <span className="text-[var(--muted)]">({totalConfigured} configured)</span>
          {hooks.loading && <span className="text-[var(--muted)]">loading…</span>}
          {hooks.error && <span className="text-red-400">{hooks.error}</span>}
          <button
            onClick={() => hooks.refresh()}
            className="ml-auto flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-0.5 hover:bg-[var(--panel)]"
          >
            <RefreshCw className="h-3 w-3" /> Refresh
          </button>
          <button
            onClick={() => setShowAdd((s) => !s)}
            className="flex items-center gap-1 rounded-md bg-[var(--accent)] px-2 py-0.5 text-white hover:opacity-90"
          >
            <Plus className="h-3 w-3" /> Add
          </button>
        </header>

        <div className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--panel)]/40 px-4 py-2">
          {((iaScope === "account" ? ["user"] : ["project", "local"]) as SettingsScope[]).map((s) => {
            const sc = hooks.scopes.find((x) => x.scope === s);
            const total = sc ? Object.values(sc.hooks).reduce((n, a) => n + (a?.length ?? 0), 0) : 0;
            return (
              <button
                key={s}
                onClick={() => setScope(s)}
                className={cn(
                  "rounded-md border border-[var(--border)] px-3 py-1 text-xs",
                  scope === s ? "bg-[var(--panel-2)]" : "bg-[var(--panel)] text-[var(--muted)] hover:text-[var(--foreground)]",
                )}
                title={sc?.path}
              >
                {SCOPE_LABELS[s]}
                <span className="ml-1 text-[10px] text-[var(--muted)]">{total}</span>
              </button>
            );
          })}
          <span className="ml-2 truncate font-mono text-[10px] text-[var(--muted)]">{active?.path ?? "—"}</span>
          <label className="ml-auto flex items-center gap-1.5 text-[11px] text-[var(--muted)]">
            <input
              type="checkbox"
              checked={!!active?.disableAllHooks}
              onChange={(e) => hooks.setDisabled(scope, e.target.checked)}
              className="h-3 w-3"
            />
            <PowerOff className="h-3 w-3" />
            disableAllHooks
          </label>
        </div>

        <div className="flex-1 overflow-y-auto scroll-thin">
          <div className="mx-auto max-w-4xl px-6 py-6">
            {showAdd && (
              <AddHookForm
                scope={scope}
                onCancel={() => setShowAdd(false)}
                onSubmit={async (event, group) => {
                  const ok = await hooks.add(scope, event, group);
                  if (ok) setShowAdd(false);
                }}
              />
            )}

            {CATEGORY_ORDER.map((cat) => {
              const items = grouped.get(cat) ?? [];
              const hasAny = items.some((it) => it.groups.length > 0);
              return (
                <section key={cat} className="mb-5">
                  <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-[var(--muted)]">
                    {CATEGORY_LABELS[cat]}
                  </h2>
                  <ul className="space-y-1.5">
                    {items.map((it) => (
                      <EventRow
                        key={it.spec.name}
                        spec={it.spec}
                        groups={it.groups}
                        onDelete={(i) => hooks.remove(scope, it.spec.name, i)}
                        emphasize={!hasAny ? false : it.groups.length > 0}
                      />
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        </div>
      </main>
    </div>
  );
}

function EventRow({
  spec,
  groups,
  onDelete,
  emphasize,
}: {
  spec: HookEventSpec;
  groups: HookGroup[];
  onDelete: (idx: number) => void;
  emphasize: boolean;
}) {
  const [open, setOpen] = useState(groups.length > 0);
  const dim = !emphasize && groups.length === 0;
  return (
    <li
      className={cn(
        "rounded-md border border-[var(--border)] bg-[var(--panel)]/40",
        dim && "opacity-60",
      )}
    >
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs"
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        <span className="font-mono">{spec.name}</span>
        <span className="truncate text-[var(--muted)]">— {spec.description}</span>
        {spec.canBlock && (
          <span className="ml-auto rounded-md border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-200">
            can block
          </span>
        )}
        <span
          className={cn(
            "ml-2 rounded-md border px-1.5 py-0.5 text-[10px]",
            groups.length > 0
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
              : "border-[var(--border)] text-[var(--muted)]",
          )}
        >
          {groups.length}
        </span>
      </button>
      {open && groups.length > 0 && (
        <ul className="border-t border-[var(--border)]">
          {groups.map((g, i) => (
            <li key={i} className="border-b border-[var(--border)] px-3 py-2 last:border-b-0">
              <div className="mb-1 flex items-center gap-2 text-[11px]">
                <span className="text-[var(--muted)]">matcher:</span>
                <code className="font-mono">{g.matcher === "" ? '""' : g.matcher ?? "*"}</code>
                <button
                  onClick={() => {
                    if (confirm(`Remove this hook for ${spec.name}?`)) onDelete(i);
                  }}
                  className="ml-auto rounded p-0.5 text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-red-400"
                  title="Remove"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
              <ul className="space-y-1">
                {g.hooks.map((h, j) => (
                  <li key={j} className="rounded-md bg-[var(--panel-2)]/40 px-2 py-1 font-mono text-[11px]">
                    <span className="text-[var(--accent)]">[{h.type}]</span>{" "}
                    {h.type === "command" && <span>{h.command}</span>}
                    {h.type === "http" && <span>{(h.method ?? "POST")} {h.url}</span>}
                    {h.type === "prompt" && <span>{h.prompt.slice(0, 80)}</span>}
                    {h.type === "agent" && <span>{h.agent}</span>}
                    {h.type === "mcp_tool" && <span>{h.tool}</span>}
                    {"timeout" in h && h.timeout != null && (
                      <span className="ml-2 text-[var(--muted)]">timeout={h.timeout}</span>
                    )}
                    {"async" in h && h.async && <span className="ml-2 text-[var(--muted)]">async</span>}
                    {"once" in h && h.once && <span className="ml-2 text-[var(--muted)]">once</span>}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
      {open && spec.matcherHint && groups.length === 0 && (
        <div className="border-t border-[var(--border)] px-3 py-2 text-[11px] text-[var(--muted)]">
          matcher hint: <code className="font-mono">{spec.matcherHint}</code>
        </div>
      )}
    </li>
  );
}

function AddHookForm({
  scope,
  onCancel,
  onSubmit,
}: {
  scope: SettingsScope;
  onCancel: () => void;
  onSubmit: (event: HookEvent, group: HookGroup) => Promise<void>;
}) {
  const [event, setEvent] = useState<HookEvent>("PostToolUse");
  const [matcher, setMatcher] = useState("");
  const [type, setType] = useState<HookHandler["type"]>("command");
  const [command, setCommand] = useState("");
  const [url, setUrl] = useState("");
  const [method, setMethod] = useState<"POST" | "GET">("POST");
  const [headersText, setHeadersText] = useState("");
  const [prompt, setPrompt] = useState("");
  const [agent, setAgent] = useState("");
  const [tool, setTool] = useState("");
  const [argsText, setArgsText] = useState("");
  const [timeout, setTimeout] = useState<number | "">("");
  const [async, setAsync] = useState(false);
  const [asyncRewake, setAsyncRewake] = useState(false);
  const [once, setOnce] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function parseRecord(text: string): { ok: true; value: Record<string, string> } | { ok: false; error: string } {
    if (!text.trim()) return { ok: true, value: {} };
    try {
      const obj = JSON.parse(text);
      if (typeof obj !== "object" || Array.isArray(obj) || obj === null)
        return { ok: false, error: "must be a JSON object" };
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(obj)) out[k] = String(v);
      return { ok: true, value: out };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  function parseArgs(text: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
    if (!text.trim()) return { ok: true, value: {} };
    try {
      const obj = JSON.parse(text);
      if (typeof obj !== "object" || Array.isArray(obj) || obj === null)
        return { ok: false, error: "must be a JSON object" };
      return { ok: true, value: obj as Record<string, unknown> };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async function submit() {
    setError(null);
    let handler: HookHandler;
    if (type === "command") {
      if (!command.trim()) return setError("command required");
      handler = {
        type: "command",
        command: command.trim(),
        ...(timeout !== "" ? { timeout: Number(timeout) } : {}),
        ...(async ? { async: true } : {}),
        ...(asyncRewake ? { asyncRewake: true } : {}),
        ...(once ? { once: true } : {}),
      };
    } else if (type === "http") {
      if (!url.trim()) return setError("url required");
      const headers = parseRecord(headersText);
      if (!headers.ok) return setError(`headers: ${headers.error}`);
      handler = {
        type: "http",
        url: url.trim(),
        method,
        ...(Object.keys(headers.value).length ? { headers: headers.value } : {}),
        ...(timeout !== "" ? { timeout: Number(timeout) } : {}),
        ...(async ? { async: true } : {}),
        ...(asyncRewake ? { asyncRewake: true } : {}),
        ...(once ? { once: true } : {}),
      };
    } else if (type === "prompt") {
      if (!prompt.trim()) return setError("prompt required");
      handler = { type: "prompt", prompt, ...(once ? { once: true } : {}) };
    } else if (type === "agent") {
      if (!agent.trim()) return setError("agent name required");
      handler = { type: "agent", agent: agent.trim(), ...(once ? { once: true } : {}) };
    } else {
      if (!tool.trim()) return setError("tool required");
      const args = parseArgs(argsText);
      if (!args.ok) return setError(`arguments: ${args.error}`);
      handler = {
        type: "mcp_tool",
        tool: tool.trim(),
        ...(Object.keys(args.value).length ? { arguments: args.value } : {}),
        ...(once ? { once: true } : {}),
      };
    }

    const group: HookGroup = {
      ...(matcher !== "" ? { matcher } : {}),
      hooks: [handler],
    };

    setSubmitting(true);
    try {
      await onSubmit(event, group);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      className="mb-4 rounded-lg border border-[var(--border)] bg-[var(--panel)]/60 p-4"
    >
      <div className="mb-3 flex items-center gap-2 text-xs">
        <Webhook className="h-3.5 w-3.5 text-[var(--accent)]" />
        <span className="font-medium">Add hook to {SCOPE_LABELS[scope]} scope</span>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <Field label="Event">
          <select
            value={event}
            onChange={(e) => setEvent(e.target.value as HookEvent)}
            className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 text-xs focus:outline-none"
          >
            {HOOK_EVENTS.map((e) => (
              <option key={e.name} value={e.name}>
                {e.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Matcher (string, pipe-list, or regex)">
          <input
            value={matcher}
            onChange={(e) => setMatcher(e.target.value)}
            placeholder={HOOK_EVENTS.find((s) => s.name === event)?.matcherHint ?? "(any)"}
            className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 font-mono text-xs focus:outline-none"
          />
        </Field>
        <Field label="Handler type">
          <select
            value={type}
            onChange={(e) => setType(e.target.value as HookHandler["type"])}
            className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 text-xs focus:outline-none"
          >
            <option value="command">command</option>
            <option value="http">http</option>
            <option value="prompt">prompt</option>
            <option value="agent">agent</option>
            <option value="mcp_tool">mcp_tool</option>
          </select>
        </Field>
      </div>

      {type === "command" && (
        <div className="mt-2">
          <Field label="Command">
            <input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="/path/to/script.sh"
              className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 font-mono text-xs focus:outline-none"
            />
          </Field>
        </div>
      )}
      {type === "http" && (
        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto]">
          <Field label="URL">
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://hooks.example.com/claude"
              className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 font-mono text-xs focus:outline-none"
            />
          </Field>
          <Field label="Method">
            <select
              value={method}
              onChange={(e) => setMethod(e.target.value as "POST" | "GET")}
              className="rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 text-xs focus:outline-none"
            >
              <option value="POST">POST</option>
              <option value="GET">GET</option>
            </select>
          </Field>
          <div className="sm:col-span-2">
            <Field label="Headers (JSON)">
              <textarea
                rows={2}
                value={headersText}
                onChange={(e) => setHeadersText(e.target.value)}
                placeholder='{"Authorization":"Bearer …"}'
                className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 font-mono text-xs focus:outline-none"
              />
            </Field>
          </div>
        </div>
      )}
      {type === "prompt" && (
        <div className="mt-2">
          <Field label="Prompt">
            <textarea
              rows={3}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="System-style instruction injected when this event fires"
              className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 text-xs focus:outline-none"
            />
          </Field>
        </div>
      )}
      {type === "agent" && (
        <div className="mt-2">
          <Field label="Agent name">
            <input
              value={agent}
              onChange={(e) => setAgent(e.target.value)}
              placeholder="my-subagent"
              className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 font-mono text-xs focus:outline-none"
            />
          </Field>
        </div>
      )}
      {type === "mcp_tool" && (
        <div className="mt-2 grid gap-2">
          <Field label="MCP tool (mcp__server__tool)">
            <input
              value={tool}
              onChange={(e) => setTool(e.target.value)}
              placeholder="mcp__myserver__notify"
              className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 font-mono text-xs focus:outline-none"
            />
          </Field>
          <Field label="Arguments (JSON)">
            <textarea
              rows={2}
              value={argsText}
              onChange={(e) => setArgsText(e.target.value)}
              placeholder='{"channel":"alerts"}'
              className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 font-mono text-xs focus:outline-none"
            />
          </Field>
        </div>
      )}

      {(type === "command" || type === "http") && (
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-4">
          <Field label="Timeout (ms)">
            <input
              type="number"
              min={0}
              value={timeout}
              onChange={(e) => setTimeout(e.target.value ? Number(e.target.value) : "")}
              placeholder="(default)"
              className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 text-xs focus:outline-none"
            />
          </Field>
          <ToggleField label="async" checked={async} onChange={setAsync} />
          <ToggleField label="asyncRewake" checked={asyncRewake} onChange={setAsyncRewake} />
          <ToggleField label="once" checked={once} onChange={setOnce} />
        </div>
      )}
      {(type === "prompt" || type === "agent" || type === "mcp_tool") && (
        <div className="mt-3">
          <ToggleField label="once" checked={once} onChange={setOnce} />
        </div>
      )}

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
          disabled={submitting}
          className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs text-white hover:opacity-90 disabled:opacity-40"
        >
          {submitting ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--muted)]">{label}</div>
      {children}
    </label>
  );
}

function ToggleField({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (b: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 text-xs">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-3 w-3" />
      <span>{label}</span>
    </label>
  );
}
