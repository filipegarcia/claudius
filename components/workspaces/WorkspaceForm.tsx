"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, CircuitBoard, FolderOpen, Image as ImageIcon, Type, X } from "lucide-react";
import { Overlay } from "@/components/overlays/Overlay";
import { DirectoryPicker } from "./DirectoryPicker";
import { ModelPicker } from "@/components/panels/widgets/ModelPicker";
import type { Icon, Workspace, WorkspaceDefaults } from "@/lib/server/workspaces-store";

const PRESET_COLORS = [
  "#d97757",
  "#5588dd",
  "#9d6cdd",
  "#2e9d8f",
  "#dd8e44",
  "#cc5577",
  "#33aabb",
  "#7d8a4c",
];

type Props = {
  initial?: Workspace;
  onCancel: () => void;
  onSubmit: (input: {
    name: string;
    rootPath: string;
    icon?: Icon;
    defaults?: WorkspaceDefaults;
  }) => Promise<{ ok: true; workspace: Workspace } | { ok: false; error: string }>;
  onIconUpload?: (id: string, file: File) => Promise<boolean>;
  onDelete?: () => Promise<void>;
};

type PendingImage = { file: File; previewUrl: string };

export function WorkspaceForm({ initial, onCancel, onSubmit, onIconUpload, onDelete }: Props) {
  const [name, setName] = useState(initial?.name ?? "");
  const [rootPath, setRootPath] = useState(initial?.rootPath ?? "");
  const [iconKind, setIconKind] = useState<"letter" | "image">(initial?.icon.kind ?? "letter");
  const [letter, setLetter] = useState(
    initial?.icon.kind === "letter" ? initial.icon.letter : (initial?.name ?? "C").charAt(0).toUpperCase(),
  );
  const [color, setColor] = useState(
    initial?.icon.kind === "letter" ? initial.icon.color : PRESET_COLORS[0],
  );
  const [pendingImage, setPendingImage] = useState<PendingImage | null>(null);
  const [defaultModel, setDefaultModel] = useState(initial?.defaults?.model ?? "");
  const [defaultMode, setDefaultMode] = useState<"" | NonNullable<WorkspaceDefaults["permissionMode"]>>(
    // For new workspaces, prefill `bypassPermissions` so agents can run
    // unattended out of the box (matches how most users actually use this).
    // When editing, respect whatever was previously saved — including "".
    initial ? (initial.defaults?.permissionMode ?? "") : "bypassPermissions",
  );
  // Default main-thread agent (SDK Options.agent). Sourced from the file-based
  // agents in this workspace's .claude/agents (+ ~/.claude/agents); "" = the
  // default agent. Built-in agents (general-purpose, Explore) aren't listed
  // here because they're plugin-provided, not on disk pre-session.
  const [defaultAgent, setDefaultAgent] = useState(initial?.defaults?.agent ?? "");
  // Spend cap (USD) for new sessions — empty string = no cap. Stored as text so
  // the input can be cleared; coerced to a positive number on submit.
  const [defaultBudget, setDefaultBudget] = useState(
    initial?.defaults?.maxBudgetUsd != null ? String(initial.defaults.maxBudgetUsd) : "",
  );
  // Fallback model id — empty = no fallback. Plain text (not the model picker)
  // since it's an advanced field and accepts any model id alias.
  const [defaultFallback, setDefaultFallback] = useState(initial?.defaults?.fallbackModel ?? "");
  // Sandbox toggle — runs shell commands under bubblewrap (Linux). The Session
  // forwards `failIfUnavailable: false` so this is a no-op on macOS rather
  // than a fatal config error.
  const [defaultSandbox, setDefaultSandbox] = useState<boolean>(
    initial?.defaults?.sandboxEnabled === true,
  );
  // 1M-token context beta — off by default; raises cost a lot and is Sonnet-only.
  const [default1m, setDefault1m] = useState<boolean>(
    initial?.defaults?.enable1mContext === true,
  );
  // Extra system-prompt steering appended to the Claude Code preset.
  const [defaultSysAppend, setDefaultSysAppend] = useState(
    initial?.defaults?.systemPromptAppend ?? "",
  );
  // Custom plan-mode workflow body (applies in plan permission mode).
  const [defaultPlanInstr, setDefaultPlanInstr] = useState(
    initial?.defaults?.planModeInstructions ?? "",
  );
  // Additional directories the agent may access (one absolute path per line).
  const [defaultAddlDirs, setDefaultAddlDirs] = useState(
    (initial?.defaults?.additionalDirectories ?? []).join("\n"),
  );
  const [agentNames, setAgentNames] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const modelTriggerRef = useRef<HTMLButtonElement>(null);

  // When creating a new workspace, the auto-derived letter follows the
  // first non-whitespace character of `name`. The user is also free to
  // override `letter` directly (color/letter swatch picker), so we don't
  // overwrite an explicit choice — only re-derive when `name` changes.
  // Done via the "store previous props" pattern so the setState isn't
  // inside an effect body.
  // https://react.dev/reference/react/useState#storing-information-from-previous-renders
  const [lastName, setLastName] = useState(name);
  if (lastName !== name) {
    setLastName(name);
    if (!initial) setLetter((name.match(/\S/)?.[0] ?? "C").toUpperCase());
  }

  // Revoke object URLs on change/unmount.
  useEffect(() => {
    return () => {
      if (pendingImage) URL.revokeObjectURL(pendingImage.previewUrl);
    };
  }, [pendingImage]);

  // Load the file-based agents available in this workspace so the default-agent
  // dropdown can list them. Best-effort; the fetch only sets state in its async
  // callback (no synchronous setState in the effect body).
  useEffect(() => {
    const cwd = rootPath.trim();
    if (!cwd) return;
    let cancelled = false;
    fetch(`/api/agents?cwd=${encodeURIComponent(cwd)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { scopes?: Array<{ files?: Array<{ name?: string }> }> } | null) => {
        if (cancelled || !d) return;
        const names = new Set<string>();
        for (const s of d.scopes ?? []) {
          for (const f of s.files ?? []) {
            if (typeof f.name === "string") names.add(f.name);
          }
        }
        setAgentNames([...names].sort((a, b) => a.localeCompare(b)));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [rootPath]);

  function pickImageFile(file: File) {
    if (pendingImage) URL.revokeObjectURL(pendingImage.previewUrl);
    setPendingImage({ file, previewUrl: URL.createObjectURL(file) });
    setIconKind("image");
  }

  async function submit() {
    setError(null);
    if (!name.trim()) return setError("name required");
    if (!rootPath.trim()) return setError("rootPath required");
    setSubmitting(true);
    try {
      // Letter icon: just submit. Image icon: submit (saves with letter as
      // placeholder), then upload the file — the upload helper PATCHes the
      // icon field to {kind:"image", ext} once it lands.
      const icon: Icon | undefined = iconKind === "letter" ? { kind: "letter", letter, color } : undefined;
      const defaults: WorkspaceDefaults = {
        // Carry forward any defaults the user didn't surface in this v1 form
        // (mcpServerIds, autoMemoryEnabled, claudeMdExcludes, additionalDirectories).
        ...(initial?.defaults ?? {}),
      };
      if (defaultModel.trim()) defaults.model = defaultModel.trim();
      else delete defaults.model;
      if (defaultMode) defaults.permissionMode = defaultMode;
      else delete defaults.permissionMode;
      if (defaultAgent.trim()) defaults.agent = defaultAgent.trim();
      else delete defaults.agent;
      const budget = Number(defaultBudget);
      if (defaultBudget.trim() && Number.isFinite(budget) && budget > 0) defaults.maxBudgetUsd = budget;
      else delete defaults.maxBudgetUsd;
      if (defaultFallback.trim()) defaults.fallbackModel = defaultFallback.trim();
      else delete defaults.fallbackModel;
      if (defaultSandbox) defaults.sandboxEnabled = true;
      else delete defaults.sandboxEnabled;
      if (default1m) defaults.enable1mContext = true;
      else delete defaults.enable1mContext;
      if (defaultSysAppend.trim()) defaults.systemPromptAppend = defaultSysAppend.trim();
      else delete defaults.systemPromptAppend;
      if (defaultPlanInstr.trim()) defaults.planModeInstructions = defaultPlanInstr.trim();
      else delete defaults.planModeInstructions;
      const dirs = defaultAddlDirs
        .split("\n")
        .map((d) => d.trim())
        .filter(Boolean);
      if (dirs.length > 0) defaults.additionalDirectories = dirs;
      else delete defaults.additionalDirectories;
      const r = await onSubmit({
        name: name.trim(),
        rootPath: rootPath.trim(),
        icon,
        defaults,
      });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      if (pendingImage && onIconUpload) {
        const ok = await onIconUpload(r.workspace.id, pendingImage.file);
        if (!ok) {
          setError("workspace saved, but icon upload failed");
          return;
        }
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <Overlay
        title={initial ? `Edit ${initial.name}` : "New workspace"}
        subtitle="Workspace"
        onClose={onCancel}
        width={520}
      >
        <div className="space-y-3 px-4 py-4">
          <Field label="Name">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Claudius"
              className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 text-sm focus:outline-none"
            />
          </Field>
          <Field label="Root folder (absolute path)">
            <div className="flex gap-2">
              <input
                value={rootPath}
                onChange={(e) => setRootPath(e.target.value)}
                placeholder="/Users/you/projects/claudius"
                className="flex-1 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 font-mono text-xs focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setShowPicker(true)}
                title="Browse for folder"
                className="flex shrink-0 items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--panel)] px-2 py-1.5 text-xs hover:bg-[var(--panel-2)]"
              >
                <FolderOpen className="h-3 w-3" /> Browse…
              </button>
            </div>
          </Field>
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--muted)]">Icon</div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setIconKind("letter")}
                className={`flex items-center gap-1 rounded-md border px-2 py-1 text-xs ${
                  iconKind === "letter"
                    ? "border-[var(--accent)] bg-[var(--panel-2)]"
                    : "border-[var(--border)] bg-[var(--panel)]"
                }`}
              >
                <Type className="h-3 w-3" /> Letter
              </button>
              <button
                type="button"
                onClick={() => setIconKind("image")}
                className={`flex items-center gap-1 rounded-md border px-2 py-1 text-xs ${
                  iconKind === "image"
                    ? "border-[var(--accent)] bg-[var(--panel-2)]"
                    : "border-[var(--border)] bg-[var(--panel)]"
                }`}
              >
                <ImageIcon className="h-3 w-3" /> Image
              </button>
            </div>
            {iconKind === "letter" ? (
              <div className="mt-2 flex items-center gap-3">
                <div
                  className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg font-semibold text-white"
                  style={{ background: color, fontSize: 24 }}
                >
                  {letter || "?"}
                </div>
                <div className="flex flex-col gap-1">
                  <input
                    value={letter}
                    onChange={(e) => setLetter(e.target.value.slice(0, 2))}
                    className="w-16 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1 font-mono text-xs focus:outline-none"
                  />
                  <div className="flex gap-1">
                    {PRESET_COLORS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => setColor(c)}
                        className={`h-4 w-4 rounded border ${
                          c === color ? "ring-2 ring-[var(--foreground)] ring-offset-2 ring-offset-[var(--panel)]" : ""
                        }`}
                        style={{ background: c, borderColor: c }}
                      />
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <div className="mt-2 flex items-start gap-3">
                {pendingImage ? (
                  <div className="relative">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      // `startsWith("blob:")` is the runtime allowlist;
                      // `encodeURI` is the CodeQL sanitizer barrier.
                      // CodeQL's js/xss-through-dom propagates taint
                      // through `URL.createObjectURL` (modeled as a flow
                      // step, not a sanitizer) so the resulting blob URL
                      // is still considered tainted at the JSX sink.
                      // CodeQL recognizes `encodeURI` (along with
                      // encodeURIComponent and escape) as a sanitizer for
                      // this query; `encodeURI` is a no-op on a valid
                      // `blob:` URL since it doesn't encode `:`, `/`, or
                      // hex chars, so the rendered preview still works.
                      // Earlier attempts (a15877f, 044258f, and the
                      // inline `new URL().protocol === "blob:"` that
                      // briefly replaced this) didn't satisfy CodeQL —
                      // see those commits for context.
                      src={pendingImage.previewUrl.startsWith("blob:") ? encodeURI(pendingImage.previewUrl) : ""}
                      alt="preview"
                      className="h-12 w-12 rounded-lg border border-[var(--border)] object-cover"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        URL.revokeObjectURL(pendingImage.previewUrl);
                        setPendingImage(null);
                      }}
                      title="Remove"
                      className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--panel)] text-[var(--muted)] hover:text-red-400"
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </div>
                ) : initial?.icon.kind === "image" ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`/api/workspaces/${initial.id}/icon`}
                    alt="current"
                    className="h-12 w-12 rounded-lg border border-[var(--border)] object-cover"
                  />
                ) : (
                  <div className="flex h-12 w-12 items-center justify-center rounded-lg border border-dashed border-[var(--border)] text-[var(--muted)]">
                    <ImageIcon className="h-5 w-5" />
                  </div>
                )}
                <div className="flex flex-col gap-1">
                  <button
                    type="button"
                    onClick={() => fileRef.current?.click()}
                    className="rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-3 py-1.5 text-xs hover:bg-[var(--panel)]"
                  >
                    Choose image…
                  </button>
                  <span className="text-[11px] text-[var(--muted)]">PNG / JPEG / WebP, ≤2 MB</span>
                </div>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  hidden
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) pickImageFile(f);
                    e.target.value = "";
                  }}
                />
              </div>
            )}
          </div>
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--muted)]">
              Defaults for new sessions
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Field label="Model">
                {/* Same picker used in the right-rail SessionCard — fed
                    by the sessionless `/api/models` endpoint. Empty value
                    is treated as "(Inherit machine default)" via the
                    picker's `showInherit` option. */}
                <button
                  ref={modelTriggerRef}
                  type="button"
                  onClick={() => setShowModelPicker((o) => !o)}
                  aria-haspopup="dialog"
                  aria-expanded={showModelPicker}
                  className="flex w-full items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 text-left font-mono text-xs hover:bg-[var(--panel)] focus:outline-none"
                >
                  <CircuitBoard className="h-3 w-3 shrink-0 text-[var(--accent)]" />
                  <span
                    className={
                      defaultModel
                        ? "truncate"
                        : "truncate text-[var(--muted)]"
                    }
                  >
                    {defaultModel || "(inherit machine default)"}
                  </span>
                  <ChevronDown
                    className={`ml-auto h-3 w-3 shrink-0 text-[var(--muted)] transition-transform ${
                      showModelPicker ? "rotate-180" : ""
                    }`}
                  />
                </button>
              </Field>
              <Field label="Permission mode">
                <select
                  value={defaultMode}
                  onChange={(e) => setDefaultMode(e.target.value as typeof defaultMode)}
                  className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 text-xs focus:outline-none"
                >
                  <option value="">(inherit)</option>
                  <option value="default">default</option>
                  <option value="acceptEdits">acceptEdits</option>
                  <option value="plan">plan</option>
                  <option value="bypassPermissions">bypassPermissions</option>
                </select>
              </Field>
            </div>
            <Field label="Agent">
              <select
                value={defaultAgent}
                onChange={(e) => setDefaultAgent(e.target.value)}
                className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 text-xs focus:outline-none"
              >
                <option value="">(default agent)</option>
                {/* Keep a saved value selectable even if its file is gone or
                    it's a non-file agent we didn't enumerate. */}
                {defaultAgent && !agentNames.includes(defaultAgent) && (
                  <option value={defaultAgent}>{defaultAgent}</option>
                )}
                {agentNames.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </Field>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Field label="Spend cap (USD)">
                <input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.5"
                  value={defaultBudget}
                  onChange={(e) => setDefaultBudget(e.target.value)}
                  placeholder="no cap"
                  className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 text-xs focus:outline-none"
                />
              </Field>
              <Field label="Fallback model">
                <input
                  type="text"
                  value={defaultFallback}
                  onChange={(e) => setDefaultFallback(e.target.value)}
                  placeholder="none (e.g. claude-haiku-4-5)"
                  spellCheck={false}
                  className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 font-mono text-xs focus:outline-none"
                />
              </Field>
            </div>
            <label className="mt-2 flex cursor-pointer items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={defaultSandbox}
                onChange={(e) => setDefaultSandbox(e.target.checked)}
                className="h-3 w-3 rounded border-[var(--border)] bg-[var(--panel-2)]"
              />
              <span>Sandbox shell commands</span>
              <span className="text-[10px] text-[var(--muted)]">
                Linux only (bubblewrap); no-op on macOS.
              </span>
            </label>
            <label className="mt-2 flex cursor-pointer items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={default1m}
                onChange={(e) => setDefault1m(e.target.checked)}
                className="h-3 w-3 rounded border-[var(--border)] bg-[var(--panel-2)]"
              />
              <span>1M context window</span>
              <span className="text-[10px] text-[var(--muted)]">
                Sonnet 4/4.5 only; significantly higher cost.
              </span>
            </label>
            <Field label="System prompt append">
              <textarea
                value={defaultSysAppend}
                onChange={(e) => setDefaultSysAppend(e.target.value)}
                placeholder="Extra steering added to every session (e.g. &quot;Always use TypeScript&quot;). Distinct from CLAUDE.md."
                rows={3}
                className="w-full resize-y rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 text-xs focus:outline-none"
              />
            </Field>
            <Field label="Plan-mode instructions">
              <textarea
                value={defaultPlanInstr}
                onChange={(e) => setDefaultPlanInstr(e.target.value)}
                placeholder="Custom plan-mode workflow steps (used only in plan mode). Empty = default workflow."
                rows={3}
                className="w-full resize-y rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 text-xs focus:outline-none"
              />
            </Field>
            <Field label="Additional directories">
              <textarea
                value={defaultAddlDirs}
                onChange={(e) => setDefaultAddlDirs(e.target.value)}
                placeholder={"One absolute path per line — extra dirs the agent may access beyond the workspace root."}
                rows={2}
                spellCheck={false}
                className="w-full resize-y rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 font-mono text-xs focus:outline-none"
              />
            </Field>
            <p className="mt-1 text-[10px] text-[var(--muted)]">
              Apply only to new sessions. An explicit per-session override still wins.
              Setting an agent also applies its own model.
            </p>
          </div>
          {error && (
            <div className="rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1 text-[11px] text-red-300">
              {error}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 border-t border-[var(--border)] bg-[var(--panel-2)]/50 px-4 py-3">
          {onDelete && initial && (
            <button
              onClick={async () => {
                if (
                  confirm(`Delete workspace "${initial.name}"? Sessions and files on disk are unaffected.`)
                ) {
                  await onDelete();
                }
              }}
              className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs text-red-300 hover:bg-red-500/20"
            >
              Delete
            </button>
          )}
          <button
            onClick={onCancel}
            className="ml-auto rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-3 py-1.5 text-xs hover:bg-[var(--panel)]"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={submitting || !name.trim() || !rootPath.trim()}
            className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs text-white hover:opacity-90 disabled:opacity-40"
          >
            {submitting ? "Saving…" : "Save"}
          </button>
        </div>
      </Overlay>
      {showPicker && (
        <DirectoryPicker
          initialPath={rootPath || undefined}
          onCancel={() => setShowPicker(false)}
          onPick={(p) => {
            setRootPath(p);
            setShowPicker(false);
          }}
        />
      )}
      {showModelPicker && (
        <ModelPicker
          sessionId={null}
          source="global"
          currentModel={defaultModel || null}
          anchorRef={modelTriggerRef}
          onClose={() => setShowModelPicker(false)}
          onPickModel={(value) => {
            // Empty string from the picker means "Inherit" — that's
            // what we store as `defaultModel === ""`, which the submit
            // path translates to "no `defaults.model`".
            setDefaultModel(value);
            setShowModelPicker(false);
          }}
          showInherit
        />
      )}
    </>
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
