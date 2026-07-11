"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, RefreshCw, Save, Search, Settings as SettingsIcon, X } from "lucide-react";
import { SideNav } from "@/components/nav/SideNav";
import { useActiveCwd } from "@/lib/client/useActiveCwd";
import { useSettings } from "@/lib/client/useSettings";
import type { ClaudeSettings, SettingsScope } from "@/lib/server/settings";
import { useTheme, THEMES, type ThemeId } from "@/lib/client/theme";
import { useLinkTarget } from "@/lib/client/link-target";
import { LINK_TARGETS } from "@/lib/shared/link-target";
import { useIsElectron } from "@/lib/client/useElectron";
import { EDITORS, useEditor, type EditorId } from "@/lib/client/ide";
import { UpdaterSettingsSection } from "@/components/updater/UpdaterSettingsSection";
import { ShortcutsSection } from "@/components/settings/ShortcutsSection";
import { RateLimitWarningSection } from "@/components/settings/RateLimitWarningSection";
import { ContextWarningSection } from "@/components/settings/ContextWarningSection";
import { GoalBannerSection } from "@/components/settings/GoalBannerSection";
import { BackupSection } from "@/components/settings/BackupSection";
import { ChatSizeSection } from "@/components/settings/ChatSizeSection";
import { FilePermissionsSection } from "@/components/settings/FilePermissionsSection";
import {
  ADVISOR_COPY,
  ADVISOR_OPTIONS,
  type AdvisorChoice,
  normalizeAdvisorChoice,
} from "@/lib/shared/advisor";
import { useMediaPreferences } from "@/lib/client/useMediaPreferences";
import { cn } from "@/lib/utils/cn";
import { setStatusLineCommand, setStatusLineRefreshInterval, type StatusLineConfig } from "@/lib/shared/status-line";
import { nextWorktree, parseDirList } from "@/lib/shared/worktree-settings";

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
  // Settings search — Chrome/Firefox-style filter that hides any section whose
  // name/keywords don't match the query. Ignored in Raw JSON mode (one big
  // textarea, nothing to filter).
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<ClaudeSettings>({});
  const [rawDraft, setRawDraft] = useState<string>("");
  const [rawError, setRawError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const theme = useTheme();
  const linkTarget = useLinkTarget();
  const isElectron = useIsElectron();
  const ide = useEditor();
  const mediaPref = useMediaPreferences();

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

  // Case-insensitive substring match for the settings search. Each section
  // declares a bag of keywords (its title plus the field labels / concepts it
  // contains) so a query like "compact" or "status line" reveals the right
  // section. Disabled in Raw JSON mode so the textarea is never hidden.
  const q = showRaw ? "" : query.trim().toLowerCase();
  const show = (keywords: string) => !q || keywords.toLowerCase().includes(q);

  // Self-contained sections — filtered as whole units (their bodies are custom
  // widgets, not a flat list of fields).
  const sEditor = show("open in editor file paths tool blocks url scheme editor vscode click-through");
  const sTheme = show("web app theme dark light color appearance browser ui");
  const sPreviews = show("previews images html render inline chat file browser preview toggle");
  const sChatSize = show(
    "chat size column width font body text reading column display zoom typography big screen large display retina",
  );
  // Link target is meaningful only inside the desktop app — in the browser
  // the OS / current tab decides where links open. Roll the platform gate
  // into the visibility flag so it also clears out of the search-match
  // accounting below (otherwise a "no matches" page could appear blank
  // because the only hit was hidden by the platform check).
  const sLinkTarget =
    isElectron &&
    show("link target external browser in-app viewer click open hyperlink electron");
  const sUpdater = show("updater auto update version release channel app update install");
  const sShortcuts = show("keyboard shortcuts keybindings tab cycling navigation side nav workspace");
  const sRateLimit = show("rate limit warning threshold usage pill chat");
  const sContext = show("context window warning compact banner threshold nudge chat");
  const sGoalBanner = show("session goal prompt banner hide show header objective chat");
  const sBackup = show("backup restore export import config bundle json snapshot");
  // macOS file-permission priming — desktop-app only (the bridge doesn't
  // exist in the browser build), so fold the platform gate into visibility
  // like sLinkTarget does.
  const sFilePerms =
    isElectron &&
    show("file permissions macos tcc documents desktop downloads pictures music movies access folder privacy claude code");
  const sWorktree = show("worktree sparse paths sparsepaths sparse-checkout cone monorepo symlink directories symlinkdirectories node_modules disk bloat");
  // Model & UI / Memory — matched per row against each field's label, so a query
  // like "output style" or "automemorydirectory" reveals just that row. A match
  // on the section title forces all of its rows to show.
  const fModelUi = show("model & ui defaults startup");
  const rModel = fModelUi || show("model");
  const rCliTheme = fModelUi || show("theme (cli rendering)");
  const rOutputStyle = fModelUi || show("output style");
  const rStatusLine = fModelUi || show("status line script refresh interval padding");
  const sModelUi = rModel || rCliTheme || rOutputStyle || rStatusLine;

  const fMemory = show("memory");
  const rAutoMemory = fMemory || show("automemoryenabled auto-memory");
  const rAutoDream = fMemory || show("autodreamenabled auto-dream consolidation");
  const rAutoMemDir = fMemory || show("automemorydirectory directory");
  const rClaudeMdExcludes = fMemory || show("claudemdexcludes comma-separated globs");
  const sMemory = rAutoMemory || rAutoDream || rAutoMemDir || rClaudeMdExcludes;

  // Chat has a single row, so its card guard is already row-level.
  const sChat = show("chat promptsuggestionenabled prompt suggestion follow-up chips composer");
  const sEnv = show("environment env variables key value");
  const sPlugins = show("plugins enabled plugin marketplace");
  const sOther = show("other keys custom advanced extra json");

  // Catalog sections (data-driven) — filtered down to the matching fields, and
  // dropped entirely when nothing in them matches. A section-title match forces
  // all of its fields to show.
  const catalogEntries = Object.entries(CATALOG_SECTIONS)
    .map(([section, metas]) => {
      const forced = show(section);
      const visible = metas.filter((m) => forced || show(`${m.key} ${m.desc}`));
      return [section, visible] as const;
    })
    .filter(([, visible]) => visible.length > 0);

  const anyMatch =
    sEditor || sTheme || sPreviews || sChatSize || sLinkTarget || sUpdater || sShortcuts || sRateLimit || sContext || sGoalBanner ||
    sBackup || sFilePerms || sWorktree || sModelUi || sMemory || sChat || sEnv || sPlugins || sOther ||
    catalogEntries.length > 0;
  const noMatches = !!q && !anyMatch;

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
          {showRaw ? (
            <div className="flex-1" />
          ) : (
            <div className="flex-1 px-3">
              <div className="relative mx-auto max-w-md">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--muted)]" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search settings"
                  aria-label="Search settings"
                  className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] py-1 pl-8 pr-7 text-xs focus:outline-none"
                />
                {query && (
                  <button
                    onClick={() => setQuery("")}
                    title="Clear search"
                    aria-label="Clear search"
                    className="absolute right-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-[var(--muted)] hover:text-[var(--foreground)]"
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
            </div>
          )}
          <button
            onClick={settings.refresh}
            className="flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-0.5 hover:bg-[var(--panel)]"
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

        <div className="flex-1 overflow-y-auto scroll-thin pb-6">
          {/* Active-search indicator. The Settings tab stays mounted, so a
              query typed earlier persists when you return — and with only a
              few matches the rest of the page is empty, which reads as a
              broken/blank page. This banner makes the filtered state explicit
              and offers a one-click clear. Only shown when the query actually
              trims the list to some (non-zero) matches; the "No settings
              match" message below covers the zero-match case. */}
          {q && anyMatch && (
            <div className="mx-auto mt-3 flex max-w-4xl items-center gap-2 px-6 text-[11px] text-[var(--muted)]">
              <Search className="h-3 w-3 shrink-0" />
              <span>
                Filtered by “<span className="text-[var(--foreground)]">{query}</span>” — other
                settings are hidden.
              </span>
              <button
                onClick={() => setQuery("")}
                className="rounded border border-[var(--border)] bg-[var(--panel-2)] px-1.5 py-0.5 text-[var(--foreground)] hover:bg-[var(--panel)]"
              >
                Clear filter
              </button>
            </div>
          )}
          {/* Split layout: the centered `max-w-4xl` cap is great for cards but
              clips the chat-size preview behind it. The wrapper opens here for
              Editor + Theme, closes before ChatSizeSection (which spans the
              full scroll-container width), and reopens after for Link target
              onward. Each segment uses `mt-5` to mirror the original
              `space-y-5` rhythm between section cards. */}
          {(sEditor || sTheme || sPreviews) && (
          <div className="mx-auto max-w-4xl space-y-5 px-6 pt-6">
            {sEditor && (
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
            )}

            {sTheme && (
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
            )}

            {sPreviews && (
            <Section
              title="Previews"
              subtitle="Show inline image and HTML previews in chat tool calls and the file browser."
            >
              <label className="flex cursor-pointer items-center gap-3">
                <input
                  type="checkbox"
                  checked={mediaPref.showPreviews}
                  onChange={(e) => mediaPref.setShowPreviews(e.target.checked)}
                  className="h-4 w-4 accent-[var(--accent)]"
                />
                <span className="text-xs">
                  Show file previews — images (PNG, GIF, SVG, …) and rendered HTML
                </span>
              </label>
              <p className="mt-1.5 text-[11px] text-[var(--muted)]">
                Stored locally in the browser. Images render expanded by default; HTML renders collapsed.
                All HTML runs inside a fully sandboxed iframe (no scripts).
              </p>
            </Section>
            )}

          </div>
          )}

          {/* Chat reading column + body text size. Rendered OUTSIDE the
              centered `max-w-4xl` wrapper so the live preview can span the
              full scroll-container width — wide-column choices (>56 rem)
              would otherwise clip behind the cap. ChatSizeSection re-applies
              its own `max-w-4xl` around the controls card so it stays
              visually matched to the other cards. Lives in localStorage
              (instant-apply, no Save). */}
          {sChatSize && (
            <div className="mt-5">
              <ChatSizeSection />
            </div>
          )}

          <div className="mx-auto max-w-4xl space-y-5 px-6 mt-5">
            {/* Link target is Electron-only — in the browser, OS / browser
                tab behavior handles where links open, so the setting has no
                effect and just clutters the page. Gated on `isElectron` so
                the section disappears entirely in the web build. */}
            {sLinkTarget && (
            <Section
              title="Link target"
              subtitle="Where clicked links open. Right-click still lets you override per-link."
            >
              <div className="flex flex-col gap-2">
                {LINK_TARGETS.map((opt) => (
                  <button
                    key={opt.id}
                    onClick={() => linkTarget.setTarget(opt.id)}
                    className={cn(
                      "flex flex-col items-start gap-1 rounded-md border px-3 py-2 text-left",
                      linkTarget.target === opt.id
                        ? "border-[var(--accent)] bg-[var(--panel-2)]"
                        : "border-[var(--border)] bg-[var(--panel)] hover:bg-[var(--panel-2)]",
                    )}
                    data-testid={`link-target-${opt.id}`}
                  >
                    <span className="text-xs font-medium">{opt.label}</span>
                    <span className="text-[10px] text-[var(--muted)]">{opt.description}</span>
                  </button>
                ))}
              </div>
            </Section>
            )}

            {/* Install-wide updater settings — independent of the User/Project/Local
                scope tabs above (those edit Claude's settings.json; this hits the
                separate updater.json store). Always visible regardless of scope. */}
            {sUpdater && <UpdaterSettingsSection />}

            {/* Browser-only keyboard shortcuts (tab cycling, side-nav nav, workspace
                cycling). Persisted to localStorage, so it sits outside the scope
                tabs above. The CLI input keybindings live on /keybindings. */}
            {sShortcuts && <ShortcutsSection />}

            {/* Browser-local threshold for the chat-side rate-limit pill —
                also outside the scope tabs because it's a Claudius UI knob,
                not a Claude Code settings.json value. */}
            {sRateLimit && <RateLimitWarningSection />}

            {/* Browser-local threshold for the chat-side context-window
                warning banner (the one-click Compact nudge). Also outside the
                scope tabs — a Claudius UI knob, separate from Claude Code's
                autoCompactEnabled / autoCompactWindow settings. */}
            {sContext && <ContextWarningSection />}

            {/* Browser-local toggle to hide/restore the empty "Set a session
                goal" prompt in the chat header. A Claudius UI knob, separate
                from the goal data itself (which lives per-project). */}
            {sGoalBanner && <GoalBannerSection />}

            {/* Backup / restore the full Claudius config as one JSON bundle.
                Outside the scope tabs because it spans every scope and
                every workspace, not a single settings.json file. */}
            {sBackup && <BackupSection />}

            {/* macOS file-permission priming — front-load the OS Files &
                Folders prompts so Claude Code doesn't trip them at random.
                Desktop-app only; outside the scope tabs (the marker lives in
                Electron userData, not settings.json). */}
            {sFilePerms && <FilePermissionsSection />}

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
                {sModelUi && (
                <Section title="Model & UI" subtitle="Defaults Claude Code reads on startup.">
                  {rModel && (
                  <Field label="Model">
                    <input
                      value={(draft.model as string | undefined) ?? ""}
                      onChange={(e) => update({ model: e.target.value || undefined })}
                      placeholder="(unset — uses CLI default)"
                      className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 font-mono text-xs focus:outline-none"
                    />
                  </Field>
                  )}
                  {rCliTheme && (
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
                  )}
                  {rOutputStyle && (
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
                  )}
                  {rStatusLine && (
                  <>
                  <Field label="Status line script">
                    <input
                      value={(draft.statusLine as StatusLineConfig | undefined)?.command ?? ""}
                      onChange={(e) => {
                        const sl = draft.statusLine as StatusLineConfig | undefined;
                        update({ statusLine: setStatusLineCommand(sl, e.target.value) });
                      }}
                      placeholder="/path/to/statusline.sh"
                      className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 font-mono text-xs focus:outline-none"
                    />
                  </Field>
                  <Field label="Refresh interval (s)">
                    <input
                      type="number"
                      min={0}
                      disabled={!(draft.statusLine as StatusLineConfig | undefined)?.command}
                      value={(draft.statusLine as StatusLineConfig | undefined)?.refreshInterval ?? ""}
                      onChange={(e) => {
                        const sl = draft.statusLine as StatusLineConfig | undefined;
                        const raw = e.target.value.trim();
                        if (!raw) {
                          update({ statusLine: setStatusLineRefreshInterval(sl, undefined) });
                          return;
                        }
                        const n = Number(raw);
                        if (Number.isFinite(n) && n >= 0) {
                          update({ statusLine: setStatusLineRefreshInterval(sl, n) });
                        }
                      }}
                      placeholder="(event-driven only)"
                      className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 font-mono text-xs focus:outline-none disabled:opacity-50"
                    />
                  </Field>
                  </>
                  )}
                </Section>
                )}

                {sMemory && (
                <Section title="Memory">
                  {rAutoMemory && (
                  <ToggleRow
                    label="autoMemoryEnabled"
                    checked={Boolean(draft.autoMemoryEnabled)}
                    onChange={(b) => update({ autoMemoryEnabled: b ? true : undefined })}
                    description="Enable auto-memory for this project. When false, Claude will not read from or write to the auto-memory directory."
                  />
                  )}
                  {rAutoDream && (
                  <ToggleRow
                    label="autoDreamEnabled"
                    checked={Boolean(draft.autoDreamEnabled)}
                    onChange={(b) => update({ autoDreamEnabled: b ? true : undefined })}
                    description="Enable background memory consolidation (auto-dream). When set, overrides the server-side default."
                  />
                  )}
                  {rAutoMemDir && (
                  <Field label="autoMemoryDirectory">
                    <input
                      value={(draft.autoMemoryDirectory as string | undefined) ?? ""}
                      onChange={(e) => update({ autoMemoryDirectory: e.target.value || undefined })}
                      placeholder="~/.claude/projects/<sanitized-cwd>/memory/"
                      className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 font-mono text-xs focus:outline-none"
                    />
                  </Field>
                  )}
                  {rClaudeMdExcludes && (
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
                  )}
                </Section>
                )}

                {sWorktree && (
                <Section
                  title="Worktree"
                  subtitle="Git worktree creation options (the --worktree flag / EnterWorktree)."
                >
                  <Field label="sparsePaths (comma-separated dirs)">
                    <input
                      value={(draft.worktree?.sparsePaths ?? []).join(", ")}
                      onChange={(e) => {
                        const arr = parseDirList(e.target.value);
                        update({ worktree: nextWorktree(draft.worktree, { sparsePaths: arr.length ? arr : undefined }) });
                      }}
                      placeholder="apps/web, packages/ui"
                      className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 font-mono text-xs focus:outline-none"
                    />
                    <p className="mt-1 text-[11px] text-[var(--muted)]">
                      Directories to include when creating worktrees, via git sparse-checkout (cone mode). Dramatically faster in large monorepos.
                    </p>
                  </Field>
                  <Field label="symlinkDirectories (comma-separated dirs)">
                    <input
                      value={(draft.worktree?.symlinkDirectories ?? []).join(", ")}
                      onChange={(e) => {
                        const arr = parseDirList(e.target.value);
                        update({ worktree: nextWorktree(draft.worktree, { symlinkDirectories: arr.length ? arr : undefined }) });
                      }}
                      placeholder="node_modules, .cache, .bin"
                      className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 font-mono text-xs focus:outline-none"
                    />
                    <p className="mt-1 text-[11px] text-[var(--muted)]">
                      Directories symlinked from the main repository to each worktree to avoid disk bloat.
                    </p>
                  </Field>
                </Section>
                )}

                {sChat && (
                <Section title="Chat">
                  <ToggleRow
                    label="promptSuggestionEnabled"
                    checked={draft.promptSuggestionEnabled !== false}
                    onChange={(b) => update({ promptSuggestionEnabled: b ? undefined : false })}
                    description="Show AI-predicted follow-up prompts as clickable chips under the composer after each turn. On by default."
                  />
                  <ToggleRow
                    label="sessionRecapEnabled"
                    checked={draft.sessionRecapEnabled !== false}
                    onChange={(b) => update({ sessionRecapEnabled: b ? undefined : false })}
                    description='Show a "where were we?" one-line recap above the composer when you return after stepping away (≥5 min). On by default. Triggered automatically on tab refocus.'
                  />
                  <ToggleRow
                    label="queueDispatchMode = asap"
                    checked={draft.queueDispatchMode === "asap"}
                    onChange={(b) =>
                      update({ queueDispatchMode: b ? "asap" : undefined })
                    }
                    description='When you send a message while the agent is still working, "wait" (default) stages it in the queue strip until the current turn ends. "asap" mirrors the Claude Code TUI — the message is pushed to the agent immediately and runs as the very next turn, with no queue-strip step. Per-message override available via the "Send now" button on individual queued messages.'
                  />
                </Section>
                )}

                {catalogEntries.map(([section, metas]) => (
                  <Section
                    key={section}
                    title={section}
                    subtitle="Claude Code settings from the SDK. Blank / “Default” means the key is absent and Claude Code's built-in default applies."
                  >
                    {metas.map((m) => (
                      <CatalogField key={m.key} meta={m} draft={draft} update={update} />
                    ))}
                  </Section>
                ))}

                {sEnv && (
                <Section title="Environment">
                  <EnvEditor
                    value={(draft.env as Record<string, string> | undefined) ?? {}}
                    onChange={(env) =>
                      update({ env: Object.keys(env).length ? (env as ClaudeSettings["env"]) : undefined })
                    }
                  />
                </Section>
                )}

                {sPlugins && (
                <Section title="Plugins" subtitle="Read-only here — manage via /plugin (Phase 13).">
                  <pre className="rounded-md border border-[var(--border)] bg-[var(--panel-2)] p-3 font-mono text-[11px] scroll-thin overflow-auto">
                    {JSON.stringify(draft.enabledPlugins ?? {}, null, 2)}
                  </pre>
                </Section>
                )}

                {sOther && (
                <Section
                  title="Other"
                  subtitle="Every other key in this file, editable. Booleans become toggles, scalars become inputs, and objects/arrays get a JSON editor."
                >
                  <OtherEditor key={activeKey} draft={draft} update={update} />
                </Section>
                )}

                {noMatches && (
                  <div className="py-10 text-center text-xs text-[var(--muted)]">
                    No settings match “{query}”.
                  </div>
                )}
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
  "autoDreamEnabled",
  "autoMemoryDirectory",
  "promptSuggestionEnabled",
  "sessionRecapEnabled",
  "queueDispatchMode",
  "claudeMdExcludes",
  "enabledPlugins",
  "env",
  "disableAllHooks",
  "worktree",
]);

