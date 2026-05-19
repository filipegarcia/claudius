"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ChevronDown, ChevronRight, Network, Plug, Plug2, Plus, Power, RefreshCw, Trash2, Wrench } from "lucide-react";
import { SideNav } from "@/components/nav/SideNav";
import { useActiveCwd } from "@/lib/client/useActiveCwd";
import { useMcp, type ConfiguredServer, type LiveStatus } from "@/lib/client/useMcp";
import type { McpScope, McpServerConfig } from "@/lib/server/mcp";
import { cn } from "@/lib/utils/cn";

const STATUS_TONES: Record<LiveStatus["status"], string> = {
  connected: "text-emerald-300 bg-emerald-500/10 border-emerald-500/30",
  failed: "text-red-300 bg-red-500/10 border-red-500/30",
  "needs-auth": "text-amber-300 bg-amber-500/10 border-amber-500/30",
  pending: "text-sky-300 bg-sky-500/10 border-sky-500/30",
  disabled: "text-[var(--muted)] bg-[var(--panel-2)] border-[var(--border)]",
};

const SCOPE_LABELS: Record<McpScope, string> = {
  user: "User (~/.claude)",
  project: "Project (.mcp.json)",
  local: "Local (.claude/settings.local.json)",
};

export default function McpPage() {
  const cwd = useActiveCwd();
  const [sessionId, setSessionId] = useState<string | null>(null);

  // Pick the first live session whose cwd matches the active workspace —
  // /api/sessions returns in-memory sessions across all workspaces, so
  // we filter to the one MCP should reload-against.
  useEffect(() => {
    if (cwd == null) return;
    let cancelled = false;
    fetch("/api/sessions")
      .then((r) => r.json())
      .then((arr: Array<{ id?: string; cwd?: string }>) => {
        if (cancelled) return;
        if (!Array.isArray(arr)) {
          setSessionId(null);
          return;
        }
        const match = cwd ? arr.find((s) => s.cwd === cwd) : arr[0];
        setSessionId(match?.id ?? null);
      })
      .catch(() => {
        if (!cancelled) setSessionId(null);
      });
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  const mcp = useMcp(cwd, sessionId);
  const [showAdd, setShowAdd] = useState(false);

  const merged = useMemo(() => {
    const map = new Map<string, { server: ConfiguredServer; status?: LiveStatus }>();
    for (const s of mcp.configured) {
      map.set(s.name, { server: s });
    }
    for (const st of mcp.status) {
      const ex = map.get(st.name);
      if (ex) ex.status = st;
      else
        map.set(st.name, {
          server: { scope: (st.scope as McpScope) ?? "user", name: st.name, config: { command: "" } },
          status: st,
        });
    }
    return [...map.values()].sort((a, b) => a.server.name.localeCompare(b.server.name));
  }, [mcp.configured, mcp.status]);

  return (
    <div className="flex h-full">
      <SideNav running={false} />
      <main data-pane-name="mcp-main" className="flex h-full flex-1 flex-col overflow-hidden">
        <header className="flex h-9 shrink-0 items-center gap-3 border-b border-[var(--border)] bg-[var(--panel)] px-4 text-xs">
          <Link href="/" className="flex items-center gap-1 text-[var(--muted)] hover:text-[var(--foreground)]">
            <ArrowLeft className="h-3.5 w-3.5" /> Chat
          </Link>
          <span className="opacity-50">·</span>
          <Network className="h-3.5 w-3.5 text-[var(--muted)]" />
          <span className="font-medium">MCP</span>
          <span className="text-[var(--muted)]">({merged.length})</span>
          {mcp.loading && <span className="text-[var(--muted)]">loading…</span>}
          {mcp.error && <span className="text-red-400">{mcp.error}</span>}
          {mcp.statusError && <span className="text-amber-400">live status: {mcp.statusError}</span>}
          <button
            onClick={() => mcp.refresh()}
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

        <div className="flex-1 overflow-y-auto scroll-thin">
          <div className="mx-auto max-w-4xl px-6 py-6">
            {showAdd && (
              <AddServerForm
                onCancel={() => setShowAdd(false)}
                onSubmit={async (scope, name, config) => {
                  const ok = await mcp.upsert(scope, name, config);
                  if (ok) setShowAdd(false);
                }}
              />
            )}

            {!sessionId && (
              <div className="mb-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                Start a chat session to see live connection status, reconnect, and toggle servers.
              </div>
            )}

            {merged.length === 0 ? (
              <div className="rounded-md border border-[var(--border)] bg-[var(--panel)]/40 px-4 py-8 text-center text-sm text-[var(--muted)]">
                No MCP servers configured.
              </div>
            ) : (
              <ul className="space-y-2">
                {merged.map(({ server, status }) => (
                  <ServerRow
                    key={server.name}
                    server={server}
                    status={status}
                    sessionId={sessionId}
                    onReconnect={() => mcp.reconnect(server.name)}
                    onToggle={(enabled) => mcp.toggle(server.name, enabled)}
                    onDelete={() => {
                      if (confirm(`Remove MCP server "${server.name}" from ${SCOPE_LABELS[server.scope]}?`)) {
                        void mcp.remove(server.scope, server.name);
                      }
                    }}
                  />
                ))}
              </ul>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

function ServerRow({
  server,
  status,
  sessionId,
  onReconnect,
  onToggle,
  onDelete,
}: {
  server: ConfiguredServer;
  status?: LiveStatus;
  sessionId: string | null;
  onReconnect: () => void;
  onToggle: (enabled: boolean) => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const cfg = server.config as McpServerConfig & { url?: string; command?: string; args?: string[] };
  const transport =
    cfg.type === "http" || cfg.type === "sse"
      ? cfg.type
      : cfg.command || (server.config as McpServerConfig & { command?: string }).command
      ? "stdio"
      : "?";
  const target = "url" in cfg && cfg.url ? cfg.url : `${cfg.command ?? ""} ${(cfg.args ?? []).join(" ")}`.trim();

  return (
    <li className="rounded-lg border border-[var(--border)] bg-[var(--panel)]/40">
      <div className="flex items-center gap-3 px-3 py-2">
        <button onClick={() => setOpen((o) => !o)} className="flex flex-1 items-center gap-2 text-left">
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          <Plug className="h-3.5 w-3.5 text-[var(--accent)]" />
          <span className="font-medium">{server.name}</span>
          <span className="font-mono text-[10px] text-[var(--muted)]">[{transport}]</span>
          {status && (
            <span
              className={cn(
                "rounded-md border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide",
                STATUS_TONES[status.status],
              )}
            >
              {status.status}
            </span>
          )}
          <span className="ml-2 text-[10px] text-[var(--muted)]">{SCOPE_LABELS[server.scope]}</span>
          {status?.tools && status.tools.length > 0 && (
            <span className="ml-2 text-[10px] text-[var(--muted)]">· {status.tools.length} tools</span>
          )}
        </button>
        <div className="flex shrink-0 items-center gap-1">
          {sessionId && status && status.status !== "disabled" && (
            <button
              onClick={onReconnect}
              title="Reconnect"
              className="flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-0.5 text-[11px] hover:bg-[var(--panel)]"
            >
              <RefreshCw className="h-3 w-3" /> Reconnect
            </button>
          )}
          {sessionId && status && (
            <button
              onClick={() => onToggle(status.status === "disabled")}
              title={status.status === "disabled" ? "Enable" : "Disable"}
              className={cn(
                "flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px]",
                status.status === "disabled"
                  ? "border-[var(--border)] bg-[var(--panel-2)] hover:bg-[var(--panel)]"
                  : "border-amber-500/30 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20",
              )}
            >
              <Power className="h-3 w-3" />
              {status.status === "disabled" ? "Enable" : "Disable"}
            </button>
          )}
          <button
            onClick={onDelete}
            title="Remove from config"
            className="flex items-center gap-1 rounded-md border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-[11px] text-red-300 hover:bg-red-500/20"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      </div>
      {open && (
        <div className="border-t border-[var(--border)] px-3 py-2 text-xs">
          {target && (
            <div className="mb-2 break-all font-mono text-[11px] text-[var(--muted)]">{target}</div>
          )}
          {status?.error && (
            <div className="mb-2 rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1 text-[11px] text-red-300">
              {status.error}
            </div>
          )}
          {status?.serverInfo && (
            <div className="mb-2 text-[11px] text-[var(--muted)]">
              <span className="font-mono">{status.serverInfo.name}</span> v{status.serverInfo.version}
            </div>
          )}
          <details>
            <summary className="cursor-pointer text-[10px] uppercase tracking-wide text-[var(--muted)]">
              Raw config
            </summary>
            <pre className="mt-1 overflow-auto rounded bg-[var(--panel-2)] p-2 font-mono text-[11px] scroll-thin">
              {JSON.stringify(server.config, null, 2)}
            </pre>
          </details>
          {status?.tools && status.tools.length > 0 && (
            <div className="mt-2">
              <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--muted)]">Tools</div>
              <ul className="space-y-1">
                {status.tools.map((t) => (
                  <li
                    key={t.name}
                    className="flex items-baseline gap-2 rounded-md border border-[var(--border)] bg-[var(--panel-2)]/40 px-2 py-1 text-[11px]"
                  >
                    <Wrench className="h-3 w-3 shrink-0 text-[var(--accent)]" />
                    <span className="font-mono">{t.name}</span>
                    {t.description && <span className="truncate text-[var(--muted)]">— {t.description}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

type Transport = "stdio" | "http" | "sse";

function AddServerForm({
  onCancel,
  onSubmit,
}: {
  onCancel: () => void;
  onSubmit: (scope: McpScope, name: string, config: McpServerConfig) => Promise<void>;
}) {
  const [scope, setScope] = useState<McpScope>("project");
  const [transport, setTransport] = useState<Transport>("stdio");
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [url, setUrl] = useState("");
  const [headersText, setHeadersText] = useState("");
  const [envText, setEnvText] = useState("");
  const [alwaysLoad, setAlwaysLoad] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  async function submit() {
    setError(null);
    const trimmedName = name.trim();
    if (!trimmedName) return setError("Name required");
    let config: McpServerConfig;
    if (transport === "stdio") {
      if (!command.trim()) return setError("Command required for stdio");
      const env = parseRecord(envText);
      if (!env.ok) return setError(`env: ${env.error}`);
      config = {
        type: "stdio",
        command: command.trim(),
        args: args.trim() ? args.trim().split(/\s+/) : undefined,
        env: Object.keys(env.value).length ? env.value : undefined,
        alwaysLoad: alwaysLoad || undefined,
      };
    } else {
      if (!url.trim()) return setError("URL required");
      const headers = parseRecord(headersText);
      if (!headers.ok) return setError(`headers: ${headers.error}`);
      config = {
        type: transport,
        url: url.trim(),
        headers: Object.keys(headers.value).length ? headers.value : undefined,
        alwaysLoad: alwaysLoad || undefined,
      };
    }
    setSubmitting(true);
    try {
      await onSubmit(scope, trimmedName, config);
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
      <div className="mb-2 flex items-center gap-2 text-xs">
        <Plug2 className="h-3.5 w-3.5 text-[var(--accent)]" />
        <span className="font-medium">Add MCP server</span>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <Field label="Scope">
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value as McpScope)}
            className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 text-xs focus:outline-none"
          >
            <option value="project">project (.mcp.json)</option>
            <option value="user">user (settings.json)</option>
            <option value="local">local (settings.local.json)</option>
          </select>
        </Field>
        <Field label="Transport">
          <select
            value={transport}
            onChange={(e) => setTransport(e.target.value as Transport)}
            className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 text-xs focus:outline-none"
          >
            <option value="stdio">stdio</option>
            <option value="http">http</option>
            <option value="sse">sse</option>
          </select>
        </Field>
        <Field label="Name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my-server"
            className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 font-mono text-xs focus:outline-none"
          />
        </Field>
      </div>
      {transport === "stdio" ? (
        <div className="mt-2 grid grid-cols-1 gap-2">
          <Field label="Command">
            <input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="/usr/local/bin/my-mcp"
              className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 font-mono text-xs focus:outline-none"
            />
          </Field>
          <Field label="Args (space-separated)">
            <input
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              placeholder="--mode=server"
              className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 font-mono text-xs focus:outline-none"
            />
          </Field>
          <Field label="Env (JSON object)">
            <textarea
              rows={2}
              value={envText}
              onChange={(e) => setEnvText(e.target.value)}
              placeholder='{"API_KEY":"…"}'
              className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 font-mono text-xs focus:outline-none"
            />
          </Field>
        </div>
      ) : (
        <div className="mt-2 grid grid-cols-1 gap-2">
          <Field label="URL">
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/mcp"
              className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 font-mono text-xs focus:outline-none"
            />
          </Field>
          <Field label="Headers (JSON object)">
            <textarea
              rows={2}
              value={headersText}
              onChange={(e) => setHeadersText(e.target.value)}
              placeholder='{"Authorization":"Bearer …"}'
              className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 font-mono text-xs focus:outline-none"
            />
          </Field>
        </div>
      )}
      <label className="mt-3 flex items-center gap-2 text-xs text-[var(--muted)]">
        <input
          type="checkbox"
          checked={alwaysLoad}
          onChange={(e) => setAlwaysLoad(e.target.checked)}
          className="h-3 w-3"
        />
        <span>
          alwaysLoad — load tools immediately at startup (don&apos;t defer behind tool search; blocks startup until
          connected)
        </span>
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
