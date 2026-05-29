"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Circle,
  Keyboard,
  RotateCcw,
  Trash2,
  XCircle,
} from "lucide-react";
import {
  bindingFromEvent,
  canonicalKey,
  formatBinding,
  reservedConflictFor,
  SHORTCUT_BY_ID,
  useShortcutRegistry,
  type ShortcutAction,
  type ShortcutBinding,
  type ShortcutCategory,
} from "@/lib/client/shortcuts";
import { useClaudius, useIsElectron } from "@/lib/client/useElectron";
import { cn } from "@/lib/utils/cn";

const CATEGORY_LABEL: Record<ShortcutCategory, string> = {
  tabs: "Session tabs",
  workspaces: "Workspaces",
  navigation: "Side-nav navigation",
  // Phase 3 of docs/electron-conversion/PLAN.md — these are owned by
  // the native OS menu in the packaged Electron build. The web build
  // still surfaces them so users can remap to a non-reserved chord.
  window: "Window controls",
  view: "View",
  app: "Application",
};

const CATEGORY_ORDER: ShortcutCategory[] = [
  "tabs",
  "workspaces",
  "navigation",
  "window",
  "view",
  "app",
];

/**
 * Web-app keyboard shortcuts section, rendered inside `/settings`. Pair with
 * `lib/client/shortcuts.ts` (the registry). The CLI-side keybindings page at
 * `/keybindings` is unrelated — that one edits Claude Code's input chords,
 * persisted server-side.
 */