// Catalog of Claude Code settings.json keys worth surfacing as labeled
// fields, transcribed VERBATIM from the SDK's `Settings` interface JSDoc in
// `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`. Deliberately
// curated, not exhaustive: managed/enterprise-only keys (allowManaged*Only,
// strictKnownMarketplaces, modelOverrides, availableModels, *McpServers
// allow/deny lists, etc.), keys already covered by their own UI sections,
// and complex nested objects (worktree, attribution, hooks…) are omitted —
// the latter fall through to the generic "Other" editor. When the SDK bumps,
// diff this table against the new sdk.d.ts.
type CatalogType = "boolean" | "number" | "string" | "string[]" | "enum";
type SettingMeta = {
  key: keyof ClaudeSettings & string;
  type: CatalogType;
  desc: string;
  section: string;
  deprecated?: boolean;
  options?: string[];
  placeholder?: string;
};
const SDK_SETTINGS_CATALOG: SettingMeta[] = [
  {
    key: "advisorModel",
    type: "string",
    section: "Model & behavior",
    placeholder: "opus",
    desc: "Advisor model for the server-side advisor tool.",
  },
  {
    key: "language",
    type: "string",
    section: "Model & behavior",
    placeholder: "japanese",
    desc: 'Preferred language for Claude responses and voice dictation (e.g., "japanese", "spanish")',
  },
  {
    key: "fastMode",
    type: "boolean",
    section: "Model & behavior",
    desc: "When true, fast mode is enabled. When absent or false, fast mode is off.",
  },
  {
    key: "alwaysThinkingEnabled",
    type: "boolean",
    section: "Thinking & effort",
    desc: "When false, thinking is disabled. When absent or true, thinking is enabled automatically for supported models.",
  },
  {
    key: "showThinkingSummaries",
    type: "boolean",
    section: "Thinking & effort",
    desc: "Request API-side thinking summaries and show them in the conversation and in the transcript view (ctrl+o). Set explicitly to override the default for your install.",
  },
  {
    key: "effortLevel",
    type: "enum",
    section: "Thinking & effort",
    options: ["low", "medium", "high", "xhigh"],
    desc: "Persisted effort level for supported models.",
  },
  {
    key: "autoCompactEnabled",
    type: "boolean",
    section: "Context & compaction",
    desc: "Automatically compact conversation when context fills",
  },
  {
    key: "autoCompactWindow",
    type: "number",
    section: "Context & compaction",
    desc: "Auto-compact window size",
  },
  {
    key: "cleanupPeriodDays",
    type: "number",
    section: "Storage & sessions",
    placeholder: "30",
    desc: "Number of days to retain chat transcripts before automatic cleanup (default: 30). Minimum 1. Use a large value for long retention; use --no-session-persistence to disable transcript writes entirely.",
  },
  {
    key: "feedbackSurveyRate",
    type: "number",
    section: "Storage & sessions",
    placeholder: "0.05",
    desc: "Probability (0–1) that the session quality survey appears when eligible. 0.05 is a reasonable starting point.",
  },
  {
    key: "respectGitignore",
    type: "boolean",
    section: "Files",
    desc: "Whether file picker should respect .gitignore files (default: true). Note: .ignore files are always respected.",
  },
  {
    key: "includeCoAuthoredBy",
    type: "boolean",
    section: "Git",
    desc: "Include Claude's `Co-Authored-By: Claude <noreply@anthropic.com>` trailer in commits and PRs (default: true). Turn off to omit it.",
  },
  {
    key: "includeGitInstructions",
    type: "boolean",
    section: "Git",
    desc: "Include built-in commit and PR workflow instructions in Claude's system prompt (default: true)",
  },
  {
    key: "prUrlTemplate",
    type: "string",
    section: "Git",
    placeholder: "https://reviews.example.com/{owner}/{repo}/pull/{number}",
    desc: "URL template for PR links in the footer badge and inline messages. Placeholders: {host} {owner} {repo} {number} {url}.",
  },
  {
    key: "enableAllProjectMcpServers",
    type: "boolean",
    section: "MCP",
    desc: "Whether to automatically approve all MCP servers in the project",
  },
  {
    key: "enabledMcpjsonServers",
    type: "string[]",
    section: "MCP",
    placeholder: "server-a, server-b",
    desc: "List of approved MCP servers from .mcp.json",
  },
  {
    key: "disabledMcpjsonServers",
    type: "string[]",
    section: "MCP",
    placeholder: "server-c",
    desc: "List of rejected MCP servers from .mcp.json",
  },
  {
    key: "skillListingMaxDescChars",
    type: "number",
    section: "Skills",
    placeholder: "1536",
    desc: "Per-skill description character cap in the skill listing sent to Claude (default: 1536). Descriptions longer than this are truncated. Raise to opt in to higher per-turn context cost.",
  },
  {
    key: "skillListingBudgetFraction",
    type: "number",
    section: "Skills",
    placeholder: "0.01",
    desc: "Fraction of the context window (in characters) reserved for the skill listing sent to Claude (default: 0.01 = 1%). When the listing exceeds this, descriptions are shortened to fit. Raise to opt in to higher per-turn context cost.",
  },
  {
    key: "disableSkillShellExecution",
    type: "boolean",
    section: "Skills",
    desc: "Disable inline shell execution in skills and custom slash commands from user, project, or plugin sources. Commands are replaced with a placeholder instead of being run.",
  },
  {
    key: "skipDangerousModePermissionPrompt",
    type: "boolean",
    section: "Permissions",
    desc: "Whether the user has accepted the bypass permissions mode dialog",
  },
  {
    key: "disableAutoMode",
    type: "enum",
    section: "Permissions",
    options: ["disable"],
    desc: 'Disable Auto mode (the autonomous permission mode) entirely — hides "Auto" from the mode picker and the Shift+Tab cycle. Default/absent leaves Auto mode available. Matches the SDK\'s single-literal key exactly (no separate "enabled" value).',
  },
  {
    key: "defaultShell",
    type: "enum",
    section: "Shell",
    options: ["bash", "powershell"],
    desc: "Default shell for input-box ! commands. Defaults to 'bash' on all platforms (no Windows auto-flip).",
  },
  {
    key: "forceLoginMethod",
    type: "enum",
    section: "Authentication",
    options: ["claudeai", "console"],
    desc: 'Force a specific login method: "claudeai" for Claude Pro/Max, "console" for Console billing',
  },
  {
    key: "apiKeyHelper",
    type: "string",
    section: "Authentication",
    placeholder: "/path/to/key-helper.sh",
    desc: "Path to a script that outputs authentication values",
  },
  {
    key: "proxyAuthHelper",
    type: "string",
    section: "Authentication",
    desc: "Shell command that outputs a Proxy-Authorization header value (EAP)",
  },
  {
    key: "awsCredentialExport",
    type: "string",
    section: "Authentication",
    placeholder: "/path/to/aws-creds.sh",
    desc: "Path to a script that exports AWS credentials",
  },
  {
    key: "awsAuthRefresh",
    type: "string",
    section: "Authentication",
    placeholder: "/path/to/aws-refresh.sh",
    desc: "Path to a script that refreshes AWS authentication",
  },
  {
    key: "gcpAuthRefresh",
    type: "string",
    section: "Authentication",
    placeholder: "gcloud auth application-default login",
    desc: "Command to refresh GCP authentication (e.g., gcloud auth application-default login)",
  },
];
const CATALOG_KEYS = new Set(SDK_SETTINGS_CATALOG.map((s) => s.key));
const CATALOG_SECTIONS = SDK_SETTINGS_CATALOG.reduce<Record<string, SettingMeta[]>>((acc, m) => {
  (acc[m.section] ??= []).push(m);
  return acc;
}, {});

