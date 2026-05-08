"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Download,
  ExternalLink,
  Package,
  Plug,
  Plus,
  Power,
  RefreshCw,
  Search,
  ShieldCheck,
  X,
} from "lucide-react";
import { SideNav } from "@/components/nav/SideNav";
import { useActiveCwd } from "@/lib/client/useActiveCwd";
import { usePlugins, type InstalledPlugin } from "@/lib/client/usePlugins";
import type { AvailablePlugin } from "@/lib/server/plugins";
import type { SettingsScope } from "@/lib/server/settings";
import { cn } from "@/lib/utils/cn";

const SCOPE_LABELS: Record<SettingsScope, string> = {
  user: "User",
  project: "Project",
  local: "Local",
};

export default function PluginsPage() {
  const cwd = useActiveCwd();
  const [sessionId, setSessionId] = useState<string | null>(null);

  // Pick the first live session whose cwd matches the active workspace —
  // /api/sessions returns in-memory sessions across all workspaces, so we
  // can't blindly grab arr[0].id any more.
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

  const plugins = usePlugins(cwd, sessionId);
  const [scope, setScope] = useState<SettingsScope>("user");

  const merged = useMemo(() => {
    // Map: pluginId → installed entry + which scopes have it enabled
    type Row = { id: string; installed?: InstalledPlugin; enabledIn: SettingsScope[] };
    const map = new Map<string, Row>();
    for (const inst of plugins.installed) {
      const id = inst.source ?? inst.name;
      map.set(id, { id, installed: inst, enabledIn: [] });
    }
    for (const s of plugins.scopes) {
      for (const [pid, on] of Object.entries(s.enabledPlugins)) {
        if (!on) continue;
        const ex = map.get(pid) ?? { id: pid, enabledIn: [] };
        ex.enabledIn.push(s.scope);
        map.set(pid, ex);
      }
    }
    return [...map.values()].sort((a, b) => a.id.localeCompare(b.id));
  }, [plugins.installed, plugins.scopes]);

  const active = plugins.scopes.find((s) => s.scope === scope);

  return (
    <div className="flex h-full">
      <SideNav running={false} />
      <main className="flex h-full flex-1 flex-col overflow-hidden">
        <header className="flex h-9 shrink-0 items-center gap-3 border-b border-[var(--border)] bg-[var(--panel)] px-4 text-xs">
          <Link href="/" className="flex items-center gap-1 text-[var(--muted)] hover:text-[var(--foreground)]">
            <ArrowLeft className="h-3.5 w-3.5" /> Chat
          </Link>
          <span className="opacity-50">·</span>
          <Plug className="h-3.5 w-3.5 text-[var(--muted)]" />
          <span className="font-medium">Plugins</span>
          <span className="text-[var(--muted)]">({merged.length})</span>
          {plugins.loading && <span className="text-[var(--muted)]">loading…</span>}
          {plugins.error && <span className="text-red-400">{plugins.error}</span>}
          {plugins.installedError && (
            <span className="text-amber-400">live status: {plugins.installedError}</span>
          )}
          <button
            onClick={() => plugins.refresh()}
            className="ml-auto flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-0.5 hover:bg-[var(--panel)]"
          >
            <RefreshCw className="h-3 w-3" /> Refresh
          </button>
          <button
            disabled={!sessionId}
            onClick={() => plugins.reload()}
            className="flex items-center gap-1 rounded-md bg-[var(--accent)] px-2 py-0.5 text-white hover:opacity-90 disabled:opacity-40"
            title={sessionId ? "Reload plugins from disk" : "Start a session to enable reload"}
          >
            <Power className="h-3 w-3" /> Reload
          </button>
        </header>

        <div className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--panel)]/40 px-4 py-2">
          {(["user", "project", "local"] as SettingsScope[]).map((s) => {
            const sc = plugins.scopes.find((x) => x.scope === s);
            const total = sc ? Object.values(sc.enabledPlugins).filter(Boolean).length : 0;
            return (
              <button
                key={s}
                onClick={() => setScope(s)}
                className={cn(
                  "rounded-md border border-[var(--border)] px-3 py-1 text-xs",
                  scope === s
                    ? "bg-[var(--panel-2)]"
                    : "bg-[var(--panel)] text-[var(--muted)] hover:text-[var(--foreground)]",
                )}
                title={sc?.path}
              >
                {SCOPE_LABELS[s]} <span className="ml-1 text-[10px] text-[var(--muted)]">{total}</span>
              </button>
            );
          })}
          <span className="ml-2 truncate font-mono text-[10px] text-[var(--muted)]">
            {active?.path ?? "—"}
          </span>
        </div>

        <div className="flex-1 overflow-y-auto scroll-thin">
          <div className="mx-auto max-w-4xl space-y-5 px-6 py-6">
            <InstallSection
              sessionId={sessionId}
              onInstall={(ref) => plugins.install(ref)}
              onRefresh={() => plugins.refresh()}
            />

            <AvailableSection
              plugins={plugins.available}
              loading={plugins.availableLoading}
              installedRefs={
                new Set(merged.map((r) => r.id).filter((id) => id.includes("@")))
              }
              sessionId={sessionId}
              onInstall={(ref) => plugins.install(ref)}
              onRefresh={() => plugins.refreshAvailable()}
            />

            <section>
              <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-[var(--muted)]">
                Installed plugins {!sessionId && "(open a session for live data)"}
              </h2>
              {merged.length === 0 ? (
                <div className="rounded-md border border-[var(--border)] bg-[var(--panel)]/40 px-4 py-8 text-center text-sm text-[var(--muted)]">
                  No plugins installed.
                </div>
              ) : (
                <ul className="space-y-1.5">
                  {merged.map((row) => (
                    <PluginRow
                      key={row.id}
                      id={row.id}
                      installed={row.installed}
                      enabledInScope={Boolean(active?.enabledPlugins?.[row.id])}
                      enabledInAnyScope={row.enabledIn}
                      onToggle={(enabled) => plugins.toggle(scope, row.id, enabled)}
                    />
                  ))}
                </ul>
              )}
            </section>

            {active && (
              <MarketplacesSection
                scope={scope}
                extra={active.extraKnownMarketplaces}
                strict={active.strictKnownMarketplaces}
                blocked={active.blockedMarketplaces}
                onChange={(patch) => plugins.setMarketplaces(scope, patch)}
              />
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

/**
 * Install a plugin by sending `/plugin install <ref>` to the active
 * session. The SDK's slash command owns marketplace resolution, download,
 * and registration — we just expose a friendly form.
 *
 * `ref` accepts:
 *   - <plugin-name>@<marketplace-id>  (e.g. frontend-design@claude-plugins-official)
 *   - any plugin id the SDK recognizes
 */
function InstallSection({
  sessionId,
  onInstall,
  onRefresh,
}: {
  sessionId: string | null;
  onInstall: (ref: string) => Promise<{ ok: boolean; error?: string }>;
  onRefresh: () => Promise<void> | void;
}) {
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);

  return (
    <section className="rounded-lg border border-[var(--border)] bg-[var(--panel)]/40 p-4">
      <h2 className="mb-2 flex items-center gap-2 text-sm font-medium">
        <Download className="h-4 w-4 text-[var(--accent)]" /> Install a plugin
      </h2>
      <p className="mb-3 text-[11px] text-[var(--muted)]">
        Sends <code className="font-mono">/plugin install &lt;ref&gt;</code> to your active
        chat session. Watch progress in chat — the SDK handles the marketplace lookup,
        download, and any prompts for trust or permissions. Refresh the list once it
        finishes.
      </p>

      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const v = draft.trim();
          if (!v) return;
          setSubmitting(true);
          setStatus(null);
          const r = await onInstall(v);
          setSubmitting(false);
          if (r.ok) {
            setStatus({
              ok: true,
              msg: `Sent “/plugin install ${v}” to chat. Watch progress there, then refresh.`,
            });
            setDraft("");
          } else {
            setStatus({ ok: false, msg: r.error ?? "Install failed." });
          }
        }}
        className="flex flex-wrap items-center gap-2"
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="frontend-design@claude-plugins-official"
          spellCheck={false}
          className="min-w-[280px] flex-1 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1 font-mono text-xs focus:outline-none"
        />
        <button
          type="submit"
          disabled={!sessionId || !draft.trim() || submitting}
          title={sessionId ? "Send install command to chat" : "Open a session first"}
          className="flex items-center gap-1 rounded-md bg-[var(--accent)] px-3 py-1 text-xs text-white hover:opacity-90 disabled:opacity-40"
        >
          <Download className="h-3 w-3" /> {submitting ? "Sending…" : "Install"}
        </button>
        <button
          type="button"
          onClick={() => void onRefresh()}
          className="flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1 text-xs hover:bg-[var(--panel)]"
          title="Refresh the installed list"
        >
          <RefreshCw className="h-3 w-3" /> Refresh
        </button>
      </form>

      {status && (
        <p
          className={cn(
            "mt-2 text-[11px]",
            status.ok ? "text-emerald-300" : "text-red-400",
          )}
        >
          {status.msg}
        </p>
      )}

      {!sessionId && (
        <p className="mt-2 text-[11px] text-amber-300">
          No active session for this workspace yet — open the chat once and come back.
        </p>
      )}

      <details className="mt-3 text-[11px] text-[var(--muted)]">
        <summary className="cursor-pointer select-none hover:text-[var(--foreground)]">
          What can I install?
        </summary>
        <div className="mt-2 space-y-1.5 pl-2">
          <div>
            <code className="font-mono">name@marketplace</code> — a plugin from a known
            marketplace, e.g. <code className="font-mono">frontend-design@claude-plugins-official</code>.
          </div>
          <div>
            A plain <code className="font-mono">name</code> if it&apos;s unique across known
            marketplaces. The SDK will disambiguate.
          </div>
          <div>
            Add custom marketplaces in the <em>Marketplaces</em> section below before
            referencing plugins from them.
          </div>
        </div>
      </details>
    </section>
  );
}

