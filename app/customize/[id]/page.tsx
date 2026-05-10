"use client";

import { use, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, ExternalLink, Loader2, Play, Square, RefreshCw, WandSparkles, Pencil, Check, X, MessageSquare, Keyboard, RotateCw } from "lucide-react";
import { PANE_LABELS_EVENT } from "@/components/overlays/PaneLabelsHost";
import { SideNav } from "@/components/nav/SideNav";
import { PublishRevertPanel } from "@/components/customize/PublishRevertPanel";
import { SyncFromBasePanel } from "@/components/customize/SyncFromBasePanel";
import type { Customization } from "@/lib/server/customizations-store";
import type { PreviewState } from "@/lib/server/preview-server";

export default function CustomizationDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [item, setItem] = useState<Customization | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [listRes, prevRes] = await Promise.all([
        fetch("/api/customizations"),
        fetch(`/api/customizations/${id}/preview`),
      ]);
      if (listRes.ok) {
        const d = (await listRes.json()) as { customizations: Customization[] };
        setItem(d.customizations.find((c) => c.id === id) ?? null);
      }
      if (prevRes.ok) {
        setPreview((await prevRes.json()) as PreviewState);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void refresh();
    // Poll the preview state while it's transitional. Cheap — 2s tick.
    const t = setInterval(() => {
      void refresh();
    }, 2000);
    return () => clearInterval(t);
  }, [refresh]);

  const onStart = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/customizations/${id}/preview`, { method: "POST" });
      if (!res.ok) {
        const e = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(e.error ?? `HTTP ${res.status}`);
      }
      setPreview((await res.json()) as PreviewState);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [id]);

  const onStop = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/customizations/${id}/preview`, { method: "DELETE" });
      if (res.ok) setPreview((await res.json()) as PreviewState);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [id]);

  const onRestart = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/customizations/${id}/preview/restart`, { method: "POST" });
      if (!res.ok) {
        const e = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(e.error ?? `HTTP ${res.status}`);
      }
      setPreview((await res.json()) as PreviewState);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [id]);

  const previewUrl = preview && preview.status !== "exited" && preview.status !== "error" && preview.port
    ? `http://localhost:${preview.port}/`
    : null;

  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [savingName, setSavingName] = useState(false);
  const nameInputRef = useRef<HTMLInputElement | null>(null);

  function beginEditName() {
    setDraftName(item?.name ?? "");
    setEditingName(true);
    // Focus + select on next paint so the user can immediately overwrite.
    requestAnimationFrame(() => {
      nameInputRef.current?.focus();
      nameInputRef.current?.select();
    });
  }

  async function commitName() {
    if (!item) return;
    const next = draftName.trim();
    if (!next || next === item.name) {
      setEditingName(false);
      return;
    }
    setSavingName(true);
    setError(null);
    try {
      const res = await fetch(`/api/customizations/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: next }),
      });
      if (!res.ok) {
        const e = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(e.error ?? `HTTP ${res.status}`);
      }
      const updated = (await res.json()) as Customization;
      setItem(updated);
      setEditingName(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingName(false);
    }
  }

  function cancelEditName() {
    setEditingName(false);
    setDraftName("");
  }

  const onGoToChat = useCallback(async () => {
    if (!item?.workspaceId) {
      router.push("/");
      return;
    }
    try {
      // Activate the customization's workspace before routing — otherwise
      // the chat lands in whatever workspace was previously active.
      await fetch(`/api/workspaces/${item.workspaceId}/select`, { method: "POST" });
    } catch {
      // Best-effort: still navigate even if the cookie write fails — the user
      // can switch via the workspace switcher.
    }
    // Hard reload via window.location so server-rendered cwd is fresh.
    if (typeof window !== "undefined") {
      window.location.assign("/");
    } else {
      router.push("/");
    }
  }, [item?.workspaceId, router]);

  return (
    <div className="flex h-full">
      <SideNav />
      <main className="flex h-full flex-1 flex-col overflow-hidden" data-pane-name="customize-detail-main">
        <header className="flex items-center justify-between border-b border-[var(--border)] px-6 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <Link
              href="/customize"
              className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)]"
              title="Back"
            >
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <WandSparkles className="h-5 w-5 text-[var(--accent)]" />
            <div className="min-w-0">
              {editingName ? (
                <div className="flex items-center gap-1.5">
                  <input
                    ref={nameInputRef}
                    type="text"
                    value={draftName}
                    onChange={(e) => setDraftName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void commitName();
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        cancelEditName();
                      }
                    }}
                    disabled={savingName}
                    placeholder="Customization name"
                    className="w-72 rounded-md border border-[var(--border)] bg-[var(--panel)] px-2 py-1 text-lg font-semibold text-[var(--foreground)] outline-none focus:border-[var(--accent)]"
                  />
                  <button
                    onClick={() => void commitName()}
                    disabled={savingName || !draftName.trim()}
                    title="Save (Enter)"
                    className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--accent)] hover:bg-[var(--panel-2)] disabled:opacity-50"
                  >
                    {savingName ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                  </button>
                  <button
                    onClick={cancelEditName}
                    disabled={savingName}
                    title="Cancel (Esc)"
                    className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--muted)] hover:bg-[var(--panel-2)] disabled:opacity-50"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-1.5">
                  <h1
                    onDoubleClick={beginEditName}
                    title="Double-click to rename"
                    className="truncate text-lg font-semibold"
                  >
                    {item?.name ?? id}
                  </h1>
                  <button
                    onClick={beginEditName}
                    title="Rename"
                    className="flex h-6 w-6 items-center justify-center rounded text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)]"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
              <p className="truncate text-xs text-[var(--muted)]">{id}</p>
            </div>
          </div>
          <button
            onClick={() => void refresh()}
            title="Refresh"
            className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)]"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        </header>

        <div className="flex-1 overflow-auto px-6 py-5">
          {error && (
            <div className="mb-4 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
              {error}
            </div>
          )}

          {loading && !item ? (
            <div className="flex items-center gap-2 text-sm text-[var(--muted)]">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : !item ? (
            <div className="text-sm text-[var(--muted)]">Customization not found.</div>
          ) : (
            <>
              <Section title="Preview" subtitle="Spawns next dev on a separate port using your customization's source.">
                <div className="flex items-center gap-3">
                  {preview?.status === "ready" || preview?.status === "starting" ? (
                    <>
                      <button
                        onClick={() => void onStop()}
                        disabled={busy}
                        className="flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--panel)] px-3 py-1.5 text-sm hover:bg-[var(--panel-2)] disabled:opacity-50"
                      >
                        <Square className="h-4 w-4" /> Stop
                      </button>
                      <button
                        onClick={() => void onRestart()}
                        disabled={busy}
                        title="Stop the running preview, reap any worker grandchildren on the port, and start a fresh one"
                        className="flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--panel)] px-3 py-1.5 text-sm hover:bg-[var(--panel-2)] disabled:opacity-50"
                      >
                        <RotateCw className="h-4 w-4" /> Restart
                      </button>
                      <span className="text-xs text-[var(--muted)]">
                        {preview.status === "starting" ? "Starting…" : "Running"} · port {preview.port} · pid {preview.pid}
                      </span>
                      {previewUrl && (
                        <a
                          href={previewUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="ml-auto flex items-center gap-1 rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
                        >
                          Open preview <ExternalLink className="h-4 w-4" />
                        </a>
                      )}
                    </>
                  ) : (
                    <>
                      <button
                        onClick={() => void onStart()}
                        disabled={busy}
                        className="flex items-center gap-2 rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
                      >
                        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                        Start preview
                      </button>
                      {preview?.status === "exited" && (
                        <span className="text-xs text-[var(--muted)]">
                          Last run exited (code {preview.exitCode ?? "?"}{preview.exitSignal ? ` / ${preview.exitSignal}` : ""})
                        </span>
                      )}
                    </>
                  )}
                </div>
                {preview && preview.logs.length > 0 && (
                  <pre className="mt-3 max-h-72 overflow-auto rounded-md border border-[var(--border)] bg-black/40 p-3 font-mono text-[11px] leading-relaxed text-[var(--muted)]">
                    {preview.logs.join("\n")}
                  </pre>
                )}
              </Section>

              <Section
                title="Sync from base"
                subtitle="Pull bug fixes / improvements from the live Claudius into this customization. Files you've edited are left alone; conflicts are flagged."
              >
                <SyncFromBasePanel customizationId={id} />
              </Section>

              <Section title="Publish & revert" subtitle="Apply your changes to the running Claudius, or restore an earlier snapshot.">
                <PublishRevertPanel customizationId={id} onChange={() => void refresh()} />
              </Section>

              <Section
                title="CLI escape hatch"
                subtitle="If a publish breaks the running UI, run this from a terminal — it doesn't need Claudius running."
              >
                <pre className="rounded-md border border-[var(--border)] bg-black/40 px-3 py-2 font-mono text-xs text-[var(--foreground)]">
                  make claudius-revert
                </pre>
                <p className="mt-2 text-xs text-[var(--muted)]">
                  Reverts the most recent active publish using the snapshot stored alongside the customization.
                </p>
              </Section>

              <section className="rounded-md border border-[var(--accent)]/40 bg-[var(--accent)]/10 p-5">
                <div className="flex items-start gap-4">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--accent)]/20">
                    <MessageSquare className="h-5 w-5 text-[var(--accent)]" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <h2 className="text-sm font-semibold text-[var(--foreground)]">Make changes — go to chat and prompt your way</h2>
                    <p className="mt-1 text-xs text-[var(--muted)]">
                      All edits happen through Claude Code in this customization workspace. Open the chat, describe what
                      you want (&ldquo;move the workspace switcher to the right&rdquo;, &ldquo;add a settings tile to the
                      left-nav&rdquo;), and Claude edits the customization source. Use the component-labels overlay to learn
                      the canonical names for each region.
                    </p>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <button
                        onClick={() => void onGoToChat()}
                        className="flex items-center gap-2 rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
                      >
                        <MessageSquare className="h-4 w-4" /> Go to chat
                      </button>
                      <button
                        onClick={() => {
                          if (typeof window !== "undefined") {
                            window.dispatchEvent(new Event(PANE_LABELS_EVENT));
                          }
                        }}
                        className="flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--panel)] px-2.5 py-1.5 text-xs hover:bg-[var(--panel-2)]"
                      >
                        <Keyboard className="h-3.5 w-3.5" /> Show component names
                      </button>
                      {!item.workspaceId && (
                        <span className="text-xs text-amber-300">
                          (this customization isn&apos;t linked to a workspace — recreate to fix)
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </section>
            </>
          )}
        </div>
      </main>
    </div>
  );
}

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section className="mb-6 rounded-md border border-[var(--border)] bg-[var(--panel)] p-4">
      <h2 className="text-sm font-medium">{title}</h2>
      {subtitle && <p className="mt-0.5 mb-3 text-xs text-[var(--muted)]">{subtitle}</p>}
      {children}
    </section>
  );
}