type Patch = Partial<ClaudeSettings>;

function OtherEditor({
  draft,
  update,
}: {
  draft: ClaudeSettings;
  update: (patch: Patch) => void;
}) {
  const others = Object.entries(draft).filter(
    ([k]) => !KNOWN_KEYS.has(k) && !CATALOG_KEYS.has(k),
  );
  return (
    <div className="space-y-2">
      {others.length === 0 ? (
        <div className="text-[11px] italic text-[var(--muted)]">No other keys.</div>
      ) : (
        others.map(([key, value]) => (
          <OtherRow key={key} name={key} value={value} update={update} />
        ))
      )}
      <AddKeyRow draft={draft} update={update} />
    </div>
  );
}

function RemoveBtn({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title="Remove key"
      className="shrink-0 rounded p-1 text-[var(--muted)] hover:bg-[var(--panel)] hover:text-red-400"
    >
      <X className="h-3 w-3" />
    </button>
  );
}

function OtherRow({
  name,
  value,
  update,
}: {
  name: string;
  value: unknown;
  update: (patch: Patch) => void;
}) {
  const remove = () => update({ [name]: undefined } as Patch);

  if (typeof value === "boolean") {
    return (
      <div className="flex items-center gap-2">
        <label className="flex flex-1 cursor-pointer items-center gap-3 rounded-md border border-[var(--border)] bg-[var(--panel-2)]/40 p-2">
          <input
            type="checkbox"
            checked={value}
            onChange={(e) => update({ [name]: e.target.checked } as Patch)}
            className="h-3.5 w-3.5"
          />
          <span className="flex-1 font-mono text-xs">{name}</span>
        </label>
        <RemoveBtn onClick={remove} />
      </div>
    );
  }

  if (typeof value === "number") {
    return (
      <Field label={name}>
        <div className="flex items-center gap-2">
          <input
            type="number"
            value={Number.isFinite(value) ? value : ""}
            onChange={(e) => {
              if (e.target.value === "") return;
              const n = Number(e.target.value);
              if (!Number.isNaN(n)) update({ [name]: n } as Patch);
            }}
            className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 font-mono text-xs focus:outline-none"
          />
          <RemoveBtn onClick={remove} />
        </div>
      </Field>
    );
  }

  if (typeof value === "string") {
    return (
      <Field label={name}>
        <div className="flex items-center gap-2">
          <input
            value={value}
            onChange={(e) => update({ [name]: e.target.value } as Patch)}
            className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 font-mono text-xs focus:outline-none"
          />
          <RemoveBtn onClick={remove} />
        </div>
      </Field>
    );
  }

  // Objects, arrays, and null fall back to a JSON editor.
  return <JsonRow name={name} value={value} update={update} onRemove={remove} />;
}

