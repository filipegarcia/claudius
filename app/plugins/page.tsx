"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import {
  AlertTriangle,
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
  Settings2,
  ShieldCheck,
  X,
} from "lucide-react";
import { SideNav } from "@/components/nav/SideNav";
import { useActiveCwd } from "@/lib/client/useActiveCwd";
import { usePlugins, type InstalledPlugin } from "@/lib/client/usePlugins";
import type { AvailablePlugin } from "@/lib/server/plugins";
import type { SettingsScope } from "@/lib/server/settings";
import type { PluginLoadError } from "@/lib/shared/parse-init";
import { lintMarketplaceName, lintMarketplaceRef, lintPluginRef } from "@/lib/shared/plugin-ref-lint";
import type {
  ExtraMarketplaceView,
  MarketplaceSource,
  MarketplaceSourceView,
} from "@/lib/shared/marketplace-settings";
import {
  currentOptionValue,
  readPluginOptions,
  type PluginConfigOption,
  type PluginOptionValue,
} from "@/lib/shared/plugin-config";
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
  // CC 2.1.295 parity — the last refused enable/disable (e.g. the 422 for a
  // settings file that doesn't load). Cleared on scope switch / next success.
  const [toggleError, setToggleError] = useState<string | null>(null);

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
  // A refused toggle belongs to this workspace's settings file: drop it when
  // the workspace changes or once that file loads again.
  const parseError = active?.parseError ?? null;
  const [toggleErrorCtx, setToggleErrorCtx] = useState({ cwd, parseError });
  if (toggleErrorCtx.cwd !== cwd || toggleErrorCtx.parseError !== parseError) {
    setToggleErrorCtx({ cwd, parseError });
    if (toggleErrorCtx.cwd !== cwd || !parseError) setToggleError(null);
  }
  // `/plugin install` records the plugin in user settings by default.
  const userScope = plugins.scopes.find((s) => s.scope === "user");

  return (
    <div className="flex h-full">
      <SideNav running={false} />
      <main data-pane-name="plugins-main" className="flex h-full flex-1 flex-col overflow-hidden">
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
                data-testid={`plugin-scope-tab-${s}`}
                onClick={() => {
                  setScope(s);
                  setToggleError(null);
                }}
                className={cn(
                  "flex items-center rounded-md border border-[var(--border)] px-3 py-1 text-xs",
                  scope === s
                    ? "bg-[var(--panel-2)]"
                    : "bg-[var(--panel)] text-[var(--muted)] hover:text-[var(--foreground)]",
                  sc?.parseError && "border-amber-500/40",
                )}
                title={sc?.parseError ? `${sc.path} doesn't load (${sc.parseError})` : sc?.path}
              >
                {SCOPE_LABELS[s]} <span className="ml-1 text-[10px] text-[var(--muted)]">{total}</span>
                {sc?.parseError && <AlertTriangle className="ml-1 h-3 w-3 text-amber-400" />}
              </button>
            );
          })}
          <span className="ml-2 truncate font-mono text-[10px] text-[var(--muted)]">
            {active?.path ?? "—"}
          </span>
        </div>

        <div className="flex-1 overflow-y-auto scroll-thin">
          <div className="mx-auto max-w-4xl space-y-5 px-6 py-6">
            {active?.parseError && (
              <SettingsInvalidBanner
                scope={scope}
                path={active.path}
                reason={active.parseError}
              />
            )}

            <InstallSection
              sessionId={sessionId}
              onInstall={(ref) => plugins.install(ref)}
              onRefresh={() => plugins.refresh()}
              userSettingsError={
                userScope?.parseError ? { path: userScope.path, reason: userScope.parseError } : null
              }
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

            <PluginErrorsSection errors={plugins.pluginErrors} />

            <section>
              <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-[var(--muted)]">
                Installed plugins {!sessionId && "(open a session for live data)"}
              </h2>
              {toggleError && (
                <p
                  data-testid="plugin-toggle-error"
                  role="alert"
                  className="mb-2 flex items-start gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-100"
                >
                  <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0 text-amber-400" />
                  <span className="min-w-0 [overflow-wrap:anywhere]">{toggleError}</span>
                </p>
              )}
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
                      onToggle={async (enabled) => {
                        const r = await plugins.toggle(scope, row.id, enabled);
                        setToggleError(r.ok ? null : (r.error ?? "Failed to update plugin."));
                      }}
                      scope={scope}
                      optionValues={readPluginOptions(active?.pluginConfigs, row.id)}
                      onSetOption={(name, value) => plugins.setPluginOption(scope, row.id, name, value)}
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
                legacyExtra={active.legacyExtra}
                onAddExtra={(name, source) => plugins.addExtraMarketplace(scope, name, source)}
                onRemoveExtra={(name) => plugins.removeExtraMarketplace(scope, name)}
                onRemovePolicy={(list, index) => plugins.removePolicyMarketplace(scope, list, index)}
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
  userSettingsError,
}: {
  sessionId: string | null;
  onInstall: (ref: string) => Promise<{ ok: boolean; error?: string }>;
  onRefresh: () => Promise<void> | void;
  /** CC 2.1.295 parity — user settings (where installs are recorded) don't load. */
  userSettingsError: { path: string; reason: string } | null;
}) {
  const [draft, setDraft] = useState("");
  // Claude Code 2.1.275 — `/plugin install <plugin> --marketplace <source>`:
  // offer to add the marketplace before installing, instead of requiring a
  // separate trip through the Marketplaces section first. Optional — most
  // installs still target an already-known marketplace via `name@id`.
  const [marketplaceSource, setMarketplaceSource] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const composedRef = marketplaceSource.trim()
    ? `${draft.trim()} --marketplace ${marketplaceSource.trim()}`
    : draft.trim();
  const draftLint = lintPluginRef(composedRef);

  return (
    <section className="rounded-lg border border-[var(--border)] bg-[var(--panel)]/40 p-4">
      <h2 className="mb-2 flex items-center gap-2 text-sm font-medium">
        <Download className="h-4 w-4 text-[var(--accent)]" /> Install a plugin
      </h2>
      <p className="mb-3 text-[11px] text-[var(--muted)]">
        Sends <code className="font-mono">/plugin install &lt;ref&gt;</code> to your active
        chat session. Watch progress in chat — the SDK handles the marketplace lookup,
        download, and any prompts for trust or permissions. The list refreshes itself once
        the install finishes.
      </p>

      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const v = composedRef;
          if (!v) return;
          setSubmitting(true);
          setStatus(null);
          const r = await onInstall(v);
          setSubmitting(false);
          if (r.ok) {
            setStatus({
              ok: true,
              msg: `Sent “/plugin install ${v}” to chat. Watch progress there — the list refreshes automatically.`,
            });
            setDraft("");
            setMarketplaceSource("");
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
        <input
          value={marketplaceSource}
          onChange={(e) => setMarketplaceSource(e.target.value)}
          placeholder="marketplace source (optional) — e.g. owner/repo"
          spellCheck={false}
          data-testid="plugin-install-marketplace-source"
          title="Offer to add this marketplace before installing, instead of adding it separately below first"
          className="min-w-[220px] flex-1 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1 font-mono text-xs focus:outline-none"
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

      {draftLint && (
        <p
          data-testid="plugin-ref-warning"
          className="mt-2 flex items-start gap-1 text-[11px] text-amber-400"
        >
          <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
          <span>{draftLint.message} It will still send as typed.</span>
        </p>
      )}

      {userSettingsError && (
        <p
          data-testid="plugin-install-settings-invalid"
          className="mt-2 flex items-start gap-1 text-[11px] text-amber-400"
        >
          <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
          <span>
            Installs are recorded in{" "}
            <code className="break-all font-mono">{userSettingsError.path}</code>, which doesn&apos;t
            load ({userSettingsError.reason}). Fix it first, or the plugin won&apos;t be enabled.
          </span>
        </p>
      )}

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
            referencing plugins from them — or fill in the marketplace source field
            above to have the SDK offer to add it as part of this install.
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
      const hay = `${p.name} ${p.displayName ?? ""} ${p.description ?? ""} ${p.category ?? ""} ${p.marketplace}`.toLowerCase();
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
                    <span className="font-medium">{p.displayName ?? p.name}</span>
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

/**
 * CC 2.1.295 parity — "Added a warning to claude plugin install, enable,
 * disable and marketplace add when the settings file they write to does not
 * load". The active scope's settings file exists but isn't valid JSON, so
 * the scope is shown empty and every write to it is refused (422) rather than
 * overwriting the user's file.
 */
function SettingsInvalidBanner({
  scope,
  path,
  reason,
}: {
  scope: SettingsScope;
  path: string;
  reason: string;
}) {
  return (
    <section
      data-testid="plugin-settings-invalid"
      role="alert"
      className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px]"
    >
      <div className="flex items-center gap-1.5 font-medium text-amber-300">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        {SCOPE_LABELS[scope]} settings file doesn&apos;t load
      </div>
      <code className="mt-1 block break-all font-mono text-[10px] text-amber-200/80">{path}</code>
      <p className="mt-1 leading-relaxed text-amber-100/90">
        {reason}. Plugins and marketplaces in this scope are shown empty, and enabling, disabling,
        adding a marketplace or changing plugin options here is refused until the file is fixed —
        Claudius won&apos;t overwrite it.
      </p>
    </section>
  );
}

/**
 * Plugin load-time errors from the session's `system:init` (SDK 0.3.283
 * `plugin_errors`). A plugin that failed to load entirely is otherwise just
 * *absent* from the installed list — a silent gap. Surfacing the error here,
 * above the list, turns "it's not there" into "it's not there, and here's
 * why". Renders nothing when the load was clean.
 *
 * `type` is an open set — we show it verbatim as a label rather than mapping
 * to friendly copy, so a category the SDK adds later still reads sensibly.
 */
function PluginErrorsSection({ errors }: { errors: PluginLoadError[] }) {
  if (errors.length === 0) return null;
  return (
    <section data-testid="plugin-load-errors">
      <h2 className="mb-1 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-amber-400">
        <AlertTriangle className="h-3.5 w-3.5" />
        Plugin load {errors.length === 1 ? "error" : "errors"} ({errors.length})
      </h2>
      <p className="mb-2 text-[11px] text-[var(--muted)]">
        Reported when this session loaded plugins. Fix the cause, then press{" "}
        <span className="font-medium">Reload</span> above to re-check.
      </p>
      <ul className="space-y-1.5">
        {errors.map((e, i) => (
          <li
            key={`${e.plugin}:${e.type}:${i}`}
            data-testid="plugin-load-error"
            className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px]"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono font-medium text-amber-100">{e.plugin}</span>
              <span className="rounded-md border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 font-mono text-[10px] text-amber-200">
                {e.type}
              </span>
            </div>
            <p className="mt-1 leading-relaxed text-amber-100/90">{e.message}</p>
            {e.path && (
              <code className="mt-1 block break-all font-mono text-[10px] text-amber-200/70">
                {e.path}
              </code>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function PluginRow({
  id,
  installed,
  enabledInScope,
  enabledInAnyScope,
  onToggle,
  scope,
  optionValues,
  onSetOption,
}: {
  id: string;
  installed?: InstalledPlugin;
  enabledInScope: boolean;
  enabledInAnyScope: SettingsScope[];
  onToggle: (enabled: boolean) => Promise<void> | void;
  scope: SettingsScope;
  optionValues: Record<string, PluginOptionValue>;
  onSetOption: (
    name: string,
    value: PluginOptionValue | undefined,
  ) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li className="rounded-lg border border-[var(--border)] bg-[var(--panel)]/40">
      <div className="flex items-center gap-3 px-3 py-2">
        <button onClick={() => setOpen((o) => !o)} className="flex flex-1 items-center gap-2 text-left">
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          <Plug className="h-3.5 w-3.5 text-[var(--accent)]" />
          <span className="font-medium">{installed?.displayName ?? installed?.name ?? id}</span>
          {installed?.version && (
            <span
              data-testid="plugin-version"
              className="rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--muted)]"
              title="Version declared in the plugin's manifest (plugin-author-controlled)"
            >
              v{installed.version}
            </span>
          )}
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
            onChange={(e) => void onToggle(e.target.checked)}
            className="h-3.5 w-3.5"
          />
          <span>enabled here</span>
        </label>
      </div>
      {open && (
        <div className="border-t border-[var(--border)] px-3 py-2 text-[11px]">
          {/* CC 2.1.265 (G2) — description from the plugin's plugin.json. */}
          {installed?.description && (
            <p className="mb-2 text-[var(--foreground)]/80">{installed.description}</p>
          )}
          <div className="text-[var(--muted)]">id</div>
          <code className="mb-2 block break-all font-mono">{id}</code>
          {installed?.path && (
            <>
              <div className="text-[var(--muted)]">path</div>
              <code className="block break-all font-mono">{installed.path}</code>
            </>
          )}
          {installed?.userConfig && installed.userConfig.length > 0 && (
            <PluginOptionsForm
              options={installed.userConfig}
              values={optionValues}
              scope={scope}
              onSetOption={onSetOption}
            />
          )}
        </div>
      )}
    </li>
  );
}

/**
 * CC 2.1.285 (G3) — the plugin options form. Renders each `userConfig` option
 * by type (text / number / checkbox / enum select), prefilled with the current
 * value or the manifest default, and persists non-sensitive edits to
 * `pluginConfigs.<id>.options` in the active scope. Sensitive options are
 * shown read-only — the CLI stores those in secure storage, which Claudius's
 * plaintext settings.json intentionally won't do.
 */
function PluginOptionsForm({
  options,
  values,
  scope,
  onSetOption,
}: {
  options: PluginConfigOption[];
  values: Record<string, PluginOptionValue>;
  scope: SettingsScope;
  onSetOption: (
    name: string,
    value: PluginOptionValue | undefined,
  ) => Promise<{ ok: boolean; error?: string }>;
}) {
  // CC 2.1.295 parity — a refused write (e.g. the 422 for a settings file
  // that doesn't load) is shown here instead of the edit silently reverting.
  const [error, setError] = useState<string | null>(null);
  const setOption = async (name: string, value: PluginOptionValue | undefined) => {
    const r = await onSetOption(name, value);
    setError(r.ok ? null : (r.error ?? "Failed to update plugin option."));
  };
  return (
    <div className="mt-2 border-t border-[var(--border)] pt-2">
      <div className="mb-1 flex items-center gap-1.5 text-[var(--muted)]">
        <Settings2 className="h-3 w-3" /> Options
        <span className="font-mono text-[10px]">({scope})</span>
      </div>
      {error && (
        <p
          data-testid="plugin-option-error"
          role="alert"
          className="mb-2 flex items-start gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-100"
        >
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0 text-amber-400" />
          <span className="min-w-0 [overflow-wrap:anywhere]">{error}</span>
        </p>
      )}
      <div className="space-y-2">
        {options.map((o) => {
          // CC 2.1.295 parity — own-key lookup, so an option named
          // `constructor` / `toString` / … reads its own value or default.
          const val = currentOptionValue(values, o);
          const label = (
            <div className="min-w-0">
              <div className="font-mono text-[11px]">{o.title ?? o.name}</div>
              {o.description && <div className="text-[10px] text-[var(--muted)]">{o.description}</div>}
            </div>
          );
          if (o.sensitive) {
            return (
              <div key={o.name} className="flex items-start justify-between gap-2">
                {label}
                <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-amber-400">
                  sensitive — set via CLI
                </span>
              </div>
            );
          }
          let control: ReactNode;
          if (o.type === "boolean") {
            control = (
              <input
                data-testid={`plugin-option-${o.name}`}
                type="checkbox"
                checked={val === true}
                onChange={(e) => void setOption(o.name, e.target.checked)}
                className="h-3.5 w-3.5 shrink-0"
              />
            );
          } else if (o.type === "enum") {
            control = (
              <select
                data-testid={`plugin-option-${o.name}`}
                value={typeof val === "string" ? val : ""}
                onChange={(e) => void setOption(o.name, e.target.value || undefined)}
                className="w-40 shrink-0 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-1.5 py-1 text-[11px] focus:outline-none"
              >
                <option value="">(default)</option>
                {o.options?.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
              </select>
            );
          } else if (o.type === "number") {
            control = (
              <input
                data-testid={`plugin-option-${o.name}`}
                type="number"
                defaultValue={typeof val === "number" ? val : ""}
                onBlur={(e) =>
                  void setOption(o.name, e.target.value === "" ? undefined : Number(e.target.value))
                }
                className="w-40 shrink-0 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1 font-mono text-[11px] focus:outline-none"
              />
            );
          } else {
            control = (
              <input
                data-testid={`plugin-option-${o.name}`}
                defaultValue={typeof val === "string" ? val : ""}
                placeholder="(default)"
                onBlur={(e) => void setOption(o.name, e.target.value === "" ? undefined : e.target.value)}
                className="w-40 shrink-0 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1 font-mono text-[11px] focus:outline-none"
              />
            );
          }
          return (
            <div key={o.name} className="flex items-start justify-between gap-2">
              {label}
              {control}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MarketplacesSection({
  scope,
  extra,
  strict,
  blocked,
  legacyExtra,
  onAddExtra,
  onRemoveExtra,
  onRemovePolicy,
}: {
  scope: SettingsScope;
  extra: ExtraMarketplaceView[];
  strict: MarketplaceSourceView[];
  blocked: MarketplaceSourceView[];
  legacyExtra: boolean;
  onAddExtra: (name: string, source: MarketplaceSource) => Promise<{ ok: boolean; error?: string }>;
  onRemoveExtra: (name: string) => Promise<{ ok: boolean; error?: string }>;
  onRemovePolicy: (
    list: "strict" | "blocked",
    index: number,
  ) => Promise<{ ok: boolean; error?: string }>;
}) {
  void scope;
  return (
    <section className="rounded-lg border border-[var(--border)] bg-[var(--panel)]/40 p-4">
      <h2 className="mb-2 flex items-center gap-2 text-sm font-medium">
        <ShieldCheck className="h-4 w-4 text-[var(--accent)]" /> Marketplaces
      </h2>
      <p className="mb-3 text-[11px] text-[var(--muted)]">
        Pre-register named marketplaces so <code className="font-mono">plugin@name</code> refs
        resolve. Rich source fields (auth headers, npm registries, monorepo paths) are preserved but
        edited in settings.json directly.
      </p>

      <ExtraList
        extra={extra}
        legacyExtra={legacyExtra}
        onAdd={onAddExtra}
        onRemove={onRemoveExtra}
      />

      <PolicyList
        title="Allowed sources (strictKnownMarketplaces)"
        entries={strict}
        onRemove={(i) => onRemovePolicy("strict", i)}
      />
      <PolicyList
        title="Blocked sources (blockedMarketplaces)"
        entries={blocked}
        onRemove={(i) => onRemovePolicy("blocked", i)}
      />
      <p className="mt-2 text-[10px] text-[var(--muted)]">
        The allowed/blocked lists are enterprise policy — honored only from managed settings. Shown
        here read-only; remove clears a stale or legacy entry.
      </p>
    </section>
  );
}

/** One redacted source row: label + kind + header/helper/legacy indicators. */
function SourceRow({ view }: { view: MarketplaceSourceView }) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1.5">
      <code className="truncate font-mono text-[11px]">{view.label || "(empty)"}</code>
      <span className="shrink-0 rounded bg-[var(--panel)] px-1 text-[9px] uppercase tracking-wide text-[var(--muted)]">
        {view.kind}
      </span>
      {view.legacy && (
        <span className="shrink-0 rounded bg-amber-500/15 px-1 text-[9px] uppercase tracking-wide text-amber-400">
          legacy
        </span>
      )}
      {view.headerKeys.length > 0 && (
        <span
          className="shrink-0 text-[9px] text-[var(--muted)]"
          title={`Auth headers: ${view.headerKeys.join(", ")} (values hidden)`}
        >
          🔑 {view.headerKeys.length}
        </span>
      )}
      {view.hasHeadersHelper && (
        <span className="shrink-0 text-[9px] text-[var(--muted)]" title="headersHelper command (hidden)">
          ⚙
        </span>
      )}
    </span>
  );
}

/** `extraKnownMarketplaces` — named rows + an add form (github / url). */
function ExtraList({
  extra,
  legacyExtra,
  onAdd,
  onRemove,
}: {
  extra: ExtraMarketplaceView[];
  legacyExtra: boolean;
  onAdd: (name: string, source: MarketplaceSource) => Promise<{ ok: boolean; error?: string }>;
  onRemove: (name: string) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"github" | "url">("github");
  const [ref, setRef] = useState("");
  const [error, setError] = useState<string | null>(null);
  const refLint = kind === "github" ? lintMarketplaceRef(ref, { allowWildcard: false }) : null;
  const draftSource: MarketplaceSource =
    kind === "github" ? { source: "github", repo: ref.trim() } : { source: "url", url: ref.trim() };
  // CC 2.1.295 parity — refuse a name no plugin can be installed under
  // (`<plugin>@<marketplace>`) or a reserved Anthropic name from a
  // non-`anthropics/` source, as the user types (the server refuses it too).
  const nameLint = lintMarketplaceName(name, draftSource);

  const submit = async () => {
    setError(null);
    const res = await onAdd(name, draftSource);
    if (res.ok) {
      setName("");
      setRef("");
    } else {
      setError(res.error ?? "Failed to add");
    }
  };

  return (
    <div className="mt-3">
      <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--muted)]">
        Extra known marketplaces
      </div>
      <ul className="space-y-1">
        {extra.map((m) => (
          <li
            key={m.name}
            className="flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--panel-2)]/40 px-2 py-1"
          >
            <span className="shrink-0 font-mono text-[11px] text-[var(--accent)]">{m.name}</span>
            <SourceRow view={m} />
            <button
              onClick={() => {
                // CC 2.1.295 parity — surface a refused write (settings file
                // doesn't load) instead of dropping the result.
                setError(null);
                void onRemove(m.name).then((r) => {
                  if (!r.ok) setError(r.error ?? "Failed to remove");
                });
              }}
              className="shrink-0 rounded p-0.5 text-[var(--muted)] hover:bg-[var(--panel)] hover:text-red-400"
              title="Remove"
            >
              <X className="h-3 w-3" />
            </button>
          </li>
        ))}
      </ul>
      {legacyExtra ? (
        <p className="mt-1 flex items-start gap-1 text-[10px] text-amber-400">
          <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
          <span>Legacy string entries present — remove them above before adding named marketplaces.</span>
        </p>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim() || !ref.trim() || refLint || nameLint) return;
            void submit();
          }}
          className="mt-1 flex flex-wrap gap-1"
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="name"
            data-testid="marketplace-name-input"
            aria-invalid={!!nameLint}
            className="w-28 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1 font-mono text-xs focus:outline-none"
          />
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as "github" | "url")}
            className="rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-1.5 py-1 text-xs focus:outline-none"
          >
            <option value="github">github</option>
            <option value="url">url</option>
          </select>
          <input
            value={ref}
            onChange={(e) => setRef(e.target.value)}
            placeholder={kind === "github" ? "owner/repo" : "https://…/marketplace.json"}
            data-testid="marketplace-source-input"
            className="min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1 font-mono text-xs focus:outline-none"
          />
          <button
            type="submit"
            disabled={!name.trim() || !ref.trim() || !!refLint || !!nameLint}
            data-testid="marketplace-add-button"
            className="rounded-md bg-[var(--accent)] p-1 text-white hover:opacity-90 disabled:opacity-40"
            title="Add"
          >
            <Plus className="h-3 w-3" />
          </button>
        </form>
      )}
      {nameLint && (
        <p
          data-testid="marketplace-name-warning"
          className="mt-1 flex items-start gap-1 text-[10px] text-amber-400"
        >
          <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
          <span>{nameLint.message}</span>
        </p>
      )}
      {(refLint || error) && (
        <p
          data-testid="marketplace-ref-warning"
          className="mt-1 flex items-start gap-1 text-[10px] text-amber-400"
        >
          <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
          <span>{error ?? refLint?.message}</span>
        </p>
      )}
    </div>
  );
}

/** A read-only policy list (strict/blocked) with per-row remove. */
function PolicyList({
  title,
  entries,
  onRemove,
}: {
  title: string;
  entries: MarketplaceSourceView[];
  onRemove: (index: number) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="mt-3">
      <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--muted)]">{title}</div>
      {entries.length === 0 ? (
        <p className="text-[10px] italic text-[var(--muted)]">None.</p>
      ) : (
        <ul className="space-y-1">
          {entries.map((e, i) => (
            <li
              key={i}
              className="flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--panel-2)]/40 px-2 py-1"
            >
              <SourceRow view={e} />
              <button
                onClick={() => {
                  setError(null);
                  void onRemove(i).then((r) => {
                    if (!r.ok) setError(r.error ?? "Failed to remove");
                  });
                }}
                className="shrink-0 rounded p-0.5 text-[var(--muted)] hover:bg-[var(--panel)] hover:text-red-400"
                title="Remove"
              >
                <X className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p
          data-testid="marketplace-policy-error"
          className="mt-1 flex items-start gap-1 text-[10px] text-amber-400"
        >
          <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}
