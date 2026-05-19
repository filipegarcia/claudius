"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Briefcase, FolderOpen, Image as ImageIcon, Save, Trash2, Type, X } from "lucide-react";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { SideNav } from "@/components/nav/SideNav";
import {
  PERMISSION_MODE_META,
  PERMISSION_MODE_ORDER,
} from "@/components/chat/ModeSelector";
import { DirectoryPicker } from "@/components/workspaces/DirectoryPicker";
import { useWorkspaces } from "@/lib/client/useWorkspaces";
import { cn } from "@/lib/utils/cn";
import type { Icon } from "@/lib/server/workspaces-store";
import {
  compilePattern,
  renderCommitPrefix,
  type CommitPrefixConfig,
} from "@/lib/shared/commit-prefix";
import {
  ALL_NOTIFICATION_KINDS,
  DEFAULT_ENABLED_KINDS,
  OPT_IN_KINDS,
  type NotificationClickBehavior,
  type NotificationKind,
  type WorkspaceNotificationPrefs,
} from "@/lib/shared/notifications";

const NOTIFICATION_KIND_LABELS: Record<NotificationKind, string> = {
  permission_request: "Permission requested",
  ask_user_question: "Question asked",
  plan_approval_request: "Plan to approve",
  session_error: "Session error",
  session_idle: "Long task finished",
  scheduled_run_finished: "Scheduled job finished",
};

const ICON_PRESET_COLORS = [
  "#d97757",
  "#5588dd",
  "#9d6cdd",
  "#2e9d8f",
  "#dd8e44",
  "#cc5577",
  "#33aabb",
  "#7d8a4c",
];

type ModeChoice = "" | PermissionMode;
type PendingImage = { file: File; previewUrl: string };

