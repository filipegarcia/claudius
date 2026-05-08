"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Keyboard, Plus, Save, Trash2 } from "lucide-react";
import { SideNav } from "@/components/nav/SideNav";
import type { Keybinding, KeybindingsFile } from "@/lib/server/keybindings";

export default function KeybindingsPage() {
  const [path, setPath] = useState<string>("");
  const [exists, setExists] = useState<boolean>(false);
  const [bindings, setBindings] = useState<Keybinding[]>([]);
  const [extras, setExtras] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [rawDraft, setRawDraft] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/keybindings");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = (await res.json()) as { path: string; exists: boolean; data: KeybindingsFile };
      setPath(d.path);
      setExists(d.exists);
      const arr = Array.isArray(d.data?.bindings) ? d.data.bindings : [];
      setBindings(arr);
      const { bindings: _ignored, ...rest } = d.data ?? {};
      void _ignored;
      setExtras(rest as Record<string, unknown>);
      setRawDraft(JSON.stringify(d.data ?? {}, null, 2));
      setDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onSave = async () => {
    setSaving(true);
    try {
      let data: KeybindingsFile;
      if (showRaw) {
        try {
          data = JSON.parse(rawDraft) as KeybindingsFile;
        } catch (err) {
          setError(`raw JSON: ${err instanceof Error ? err.message : String(err)}`);
          return;
        }
      } else {
        data = { ...extras, bindings };
      }
      const res = await fetch("/api/keybindings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data }),
      });
      if (!res.ok) {
        setError(`save failed: ${res.status}`);
        return;
      }
      await refresh();
    } finally {
      setSaving(false);
    }
  };

  const updateBinding = (i: number, patch: Partial<Keybinding>) => {
    setBindings((prev) => prev.map((b, idx) => (idx === i ? { ...b, ...patch } : b)));
    setDirty(true);
  };

  const removeBinding = (i: number) => {
    setBindings((prev) => prev.filter((_, idx) => idx !== i));
    setDirty(true);
  };

  const addBinding = () => {
    setBindings((prev) => [...prev, { key: "ctrl+shift+p", command: "" }]);
    setDirty(true);
  };

  const total = useMemo(() => bindings.length, [bindings]);

  return (
    <div className="flex h-full">
      <SideNav running={false} />
      <main className="flex h-full flex-1 flex-col overflow-hidden">
        <header className="flex h-9 shrink-0 items-center gap-3 border-b border-[var(--border)] bg-[var(--panel)] px-4 text-xs">
          <Link href="/" className="flex items-center gap-1 text-[var(--muted)] hover:text-[var(--foreground)]">
            <ArrowLeft className="h-3.5 w-3.5" /> Chat
          </Link>
          <span className="opacity-50">·</span>
          <Keyboard className="h-3.5 w-3.5 text-[var(--muted)]" />
          <span className="font-medium">Keybindings</span>
          <span className="text-[var(--muted)]">({total})</span>
          {!exists && <span className="text-[var(--muted)]">— file does not exist yet</span>}
          {loading && <span className="text-[var(--muted)]">loading…</span>}
          {error && <span className="text-red-400">{error}</span>}
          <button
            onClick={() => setShowRaw((s) => !s)}
            className={`ml-auto rounded-md border border-[var(--border)] px-2 py-0.5 ${showRaw ? "bg-[var(--panel)]" : "bg-[var(--panel-2)] hover:bg-[var(--panel)]"}`}
          >
            {showRaw ? "Form" : "Raw JSON"}
          </button>
          <button
            onClick={addBinding}
            disabled={showRaw}
            className="flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-0.5 hover:bg-[var(--panel)] disabled:opacity-40"
          >
            <Plus className="h-3 w-3" /> Add
          </button>
          <button
            onClick={onSave}
            disabled={!dirty || saving}
            className="flex items-center gap-1 rounded-md bg-[var(--accent)] px-2 py-0.5 text-white hover:opacity-90 disabled:opacity-40"
          >
            <Save className="h-3 w-3" /> {saving ? "Saving…" : "Save"}
          </button>
        </header>
        <div className="border-b border-[var(--border)] bg-[var(--panel-2)]/30 px-4 py-1 font-mono text-[10px] text-[var(--muted)]">
          {path}
        </div>

        <div className="flex-1 overflow-y-auto scroll-thin">
          <div className="mx-auto max-w-3xl px-6 py-6">
            {showRaw ? (
              <textarea
                value={rawDraft}
                onChange={(e) => {
                  setRawDraft(e.target.value);
                  setDirty(true);
                }}
                spellCheck={false}
                rows={28}
                className="block w-full resize-none rounded-md border border-[var(--border)] bg-[var(--panel-2)] p-3 font-mono text-xs leading-5 focus:outline-none scroll-thin"
              />
            ) : (
              <ul className="space-y-1.5">
                {bindings.length === 0 && (
                  <li className="rounded-md border border-[var(--border)] bg-[var(--panel)]/40 px-4 py-8 text-center text-sm text-[var(--muted)]">
                    No bindings yet. Click <strong>Add</strong> to create one.
                  </li>
                )}
                {bindings.map((b, i) => (
                  <li key={i} className="rounded-md border border-[var(--border)] bg-[var(--panel)]/40 p-3">
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-[180px_180px_1fr_auto]">
                      <input
                        value={b.chord ?? ""}
                        onChange={(e) => updateBinding(i, { chord: e.target.value || undefined })}
                        placeholder="chord (optional)"
                        className="rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 font-mono text-xs focus:outline-none"
                      />
                      <input
                        value={b.key}
                        onChange={(e) => updateBinding(i, { key: e.target.value })}
                        placeholder="key (e.g. ctrl+s)"
                        className="rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 font-mono text-xs focus:outline-none"
                      />
                      <input
                        value={b.command}
                        onChange={(e) => updateBinding(i, { command: e.target.value })}
                        placeholder="command (e.g. submit, interrupt, /clear)"
                        className="rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 font-mono text-xs focus:outline-none"
                      />
                      <button
                        onClick={() => removeBinding(i)}
                        className="rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1 text-[11px] text-red-300 hover:bg-red-500/20"
                        title="Remove"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                    <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                      <input
                        value={b.when ?? ""}
                        onChange={(e) => updateBinding(i, { when: e.target.value || undefined })}
                        placeholder='when (optional, e.g. "input.focused")'
                        className="rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 font-mono text-xs focus:outline-none"
                      />
                      <input
                        value={b.args == null ? "" : JSON.stringify(b.args)}
                        onChange={(e) => {
                          const v = e.target.value;
                          if (!v.trim()) return updateBinding(i, { args: undefined });
                          try {
                            updateBinding(i, { args: JSON.parse(v) });
                          } catch {
                            // keep as-is, user is mid-typing
                          }
                        }}
                        placeholder='args JSON (optional)'
                        className="rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 font-mono text-xs focus:outline-none"
                      />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
