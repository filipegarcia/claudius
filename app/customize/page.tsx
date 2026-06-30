"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
// `useEffect` stays in the import list because the file uses it elsewhere
// (theme/help-overlay wiring). The data-fetch effect below was rewritten
// to put setState in `.then`/`.catch`/`.finally` callbacks instead of
// firing them synchronously in the effect body, satisfying
// `react-hooks/set-state-in-effect`.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { WandSparkles, Plus, RefreshCw, Loader2, ExternalLink, HelpCircle, Trash2, Power, PowerOff } from "lucide-react";
import { SideNav } from "@/components/nav/SideNav";
import { CustomizeHelpOverlay } from "@/components/overlays/CustomizeHelpOverlay";
import type { Customization, PublishRecord } from "@/lib/server/customizations-store";

const HELP_SEEN_KEY = "claudius.customize.help-seen";

type ListResponse = { customizations: Customization[]; publishes: PublishRecord[] };

export default function CustomizePage() {
  const router = useRouter();
  const [items, setItems] = useState<Customization[]>([]);
  const [publishes, setPublishes] = useState<PublishRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // First-visit auto-open: derive initial state from localStorage so we
  // don't trigger a setState-in-effect cascade. The "seen" flag is written
  // when the user closes the overlay (see the onClose handler below).
  const [helpOpen, setHelpOpen] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return !window.localStorage.getItem(HELP_SEEN_KEY);
  });

  const [refetchTrigger, setRefetchTrigger] = useState(0);

  useEffect(() => {
    const controller = new AbortController();

    fetch("/api/customizations", { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as ListResponse;
      })
      .then((d) => {
        setItems(d.customizations);
        setPublishes(d.publishes);
        setError(null);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [refetchTrigger]);

  const refresh = useCallback(() => {
    setLoading(true);
    setRefetchTrigger((n) => n + 1);
  }, []);

  const onCreate = useCallback(async () => {
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/customizations", { method: "POST" });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      const d = (await res.json()) as { customization: Customization };
      // Make the new customization the active context, then land on its detail
      // page (preview / publish / description / sync). The drawer's quick-create
      // is the path that jumps straight to chat; the manage page lands here.
      await fetch(`/api/customizations/${d.customization.id}/select`, { method: "POST" });
      router.push(`/customize/${d.customization.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }, [router]);

  const activePublishCountById = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of publishes) {
      if (p.revertedAt != null) continue;
      map.set(p.customizationId, (map.get(p.customizationId) ?? 0) + 1);
    }
    return map;
  }, [publishes]);

  const [togglingId, setTogglingId] = useState<string | null>(null);

  const onActivate = useCallback(
    async (c: Customization) => {
      const msg =
        `Activate "${c.name}"?\n\n` +
        `Claudius will publish your changes — base files in the live install will be overwritten ` +
        `with the customization's version, with snapshots taken first so a deactivate / revert can restore them.`;
      if (!confirm(msg)) return;
      setTogglingId(c.id);
      setError(null);
      try {
        const res = await fetch(`/api/customizations/${c.id}/publish`, { method: "POST" });
        if (!res.ok) {
          const e = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(e.error ?? `HTTP ${res.status}`);
        }
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setTogglingId(null);
      }
    },
    [refresh],
  );

  const onDeactivate = useCallback(
    async (c: Customization, activeCount: number) => {
      const msg =
        `Deactivate "${c.name}"?\n\n` +
        `Will revert ${activeCount} active publish${activeCount === 1 ? "" : "es"} — base files restored ` +
        `from snapshots. Your customization source is untouched; you can activate again later.`;
      if (!confirm(msg)) return;
      setTogglingId(c.id);
      setError(null);
      try {
        const res = await fetch(`/api/customizations/${c.id}/deactivate`, { method: "POST" });
        if (!res.ok && res.status !== 207) {
          const e = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(e.error ?? `HTTP ${res.status}`);
        }
        const body = (await res.json()) as { reverted: number; errors?: { publishId: string; error: string }[] };
        if (body.errors && body.errors.length > 0) {
          setError(
            `Reverted ${body.reverted}, but ${body.errors.length} failed: ` +
              body.errors.map((e) => `${e.publishId} (${e.error})`).join("; "),
          );
        }
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setTogglingId(null);
      }
    },
    [refresh],
  );

  const onDelete = useCallback(
    async (c: Customization) => {
      const activeCount = activePublishCountById.get(c.id) ?? 0;
      const msg = activeCount > 0
        ? `"${c.name}" has ${activeCount} active publish(es). Revert them first, then delete.`
        : `Delete "${c.name}"? Source files and snapshots will be removed. This cannot be undone.`;
      if (activeCount > 0) {
        alert(msg);
        return;
      }
      if (!confirm(msg)) return;
      setError(null);
      try {
        const res = await fetch(`/api/customizations/${c.id}`, { method: "DELETE" });
        if (!res.ok) {
          const e = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(e.error ?? `HTTP ${res.status}`);
        }
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [activePublishCountById, refresh],
  );

  return (
    <div className="flex h-full">
      <SideNav />
      <main className="flex h-full flex-1 flex-col overflow-hidden" data-pane-name="customize-main">
        <header className="flex items-center justify-between border-b border-[var(--border)] px-6 py-4">
          <div className="flex items-center gap-3">
            <WandSparkles className="h-5 w-5 text-[var(--accent)]" />
            <div>
              <h1 className="text-lg font-semibold">Customize Claudius</h1>
              <p className="text-xs text-[var(--muted)]">
                Modify Claudius itself in an isolated mirror, preview before publishing, revert if anything breaks.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setHelpOpen(true)}
              title="Help & instructions"
              className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)]"
            >
              <HelpCircle className="h-4 w-4" />
            </button>
            <button
              onClick={() => void refresh()}
              title="Refresh"
              className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)]"
            >
              <RefreshCw className="h-4 w-4" />
            </button>
            <button
              onClick={() => void onCreate()}
              disabled={creating}
              className="flex items-center gap-2 rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              New customization
            </button>
          </div>
        </header>

        <div className="flex-1 overflow-auto px-6 py-5">
          {error && (
            <div className="mb-4 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
              {error}
            </div>
          )}

          <section className="mb-6 rounded-md border border-[var(--border)] bg-[var(--panel)] p-4 text-sm leading-relaxed text-[var(--muted)]">
            <p className="mb-2 text-[var(--foreground)] font-medium">How this works</p>
            <ol className="list-decimal pl-5 space-y-1">
              <li>
                Click <span className="text-[var(--foreground)]">New customization</span> — Claudius mirrors its source into a private dir under <code className="text-[var(--foreground)]">~/.claude/.claudius/customizations/</code> and creates a workspace pointing there.
              </li>
              <li>
                In that workspace, chat with Claude Code as usual. Edits stay isolated from the running Claudius.
              </li>
              <li>
                Open a preview (auto-spawned on a separate port) to test changes safely.
              </li>
              <li>
                When you&apos;re happy, hit <span className="text-[var(--foreground)]">Publish</span>. Snapshots of the displaced base files are kept for revert.
              </li>
              <li>
                If a publish breaks the UI, run <code className="text-[var(--foreground)]">make claudius-revert</code> from the terminal — it doesn&apos;t need Claudius running.
              </li>
            </ol>
          </section>

          <h2 className="mb-2 text-sm font-medium text-[var(--muted)]">Your customizations</h2>
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-[var(--muted)]">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : items.length === 0 ? (
            <div className="rounded-md border border-dashed border-[var(--border)] px-4 py-8 text-center text-sm text-[var(--muted)]">
              You don&apos;t have any customizations yet. Create one to start editing Claudius itself.
            </div>
          ) : (
            <ul className="space-y-2">
              {items.map((c) => {
                const activeCount = activePublishCountById.get(c.id) ?? 0;
                return (
                  <li
                    key={c.id}
                    className="flex items-center justify-between rounded-md border border-[var(--border)] bg-[var(--panel)] px-3 py-2"
                  >
                    <div className="min-w-0 pr-3">
                      <div className="flex items-center gap-2">
                        <WandSparkles className="h-4 w-4 text-[var(--accent)] shrink-0" />
                        <span className="truncate font-medium">{c.name}</span>
                        {activeCount > 0 && (
                          <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-300">
                            {activeCount} published
                          </span>
                        )}
                      </div>
                      {c.description ? (
                        <p
                          className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-[var(--muted)]"
                          title={c.description}
                        >
                          {c.description}
                        </p>
                      ) : (
                        <div className="text-xs text-[var(--muted)]">
                          Created {new Date(c.createdAt).toLocaleString()}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      {activeCount > 0 ? (
                        <button
                          onClick={() => void onDeactivate(c, activeCount)}
                          disabled={togglingId === c.id}
                          title={`Revert ${activeCount} active publish${activeCount === 1 ? "" : "es"} — restores base files from snapshots`}
                          className="flex items-center gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-xs text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50"
                        >
                          {togglingId === c.id ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <Power className="h-3 w-3" />
                          )}
                          On
                        </button>
                      ) : (
                        <button
                          onClick={() => void onActivate(c)}
                          disabled={togglingId === c.id}
                          title="Publish this customization — applies the customization src to the live install"
                          className="flex items-center gap-1.5 rounded-md border border-[var(--border)] px-2 py-1 text-xs text-[var(--muted)] hover:border-[var(--accent)]/40 hover:bg-[var(--accent)]/10 hover:text-[var(--foreground)] disabled:opacity-50"
                        >
                          {togglingId === c.id ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <PowerOff className="h-3 w-3" />
                          )}
                          Off
                        </button>
                      )}
                      <Link
                        href={`/customize/${c.id}`}
                        className="flex items-center gap-1 rounded-md border border-[var(--border)] px-2 py-1 text-xs hover:bg-[var(--panel-2)]"
                      >
                        Open <ExternalLink className="h-3 w-3" />
                      </Link>
                      <button
                        onClick={() => void onDelete(c)}
                        disabled={togglingId === c.id}
                        title={activeCount > 0 ? "Revert active publishes first" : "Delete customization"}
                        className="flex items-center justify-center rounded-md border border-[var(--border)] p-1.5 text-[var(--muted)] hover:border-red-500/40 hover:bg-red-500/10 hover:text-red-300 disabled:opacity-50"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </main>
      {helpOpen && (
        <CustomizeHelpOverlay
          onClose={() => {
            setHelpOpen(false);
            if (typeof window !== "undefined") {
              window.localStorage.setItem(HELP_SEEN_KEY, "1");
            }
          }}
        />
      )}
    </div>
  );
}
