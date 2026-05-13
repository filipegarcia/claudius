"use client";

import { useEffect, useRef, useState } from "react";
import { FolderOpen, Image as ImageIcon, Type, X } from "lucide-react";
import { Overlay } from "@/components/overlays/Overlay";
import { DirectoryPicker } from "./DirectoryPicker";
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

/**
 * Hardens the `<img src>` assignment against an XSS sink. `URL.createObjectURL`
 * is the only producer of `previewUrl`, which always returns a `blob:` URL —
 * but CodeQL's `js/xss-through-dom` flags the flow regardless, so we narrow
 * the value here at the use site. Returns `""` if the input isn't a blob URL,
 * which produces a broken-but-safe image rather than executing a script.
 */
function safeBlobSrc(url: string): string {
  return url.startsWith("blob:") ? url : "";
}

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
    initial?.defaults?.permissionMode ?? "",
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!initial) setLetter((name.match(/\S/)?.[0] ?? "C").toUpperCase());
  }, [name, initial]);

  // Revoke object URLs on change/unmount.
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
                      src={safeBlobSrc(pendingImage.previewUrl)}
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
                <input
                  value={defaultModel}
                  onChange={(e) => setDefaultModel(e.target.value)}
                  placeholder="(inherit machine default)"
                  className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 font-mono text-xs focus:outline-none"
                />
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
            <p className="mt-1 text-[10px] text-[var(--muted)]">
              Apply only to new sessions. An explicit per-session override still wins.
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
