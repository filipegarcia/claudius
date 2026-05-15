"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, Cpu, Gauge, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils/cn";

/**
 * Mirror of `ModelInfo` from `@anthropic-ai/claude-agent-sdk`. We don't
 * import the type directly to avoid pulling the SDK type-graph into client
 * bundles — the API route already trusts the SDK's shape and we just pass
 * the JSON through.
 */
type ModelInfo = {
  value: string;
  displayName: string;
  description: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: EffortLevel[];
  supportsAdaptiveThinking?: boolean;
  supportsFastMode?: boolean;
  supportsAutoMode?: boolean;
};

type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

const EFFORT_LABEL: Record<EffortLevel, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Very High",
  max: "Max",
};

type Props = {
  sessionId: string | null;
  currentModel: string | null;
  /**
   * Anchor element the popover positions itself against. We use fixed
   * positioning so the panel can escape the right rail's `overflow-y-auto`
   * container without getting clipped — the same problem the
   * `NotificationsDrawer` solves by living outside the scroll region.
   */
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  onPickModel: (modelValue: string) => Promise<void> | void;
  onPickEffort: (level: EffortLevel | "auto") => Promise<void> | void;
};

export function ModelPicker({
  sessionId,
  currentModel,
  anchorRef,
  onClose,
  onPickModel,
  onPickEffort,
}: Props) {
  const panelRef = useRef<HTMLDivElement>(null);

  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Position the floating panel under (or above) the anchor button. We
  // recompute on open, scroll, and resize so it stays glued to the trigger
  // even as the right rail scrolls.
  const [position, setPosition] = useState<{ top: number; left: number; width: number } | null>(
    null,
  );

  useLayoutEffect(() => {
    function measure() {
      const a = anchorRef.current;
      if (!a) return;
      const rect = a.getBoundingClientRect();
      // Panel width is capped at the rail (anchor) width with a sane min so
      // the descriptions don't squeeze into ribbons. We also clamp so the
      // panel never falls off the left edge.
      const width = Math.max(rect.width, 280);
      const left = Math.max(8, rect.right - width);
      setPosition({ top: rect.bottom + 4, left, width });
    }
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [anchorRef]);

  // Click outside + Escape closes the panel. Matches the NotificationsDrawer
  // pattern so behavior is consistent across the rail.
  useEffect(() => {
    function onClick(e: MouseEvent) {
      const t = e.target as Node | null;
      if (!t) return;
      if (panelRef.current?.contains(t)) return;
      if (anchorRef.current?.contains(t)) return;
      onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [anchorRef, onClose]);

  // Lazy-fetch the model list. The SDK's `supportedModels()` requires an
  // active query, so we only call it after the user opens the picker — by
  // then the session is almost always bound. If the call 503s (resume in
  // flight), we surface a friendly empty state instead of a JSON error.
  // Reset loading/error state during render when the session unbinds,
  // so the effect below contains no sync setState in its body.
  // https://react.dev/reference/react/useState#storing-information-from-previous-renders
  const [lastSessionId, setLastSessionId] = useState(sessionId);
  if (lastSessionId !== sessionId) {
    setLastSessionId(sessionId);
    if (!sessionId) {
      setLoading(false);
      setError("No active session");
    } else {
      setLoading(true);
      setError(null);
    }
  }

  useEffect(() => {
    if (!sessionId) return;
    const controller = new AbortController();
    fetch(`/api/sessions/${sessionId}/model`, { signal: controller.signal })
      .then(async (r) => {
        if (controller.signal.aborted) return;
        if (!r.ok) {
          const body = (await r.json().catch(() => ({}))) as { error?: string };
          setError(body.error ?? `HTTP ${r.status}`);
          setModels([]);
          return;
        }
        const data = (await r.json()) as { models?: ModelInfo[] };
        setModels(Array.isArray(data.models) ? data.models : []);
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : String(err));
        setModels([]);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [sessionId]);

  // The effort row is tied to the *currently active* model, not whatever
  // model the user is hovering. Earlier cuts of this component flipped the
  // focused model on `mouseenter`, but the path from the topmost model row
  // down to the effort chips ran over the intermediate model rows — and if
  // one of them (e.g. Haiku) didn't support effort, the effort row vanished
  // before the click could land. Tying effort to `currentModel` keeps the
  // row stable: when the user picks a different model the optimistic update
  // in `setModel` (use-session) refreshes `currentModel` and the chips
  // re-render to that model's `supportedEffortLevels`.
  const activeModel = models?.find((m) => m.value === currentModel) ?? null;

  if (!position) return null;

  return (
    <div
      ref={panelRef}
      data-testid="model-picker-panel"
      role="dialog"
      aria-label="Model and effort picker"
      style={{ top: position.top, left: position.left, width: position.width }}
      className="fixed z-50 max-h-[70vh] overflow-y-auto rounded-md border border-[var(--border)] bg-[var(--panel)] py-1 text-[12px] shadow-lg scroll-thin"
    >
      <div className="flex items-center gap-1.5 border-b border-[var(--border)]/60 px-3 py-2">
        <Cpu className="h-3 w-3 text-[var(--accent)]" />
        <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--muted)]">
          Model
        </span>
      </div>

      {loading && (
        <div className="flex items-center gap-2 px-3 py-4 text-[var(--muted)]">
          <Loader2 className="h-3 w-3 animate-spin" />
          <span>Loading models…</span>
        </div>
      )}

      {!loading && error && (
        <div className="px-3 py-3 text-[var(--muted)]">
          <div className="font-medium text-[var(--foreground)]">Couldn&apos;t load models</div>
          <div className="mt-1 text-[10px]">{error}</div>
        </div>
      )}

      {!loading && !error && models && models.length === 0 && (
        <div className="px-3 py-3 text-[var(--muted)]">No models available.</div>
      )}

      {!loading && !error && models && models.length > 0 && (
        <ul className="py-1" role="listbox" aria-label="Available models">
          {models.map((m) => {
            const isCurrent = m.value === currentModel;
            return (
              <li key={m.value}>
                <button
                  type="button"
                  role="option"
                  aria-selected={isCurrent}
                  data-testid="model-picker-option"
                  data-model={m.value}
                  onClick={() => onPickModel(m.value)}
                  className={cn(
                    "flex w-full items-start gap-2 px-3 py-2 text-left transition",
                    // CSS-only hover style — JS-managed "focused" state used
                    // to live here, but listening for `mouseenter` made the
                    // effort row vanish whenever the mouse crossed a model
                    // that didn't support effort on its way to the chips.
                    isCurrent
                      ? "bg-[var(--panel-2)]/40 hover:bg-[var(--panel-2)]"
                      : "hover:bg-[var(--panel-2)]/60",
                  )}
                >
                  <Check
                    className={cn(
                      "mt-0.5 h-3 w-3 shrink-0",
                      isCurrent ? "text-[var(--accent)]" : "text-transparent",
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium text-[var(--foreground)]">
                        {m.displayName || m.value}
                      </span>
                      {m.supportsEffort && (
                        <span className="rounded border border-[var(--border)] bg-[var(--panel-2)] px-1 py-px text-[9px] text-[var(--muted)]">
                          effort
                        </span>
                      )}
                      {m.supportsFastMode && (
                        <span className="rounded border border-amber-500/30 bg-amber-500/10 px-1 py-px text-[9px] text-amber-200">
                          fast
                        </span>
                      )}
                    </div>
                    {m.description && (
                      <div className="mt-0.5 truncate text-[10px] text-[var(--muted)]">
                        {m.description}
                      </div>
                    )}
                    <div className="mt-0.5 truncate font-mono text-[9px] text-[var(--muted)]/80">
                      {m.value}
                    </div>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {activeModel?.supportsEffort &&
        activeModel.supportedEffortLevels &&
        activeModel.supportedEffortLevels.length > 0 && (
          <>
            <div className="flex items-center gap-1.5 border-t border-[var(--border)]/60 px-3 py-2">
              <Gauge className="h-3 w-3 text-[var(--accent)]" />
              <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--muted)]">
                Effort
              </span>
              <span className="ml-auto truncate font-mono text-[9px] text-[var(--muted)]/80">
                {activeModel.displayName || activeModel.value}
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5 px-3 pb-3 pt-1">
              {activeModel.supportsAdaptiveThinking !== false && (
                <EffortChip
                  label="Auto"
                  onClick={() => onPickEffort("auto")}
                  tone="adaptive"
                />
              )}
              {activeModel.supportedEffortLevels.map((level) => (
                <EffortChip
                  key={level}
                  label={EFFORT_LABEL[level]}
                  onClick={() => onPickEffort(level)}
                  tone={level}
                />
              ))}
            </div>
            <div className="px-3 pb-2 text-[10px] text-[var(--muted)]">
              Applies on the next turn. If a turn is in flight, queues
              behind it.
            </div>
          </>
        )}
    </div>
  );
}

function EffortChip({
  label,
  onClick,
  tone,
}: {
  label: string;
  onClick: () => void;
  tone: EffortLevel | "adaptive";
}) {
  const toneClass =
    tone === "adaptive"
      ? "border-[var(--border)] bg-[var(--panel-2)] text-[var(--muted)] hover:text-[var(--foreground)]"
      : tone === "low"
        ? "border-sky-500/30 bg-sky-500/10 text-sky-200 hover:bg-sky-500/20"
        : tone === "medium"
          ? "border-violet-500/30 bg-violet-500/10 text-violet-200 hover:bg-violet-500/20"
          : tone === "high"
            ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20"
            : tone === "xhigh"
              ? "border-amber-500/30 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20"
              : "border-red-500/30 bg-red-500/10 text-red-200 hover:bg-red-500/20";

  return (
    <button
      type="button"
      data-testid="model-picker-effort"
      data-effort={tone}
      onClick={onClick}
      className={cn(
        "rounded border px-2 py-1 text-[10px] font-medium transition",
        toneClass,
      )}
    >
      {label}
    </button>
  );
}