function JsonRow({
  name,
  value,
  update,
  onRemove,
}: {
  name: string;
  value: unknown;
  update: (patch: Patch) => void;
  onRemove: () => void;
}) {
  // Local text buffer so partial/invalid JSON doesn't fight the controlled
  // input. Each keystroke that parses cleanly commits to the draft (so a
  // Save without blurring never drops the edit); an unparseable buffer keeps
  // the last valid value and surfaces the error. The parent re-mounts this
  // row on scope switch / refetch (OtherEditor is keyed by activeKey) so the
  // seed never goes stale.
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [err, setErr] = useState<string | null>(null);
  const onText = (next: string) => {
    setText(next);
    try {
      update({ [name]: JSON.parse(next) } as Patch);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <Field label={name}>
      <div className="flex items-start gap-2">
        <div className="flex-1">
          <textarea
            value={text}
            onChange={(e) => onText(e.target.value)}
            spellCheck={false}
            rows={Math.min(10, Math.max(2, text.split("\n").length))}
            className="block w-full resize-y rounded-md border border-[var(--border)] bg-[var(--panel-2)] p-2 font-mono text-[11px] leading-5 focus:outline-none scroll-thin"
          />
          {err && (
            <div className="mt-1 rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1 text-[11px] text-red-300">
              {err}
            </div>
          )}
        </div>
        <RemoveBtn onClick={onRemove} />
      </div>
    </Field>
  );
}

const NEW_KEY_TYPES = ["string", "boolean", "number", "json"] as const;
type NewKeyType = (typeof NEW_KEY_TYPES)[number];

function AddKeyRow({ draft, update }: { draft: ClaudeSettings; update: (patch: Patch) => void }) {
  const [name, setName] = useState("");
  const [type, setType] = useState<NewKeyType>("string");
  const trimmed = name.trim();
  const duplicate = trimmed in draft;
  const add = () => {
    if (!trimmed || duplicate) return;
    const init: unknown =
      type === "boolean" ? true : type === "number" ? 0 : type === "json" ? {} : "";
    update({ [trimmed]: init } as Patch);
    setName("");
    setType("string");
  };
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2 border-t border-[var(--border)] pt-2">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") add();
        }}
        placeholder="newSettingKey"
        className="flex-1 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1 font-mono text-[11px] focus:outline-none"
      />
      <select
        value={type}
        onChange={(e) => setType(e.target.value as NewKeyType)}
        className="rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1 text-[11px] focus:outline-none"
      >
        {NEW_KEY_TYPES.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
      <button
        onClick={add}
        disabled={!trimmed || duplicate}
        title={duplicate ? "Key already exists" : undefined}
        className="rounded-md bg-[var(--accent)] px-2 py-1 text-[11px] text-white hover:opacity-90 disabled:opacity-40"
      >
        Add key
      </button>
    </div>
  );
}

