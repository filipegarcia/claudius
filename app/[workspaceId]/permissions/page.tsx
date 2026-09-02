"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { ArrowLeft, Plus, X, Info, Clock, AlertTriangle } from "lucide-react";
import { SideNav } from "@/components/nav/SideNav";
import { ScopeToggle, type Scope as IaScope } from "@/components/nav/ScopeToggle";
import { usePermissions, type RuleKind, type Scope } from "@/lib/client/usePermissions";
import { useAutoMode } from "@/lib/client/useAutoMode";
import { useActiveCwd } from "@/lib/client/useActiveCwd";
import { useRecentDenials } from "@/lib/client/useRecentDenials";
import { lintBashWildcardRule, lintPermissionRule } from "@/lib/shared/permission-rule-lint";
import { cn } from "@/lib/utils/cn";

const SCOPES: { id: Scope; label: string; path: string }[] = [
  { id: "user", label: "User", path: "~/.claude/settings.json" },
  { id: "project", label: "Project", path: ".claude/settings.json" },
  { id: "local", label: "Local", path: ".claude/settings.local.json" },
];

const KINDS: { id: RuleKind; label: string; tone: string }[] = [
  { id: "allow", label: "Allow", tone: "border-emerald-500/30 bg-emerald-500/5 text-emerald-200" },
  { id: "ask", label: "Ask", tone: "border-amber-500/30 bg-amber-500/5 text-amber-200" },
  { id: "deny", label: "Deny", tone: "border-red-500/30 bg-red-500/5 text-red-200" },
];

const SYNTAX_HINTS = [
  { example: "Bash", note: "all Bash commands" },
  { example: "Bash(npm run *)", note: "wildcard match" },
  { example: "Read", note: "all reads" },
  { example: "Read(./src/**)", note: "path-scoped (gitignore syntax)" },
  { example: "Edit(./src/**/*.ts)", note: "edits to TS files" },
  { example: "WebFetch(domain:example.com)", note: "domain whitelist" },
  { example: "mcp__server__tool", note: "specific MCP tool" },
];