/**
 * Browse every plugin in the cached marketplaces. Filter by category or
 * free-text search. The Install button on each row delegates to the same
 * `/plugin install` slash-command path the manual form uses, with the
 * fully-qualified <name>@<marketplace> reference auto-filled.
 */
function AvailableSection({
  plugins,
  loading,
  installedRefs,
  sessionId,
  onInstall,
  onRefresh,
}: {
  plugins: AvailablePlugin[];
  loading: boolean;
  installedRefs: Set<string>;
  sessionId: string | null;
  onInstall: (ref: string) => Promise<{ ok: boolean; error?: string }>;
  onRefresh: () => Promise<void> | void;
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const p of plugins) if (p.category) set.add(p.category);
    return [...set].sort();
  }, [plugins]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return plugins.filter((p) => {
      if (category && p.category !== category) return false;
      if (!q) return true;
      const hay = `${p.name} ${p.description ?? ""} ${p.category ?? ""} ${p.marketplace}`.toLowerCase();
      return hay.includes(q);
    });
  }, [plugins, query, category]);

  return (
    <section className="rounded-lg border border-[var(--border)] bg-[var(--panel)]/40">
      <div className="flex items-center gap-2 border-b border-[var(--border)] px-4 py-2">
        <Package className="h-4 w-4 text-[var(--accent)]" />
        <h2 className="text-sm font-medium">Available plugins</h2>
        <span className="text-[11px] text-[var(--muted)]">
          {loading ? "loading…" : `${filtered.length} of ${plugins.length}`}
        </span>
        <button
          onClick={() => void onRefresh()}
          title="Re-read marketplace manifests from disk"
          className="ml-auto flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-0.5 text-[11px] hover:bg-[var(--panel)]"
        >
          <RefreshCw className="h-3 w-3" /> Refresh
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] px-4 py-2">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-[var(--muted)]" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name, description, marketplace…"
            className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] py-1 pl-7 pr-2 text-xs focus:outline-none"
          />
        </div>
        <button
          onClick={() => setCategory(null)}
          className={cn(
            "rounded-md border border-[var(--border)] px-2 py-0.5 text-[11px]",
            category === null ? "bg-[var(--panel-2)]" : "bg-[var(--panel)] text-[var(--muted)] hover:text-[var(--foreground)]",
          )}
        >
          all
        </button>
        {categories.map((c) => (
          <button
            key={c}
            onClick={() => setCategory(c === category ? null : c)}
            className={cn(
              "rounded-md border border-[var(--border)] px-2 py-0.5 text-[11px]",
              category === c ? "bg-[var(--panel-2)]" : "bg-[var(--panel)] text-[var(--muted)] hover:text-[var(--foreground)]",
            )}
          >
            {c}
          </button>
        ))}
      </div>

      {plugins.length === 0 && !loading ? (
        <div className="px-4 py-8 text-center text-sm text-[var(--muted)]">
          No marketplaces cached yet. Add one in the Marketplaces section below, then refresh.
        </div>
      ) : (
        <ul className="max-h-[480px] divide-y divide-[var(--border)] overflow-y-auto scroll-thin">
          {filtered.map((p) => {
            const ref = `${p.name}@${p.marketplace}`;
            const installedHere = installedRefs.has(ref);
            const authorName =
              typeof p.author === "string"
                ? p.author
                : p.author && typeof p.author === "object"
                  ? p.author.name
                  : undefined;
            const isInstallingThis = installing === ref;
            return (
              <li key={ref} className="flex items-start gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{p.name}</span>
                    {p.category && (
                      <span className="rounded-md bg-[var(--panel-2)] px-1.5 py-0.5 text-[10px] text-[var(--muted)]">
                        {p.category}
                      </span>
                    )}
                    <span className="font-mono text-[10px] text-[var(--muted)]">@{p.marketplace}</span>
                    {typeof p.installs === "number" && (
                      <span
                        title={`${p.installs.toLocaleString()} unique installs`}
                        className="rounded-md border border-[var(--border)] bg-[var(--panel)]/60 px-1.5 py-0.5 font-mono text-[10px] text-[var(--muted)]"
                      >
                        ↓ {formatInstalls(p.installs)}
                      </span>
                    )}
                    {p.homepage && (
                      <a
                        href={p.homepage}
                        target="_blank"
                        rel="noreferrer"
                        title={p.homepage}
                        className="text-[var(--muted)] hover:text-[var(--foreground)]"
                      >
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                  </div>
                  {p.description && (
                    <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-[var(--muted)]">
                      {p.description}
                    </p>
                  )}
                  {authorName && (
                    <p className="mt-1 text-[10px] text-[var(--muted)]">by {authorName}</p>
                  )}
                </div>
                {installedHere ? (
                  <span className="shrink-0 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-200">
                    installed
                  </span>
                ) : (
                  <button
                    disabled={!sessionId || isInstallingThis}
                    onClick={async () => {
                      setInstalling(ref);
                      await onInstall(ref);
                      setInstalling(null);
                    }}
                    title={sessionId ? `Send /plugin install ${ref}` : "Open a session first"}
                    className="flex shrink-0 items-center gap-1 rounded-md bg-[var(--accent)] px-2 py-1 text-[11px] text-white hover:opacity-90 disabled:opacity-40"
                  >
                    <Download className="h-3 w-3" />
                    {isInstallingThis ? "Sending…" : "Install"}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Compact install counts: 1.2k, 12k, 510k. */
function formatInstalls(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 10_000) return `${Math.round(n / 1_000)}k`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${n}`;
}

function PluginRow({
  id,
  installed,
  enabledInScope,
  enabledInAnyScope,
  onToggle,
}: {
  id: string;
  installed?: InstalledPlugin;
  enabledInScope: boolean;
  enabledInAnyScope: SettingsScope[];
  onToggle: (enabled: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li className="rounded-lg border border-[var(--border)] bg-[var(--panel)]/40">
      <div className="flex items-center gap-3 px-3 py-2">
        <button onClick={() => setOpen((o) => !o)} className="flex flex-1 items-center gap-2 text-left">
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          <Plug className="h-3.5 w-3.5 text-[var(--accent)]" />
          <span className="font-medium">{installed?.name ?? id}</span>
          {installed?.source && installed.source !== installed.name && (
            <span className="font-mono text-[10px] text-[var(--muted)]">{installed.source}</span>
          )}
          {enabledInAnyScope.length > 0 && (
            <span className="ml-2 inline-flex gap-1">
              {enabledInAnyScope.map((s) => (
                <span
                  key={s}
                  className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-200"
                >
                  {SCOPE_LABELS[s]}
                </span>
              ))}
            </span>
          )}
          {!installed && (
            <span className="ml-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-200">
              configured but not installed
            </span>
          )}
        </button>
        <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-[11px]">
          <input
            type="checkbox"
            checked={enabledInScope}
            onChange={(e) => onToggle(e.target.checked)}
            className="h-3.5 w-3.5"
          />
          <span>enabled here</span>
        </label>
      </div>
      {open && (
        <div className="border-t border-[var(--border)] px-3 py-2 text-[11px]">
          <div className="text-[var(--muted)]">id</div>
          <code className="mb-2 block break-all font-mono">{id}</code>
          {installed?.path && (
            <>
              <div className="text-[var(--muted)]">path</div>
              <code className="block break-all font-mono">{installed.path}</code>
            </>
          )}
        </div>
      )}
    </li>
  );
}

function MarketplacesSection({
  scope,
  extra,
  strict,
  blocked,
  onChange,
}: {
  scope: SettingsScope;
  extra: string[];
  strict: boolean;
  blocked: string[];
  onChange: (patch: {
    extraKnownMarketplaces?: string[];
    strictKnownMarketplaces?: boolean;
    blockedMarketplaces?: string[];
  }) => void;
}) {
  void scope;
  return (
    <section className="rounded-lg border border-[var(--border)] bg-[var(--panel)]/40 p-4">
      <h2 className="mb-2 flex items-center gap-2 text-sm font-medium">
        <ShieldCheck className="h-4 w-4 text-[var(--accent)]" /> Marketplaces
      </h2>
      <p className="mb-3 text-[11px] text-[var(--muted)]">
        Strict mode disallows installing plugins from any marketplace not explicitly known. Blocked
        marketplaces are always rejected even when strict mode is off.
      </p>

      <label className="mb-3 flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={strict}
          onChange={(e) => onChange({ strictKnownMarketplaces: e.target.checked })}
          className="h-3.5 w-3.5"
        />
        <span>strictKnownMarketplaces</span>
      </label>

      <UrlList
        title="Extra known marketplaces"
        values={extra}
        onChange={(next) => onChange({ extraKnownMarketplaces: next })}
        placeholder="git+https://example.com/my-marketplace"
      />
      <UrlList
        title="Blocked marketplaces"
        values={blocked}
        onChange={(next) => onChange({ blockedMarketplaces: next })}
        placeholder="https://malicious.example.com"
      />
    </section>
  );
}

function UrlList({
  title,
  values,
  onChange,
  placeholder,
}: {
  title: string;
  values: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
}) {
  const [draft, setDraft] = useState("");
  return (
    <div className="mt-3">
      <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--muted)]">{title}</div>
      <ul className="space-y-1">
        {values.map((v) => (
          <li key={v} className="flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--panel-2)]/40 px-2 py-1">
            <code className="flex-1 truncate font-mono text-[11px]">{v}</code>
            <button
              onClick={() => onChange(values.filter((x) => x !== v))}
              className="rounded p-0.5 text-[var(--muted)] hover:bg-[var(--panel)] hover:text-red-400"
              title="Remove"
            >
              <X className="h-3 w-3" />
            </button>
          </li>
        ))}
      </ul>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const v = draft.trim();
          if (!v || values.includes(v)) return;
          onChange([...values, v]);
          setDraft("");
        }}
        className="mt-1 flex gap-1"
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={placeholder}
          className="flex-1 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1 font-mono text-xs focus:outline-none"
        />
        <button
          type="submit"
          disabled={!draft.trim()}
          className="rounded-md bg-[var(--accent)] p-1 text-white hover:opacity-90 disabled:opacity-40"
          title="Add"
        >
          <Plus className="h-3 w-3" />
        </button>
      </form>
    </div>
  );
}