function CatalogField({
  meta,
  draft,
  update,
}: {
  meta: SettingMeta;
  draft: ClaudeSettings;
  update: (patch: Patch) => void;
}) {
  const value = (draft as Record<string, unknown>)[meta.key];
  const set = (v: unknown) => update({ [meta.key]: v } as Patch);

  // `advisorModel` gets a rich, Claude Code-style picker instead of the
  // generic free-form text input. The radio options + copy come from
  // `lib/shared/advisor.ts`, which is also what the SessionCard's
  // ModelPicker renders — so the two surfaces stay in lock-step. Power
  // users can still drop the value via the "default" row.
  if (meta.key === "advisorModel") {
    return <AdvisorCatalogField value={value} set={set} />;
  }
  const inputCls =
    "w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 font-mono text-xs focus:outline-none";
  const selectCls =
    "w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 text-xs focus:outline-none";

  let control: React.ReactNode;
  if (meta.type === "boolean") {
    const cur = value === true ? "true" : value === false ? "false" : "";
    control = (
      <select
        value={cur}
        onChange={(e) => set(e.target.value === "" ? undefined : e.target.value === "true")}
        className={selectCls}
      >
        <option value="">Default</option>
        <option value="true">On (true)</option>
        <option value="false">Off (false)</option>
      </select>
    );
  } else if (meta.type === "enum") {
    control = (
      <select
        value={typeof value === "string" ? value : ""}
        onChange={(e) => set(e.target.value || undefined)}
        className={selectCls}
      >
        <option value="">Default</option>
        {meta.options?.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  } else if (meta.type === "number") {
    control = (
      <input
        type="number"
        value={typeof value === "number" ? value : ""}
        placeholder={meta.placeholder ?? "(default)"}
        onChange={(e) => {
          if (e.target.value === "") return set(undefined);
          const n = Number(e.target.value);
          if (!Number.isNaN(n)) set(n);
        }}
        className={inputCls}
      />
    );
  } else if (meta.type === "string[]") {
    const arr = Array.isArray(value) ? (value as string[]) : [];
    control = (
      <input
        value={arr.join(", ")}
        placeholder={meta.placeholder ?? "a, b, c"}
        onChange={(e) => {
          const list = e.target.value
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
          set(list.length ? list : undefined);
        }}
        className={inputCls}
      />
    );
  } else {
    control = (
      <input
        value={typeof value === "string" ? value : ""}
        placeholder={meta.placeholder ?? "(unset)"}
        onChange={(e) => set(e.target.value || undefined)}
        className={inputCls}
      />
    );
  }

  const isSet = value !== undefined;
  return (
    <div
      data-testid={`catalog-field-${meta.key}`}
      className="rounded-md border border-[var(--border)] bg-[var(--panel-2)]/40 p-2"
    >
      <div className="mb-1 flex items-center gap-2">
        <span className="font-mono text-xs">{meta.key}</span>
        {meta.deprecated && (
          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-amber-400">
            deprecated
          </span>
        )}
        <span
          className={cn(
            "ml-auto text-[9px] uppercase tracking-wide",
            isSet ? "text-[var(--accent)]" : "text-[var(--muted)]",
          )}
        >
          {isSet ? "overridden" : "default"}
        </span>
      </div>
      <p className="mb-2 text-[11px] leading-4 text-[var(--muted)]">{meta.desc}</p>
      {control}
    </div>
  );
}

/**
 * Custom catalog row for `advisorModel` — replaces the generic free-form
 * text input with the Claude Code-style picker (3 fixed options, the
 * "(experimental)" header, the explanatory paragraph, the recommended
 * setup line, and a learn-more link). Mirrors the per-session picker in
 * `components/panels/widgets/ModelPicker.tsx` exactly: the copy and
 * options come from the same `lib/shared/advisor.ts` module.
 *
 * Selecting "No advisor" clears the key (writes `undefined`) so the key
 * disappears from settings.json rather than persisting as an empty
 * string — keeps the file tidy and matches the convention of the rest of
 * the catalog (blank ⇄ unset).
 */
function AdvisorCatalogField({
  value,
  set,
}: {
  value: unknown;
  set: (v: unknown) => void;
}) {
  // Normalize whatever's currently in settings.json to one of our three
  // known choices. An unknown string (e.g. a hand-edited custom model id)
  // collapses to "no advisor" in the UI — but we preserve the raw value
  // until the user clicks a different row, so an accidental load of this
  // page can't silently nuke a power-user override.
  const current = normalizeAdvisorChoice(value);
  const isSet = typeof value === "string" && value.length > 0;
  const customValue =
    isSet && current === null ? (value as string) : null;
  const pick = (choice: AdvisorChoice) => {
    // `null` → unset (`undefined`) so the key drops out of settings.json.
    // A string value persists verbatim.
    set(choice ?? undefined);
  };
  return (
    <div className="rounded-md border border-[var(--border)] bg-[var(--panel-2)]/40 p-3">
      <div className="mb-1 flex items-center gap-2">
        <span className="font-mono text-xs">advisorModel</span>
        <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-amber-400">
          experimental
        </span>
        <span
          className={cn(
            "ml-auto text-[9px] uppercase tracking-wide",
            isSet ? "text-[var(--accent)]" : "text-[var(--muted)]",
          )}
        >
          {isSet ? "overridden" : "default"}
        </span>
      </div>
      <div className="mb-2 text-sm font-medium">{ADVISOR_COPY.header}</div>
      <p className="mb-3 text-[11px] leading-snug text-[var(--muted)]">
        {ADVISOR_COPY.paragraph}
      </p>
      <ul
        role="radiogroup"
        aria-label={ADVISOR_COPY.header}
        className="space-y-1.5"
      >
        {ADVISOR_OPTIONS.map((opt) => {
          const isCurrent = opt.value === current && customValue === null;
          return (
            <li key={opt.value ?? "none"}>
              <button
                type="button"
                role="radio"
                aria-checked={isCurrent}
                data-testid="advisor-setting-option"
                data-advisor={opt.value ?? "none"}
                data-current={isCurrent ? "1" : "0"}
                onClick={() => pick(opt.value)}
                className={cn(
                  "flex w-full items-center gap-2 rounded border px-2 py-2 text-left transition",
                  isCurrent
                    ? "border-[var(--accent)]/50 bg-[var(--accent)]/10"
                    : "border-[var(--border)] bg-[var(--panel-2)] hover:bg-[var(--panel)]",
                )}
              >
                <span
                  className={cn(
                    "h-3 w-3 shrink-0 rounded-full border",
                    isCurrent
                      ? "border-[var(--accent)] bg-[var(--accent)]"
                      : "border-[var(--border)] bg-transparent",
                  )}
                />
                <span className="flex-1 truncate text-xs text-[var(--foreground)]">
                  {opt.label}
                </span>
                {opt.recommended && (
                  <span className="shrink-0 rounded border border-[var(--accent)]/40 bg-[var(--accent)]/10 px-1.5 py-px text-[9px] text-[var(--accent)]">
                    recommended
                  </span>
                )}
              </button>
            </li>
          );
        })}
        {customValue !== null && (
          <li>
            <div
              className="flex items-center gap-2 rounded border border-amber-500/30 bg-amber-500/5 px-2 py-2"
              title="A non-standard advisor model is persisted in settings.json. Pick one of the three options above to overwrite it, or edit settings.json directly to keep it."
            >
              <span className="h-3 w-3 shrink-0 rounded-full border border-amber-500/40 bg-amber-500/20" />
              <span className="flex-1 truncate font-mono text-[11px] text-amber-200">
                {customValue}
              </span>
              <span className="shrink-0 rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-px text-[9px] text-amber-200">
                custom
              </span>
            </div>
          </li>
        )}
      </ul>
      <p className="mt-3 text-[11px] leading-snug text-[var(--muted)]">
        {ADVISOR_COPY.recommended}
      </p>
      <a
        href={ADVISOR_COPY.learnMoreUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-[var(--accent)] hover:underline"
      >
        {ADVISOR_COPY.learnMoreLabel} →
      </a>
    </div>
  );
}
