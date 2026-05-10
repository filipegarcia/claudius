"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, RotateCcw, Save, Settings as SettingsIcon } from "lucide-react";
import { SideNav } from "@/components/nav/SideNav";

type FetchedSettings = {
  autoFixPrompt: string;
  defaults: { autoFixPrompt: string };
};

/**
 * Customize-wide settings. Currently a single field — the prompt template
 * the "Auto-fix conflicts" button on each customization page sends to
 * Claude Code. Two placeholders are substituted at run time:
 *   {{conflict_count}}  → number of conflicting paths
 *   {{conflict_paths}}  → bulleted list of paths
 */
export default function CustomizeSettingsPage() {
  const [draft, setDraft] = useState<string>("");
  const [defaultPrompt, setDefaultPrompt] = useState<string>("");
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await fetch("/api/customize-settings");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = (await r.json()) as FetchedSettings;
      setDraft(d.autoFixPrompt);
      setDefaultPrompt(d.defaults.autoFixPrompt);
      setDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const onSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const r = await fetch("/api/customize-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autoFixPrompt: draft }),
      });
      if (!r.ok) {
        const err = (await r.json().catch(() => null)) as { error?: string } | null;
        throw new Error(err?.error ?? `HTTP ${r.status}`);
      }
      setDirty(false);
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [draft]);

  const onReset = useCallback(() => {
    if (!defaultPrompt) return;
    if (!confirm("Replace the current prompt with the default?")) return;
    setDraft(defaultPrompt);
    setDirty(true);
  }, [defaultPrompt]);

  return (
    <div className="flex h-full">
      <SideNav running={false} />
      <main className="flex h-full flex-1 flex-col overflow-hidden">
        <header className="flex h-9 shrink-0 items-center gap-3 border-b border-[var(--border)] bg-[var(--panel)] px-4 text-xs">
          <Link
            href="/customize"
            className="flex items-center gap-1 text-[var(--muted)] hover:text-[var(--foreground)]"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Customizations
          </Link>
          <span className="opacity-50">·</span>
          <SettingsIcon className="h-3.5 w-3.5 text-[var(--muted)]" />
          <span className="font-medium">Customize settings</span>
        </header>

        <div className="flex-1 overflow-y-auto scroll-thin">
          <div className="mx-auto max-w-3xl space-y-6 px-6 py-6">
            <section className="rounded-md border border-[var(--border)] bg-[var(--panel)] p-4">
              <h2 className="text-sm font-medium">Auto-fix prompt</h2>
              <p className="mt-1 text-xs text-[var(--muted)] leading-relaxed">
                When you click <em>Auto-fix conflicts</em> on a customization page, Claudius opens a
                chat in that customization&apos;s workspace with this prompt prefilled. Two
                placeholders are substituted at run time:
              </p>
              <ul className="mt-2 space-y-1 text-xs text-[var(--muted)]">
                <li>
                  <code className="rounded bg-[var(--panel-2)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--foreground)]">
                    {"{{conflict_count}}"}
                  </code>{" "}
                  &mdash; number of conflicting paths
                </li>
                <li>
                  <code className="rounded bg-[var(--panel-2)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--foreground)]">
                    {"{{conflict_paths}}"}
                  </code>{" "}
                  &mdash; bulleted list of paths, one per line
                </li>
              </ul>

              {loading ? (
                <div className="mt-4 text-xs text-[var(--muted)]">Loading…</div>
              ) : (
                <textarea
                  value={draft}
                  onChange={(e) => {
                    setDraft(e.target.value);
                    setDirty(true);
                  }}
                  spellCheck={false}
                  rows={20}
                  className="mt-3 w-full resize-y rounded-md border border-[var(--border)] bg-[var(--background)] p-3 font-mono text-xs leading-5 outline-none focus:border-[var(--accent)] scroll-thin"
                />
              )}

              <div className="mt-3 flex items-center gap-2">
                <button
                  onClick={() => void onSave()}
                  disabled={!dirty || saving || loading}
                  className="flex items-center gap-1 rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-40"
                >
                  <Save className="h-3 w-3" /> {saving ? "Saving…" : "Save"}
                </button>
                <button
                  onClick={onReset}
                  disabled={loading}
                  className="flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 text-xs hover:bg-[var(--panel)]"
                >
                  <RotateCcw className="h-3 w-3" /> Reset to default
                </button>
                {savedAt && !dirty && (
                  <span className="text-[11px] text-emerald-300">
                    Saved {new Date(savedAt).toLocaleTimeString()}
                  </span>
                )}
                {error && <span className="text-[11px] text-red-300">{error}</span>}
              </div>
            </section>
          </div>
        </div>
      </main>
    </div>
  );
}