export default function PermissionsPage() {
  const { rules, loading, error, updateRules, updateBlockReadsOutsideWorkingDirectories } = usePermissions();
  const [scope, setScope] = useState<Scope>("project");
  const [iaScope, setIaScope] = useState<IaScope>("workspace");
  // CC 2.1.246 parity — the "Auto mode" tab only exists in account ("user")
  // scope, matching upstream (`autoMode` is read from `~/.claude/settings.json`
  // only). Forced back to "rules" whenever the user leaves account scope so
  // switching to Project/Local never leaves an unreachable tab selected.
  const [tab, setTab] = useState<"rules" | "auto-mode">("rules");

  // Find the live session matching the active workspace CWD so we can surface
  // its recent-denial ring buffer (CC 2.1.193 parity). Same pattern as McpPage.
  const cwd = useActiveCwd();
  const [sessionId, setSessionId] = useState<string | null>(null);
  useEffect(() => {
    if (cwd == null) return;
    let cancelled = false;
    fetch("/api/sessions")
      .then((r) => r.json())
      .then((arr: Array<{ id?: string; cwd?: string }>) => {
        if (cancelled) return;
        if (!Array.isArray(arr)) { setSessionId(null); return; }
        const match = cwd ? arr.find((s) => s.cwd === cwd) : arr[0];
        setSessionId(match?.id ?? null);
      })
      .catch(() => { if (!cancelled) setSessionId(null); });
    return () => { cancelled = true; };
  }, [cwd]);

  const { denials } = useRecentDenials(sessionId);

  function setIaScopeWithSnap(next: IaScope) {
    setIaScope(next);
    if (next === "account") setScope("user");
    else {
      if (scope === "user") setScope("project");
      setTab("rules");
    }
  }

  const visibleScopes = iaScope === "account"
    ? SCOPES.filter((s) => s.id === "user")
    : SCOPES.filter((s) => s.id !== "user");

  function add(kind: RuleKind, value: string) {
    const v = value.trim();
    if (!v) return;
    const cur = rules[scope][kind];
    if (cur.includes(v)) return;
    void updateRules(scope, kind, [...cur, v]);
  }

  function remove(kind: RuleKind, value: string) {
    const cur = rules[scope][kind];
    void updateRules(
      scope,
      kind,
      cur.filter((r) => r !== value),
    );
  }

  return (
    <div className="flex h-full">
      <SideNav running={false} />
      <main data-pane-name="permissions-main" className="flex h-full flex-1 flex-col overflow-hidden">
        <header className="flex h-9 shrink-0 items-center gap-3 border-b border-[var(--border)] bg-[var(--panel)] px-4 text-xs">
          <Link href="/" className="flex items-center gap-1 text-[var(--muted)] hover:text-[var(--foreground)]">
            <ArrowLeft className="h-3.5 w-3.5" /> Chat
          </Link>
          <span className="opacity-50">·</span>
          <span className="font-medium">Permissions</span>
          <ScopeToggle value={iaScope} onChange={setIaScopeWithSnap} />
          {error && <span className="ml-3 text-red-400">{error}</span>}
          {loading && <span className="ml-3 text-[var(--muted)]">loading…</span>}
        </header>

        <div className="flex-1 overflow-y-auto scroll-thin">
          <div className="mx-auto max-w-4xl px-6 py-6">
            <div className="mb-4 flex items-center gap-2">
              {visibleScopes.map((s) => (
                <button
                  key={s.id}
                  onClick={() => setScope(s.id)}
                  className={cn(
                    "rounded-md border border-[var(--border)] px-3 py-1.5 text-sm",
                    scope === s.id
                      ? "bg-[var(--panel-2)] text-[var(--foreground)]"
                      : "bg-[var(--panel)] text-[var(--muted)] hover:text-[var(--foreground)]",
                  )}
                  title={s.path}
                >
                  {s.label}
                </button>
              ))}
              <span className="ml-2 font-mono text-[10px] text-[var(--muted)]">
                {SCOPES.find((s) => s.id === scope)?.path}
              </span>
            </div>

            {/* CC 2.1.246 parity — "Auto mode" tab, account (user) scope
                only: upstream reads `autoMode` from `~/.claude/settings.json`
                exclusively, so this has no Project/Local equivalent. */}
            {iaScope === "account" && (
              <div className="mb-4 flex items-center gap-2">
                {(
                  [
                    { id: "rules", label: "Rules" },
                    { id: "auto-mode", label: "Auto mode" },
                  ] as const
                ).map((t) => (
                  <button
                    key={t.id}
                    data-testid={`permissions-tab-${t.id}`}
                    onClick={() => setTab(t.id)}
                    className={cn(
                      "rounded-md border border-[var(--border)] px-3 py-1.5 text-sm",
                      tab === t.id
                        ? "bg-[var(--panel-2)] text-[var(--foreground)]"
                        : "bg-[var(--panel)] text-[var(--muted)] hover:text-[var(--foreground)]",
                    )}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            )}

            {tab === "auto-mode" && iaScope === "account" ? (
              <AutoModeTab />
            ) : (
              <>
                {/* CC 2.1.257 parity — "Added a one-time prompt in auto mode
                    before the first file read outside the working
                    directories, with the option to block such reads
                    (permissions.blockReadsOutsideWorkingDirectories)".
                    Claudius has no one-time-prompt equivalent (auto mode's
                    classifier is server-side, inside the SDK), so the
                    setting itself is exposed as a plain per-scope toggle —
                    "true in any settings source wins", same as upstream. */}
                <div className="mb-4 rounded-lg border border-[var(--border)] bg-[var(--panel)]/40 p-3 text-xs">
                  <label className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      data-testid="block-reads-outside-working-dirs"
                      checked={rules[scope].blockReadsOutsideWorkingDirectories}
                      onChange={(e) =>
                        void updateBlockReadsOutsideWorkingDirectories(scope, e.target.checked)
                      }
                      className="mt-0.5"
                    />
                    <span>
                      <span className="font-medium text-[var(--foreground)]">
                        Block reads outside working directories
                      </span>
                      <p className="mt-0.5 text-[10px] text-[var(--muted)]">
                        Refuse Read/Grep/Glob/LSP file access outside this session&apos;s working
                        directories, in every permission mode. Enabled in any scope applies
                        everywhere.
                      </p>
                    </span>
                  </label>
                </div>

                <div className="mb-6 rounded-lg border border-[var(--border)] bg-[var(--panel)]/40 p-3 text-xs">
                  <div className="mb-2 flex items-center gap-1.5 text-[var(--muted)]">
                    <Info className="h-3.5 w-3.5" />
                    Rule syntax
                  </div>
                  <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                    {SYNTAX_HINTS.map((h) => (
                      <div key={h.example} className="flex items-baseline gap-2">
                        <code className="font-mono text-[var(--foreground)]">{h.example}</code>
                        <span className="text-[var(--muted)]">{h.note}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                  {KINDS.map((k) => (
                    <RuleColumn
                      key={k.id}
                      kind={k.id}
                      label={k.label}
                      tone={k.tone}
                      rules={rules[scope][k.id]}
                      onAdd={(v) => add(k.id, v)}
                      onRemove={(v) => remove(k.id, v)}
                    />
                  ))}
                </div>

                {/* Recent Denials — CC 2.1.193 parity */}
                <div
                  data-testid="recent-denials-section"
                  className="mt-6 rounded-lg border border-[var(--border)] bg-[var(--panel)]/40 p-4"
                >
                  <div className="mb-3 flex items-center gap-1.5 text-xs font-medium text-[var(--muted)]">
                    <Clock className="h-3.5 w-3.5" />
                    Recent Denials
                    {denials.length > 0 && (
                      <span className="ml-1 opacity-70">({denials.length})</span>
                    )}
                  </div>
                  {denials.length === 0 ? (
                    <p className="text-[11px] text-[var(--muted)]">
                      No permission denials recorded for this session.
                    </p>
                  ) : (
                    <div className="space-y-1.5">
                      {[...denials].reverse().map((d, i) => (
                        <div
                          key={i}
                          data-testid="recent-denial-entry"
                          className="flex items-center gap-2 rounded-md border border-red-500/20 bg-red-500/5 px-2.5 py-1.5 text-xs"
                        >
                          <code className="font-mono text-red-200">{d.toolName}</code>
                          <span className="text-[var(--muted)]">·</span>
                          <span className="text-[var(--muted)]">{d.reasonType}</span>
                          <span className="ml-auto font-mono text-[10px] text-[var(--muted)]">
                            {new Date(d.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

/**
 * CC 2.1.246 parity — "Added an Auto mode tab to /permissions for viewing
 * and editing auto mode classifier rules". The classifier itself runs
 * server-side (engine feature, arrives via the SDK); this tab only exposes
 * its configuration (`autoMode.{environment,allow,soft_deny,hard_deny}` in
 * `~/.claude/settings.json`) — four freeform prose-string lists, each with a
 * `$defaults` toggle for whether Anthropic's built-in rules stay in effect
 * alongside the user's own.
 */
function AutoModeTab() {
  const { config, loading, error, updateConfig } = useAutoMode();
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)]/40 p-3 text-xs text-[var(--muted)]">
        <div className="mb-1 flex items-center gap-1.5 font-medium text-[var(--foreground)]">
          <Info className="h-3.5 w-3.5" />
          Auto mode classifier configuration
        </div>
        Auto mode routes tool calls through a server-side classifier instead of asking you. These
        sections tell it what to trust — the classifier&apos;s own judgment isn&apos;t something
        Claudius can override, only inform. Saved to{" "}
        <code className="font-mono text-[var(--foreground)]">~/.claude/settings.json</code>.
        {loading && <span className="ml-2">loading…</span>}
        {error && <span className="ml-2 text-red-400">{error}</span>}
      </div>
      <AutoModeSection
        id="environment"
        title="Environment"
        description="What the classifier treats as inside your trust boundary — repos, buckets, domains, services. One entry per line, in plain prose."
        value={config.environment}
        onSave={(next) => void updateConfig({ environment: next })}
      />
      <AutoModeSection
        id="allow"
        title="Allow"
        description="Exceptions to the soft-deny rules below — routine actions the classifier should stop flagging."
        value={config.allow}
        onSave={(next) => void updateConfig({ allow: next })}
      />
      <AutoModeSection
        id="soft-deny"
        title="Soft deny"
        description="Destructive actions the classifier blocks unless your message states the exact intent."
        value={config.soft_deny}
        onSave={(next) => void updateConfig({ soft_deny: next })}
      />
      <AutoModeSection
        id="hard-deny"
        title="Hard deny"
        description="Unconditional boundaries — never overridden by allow rules or stated intent."
        value={config.hard_deny}
        onSave={(next) => void updateConfig({ hard_deny: next })}
      />
    </div>
  );
}

type AutoModeSectionProps = {
  /** Used only to derive this section's `data-testid`s — not an `AutoModeConfig` key (avoids the "soft_deny" vs "soft-deny" testid-casing mismatch). */
  id: string;
  title: string;
  description: string;
  value: string[] | undefined;
  onSave: (next: string[]) => void;
};

/**
 * One `autoMode.*` list as a document editor: a multi-line textarea (one
 * rule per line) plus a "Keep built-in rules" checkbox that adds/removes the
 * literal `"$defaults"` sentinel from the saved array. Commits on blur or on
 * toggling the checkbox — not per keystroke — so typing a multi-line prose
 * rule doesn't fire a save per character.
 */
function AutoModeSection({ id, title, description, value, onSave }: AutoModeSectionProps) {
  const keepDefaults = !!value?.includes("$defaults");
  const customLines = (value ?? []).filter((v) => v !== "$defaults");
  const [draft, setDraft] = useState(customLines.join("\n"));
  // Tracks the last value we either loaded or committed, so an upstream
  // refresh (e.g. after a failed save triggers `refresh()`) can resync the
  // textarea without clobbering in-progress typing on every parent re-render.
  const lastSyncedRef = useRef(customLines.join("\n"));

  useEffect(() => {
    const joined = (value ?? []).filter((v) => v !== "$defaults").join("\n");
    if (joined !== lastSyncedRef.current) {
      lastSyncedRef.current = joined;
      setDraft(joined);
    }
  }, [value]);

  function commit(nextDraft: string, nextKeepDefaults: boolean) {
    const lines = nextDraft
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    lastSyncedRef.current = lines.join("\n");
    onSave(nextKeepDefaults ? ["$defaults", ...lines] : lines);
  }

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)]/40 p-3">
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="text-xs font-medium uppercase tracking-wide text-[var(--foreground)]">
          {title}
        </div>
        <label className="flex items-center gap-1.5 text-[10px] text-[var(--muted)]">
          <input
            type="checkbox"
            data-testid={`auto-mode-${id}-keep-defaults`}
            checked={keepDefaults}
            onChange={(e) => commit(draft, e.target.checked)}
          />
          Keep built-in rules
        </label>
      </div>
      <p className="mb-2 text-[10px] text-[var(--muted)]">{description}</p>
      <textarea
        data-testid={`auto-mode-${id}`}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => commit(draft, keepDefaults)}
        placeholder="One rule per line, in plain prose…"
        rows={4}
        className="w-full resize-y rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 font-mono text-[11px] focus:border-[var(--accent)]/60 focus:outline-none"
      />
    </div>
  );
}

type ColumnProps = {
  kind: RuleKind;
  label: string;
  tone: string;
  rules: string[];
  onAdd: (v: string) => void;
  onRemove: (v: string) => void;
};

function RuleColumn({ kind, label, tone, rules, onAdd, onRemove }: ColumnProps) {
  const [draft, setDraft] = useState("");
  // CC 2.1.210 parity: `Write(path)` / `NotebookEdit(path)` / `Glob(path)`
  // don't support path scoping — warn (don't block; the rule still saves,
  // matching upstream's "warn at startup" rather than reject) both as the
  // user types and for rules already saved from before this check existed.
  const draftLint = lintPermissionRule(draft);
  // CC 2.1.246 parity: a Bash *allow* rule with a wildcard before a fixed
  // trailing token (e.g. `Bash(git * main)`) also matches options inserted
  // in between — warn, don't block, same as the check above. Scoped to
  // `allow` because a rule matching more than intended is a safety concern
  // only when it widens what auto-runs; over-matching an `ask`/`deny` rule
  // just asks/denies more, which isn't a risk.
  const draftBashLint = kind === "allow" ? lintBashWildcardRule(draft) : null;
  return (
    <div className={cn("rounded-lg border bg-[var(--panel)]/40", tone)}>
      <div className="border-b border-current/30 px-3 py-2 text-xs font-medium uppercase tracking-wide">
        {label} <span className="ml-1 opacity-70">({rules.length})</span>
      </div>
      <div className="space-y-1.5 p-3">
        {rules.length === 0 && (
          <div className="text-[11px] text-[var(--muted)]">No rules in this scope.</div>
        )}
        {rules.map((r) => {
          const lint = lintPermissionRule(r);
          const bashLint = kind === "allow" ? lintBashWildcardRule(r) : null;
          return (
            <div
              key={r}
              className="group flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--panel-2)]/60 px-2 py-1"
            >
              {lint && (
                <span
                  data-testid="permission-rule-warning-icon"
                  title={`${lint.tool}(path) isn't a supported path-scoped rule — use ${lint.suggestion} instead`}
                >
                  <AlertTriangle className="h-3 w-3 shrink-0 text-amber-400" />
                </span>
              )}
              {bashLint && (
                <span
                  data-testid="permission-rule-bash-wildcard-warning-icon"
                  title={`The wildcard in "${bashLint.command}" sits before a fixed word — it also matches options inserted in between, not just the subcommand you intended`}
                >
                  <AlertTriangle className="h-3 w-3 shrink-0 text-amber-400" />
                </span>
              )}
              <code className="flex-1 truncate font-mono text-xs text-[var(--foreground)]">{r}</code>
              <button
                onClick={() => onRemove(r)}
                className="rounded p-0.5 text-[var(--muted)] opacity-0 group-hover:opacity-100 hover:bg-[var(--panel)] hover:text-[var(--foreground)]"
                title="Remove"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          );
        })}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onAdd(draft);
            setDraft("");
          }}
          className="flex items-center gap-1 pt-1"
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="add rule"
            className="flex-1 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1 font-mono text-xs focus:border-[var(--accent)]/60 focus:outline-none"
          />
          <button
            type="submit"
            disabled={!draft.trim()}
            className="rounded-md bg-[var(--accent)] p-1 text-white hover:opacity-90 disabled:opacity-40"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </form>
        {draftLint && (
          <p
            data-testid="permission-rule-warning"
            className="flex items-start gap-1 text-[10px] text-amber-400"
          >
            <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
            <span>
              <code className="font-mono">{draftLint.tool}(path)</code> isn&apos;t a supported
              path-scoped rule — use <code className="font-mono">{draftLint.suggestion}</code> instead.
              The rule will still save as typed.
            </span>
          </p>
        )}
        {draftBashLint && (
          <p
            data-testid="permission-rule-bash-wildcard-warning"
            className="flex items-start gap-1 text-[10px] text-amber-400"
          >
            <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
            <span>
              The wildcard in <code className="font-mono">{draftBashLint.command}</code> sits before a
              fixed word — it also matches options inserted in between (e.g. a flag), not just the
              subcommand you intended. The rule will still save as typed.
            </span>
          </p>
        )}
      </div>
    </div>
  );
}