export default function WorkspacePage() {
  const { items, activeId, update, uploadIcon, remove } = useWorkspaces();
  const router = useRouter();
  const active = useMemo(() => items.find((w) => w.id === activeId) ?? null, [items, activeId]);

  // Identity (name, root, icon) — these used to live in a modal triggered
  // by clicking the active workspace tile. The tile is now a "home" button
  // (back to chat); identity edits happen inline here.
  const [name, setName] = useState("");
  const [rootPath, setRootPath] = useState("");
  const [showPicker, setShowPicker] = useState(false);
  const [iconKind, setIconKind] = useState<"letter" | "image">("letter");
  const [letter, setLetter] = useState("C");
  const [color, setColor] = useState(ICON_PRESET_COLORS[0]);
  const [pendingImage, setPendingImage] = useState<PendingImage | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const [model, setModel] = useState("");
  const [mode, setMode] = useState<ModeChoice>("");
  const [saving, setSaving] = useState(false);
  const [savedTick, setSavedTick] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Commit prefix config — separate from defaults because it isn't a
  // session-creation default.
  const [prefixEnabled, setPrefixEnabled] = useState(false);
  const [branchPattern, setBranchPattern] = useState("");
  const [template, setTemplate] = useState("");
  const [sampleBranch, setSampleBranch] = useState("");

  // Notifications config — read from `defaults.notifications`.
  const [notifyEnabled, setNotifyEnabled] = useState(false);
  const [notifyOnClick, setNotifyOnClick] = useState<NotificationClickBehavior>("jump");
  const [notifyKinds, setNotifyKinds] = useState<NotificationKind[]>(DEFAULT_ENABLED_KINDS);

  // Hydrate inputs from server state. Uses the React 19 "set state during
  // render" pattern (gated on the active workspace identity) so the lint
  // rule `react-hooks/set-state-in-effect` stays clean.
  const [hydratedFor, setHydratedFor] = useState<string | null>(null);
  if (active && hydratedFor !== active.id) {
    setHydratedFor(active.id);
    setName(active.name);
    setRootPath(active.rootPath);
    setIconKind(active.icon.kind);
    if (active.icon.kind === "letter") {
      setLetter(active.icon.letter);
      setColor(active.icon.color);
    } else {
      // Image workspaces: keep the previous color/letter inputs as defaults
      // so toggling back to "letter" doesn't render an empty preview.
      setLetter((active.name.match(/\S/)?.[0] ?? "C").toUpperCase());
      setColor(ICON_PRESET_COLORS[0]);
    }
    if (pendingImage) {
      URL.revokeObjectURL(pendingImage.previewUrl);
      setPendingImage(null);
    }
    setModel(active.defaults?.model ?? "");
    setMode(active.defaults?.permissionMode ?? "");
    setPrefixEnabled(active.commitPrefix?.enabled ?? false);
    setBranchPattern(active.commitPrefix?.branchPattern ?? "{type}/{id}-{rest}");
    setTemplate(active.commitPrefix?.template ?? "{type} #{id} - ");
    const np = active.defaults?.notifications;
    setNotifyEnabled(np?.enabled ?? false);
    setNotifyOnClick(np?.onClick ?? "jump");
    setNotifyKinds(np?.enabledKinds ?? DEFAULT_ENABLED_KINDS);
  }

  // Revoke object URLs on unmount. The above hydrate path already revokes
  // when switching workspaces; this is the cleanup for component teardown.
  useEffect(() => {
    return () => {
      if (pendingImage) URL.revokeObjectURL(pendingImage.previewUrl);
    };
  }, [pendingImage]);

  function pickImageFile(file: File) {
    if (pendingImage) URL.revokeObjectURL(pendingImage.previewUrl);
    setPendingImage({ file, previewUrl: URL.createObjectURL(file) });
    setIconKind("image");
  }

  const previewConfig: CommitPrefixConfig = useMemo(
    () => ({ enabled: true, branchPattern, template }),
    [branchPattern, template],
  );
  const patternError = useMemo(() => {
    if (!branchPattern.trim()) return null;
    return compilePattern(branchPattern) ? null : "Pattern is empty or has duplicate placeholders.";
  }, [branchPattern]);
  const preview = useMemo(
    () => renderCommitPrefix(sampleBranch || null, previewConfig),
    [sampleBranch, previewConfig],
  );

  async function onSave() {
    if (!active) return;
    if (!name.trim()) {
      setError("Name is required.");
      return;
    }
    if (!rootPath.trim()) {
      setError("Root folder is required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const defaults = { ...(active.defaults ?? {}) };
      if (model.trim()) defaults.model = model.trim();
      else delete defaults.model;
      if (mode) defaults.permissionMode = mode;
      else delete defaults.permissionMode;
      // Notifications: persist only the diff from the implicit defaults so the
      // JSON stays compact for users who haven't customised anything.
      const notifyPrefs: WorkspaceNotificationPrefs = {
        enabled: notifyEnabled,
        onClick: notifyOnClick,
        enabledKinds: notifyKinds,
      };
      defaults.notifications = notifyPrefs;
      const commitPrefix: CommitPrefixConfig = {
        enabled: prefixEnabled,
        branchPattern: branchPattern.trim(),
        template,
      };
      // Identity payload. Image-icon updates land in two phases: the patch
      // below saves with a letter placeholder (or carries the existing icon
      // when none was picked), then the uploadIcon helper re-PATCHes with
      // `{kind: "image", ext}` once the bytes hit disk.
      const iconPatch: Icon | undefined =
        iconKind === "letter"
          ? { kind: "letter", letter, color }
          : pendingImage
            ? undefined // upload helper will set the final shape
            : active.icon.kind === "image"
              ? active.icon
              : undefined;
      const patch: Parameters<typeof update>[1] = {
        name: name.trim(),
        rootPath: rootPath.trim(),
        defaults,
        commitPrefix,
        ...(iconPatch ? { icon: iconPatch } : {}),
      };
      // Capture which kinds we just removed BEFORE the patch lands, so the
      // mark-read fanout below operates on the diff against the prior saved
      // state (not against whatever was staged half a save ago).
      const prevKinds = new Set(
        active.defaults?.notifications?.enabledKinds ?? DEFAULT_ENABLED_KINDS,
      );
      const nextKinds = new Set(notifyKinds);
      const removed: NotificationKind[] = [];
      for (const k of prevKinds) if (!nextKinds.has(k)) removed.push(k);

      const ok = await update(active.id, patch);
      if (!ok) {
        setError("Save failed.");
        return;
      }
      // Once the user has said "stop notifying me about X", clear the
      // backlog of X rows so the badge actually reflects the new policy.
      // Best-effort: a failed mark-read just means the user has stale rows
      // they can dismiss manually, not a corrupted state.
      for (const k of removed) {
        try {
          await fetch("/api/notifications/read-by-kind", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ workspaceId: active.id, kind: k }),
          });
        } catch {
          // ignore — best effort
        }
      }
      if (pendingImage) {
        const uploaded = await uploadIcon(active.id, pendingImage.file);
        if (!uploaded) {
          setError("Saved, but icon upload failed.");
          return;
        }
        URL.revokeObjectURL(pendingImage.previewUrl);
        setPendingImage(null);
      }
      setSavedTick((t) => t + 1);
    } finally {
      setSaving(false);
    }
  }

  async function onDelete() {
    if (!active) return;
    if (
      !confirm(
        `Delete workspace "${active.name}"? Sessions and files on disk are unaffected.`,
      )
    ) {
      return;
    }
    const ok = await remove(active.id);
    if (!ok) {
      setError("Delete failed.");
      return;
    }
    // The list will refresh and a new active workspace will be picked by
    // the cookie/server hint; route back to chat so the user lands on the
    // new active rather than a stale `/workspace` page pointing at a
    // workspace that no longer exists.
    router.push("/");
  }

  const prefixDirty =
    !!active &&
    ((active.commitPrefix?.enabled ?? false) !== prefixEnabled ||
      (active.commitPrefix?.branchPattern ?? "{type}/{id}-{rest}") !== branchPattern ||
      (active.commitPrefix?.template ?? "{type} #{id} - ") !== template);

  const notifyDirty =
    !!active &&
    ((active.defaults?.notifications?.enabled ?? false) !== notifyEnabled ||
      (active.defaults?.notifications?.onClick ?? "jump") !== notifyOnClick ||
      !sameKindSet(active.defaults?.notifications?.enabledKinds, notifyKinds));

  // Identity dirty check: name/root, icon kind, letter+color (when in letter
  // mode), or a pending image upload.
  const identityDirty =
    !!active &&
    (name.trim() !== active.name ||
      rootPath.trim() !== active.rootPath ||
      iconKind !== active.icon.kind ||
      (iconKind === "letter" &&
        active.icon.kind === "letter" &&
        (letter !== active.icon.letter || color !== active.icon.color)) ||
      pendingImage !== null);

  const dirty =
    !!active &&
    (identityDirty ||
      (model.trim() || "") !== (active.defaults?.model ?? "") ||
      (mode || "") !== (active.defaults?.permissionMode ?? "") ||
      prefixDirty ||
      notifyDirty);

  return (
    <div className="flex h-full">
      <SideNav running={false} />
      <main data-pane-name="workspace-main" className="flex h-full flex-1 flex-col overflow-hidden">
        <header className="flex h-9 shrink-0 items-center gap-3 border-b border-[var(--border)] bg-[var(--panel)] px-4 text-xs">
          <Link href="/" className="flex items-center gap-1 text-[var(--muted)] hover:text-[var(--foreground)]">
            <ArrowLeft className="h-3.5 w-3.5" /> Chat
          </Link>
          <span className="opacity-50">·</span>
          <Briefcase className="h-3.5 w-3.5 text-[var(--muted)]" />
          <span className="font-medium">Workspace</span>
          {active && (
            <span className="ml-2 truncate font-mono text-[var(--muted)]">{active.name}</span>
          )}
        </header>

        <div className="flex-1 overflow-y-auto scroll-thin">
          {!active ? (
            <div className="mx-auto max-w-2xl px-6 py-12 text-center text-sm text-[var(--muted)]">
              No active workspace.
            </div>
          ) : (
            <div className="mx-auto max-w-2xl space-y-5 px-6 py-6">
              {/* Identity (editable) — used to live in a modal popped from
                  the workspace tile; moved here so the rail-click can go
                  straight to chat. */}
              <section>
                <header className="mb-3">
                  <h2 className="text-base font-semibold">Identity</h2>
                  <p className="mt-1 text-[11px] text-[var(--muted)]">
                    Name, root folder, and icon. Renaming or moving the root only
                    affects this Claudius workspace — files on disk are untouched.
                  </p>
                </header>
                <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)]/40 p-4">
                  <label className="block">
                    <div className="mb-1 text-[11px] font-medium">Name</div>
                    <input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Claudius"
                      className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 text-sm focus:outline-none"
                    />
                  </label>

                  <label className="mt-3 block">
                    <div className="mb-1 text-[11px] font-medium">Root folder (absolute path)</div>
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
                  </label>

                  <div className="mt-3">
                    <div className="mb-1 text-[11px] font-medium">Icon</div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => setIconKind("letter")}
                        className={cn(
                          "flex items-center gap-1 rounded-md border px-2 py-1 text-xs",
                          iconKind === "letter"
                            ? "border-[var(--accent)] bg-[var(--panel-2)]"
                            : "border-[var(--border)] bg-[var(--panel)]",
                        )}
                      >
                        <Type className="h-3 w-3" /> Letter
                      </button>
                      <button
                        type="button"
                        onClick={() => setIconKind("image")}
                        className={cn(
                          "flex items-center gap-1 rounded-md border px-2 py-1 text-xs",
                          iconKind === "image"
                            ? "border-[var(--accent)] bg-[var(--panel-2)]"
                            : "border-[var(--border)] bg-[var(--panel)]",
                        )}
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
                            {ICON_PRESET_COLORS.map((c) => (
                              <button
                                key={c}
                                type="button"
                                onClick={() => setColor(c)}
                                className={cn(
                                  "h-4 w-4 rounded border",
                                  c === color &&
                                    "ring-2 ring-[var(--foreground)] ring-offset-2 ring-offset-[var(--panel)]",
                                )}
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
                              // Inline `new URL(...).protocol === "blob:"` —
                              // CodeQL's js/xss-through-dom recognizes the
                              // URL constructor + protocol check as a URL
                              // barrier; commits a15877f / 044258f tried
                              // `startsWith("blob:")` (helper and inline)
                              // and CodeQL kept flagging the flow. The
                              // check is provably redundant at runtime —
                              // `URL.createObjectURL` is the only producer
                              // of `previewUrl` and only returns `blob:`
                              // URLs — but the URL-constructor form is the
                              // pattern the query knows.
                              src={(() => {
                                try {
                                  return new URL(pendingImage.previewUrl).protocol === "blob:"
                                    ? pendingImage.previewUrl
                                    : "";
                                } catch {
                                  return "";
                                }
                              })()}
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
                        ) : active.icon.kind === "image" ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={`/api/workspaces/${active.id}/icon`}
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
                          <span className="text-[11px] text-[var(--muted)]">
                            PNG / JPEG / WebP, ≤ 2&nbsp;MB
                          </span>
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

                  <div className="mt-4 flex items-center justify-between border-t border-[var(--border)] pt-3">
                    <span className="text-[10px] text-[var(--muted)]">
                      Deleting only removes the workspace registration. Sessions
                      and files on disk stay put.
                    </span>
                    <button
                      type="button"
                      onClick={onDelete}
                      className="flex items-center gap-1 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs text-red-300 hover:bg-red-500/20"
                    >
                      <Trash2 className="h-3 w-3" /> Delete workspace
                    </button>
                  </div>
                </div>
              </section>

              {/* Defaults */}
              <section>
                <header className="mb-3">
                  <h2 className="text-base font-semibold">Defaults for new chats</h2>
                  <p className="mt-1 text-[11px] text-[var(--muted)]">
                    These apply to new sessions started in this workspace. Existing sessions are
                    unaffected. An explicit per-session override (model switcher, mode dropdown) still wins.
                  </p>
                </header>

                <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)]/40 p-4">
                  <label className="block">
                    <div className="mb-1 text-[11px] font-medium">Model</div>
                    <input
                      value={model}
                      onChange={(e) => setModel(e.target.value)}
                      placeholder="(inherit machine default)"
                      className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 font-mono text-xs focus:outline-none"
                    />
                    <div className="mt-1 text-[10px] text-[var(--muted)]">
                      Examples: <code className="font-mono">claude-opus-4-7</code>,{" "}
                      <code className="font-mono">claude-sonnet-4-6</code>,{" "}
                      <code className="font-mono">claude-haiku-4-5-20251001</code>
                    </div>
                  </label>

                  <div className="mt-4">
                    <div className="mb-2 text-[11px] font-medium">Permission mode</div>
                    <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                      <ModeRadio
                        value=""
                        currentValue={mode}
                        onSelect={() => setMode("")}
                        label="Inherit (default)"
                        description="Use the machine-level setting."
                      />
                      {PERMISSION_MODE_ORDER.map((m) => {
                        const meta = PERMISSION_MODE_META[m];
                        const Icon = meta.icon;
                        return (
                          <ModeRadio
                            key={m}
                            value={m}
                            currentValue={mode}
                            onSelect={() => setMode(m)}
                            label={
                              <span className="flex items-center gap-1.5">
                                <Icon className={cn("h-3.5 w-3.5", meta.tone)} />
                                {meta.label}
                              </span>
                            }
                            description={meta.description}
                          />
                        );
                      })}
                    </div>
                  </div>

                </div>

                <p className="mt-2 text-[10px] text-[var(--muted)]">
                  Other defaults — MCP servers, auto-memory, additional directories — round-trip in
                  the workspace JSON but are not yet applied at session-creation time.
                </p>
              </section>

              {/* Commit prefix */}
              <section>
                <header className="mb-3">
                  <h2 className="text-base font-semibold">Commit message prefix</h2>
                  <p className="mt-1 text-[11px] text-[var(--muted)]">
                    Pre-fill the commit textarea on the Git page with a prefix derived from the
                    current branch name. Use <code className="font-mono">{`{name}`}</code>{" "}
                    placeholders in both the pattern and the template.
                  </p>
                </header>

                <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)]/40 p-4">
                  <label className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      checked={prefixEnabled}
                      onChange={(e) => setPrefixEnabled(e.target.checked)}
                      className="mt-0.5"
                    />
                    <span>
                      <span className="text-xs font-medium">Enable for this workspace</span>
                      <span className="block text-[10px] text-[var(--muted)]">
                        When the current branch matches the pattern, the empty commit textarea
                        starts with the rendered prefix and the cursor is placed at the end.
                      </span>
                    </span>
                  </label>

                  <label className="mt-4 block">
                    <div className="mb-1 text-[11px] font-medium">Branch pattern</div>
                    <input
                      value={branchPattern}
                      onChange={(e) => setBranchPattern(e.target.value)}
                      placeholder="{type}/{id}-{rest}"
                      className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 font-mono text-xs focus:outline-none"
                    />
                    <div className="mt-1 text-[10px] text-[var(--muted)]">
                      Each <code className="font-mono">{`{name}`}</code> matches one segment;
                      everything else (slashes, dashes) is literal. The last placeholder absorbs the
                      rest of the branch and is optional — branches without a trailing description
                      (e.g. <code className="font-mono">feat/4729</code>) still match and render the
                      last placeholder as empty.
                    </div>
                    {patternError && (
                      <div className="mt-1 text-[10px] text-red-300">{patternError}</div>
                    )}
                  </label>

                  <label className="mt-3 block">
                    <div className="mb-1 text-[11px] font-medium">Template</div>
                    <input
                      value={template}
                      onChange={(e) => setTemplate(e.target.value)}
                      placeholder="{type} #{id} - "
                      className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 font-mono text-xs focus:outline-none"
                    />
                    <div className="mt-1 text-[10px] text-[var(--muted)]">
                      Reference the same placeholders. Trailing whitespace is preserved so you can
                      end with <code className="font-mono">&quot; - &quot;</code>.
                    </div>
                  </label>

                  <label className="mt-3 block">
                    <div className="mb-1 text-[11px] font-medium">Test against a branch</div>
                    <input
                      value={sampleBranch}
                      onChange={(e) => setSampleBranch(e.target.value)}
                      placeholder="feat/4715-add-search-filter"
                      className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 font-mono text-xs focus:outline-none"
                    />
                    <div className="mt-2 text-[10px] text-[var(--muted)]">Resulting prefix:</div>
                    <div className="mt-1 rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-1.5 font-mono text-xs">
                      {preview != null ? (
                        <span>{preview}</span>
                      ) : sampleBranch ? (
                        <span className="text-[var(--muted)]">
                          (branch doesn&apos;t match — no prefix)
                        </span>
                      ) : (
                        <span className="text-[var(--muted)]">(enter a branch above)</span>
                      )}
                    </div>
                  </label>
                </div>
              </section>

              {/* Notifications */}
              <section>
                <header className="mb-3">
                  <h2 className="text-base font-semibold">Notifications</h2>
                  <p className="mt-1 text-[11px] text-[var(--muted)]">
                    Browser notifications and the in-app inbox surface attention-worthy
                    events from sessions and scheduled jobs in this workspace. Per-session
                    block / snooze is in the session header.
                  </p>
                </header>

                <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)]/40 p-4">
                  <label className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      checked={notifyEnabled}
                      onChange={(e) => setNotifyEnabled(e.target.checked)}
                      className="mt-0.5"
                    />
                    <span>
                      <span className="text-xs font-medium">
                        Enable notifications for this workspace
                      </span>
                      <span className="block text-[10px] text-[var(--muted)]">
                        Requires browser permission. The inbox writes rows even when this
                        is off — turning it off only suppresses OS notifications.
                      </span>
                    </span>
                  </label>

                  <div className="mt-4">
                    <div className="mb-2 text-[11px] font-medium">When a notification is clicked</div>
                    <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                      <ClickRadio
                        value="jump"
                        current={notifyOnClick}
                        onSelect={() => setNotifyOnClick("jump")}
                        label="Jump to session"
                        description="Focus the tab and navigate to the originating session or run."
                      />
                      <ClickRadio
                        value="dismiss"
                        current={notifyOnClick}
                        onSelect={() => setNotifyOnClick("dismiss")}
                        label="Just notify"
                        description="Click only dismisses; you'll navigate manually from the inbox."
                      />
                    </div>
                  </div>

                  <div className="mt-4">
                    <div className="mb-2 text-[11px] font-medium">Trigger on</div>
                    <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                      {DEFAULT_ENABLED_KINDS.map((k) => (
                        <NotifyKindToggle
                          key={k}
                          kind={k}
                          label={NOTIFICATION_KIND_LABELS[k]}
                          checked={notifyKinds.includes(k)}
                          onChange={(next) => setNotifyKinds(updateKindSet(notifyKinds, k, next))}
                        />
                      ))}
                    </div>

                    {/*
                      Opt-in kinds live in their own section so users know
                      they're outside the "sensible default" set. Currently
                      just `session_error`: it ships off because the SDK
                      throws an error on every user abort / reaper kill /
                      "No conversation found" resume failure, and errors
                      that genuinely need attention already show in the
                      chat transcript. The label intentionally calls out
                      that this is the opt-in tier.
                    */}
                    {OPT_IN_KINDS.length > 0 && (
                      <div className="mt-4 border-t border-[var(--border)] pt-3">
                        <div className="mb-1 text-[11px] font-medium text-[var(--muted)]">
                          Optional — off by default
                        </div>
                        <div className="mb-2 text-[10px] text-[var(--muted)]/80">
                          Most users don&apos;t want these. They&apos;re noisy and the underlying state is already visible in the chat.
                        </div>
                        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                          {OPT_IN_KINDS.map((k) => (
                            <NotifyKindToggle
                              key={k}
                              kind={k}
                              label={NOTIFICATION_KIND_LABELS[k]}
                              checked={notifyKinds.includes(k)}
                              onChange={(next) => setNotifyKinds(updateKindSet(notifyKinds, k, next))}
                            />
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </section>

              <div className="sticky bottom-0 -mx-6 flex items-center justify-end gap-2 border-t border-[var(--border)] bg-[var(--background)]/95 px-6 py-3 backdrop-blur">
                {savedTick > 0 && !dirty && (
                  <span className="text-[11px] text-emerald-400">Saved.</span>
                )}
                {error && (
                  <span className="text-[11px] text-red-300">{error}</span>
                )}
                <button
                  onClick={onSave}
                  disabled={!dirty || saving}
                  className="flex items-center gap-1 rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs text-white hover:opacity-90 disabled:opacity-40"
                >
                  <Save className="h-3 w-3" /> {saving ? "Saving…" : "Save"}
                </button>
              </div>
            </div>
          )}
        </div>
      </main>
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
    </div>
  );
}

function sameKindSet(
  a: NotificationKind[] | undefined,
  b: NotificationKind[],
): boolean {
  const aa = a ?? DEFAULT_ENABLED_KINDS;
  if (aa.length !== b.length) return false;
  const sa = new Set(aa);
  for (const k of b) if (!sa.has(k)) return false;
  return true;
}

/**
 * Toggle one kind on/off in the staged set while preserving the canonical
 * order (defaults first, opt-ins last). The order matters because the
 * dirty-check `sameKindSet` is order-insensitive but the wire payload sent
 * by Save is ordered — keeping a stable order avoids spurious dirty flags
 * from re-arranging without actually changing.
 */
function updateKindSet(
  current: NotificationKind[],
  kind: NotificationKind,
  next: boolean,
): NotificationKind[] {
  const set = new Set(current);
  if (next) set.add(kind);
  else set.delete(kind);
  return ALL_NOTIFICATION_KINDS.filter((x) => set.has(x));
}

function NotifyKindToggle({
  kind,
  label,
  checked,
  onChange,
}: {
  kind: NotificationKind;
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label
      className={cn(
        "flex items-start gap-2 rounded-md border px-3 py-2 transition",
        checked
          ? "border-[var(--accent)] bg-[var(--accent)]/5"
          : "border-[var(--border)] bg-[var(--panel-2)]/40 hover:bg-[var(--panel-2)]",
      )}
      data-kind={kind}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5"
      />
      <span className="text-xs">{label}</span>
    </label>
  );
}

function ClickRadio({
  value,
  current,
  onSelect,
  label,
  description,
}: {
  value: NotificationClickBehavior;
  current: NotificationClickBehavior;
  onSelect: () => void;
  label: string;
  description: string;
}) {
  const active = current === value;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onSelect}
      className={cn(
        "rounded-md border px-3 py-2 text-left transition",
        active
          ? "border-[var(--accent)] bg-[var(--accent)]/5"
          : "border-[var(--border)] bg-[var(--panel-2)]/40 hover:bg-[var(--panel-2)]",
      )}
    >
      <div className="flex items-center justify-between gap-2 text-xs font-medium">
        <span>{label}</span>
        {active && <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />}
      </div>
      <div className="mt-0.5 text-[10px] text-[var(--muted)]">{description}</div>
    </button>
  );
}

function ModeRadio({
  value,
  currentValue,
  onSelect,
  label,
  description,
}: {
  value: ModeChoice;
  currentValue: ModeChoice;
  onSelect: () => void;
  label: React.ReactNode;
  description: string;
}) {
  const active = currentValue === value;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onSelect}
      className={cn(
        "rounded-md border px-3 py-2 text-left transition",
        active
          ? "border-[var(--accent)] bg-[var(--accent)]/5"
          : "border-[var(--border)] bg-[var(--panel-2)]/40 hover:bg-[var(--panel-2)]",
      )}
    >
      <div className="flex items-center justify-between gap-2 text-xs font-medium">
        <span>{label}</span>
        {active && <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />}
      </div>
      <div className="mt-0.5 text-[10px] text-[var(--muted)]">{description}</div>
    </button>
  );
}