export function ShortcutsSection() {
  const { items, collisions, setBinding, resetAll, resetOne } = useShortcutRegistry();
  const isElectron = useIsElectron();

  // Group by category for the rendered list. `useMemo` avoids re-grouping on
  // every keystroke during recording — items only changes when bindings do.
  const grouped = useMemo(() => {
    const m = new Map<ShortcutCategory, typeof items>();
    for (const cat of CATEGORY_ORDER) m.set(cat, []);
    for (const it of items) {
      const arr = m.get(it.action.category);
      if (arr) arr.push(it);
    }
    return m;
  }, [items]);

  const anyCustom = items.some((i) => i.isCustom);
  const collisionCount = Object.keys(collisions).length;

  return (
    <section className="rounded-lg border border-[var(--border)] bg-[var(--panel)]/40 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-medium">
            <Keyboard className="h-3.5 w-3.5 text-[var(--muted)]" />
            {isElectron ? "App shortcuts" : "Web app shortcuts"}
          </h2>
          <p className="mt-0.5 text-[11px] text-[var(--muted)]">
            Keyboard chords for the {isElectron ? "app" : "browser"} UI — tab
            switching, workspace cycling, side-nav navigation. Persisted{" "}
            {isElectron ? "on this machine" : "per browser"}. For Claude
            Code&rsquo;s input keybindings instead, see{" "}
            <Link
              href="/keybindings"
              className="underline decoration-dotted hover:text-[var(--foreground)]"
            >
              /keybindings
            </Link>
            .
          </p>
        </div>
        {anyCustom && (
          <button
            onClick={resetAll}
            title="Restore every shortcut to its default"
            className="flex shrink-0 items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-0.5 text-[11px] hover:bg-[var(--panel)]"
          >
            <RotateCcw className="h-3 w-3" /> Reset all
          </button>
        )}
      </div>

      {collisionCount > 0 && (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-300">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
          <span>
            <strong>{collisionCount}</strong>{" "}
            {collisionCount === 1 ? "collision" : "collisions"} detected. Two or
            more shortcuts share a key — the first action to register the
            handler wins, and behaviour may be unpredictable.
          </span>
        </div>
      )}

      <div className="mt-3 space-y-4">
        {CATEGORY_ORDER.map((cat) => {
          const rows = grouped.get(cat) ?? [];
          if (rows.length === 0) return null;
          return (
            <div key={cat}>
              <div className="mb-1.5 text-[10px] uppercase tracking-wide text-[var(--muted)]">
                {CATEGORY_LABEL[cat]}
              </div>
              <ul className="space-y-1">
                {rows.map(({ action, binding, isCustom }) => (
                  <ShortcutRow
                    key={action.id}
                    action={action}
                    binding={binding}
                    isCustom={isCustom}
                    isElectron={isElectron}
                    collidesWith={
                      binding
                        ? (collisions[canonicalKey(binding)] ?? []).filter((id) => id !== action.id)
                        : []
                    }
                    onSet={(b) => setBinding(action.id, b)}
                    onReset={() => resetOne(action.id)}
                  />
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ── Per-action row ───────────────────────────────────────────────────────

function ShortcutRow({
  action,
  binding,
  isCustom,
  isElectron,
  collidesWith,
  onSet,
  onReset,
}: {
  action: ShortcutAction;
  binding: ShortcutBinding | null;
  isCustom: boolean;
  isElectron: boolean;
  collidesWith: string[];
  onSet: (b: ShortcutBinding | null) => void;
  onReset: () => void;
}) {
  const [recording, setRecording] = useState(false);
  const [preview, setPreview] = useState<ShortcutBinding | null>(null);
  // In Electron the native menu owns these chords, so the browser never
  // reserves them — the "browser reserves this" warning only applies to the
  // web build.
  const reserved = isElectron ? null : reservedConflictFor(binding);
  const recordRef = useRef<HTMLButtonElement | null>(null);
  const bridge = useClaudius();

  // While the recorder is listening in Electron, suspend the native menu's
  // accelerators so a chord the menu owns (⌘T, ⌘W, …) reaches the recorder
  // instead of firing the menu item. Re-enables on stop / unmount. No-op in
  // the browser build or on an older preload (feature-detected).
  useEffect(() => {
    if (!bridge || bridge.bridgeVersion < 3 || typeof bridge.menu.setRecording !== "function") {
      return;
    }
    bridge.menu.setRecording(recording);
    return () => {
      bridge.menu.setRecording(false);
    };
  }, [bridge, recording]);

  // While recording, listen globally. We capture in the bubble phase but
  // `preventDefault` + `stopPropagation` everything so the page's own
  // shortcut handlers don't fire during capture — otherwise pressing the
  // current binding would activate the very action we're trying to remap.
  useEffect(() => {
    if (!recording) return;
    function onKey(e: KeyboardEvent) {
      // Esc cancels recording without saving.
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setRecording(false);
        setPreview(null);
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      const next = bindingFromEvent(e);
      if (!next) {
        // Bare modifier press — show what's held so far in the preview but
        // don't commit. The recorder waits for the first non-modifier key.
        setPreview({
          mod: e.metaKey || e.ctrlKey,
          alt: e.altKey,
          shift: e.shiftKey,
          code: null,
        });
        return;
      }
      // For modifier-only actions (tab.selectByNumber), strip the code part —
      // the handler will combine the chord with Digit1..9 at runtime.
      const committed: ShortcutBinding = action.modifierOnly
        ? { mod: next.mod, alt: next.alt, shift: next.shift, code: null }
        : next;
      onSet(committed);
      setRecording(false);
      setPreview(null);
    }
    // useCapture: true so we beat the rest of the page to the keydown.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, onSet, action.modifierOnly]);

  // Outside-click cancels recording. Keeps the recorder from staying live
  // if the user clicks away without pressing a key.
  useEffect(() => {
    if (!recording) return;
    function onDown(e: MouseEvent) {
      if (recordRef.current && !recordRef.current.contains(e.target as Node)) {
        setRecording(false);
        setPreview(null);
      }
    }
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [recording]);

  const displayBinding = recording ? preview : binding;
  const hasCollision = collidesWith.length > 0;
  const showWarn = !recording && (hasCollision || reserved);

  return (
    <li
      data-testid="shortcut-row"
      data-action-id={action.id}
      className={cn(
        "grid grid-cols-1 gap-2 rounded-md border border-[var(--border)] bg-[var(--panel-2)]/40 p-2 sm:grid-cols-[1fr_auto]",
        recording && "ring-1 ring-[var(--accent)]",
      )}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs">{action.label}</span>
          {action.modifierOnly && (
            <span className="rounded bg-[var(--panel)] px-1 py-px text-[9px] text-[var(--muted)]">
              + 1–9
            </span>
          )}
          {isCustom && (
            <span className="rounded bg-[var(--accent)]/15 px-1.5 py-px text-[9px] text-[var(--accent)]">
              customised
            </span>
          )}
          {action.electronMenuOwned && isElectron && (
            <span
              title="The native app menu owns the canonical handler for this chord. Remapping here still works, but the menu accelerator is what reliably reaches the app when the chord is browser-reserved."
              className="rounded bg-[var(--panel)] px-1.5 py-px text-[9px] uppercase tracking-wide text-[var(--muted)]"
            >
              app menu
            </span>
          )}
        </div>
        {action.description && (
          <div className="mt-0.5 text-[11px] text-[var(--muted)]">{action.description}</div>
        )}
        {showWarn && (
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[10.5px]">
            {hasCollision && (
              <span className="flex items-center gap-1 text-amber-300">
                <AlertTriangle className="h-3 w-3" />
                Collides with{" "}
                <span className="font-mono">
                  {collidesWith.map((id) => SHORTCUT_BY_ID[id]?.label ?? id).join(", ")}
                </span>
              </span>
            )}
            {reserved && (
              <span className="flex items-center gap-1 text-amber-300/90">
                <AlertTriangle className="h-3 w-3" />
                Browser reserves this for {reserved} — the chord may not reach the app.
              </span>
            )}
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <BindingChip binding={displayBinding} recording={recording} />
        <button
          ref={recordRef}
          type="button"
          data-testid="shortcut-record"
          onClick={() => {
            setPreview(null);
            setRecording((r) => !r);
          }}
          title={recording ? "Press the chord, or Esc to cancel" : "Record a new chord"}
          className={cn(
            "flex items-center gap-1 rounded-md border px-2 py-1 text-[11px]",
            recording
              ? "border-[var(--accent)] bg-[var(--accent)]/15 text-[var(--accent)]"
              : "border-[var(--border)] bg-[var(--panel)] hover:bg-[var(--panel-2)]",
          )}
        >
          {recording ? (
            <>
              <Circle className="h-3 w-3 animate-pulse fill-current" />
              Listening…
            </>
          ) : (
            <>
              <Keyboard className="h-3 w-3" />
              Record
            </>
          )}
        </button>
        {binding && !recording && (
          <button
            type="button"
            onClick={() => onSet(null)}
            title="Disable this shortcut"
            className="flex h-7 w-7 items-center justify-center rounded-md border border-[var(--border)] bg-[var(--panel)] text-[var(--muted)] hover:border-red-500/30 hover:bg-red-500/10 hover:text-red-400"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        )}
        {!binding && !recording && action.default && (
          // Restore the original default when the shortcut is currently
          // disabled — the most likely "oops, I want this back" path.
          <button
            type="button"
            onClick={onReset}
            title="Restore default binding"
            className="flex h-7 w-7 items-center justify-center rounded-md border border-[var(--border)] bg-[var(--panel)] text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)]"
          >
            <RotateCcw className="h-3 w-3" />
          </button>
        )}
        {isCustom && !recording && binding && (
          <button
            type="button"
            onClick={onReset}
            title="Reset to default"
            className="flex h-7 w-7 items-center justify-center rounded-md border border-[var(--border)] bg-[var(--panel)] text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)]"
          >
            <RotateCcw className="h-3 w-3" />
          </button>
        )}
      </div>
    </li>
  );
}

function BindingChip({
  binding,
  recording,
}: {
  binding: ShortcutBinding | null;
  recording: boolean;
}) {
  if (recording && !binding) {
    return (
      <span className="flex h-7 min-w-[88px] items-center justify-center gap-1 rounded-md border border-dashed border-[var(--accent)]/60 bg-[var(--accent)]/5 px-2 font-mono text-[11px] text-[var(--accent)]">
        Press keys…
      </span>
    );
  }
  if (!binding) {
    return (
      <span className="flex h-7 min-w-[88px] items-center justify-center gap-1 rounded-md border border-dashed border-[var(--border)] px-2 font-mono text-[11px] text-[var(--muted)]">
        <XCircle className="h-3 w-3" /> off
      </span>
    );
  }
  return (
    <span
      data-testid="shortcut-binding-display"
      className={cn(
        "flex h-7 min-w-[88px] items-center justify-center rounded-md border bg-[var(--panel)] px-2 font-mono text-[11.5px] tabular-nums",
        recording
          ? "border-[var(--accent)]/60 text-[var(--accent)]"
          : "border-[var(--border)] text-[var(--foreground)]",
      )}
    >
      {formatBinding(binding)}
    </span>
  );
}
