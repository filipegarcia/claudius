"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  LayoutPanelTop,
  Network,
  Plug,
  Plug2,
  Plus,
  Power,
  RefreshCw,
  Trash2,
  Wrench,
} from "lucide-react";
import { SideNav } from "@/components/nav/SideNav";
import { useActiveCwd } from "@/lib/client/useActiveCwd";
import {
  MCP_OTHER_SCOPE_LABELS,
  mcpRemoveHint,
  reconnectOutcome,
  useMcp,
  type ConfiguredServer,
  type LiveStatus,
  type ReconnectAttempt,
} from "@/lib/client/useMcp";
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

function scopeLabel(scope: string): string {
  return SCOPE_LABELS[scope as McpScope] ?? MCP_OTHER_SCOPE_LABELS[scope] ?? scope;
}

/**
 * SDK 0.3.280 — a tool's `_meta` carries MCP Apps (SEP-1865) metadata under
 * `ui.resourceUri` (or the deprecated flat `ui/resourceUri`), a `ui://`
 * string a host can pass to `readMcpResource()` to fetch the tool's widget.
 * We only surface *presence*, not the resource itself — reading and
 * rendering third-party `ui://` HTML needs a sandboxing design of its own
 * (tracked as a follow-up), so this is deliberately a "has a UI" indicator,
 * nothing more.
 */
