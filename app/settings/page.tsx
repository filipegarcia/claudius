"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, RefreshCw, Save, Settings as SettingsIcon, X } from "lucide-react";
import { SideNav } from "@/components/nav/SideNav";
import { useActiveCwd } from "@/lib/client/useActiveCwd";
import { useSettings } from "@/lib/client/useSettings";
import type { ClaudeSettings, SettingsScope } from "@/lib/server/settings";
import { useTheme, THEMES, type ThemeId } from "@/lib/client/theme";
import { EDITORS, useEditor, type EditorId } from "@/lib/client/ide";
import { UpdaterSettingsSection } from "@/components/updater/UpdaterSettingsSection";
import { ShortcutsSection } from "@/components/settings/ShortcutsSection";
import { RateLimitWarningSection } from "@/components/settings/RateLimitWarningSection";
import { BackupSection } from "@/components/settings/BackupSection";
import { cn } from "@/lib/utils/cn";

const SCOPE_LABELS: Record<SettingsScope, string> = {
  user: "User",
  project: "Project",
  local: "Local",
};

const SDK_THEMES = ["auto", "dark", "light", "dark-daltonized", "light-daltonized", "ansi"];
const OUTPUT_STYLES = ["default", "explanatory", "concise", "developer"];

export default function SettingsPage() {
  const cwd = useActiveCwd();

  const settings = useSettings(cwd);
  const [scope, setScope] = useState<SettingsScope>("user");
  const [showRaw, setShowRaw] = useState(false);
  const [draft, setDraft] = useState<ClaudeSettings>({});
  const [rawDraft, setRawDraft] = useState<string>("");
  const [rawError, setRawError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const theme = useTheme();
  const ide = useEditor();

  const active = settings.scopes.find((s) => s.scope === scope);

  // Re-seed draft whenever the active scope's settings load. Done during
  // render via the "store previous props" pattern so the reset isn't a
  // sync setState inside an effect body.
  // https://react.dev/reference/react/useState#storing-information-from-previous-renders
  //
  // Keyed by `(scope, JSON of active settings)` so a re-fetch that returns
  // the same payload doesn't gratuitously wipe an in-progress edit.
  const activeKey = `${scope}:${JSON.stringify(active?.settings ?? {})}`;
  const [lastActiveKey, setLastActiveKey] = useState(activeKey);
  if (lastActiveKey !== activeKey) {
    setLastActiveKey(activeKey);
    setDraft(active?.settings ?? {});
    setRawDraft(JSON.stringify(active?.settings ?? {}, null, 2));
    setRawError(null);
    setDirty(false);
  }

  const onSave = async () => {
    if (!dirty) return;
    setSaving(true);
    try {
      let toWrite = draft;
      if (showRaw) {
        try {
          toWrite = JSON.parse(rawDraft) as ClaudeSettings;
        } catch (err) {
          setRawError(err instanceof Error ? err.message : String(err));
          setSaving(false);
          return;
        }
      }
      await settings.save(scope, toWrite);
    } finally {
      setSaving(false);
    }
  };

  const update = (patch: Partial<ClaudeSettings>) => {
    setDraft((prev) => {
      const next = { ...prev, ...patch };
      // Strip keys explicitly set to undefined.
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) delete (next as Record<string, unknown>)[k];
      }
      return next;
    });
    setDirty(true);
  };

  return (
    <div className="flex h-full">
      <SideNav running={false} />
      <main data-pane-name="settings-main" className="flex h-full flex-1 flex-col overflow-hidden">
        <header className="flex h-9 shrink-0 items-center gap-3 border-b border-[var(--border)] bg-[var(--panel)] px-4 text-xs">
          <Link href="/" className="flex items-center gap-1 text-[var(--muted)] hover:text-[var(--foreground)]">
            <ArrowLeft className="h-3.5 w-3.5" /> Chat
          </Link>
          <span className="opacity-50">·</span>
          <SettingsIcon className="h-3.5 w-3.5 text-[var(--muted)]" />
          <span className="font-medium">Settings</span>
          {settings.loading && <span className="text-[var(--muted)]">loading…</span>}
          {settings.error && <span className="text-red-400">{settings.error}</span>}
          <button
            onClick={settings.refresh}
            className="ml-auto flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-0.5 hover:bg-[var(--panel)]"
          >
            <RefreshCw className="h-3 w-3" /> Refresh
          </button>
          <button
            onClick={() => setShowRaw((s) => !s)}
            className={cn(
              "rounded-md border border-[var(--border)] px-2 py-0.5",
              showRaw ? "bg-[var(--panel)]" : "bg-[var(--panel-2)] hover:bg-[var(--panel)]",
            )}
          >
            {showRaw ? "Form" : "Raw JSON"}
          </button>
          <button
            onClick={onSave}
            disabled={!dirty || saving}
            className="flex items-center gap-1 rounded-md bg-[var(--accent)] px-2 py-0.5 text-white hover:opacity-90 disabled:opacity-40"
          >
            <Save className="h-3 w-3" />
            {saving ? "Saving…" : "Save"}
          </button>
        </header>

        <div className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--panel)]/40 px-4 py-2">
          {(["user", "project", "local"] as SettingsScope[]).map((s) => (
            <button
              key={s}
              onClick={() => setScope(s)}
              className={cn(
                "rounded-md border border-[var(--border)] px-3 py-1 text-xs",
                scope === s
                  ? "bg-[var(--panel-2)]"
                  : "bg-[var(--panel)] text-[var(--muted)] hover:text-[var(--foreground)]",
              )}
            >
              {SCOPE_LABELS[s]}
            </button>
          ))}
          <span className="ml-2 truncate font-mono text-[10px] text-[var(--muted)]">
            {active?.path ?? "—"}
          </span>
        </div>

        <div className="flex-1 overflow-y-auto scroll-thin">
          <div className="mx-auto max-w-4xl space-y-5 px-6 py-6">
            <Section
              title="Open in editor"
              subtitle="Click-through editor for file paths in tool blocks. URL scheme only — no install required."
            >
              <div className="flex flex-wrap gap-2">
                {EDITORS.map((e) => (
                  <button
                    key={e.id}
                    onClick={() => ide.setEditor(e.id as EditorId)}
                    className={cn(
                      "rounded-md border px-3 py-1.5 text-xs",
                      ide.editor === e.id
                        ? "border-[var(--accent)] bg-[var(--panel-2)]"
                        : "border-[var(--border)] bg-[var(--panel)] hover:bg-[var(--panel-2)]",
                    )}
                    title={e.hint}
                  >
                    {e.label}
                  </button>
                ))}
              </div>
              <div className="mt-2 font-mono text-[10px] text-[var(--muted)]">
                {EDITORS.find((e) => e.id === ide.editor)?.hint}
              </div>
            </Section>

            <Section title="Web app theme" subtitle="Applies to the Claudius browser UI only.">
              <div className="flex flex-wrap gap-2">
                {THEMES.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => theme.setTheme(t.id as ThemeId)}
                    className={cn(
                      "flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs",
                      theme.theme === t.id
                        ? "border-[var(--accent)] bg-[var(--panel-2)]"
                        : "border-[var(--border)] bg-[var(--panel)] hover:bg-[var(--panel-2)]",
                    )}
                  >
                    <span className="flex gap-1">
                      <span
                        className="h-3 w-3 rounded-sm border border-black/10"
                        style={{ background: t.preview.bg }}
                      />
                      <span
                        className="h-3 w-3 rounded-sm border border-black/10"
                        style={{ background: t.preview.accent }}
                      />
                    </span>
                    {t.label}
                  </button>
                ))}
              </div>
            </Section>

            {/* Install-wide updater settings — independent of the User/Project/Local
                scope tabs above (those edit Claude's settings.json; this hits the
                separate updater.json store). Always visible regardless of scope. */}
            <UpdaterSettingsSection />

            {/* Browser-only keyboard shortcuts (tab cycling, side-nav nav, workspace
                cycling). Persisted to localStorage, so it sits outside the scope
                tabs above. The CLI input keybindings live on /keybindings. */}
            <ShortcutsSection />

            {/* Browser-local threshold for the chat-side rate-limit pill —
                also outside the scope tabs because it's a Claudius UI knob,
                not a Claude Code settings.json value. */}
            <RateLimitWarningSection />

            {/* Backup / restore the full Claudius config as one JSON bundle.
                Outside the scope tabs because it spans every scope and
                every workspace, not a single settings.json file. */}
            <BackupSection />

            {showRaw ? (
              <Section title="Raw JSON" subtitle="Direct edit of the settings file.">
                <textarea
                  value={rawDraft}
                  onChange={(e) => {
                    setRawDraft(e.target.value);
                    setDirty(true);
                    setRawError(null);
                  }}
                  spellCheck={false}
                  rows={28}
                  className="block w-full resize-none rounded-md border border-[var(--border)] bg-[var(--panel-2)] p-3 font-mono text-xs leading-5 focus:outline-none scroll-thin"
                />
                {rawError && (
                  <div className="mt-2 rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1 text-[11px] text-red-300">
                    {rawError}
                  </div>
                )}
              </Section>
            ) : (
              <>
                <Section title="Model & UI" subtitle="Defaults Claude Code reads on startup.">
                  <Field label="Model">
                    <input
                      value={(draft.model as string | undefined) ?? ""}
                      onChange={(e) => update({ model: e.target.value || undefined })}
                      placeholder="(unset — uses CLI default)"
                      className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 font-mono text-xs focus:outline-none"
                    />
                  </Field>
                  <Field label="Theme (CLI rendering)">
                    <select
                      value={(draft.theme as string | undefined) ?? ""}
                      onChange={(e) => update({ theme: e.target.value || undefined })}
                      className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 text-xs focus:outline-none"
                    >
                      <option value="">(unset)</option>
                      {SDK_THEMES.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Output style">
                    <select
                      value={(draft.outputStyle as string | undefined) ?? ""}
                      onChange={(e) => update({ outputStyle: e.target.value || undefined })}
                      className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 text-xs focus:outline-none"
                    >
                      <option value="">(unset)</option>
                      {OUTPUT_STYLES.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Status line script">
                    <input
                      value={
                        (draft.statusLine as { type?: string; command?: string } | undefined)?.command ?? ""
                      }
                      onChange={(e) => {
                        const cmd = e.target.value.trim();
                        if (!cmd) update({ statusLine: undefined });
                        else update({ statusLine: { type: "command", command: cmd } });
                      }}
                      placeholder="/path/to/statusline.sh"
                      className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 font-mono text-xs focus:outline-none"
                    />
                  </Field>
                </Section>

                <Section title="Memory">
                  <ToggleRow
                    label="autoMemoryEnabled"
                    checked={Boolean(draft.autoMemoryEnabled)}
                    onChange={(b) => update({ autoMemoryEnabled: b ? true : undefined })}
                    description="Let Claude self-note across sessions in ~/.claude/projects/<project>/memory."
                  />
                  <Field label="claudeMdExcludes (comma-separated globs)">
                    <input
                      value={
                        Array.isArray(draft.claudeMdExcludes)
                          ? (draft.claudeMdExcludes as string[]).join(", ")
                          : (draft.claudeMdExcludes as string | undefined) ?? ""
                      }
                      onChange={(e) => {
                        const v = e.target.value;
                        const arr = v
                          .split(",")
                          .map((s) => s.trim())
                          .filter(Boolean);
                        update({ claudeMdExcludes: arr.length ? arr : undefined } as Partial<ClaudeSettings>);
                      }}
                      placeholder="**/secrets/**, vendor/**"
                      className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 font-mono text-xs focus:outline-none"
                    />
                  </Field>
                </Section>

                <Section title="Environment">
                  <EnvEditor
                    value={(draft.env as Record<string, string> | undefined) ?? {}}
                    onChange={(env) =>
                      update({ env: Object.keys(env).length ? (env as ClaudeSettings["env"]) : undefined })
                    }
                  />
                </Section>

                <Section title="Plugins" subtitle="Read-only here — manage via /plugin (Phase 13).">
                  <pre className="rounded-md border border-[var(--border)] bg-[var(--panel-2)] p-3 font-mono text-[11px] scroll-thin overflow-auto">
                    {JSON.stringify(draft.enabledPlugins ?? {}, null, 2)}
                  </pre>
                </Section>

                <Section title="Other" subtitle="Anything not covered above is preserved on save.">
                  <Other draft={draft} />
                </Section>
              </>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-[var(--border)] bg-[var(--panel)]/40 p-4">
      <h2 className="text-sm font-medium">{title}</h2>
      {subtitle && <p className="mt-0.5 text-[11px] text-[var(--muted)]">{subtitle}</p>}
      <div className="mt-3 space-y-3">{children}</div>
    </section>
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

function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (b: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-md border border-[var(--border)] bg-[var(--panel-2)]/40 p-2">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-3.5 w-3.5"
      />
      <div className="flex-1">
        <div className="font-mono text-xs">{label}</div>
        <div className="text-[11px] text-[var(--muted)]">{description}</div>
      </div>
    </label>
  );
}

function EnvEditor({ value, onChange }: { value: Record<string, string>; onChange: (v: Record<string, string>) => void }) {
  const entries = useMemo(() => Object.entries(value), [value]);
  const [k, setK] = useState("");
  const [v, setV] = useState("");
  return (
    <div>
      <ul className="space-y-1">
        {entries.map(([key, val]) => (
          <li
            key={key}
            className="flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--panel-2)]/40 px-2 py-1"
          >
            <code className="flex-1 truncate font-mono text-[11px]">{key}</code>
            <input
              value={val}
              onChange={(e) => onChange({ ...value, [key]: e.target.value })}
              className="flex-1 rounded-md border border-[var(--border)] bg-[var(--panel)] px-2 py-1 font-mono text-[11px] focus:outline-none"
            />
            <button
              onClick={() => {
                const copy = { ...value };
                delete copy[key];
                onChange(copy);
              }}
              className="rounded p-0.5 text-[var(--muted)] hover:bg-[var(--panel)] hover:text-red-400"
              title="Remove"
            >
              <X className="h-3 w-3" />
            </button>
          </li>
        ))}
      </ul>
      <div className="mt-2 flex gap-2">
        <input
          value={k}
          onChange={(e) => setK(e.target.value)}
          placeholder="KEY"
          className="flex-1 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1 font-mono text-[11px] focus:outline-none"
        />
        <input
          value={v}
          onChange={(e) => setV(e.target.value)}
          placeholder="value"
          className="flex-1 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1 font-mono text-[11px] focus:outline-none"
        />
        <button
          onClick={() => {
            if (!k.trim()) return;
            onChange({ ...value, [k.trim()]: v });
            setK("");
            setV("");
          }}
          disabled={!k.trim()}
          className="rounded-md bg-[var(--accent)] px-2 py-1 text-[11px] text-white hover:opacity-90 disabled:opacity-40"
        >
          Add
        </button>
      </div>
    </div>
  );
}

const KNOWN_KEYS = new Set([
  "model",
  "theme",
  "outputStyle",
  "statusLine",
  "permissions",
  "hooks",
  "mcpServers",
  "autoMemoryEnabled",
  "claudeMdExcludes",
  "enabledPlugins",
  "env",
  "disableAllHooks",
]);

function Other({ draft }: { draft: ClaudeSettings }) {
  const others = Object.entries(draft).filter(([k]) => !KNOWN_KEYS.has(k));
  if (others.length === 0)
    return <div className="text-[11px] italic text-[var(--muted)]">No other keys.</div>;
  return (
    <pre className="overflow-auto rounded-md border border-[var(--border)] bg-[var(--panel-2)] p-3 font-mono text-[11px] scroll-thin">
      {JSON.stringify(Object.fromEntries(others), null, 2)}
    </pre>
  );
}