function mcpToolUiResourceUri(meta: Record<string, unknown> | undefined): string | null {
  if (!meta) return null;
  const ui = meta.ui;
  if (ui && typeof ui === "object" && "resourceUri" in ui) {
    const uri = (ui as { resourceUri?: unknown }).resourceUri;
    if (typeof uri === "string" && uri.startsWith("ui://")) return uri;
  }
  const flat = meta["ui/resourceUri"];
  if (typeof flat === "string" && flat.startsWith("ui://")) return flat;
  return null;
}

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
  const [reconnectingAll, setReconnectingAll] = useState(false);

  const needsReconnectCount = useMemo(
    () => mcp.status.filter((s) => s.status === "failed" || s.status === "needs-auth").length,
    [mcp.status],
  );

  // CC 2.1.330 — `editable` is whether the server is in a file Claudius
  // writes (`configured`); a status-only row (claude.ai connector, plugin,
  // sdk, or a CLI-added server in ~/.claude.json) can't be removed here.
  const merged = useMemo(() => {
    const map = new Map<string, { server: ConfiguredServer; status?: LiveStatus; editable: boolean }>();
    for (const s of mcp.configured) {
      map.set(s.name, { server: s, editable: true });
    }
    for (const st of mcp.status) {
      const ex = map.get(st.name);
      if (ex) ex.status = st;
      else
        map.set(st.name, {
          server: { scope: (st.scope as McpScope) ?? "user", name: st.name, config: { command: "" } },
          status: st,
          editable: false,
        });
    }
    return [...map.values()].sort((a, b) => a.server.name.localeCompare(b.server.name));
  }, [mcp.configured, mcp.status]);
  // CC 2.1.330 — the last failed Remove per server, shown on its row.
  const [removeErrors, setRemoveErrors] = useState<Record<string, string>>({});
  // CC 2.1.330 — "Improved Reconnect in `/mcp` and `/plugin`: a server's page
  // now stays open, with the cause in view, when the server still fails or
  // needs sign-in". Per server: the status it had when Reconnect was pressed (so a
  // refreshed status can be told apart) and the reconnect call's error.
  const [reconnects, setReconnects] = useState<Record<string, ReconnectAttempt>>({});
  function startReconnects(names: string[]) {
    setReconnects((prev) => {
      const next = { ...prev };
      for (const n of names) next[n] = { before: mcp.status.find((s) => s.name === n), error: null };
      return next;
    });
  }
  function recordReconnectErrors(errors: Record<string, string>) {
    setReconnects((prev) => {
      const next = { ...prev };
      for (const [n, error] of Object.entries(errors)) if (next[n]) next[n] = { ...next[n], error };
      return next;
    });
  }
  function dismissReconnect(name: string) {
    setReconnects((prev) => {
      const next = { ...prev };
      delete next[name];
      return next;
    });
  }

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
          {sessionId && needsReconnectCount > 0 && (
            <button
              data-testid="mcp-reconnect-all"
              disabled={reconnectingAll}
              onClick={async () => {
                setReconnectingAll(true);
                startReconnects(
                  mcp.status.filter((s) => s.status === "failed" || s.status === "needs-auth").map((s) => s.name),
                );
                try {
                  const { errors } = await mcp.reconnectAll();
                  recordReconnectErrors(errors);
                } finally {
                  setReconnectingAll(false);
                }
              }}
              title={`Retry every server that failed to connect or needs authentication (${needsReconnectCount})`}
              className="flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-0.5 hover:bg-[var(--panel)] disabled:opacity-40"
            >
              <RefreshCw className={cn("h-3 w-3", reconnectingAll && "animate-spin")} /> Reconnect all ({needsReconnectCount})
            </button>
          )}
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
                  const err = await mcp.upsert(scope, name, config);
                  if (!err) setShowAdd(false);
                  return err;
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
                {merged.map(({ server, status, editable }) => (
                  <ServerRow
                    key={server.name}
                    server={server}
                    status={status}
                    editable={editable}
                    removeError={removeErrors[server.name] ?? null}
                    reconnect={reconnects[server.name]}
                    onDismissReconnect={() => dismissReconnect(server.name)}
                    sessionId={sessionId}
                    statusLoaded={mcp.statusLoaded}
                    onReconnect={() => {
                      startReconnects([server.name]);
                      void mcp.reconnect(server.name).then((r) => {
                        if (!r.ok) recordReconnectErrors({ [server.name]: r.error ?? "Reconnect failed" });
                      });
                    }}
                    onToggle={(enabled) => mcp.toggle(server.name, enabled)}
                    onDelete={() => {
                      if (confirm(`Remove MCP server "${server.name}" from ${SCOPE_LABELS[server.scope]}?`)) {
                        void mcp.remove(server.scope, server.name).then((err) =>
                          setRemoveErrors((prev) => {
                            const next = { ...prev };
                            if (err) next[server.name] = err;
                            else delete next[server.name];
                            return next;
                          }),
                        );
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
  editable,
  removeError,
  reconnect,
  onDismissReconnect,
  sessionId,
  statusLoaded,
  onReconnect,
  onToggle,
  onDelete,
}: {
  server: ConfiguredServer;
  status?: LiveStatus;
  /** In a file Claudius edits, so Remove can work (CC 2.1.330). */
  editable: boolean;
  removeError: string | null;
  reconnect?: ReconnectAttempt;
  onDismissReconnect: () => void;
  sessionId: string | null;
  statusLoaded: boolean;
  onReconnect: () => void;
  onToggle: (enabled: boolean) => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  // CC 2.1.330 — after Reconnect, the row opens itself with the cause in
  // view when the call failed or the server still fails / needs sign-in.
  const { stillFailing, showCause } = reconnectOutcome(reconnect, status);
  const isOpen = open || showCause;
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
        <button
          onClick={() => {
            if (isOpen) {
              setOpen(false);
              if (showCause) onDismissReconnect();
            } else setOpen(true);
          }}
          aria-expanded={isOpen}
          data-testid={`mcp-row-toggle-${server.name}`}
          className="flex flex-1 items-center gap-2 text-left"
        >
          {isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          <Plug className="h-3.5 w-3.5 text-[var(--accent)]" />
          <span className="font-medium">{server.name}</span>
          <span className="font-mono text-[10px] text-[var(--muted)]">[{transport}]</span>
          {status && (
            <span
              data-testid={`mcp-status-badge-${server.name}`}
              className={cn(
                "rounded-md border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide",
                STATUS_TONES[status.status],
              )}
            >
              {status.status}
            </span>
          )}
          <span className="ml-2 text-[10px] text-[var(--muted)]">
            {server.name.startsWith("plugin:") ? "Plugin" : scopeLabel(server.scope)}
          </span>
          {status?.source && (
            <span
              data-testid={`mcp-source-badge-${server.name}`}
              title="Where this server's definition came from"
              className={cn(
                "ml-1 rounded-md border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide",
                status.source === "sdk"
                  ? "border-[var(--accent)]/30 bg-[var(--accent)]/10 text-[var(--accent)]"
                  : "border-[var(--border)] bg-[var(--panel-2)] text-[var(--muted)]",
              )}
            >
              {status.source}
            </span>
          )}
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
          {editable ? (
            <button
              onClick={onDelete}
              title="Remove from config"
              data-testid={`mcp-remove-${server.name}`}
              className="flex items-center gap-1 rounded-md border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-[11px] text-red-300 hover:bg-red-500/20"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          ) : (
            // CC 2.1.330 — not in a file Claudius edits: say where it's
            // managed instead of a Remove that does nothing.
            (() => {
              const hint = mcpRemoveHint(server.name, server.scope);
              const cls = "px-1 text-[11px] text-[var(--muted)]";
              return hint.href?.startsWith("/") ? (
                <Link href={hint.href} title={hint.title} data-testid={`mcp-remove-hint-${server.name}`} className={cn(cls, "underline hover:text-[var(--foreground)]")}>
                  {hint.label}
                </Link>
              ) : hint.href ? (
                <a
                  href={hint.href}
                  target="_blank"
                  rel="noreferrer"
                  title={hint.title}
                  data-testid={`mcp-remove-hint-${server.name}`}
                  className={cn(cls, "underline hover:text-[var(--foreground)]")}
                >
                  {hint.label}
                </a>
              ) : (
                <span title={hint.title} data-testid={`mcp-remove-hint-${server.name}`} className={cls}>
                  {hint.label}
                </span>
              );
            })()
          )}
        </div>
      </div>
      {removeError && (
        <div
          data-testid={`mcp-remove-error-${server.name}`}
          className="mx-3 mb-2 rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1 text-[11px] text-red-300"
        >
          Couldn&apos;t remove: {removeError}
        </div>
      )}
      {server.rejected && !status ? (
        // CC 2.1.327 — a project server listed in `disabledMcpjsonServers`
        // is filtered out by the engine; "start a new chat" would be wrong
        // advice, so say where it was turned off instead.
        <div
          data-testid={`mcp-rejected-hint-${server.name}`}
          className="-mt-1 pr-3 pb-2 pl-14 text-[11px] text-[var(--muted)]"
        >
          Turned off in{" "}
          <Link href="/settings#mcp" className="underline hover:text-[var(--foreground)]">
            Settings
          </Link>{" "}
          (<code className="font-mono">disabledMcpjsonServers</code>).
        </div>
      ) : sessionId && statusLoaded && !status && (
        // CC 2.1.327 — a configured server the live session doesn't know
        // about (added mid-session, or a project server that wasn't
        // approved) used to render with no badge and no actions.
        <div
          data-testid={`mcp-not-loaded-hint-${server.name}`}
          className="-mt-1 pr-3 pb-2 pl-14 text-[11px] text-[var(--muted)]"
        >
          Not loaded in this session. Start a new chat to connect it.
          {server.scope === "project" && (
            <>
              {" "}
              If it still doesn&apos;t load, approve it under MCP in{" "}
              <Link href="/settings#mcp" className="underline hover:text-[var(--foreground)]">
                Settings
              </Link>
              .
            </>
          )}
        </div>
      )}
      {isOpen && (
        <div className="border-t border-[var(--border)] px-3 py-2 text-xs">
          {target && (
            <div className="mb-2 break-all font-mono text-[11px] text-[var(--muted)]">{target}</div>
          )}
          {reconnect?.error && (
            <div
              data-testid={`mcp-reconnect-error-${server.name}`}
              className="mb-2 rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1 text-[11px] text-red-300"
            >
              Reconnect failed: {reconnect.error}
            </div>
          )}
          {status?.error && (
            <div
              data-testid={`mcp-status-error-${server.name}`}
              className="mb-2 rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1 text-[11px] text-red-300"
            >
              {status.error}
            </div>
          )}
          {stillFailing && !status?.error && (
            <div
              data-testid={`mcp-reconnect-still-failing-${server.name}`}
              className={cn(
                "mb-2 rounded-md border px-2 py-1 text-[11px]",
                status?.status === "needs-auth"
                  ? "border-amber-500/30 bg-amber-500/10 text-amber-300"
                  : "border-red-500/30 bg-red-500/10 text-red-300",
              )}
            >
              {status?.status === "needs-auth"
                ? "Still needs sign-in — this server won't connect until you authenticate it."
                : "Still failing to connect, and the server gave no reason."}
            </div>
          )}
          {server.warnings && server.warnings.length > 0 && (
            <div
              data-testid="mcp-whitespace-warning"
              className="mb-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-300"
            >
              {server.warnings.join("; ")}
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
                {status.tools.map((t) => {
                  const uiResourceUri = mcpToolUiResourceUri(t._meta);
                  return (
                    <li
                      key={t.name}
                      className="flex items-baseline gap-2 rounded-md border border-[var(--border)] bg-[var(--panel-2)]/40 px-2 py-1 text-[11px]"
                    >
                      <Wrench className="h-3 w-3 shrink-0 text-[var(--accent)]" />
                      <span className="font-mono">{t.name}</span>
                      {uiResourceUri && (
                        <span
                          data-testid={`mcp-tool-ui-badge-${t.name}`}
                          title={`Ships an MCP Apps UI resource: ${uiResourceUri}`}
                          className="flex shrink-0 items-center gap-1 rounded-md border border-[var(--accent)]/30 bg-[var(--accent)]/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-[var(--accent)]"
                        >
                          <LayoutPanelTop className="h-2.5 w-2.5" /> UI
                        </span>
                      )}
                      {t.description && <span className="truncate text-[var(--muted)]">— {t.description}</span>}
                    </li>
                  );
                })}
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
  /** Resolves to `null` on success, or an error to show in the form. */
  onSubmit: (scope: McpScope, name: string, config: McpServerConfig) => Promise<string | null>;
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
  const [bareElicitation, setBareElicitation] = useState(false);
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
        bareElicitationCapability: bareElicitation || undefined,
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
        bareElicitationCapability: bareElicitation || undefined,
      };
    }
    setSubmitting(true);
    try {
      const err = await onSubmit(scope, trimmedName, config);
      if (err) setError(err);
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
      <label className="mt-1.5 flex items-center gap-2 text-xs text-[var(--muted)]">
        <input
          type="checkbox"
          data-testid="mcp-bare-elicitation"
          checked={bareElicitation}
          onChange={(e) => setBareElicitation(e.target.checked)}
          className="h-3 w-3"
        />
        <span>
          bareElicitationCapability — only if this server won&apos;t connect: skips advertising URL sign-in prompts
          (MCP 2025-11-25), which some older servers reject
        </span>
      </label>
      {error && (
        <div data-testid="mcp-add-error" className="mt-2 rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1 text-[11px] text-red-300">
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
