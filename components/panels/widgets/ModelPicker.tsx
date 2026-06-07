"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, Cpu, ExternalLink, Gauge, Lightbulb, Loader2, Workflow, Zap } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import {
  ADVISOR_COPY,
  ADVISOR_OPTIONS,
  advisorFamily,
  type AdvisorChoice,
  isCustomAdvisor,
} from "@/lib/shared/advisor";

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
  /**
   * When set, the picker fetches the model list from
   * `/api/sessions/<id>/model` (session-scoped, what the SDK is currently
   * advertising for that session). When null and `source: "global"`, the
   * picker fetches from `/api/models` instead — used by surfaces without
   * a live session (e.g. the workspace-create form).
   */
  sessionId: string | null;
  /**
   * Where to fetch the model list from when `sessionId` is null.
   * Defaults to "session" to preserve existing call sites — if you pass
   * `sessionId={null}` and don't set this, the picker shows "No active
   * session" exactly as it always has.
   */
  source?: "session" | "global";
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
  /**
   * Effort selection only applies inside a live session. Optional so the
   * picker can be reused on session-less surfaces (workspace defaults)
   * that pick a model but have no notion of effort.
   */
  onPickEffort?: (level: EffortLevel | "auto") => Promise<void> | void;
  /**
   * "Ultracode" (Dynamic Workflows) — Opus 4.8's xhigh-effort + parallel-
   * subagent mode. Only meaningful in a live session on an xhigh-capable
   * model, so optional: the row hides itself when this is absent or the
   * active model lacks `xhigh`.
   */
  ultracode?: boolean;
  onToggleUltracode?: (enabled: boolean) => Promise<void> | void;
  /**
   * "Fast mode" — accelerated decoding on supported models (Opus 4.8). Only
   * meaningful in a live session on a `supportsFastMode` model, so optional:
   * the row hides itself when this is absent or the active model lacks fast
   * mode.
   */
  fastMode?: boolean;
  onToggleFast?: (enabled: boolean) => Promise<void> | void;
  /**
   * Advisor model the SDK escalates to mid-turn for stronger judgment
   * (see `lib/shared/advisor.ts`). Optional so the picker can be reused on
   * session-less surfaces (workspace defaults / new-session form) that don't
   * surface advisor controls. When provided as a non-`null` value not in our
   * three-option list, we treat it as "(no advisor selected here)" and let the
   * user re-pick — we don't try to render an unknown model id as a custom
   * fourth row.
   */
  advisorModel?: string | null;
  onPickAdvisor?: (model: AdvisorChoice) => Promise<void> | void;
  /**
   * When true, prepends an "(Inherit machine default)" entry that maps to
   * an empty model value (the workspace form treats empty as "use the
   * machine's default"). Selecting it calls `onPickModel("")`.
   */
  showInherit?: boolean;
  /** Label shown next to the Cpu icon. Defaults to "Model". */
  headerLabel?: string;
};

export function ModelPicker({
  sessionId,
  source = "session",
  currentModel,
  anchorRef,
  onClose,
  onPickModel,
  onPickEffort,
  ultracode = false,
  onToggleUltracode,
  fastMode = false,
  onToggleFast,
  advisorModel = null,
  onPickAdvisor,
  showInherit = false,
  headerLabel = "Model",
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
  //
  // The "global" source path fetches from a sessionless `/api/models` —
  // used by the workspace-create form to render the same picker without
  // a bound session. In that mode the `sessionId` is null but the fetch
  // still goes out, and we don't show the "No active session" hint.
  const fetchUrl =
    source === "global"
      ? "/api/models"
      : sessionId
        ? `/api/sessions/${sessionId}/model`
        : null;

  const [lastFetchUrl, setLastFetchUrl] = useState(fetchUrl);
  if (lastFetchUrl !== fetchUrl) {
    setLastFetchUrl(fetchUrl);
    if (!fetchUrl) {
      setLoading(false);
      setError("No active session");
    } else {
      setLoading(true);
      setError(null);
    }
  }

  useEffect(() => {
    if (!fetchUrl) return;
    const controller = new AbortController();
    fetch(fetchUrl, { signal: controller.signal })
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
  }, [fetchUrl]);

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
          {headerLabel}
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
          {showInherit && (
            <li>
              <button
                type="button"
                role="option"
                aria-selected={!currentModel}
                data-testid="model-picker-option"
                data-model=""
                onClick={() => onPickModel("")}
                className={cn(
                  "flex w-full items-start gap-2 px-3 py-2 text-left transition",
                  !currentModel
                    ? "bg-[var(--panel-2)]/40 hover:bg-[var(--panel-2)]"
                    : "hover:bg-[var(--panel-2)]/60",
                )}
              >
                <Check
                  className={cn(
                    "mt-0.5 h-3 w-3 shrink-0",
                    !currentModel ? "text-[var(--accent)]" : "text-transparent",
                  )}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium text-[var(--foreground)]">
                      Inherit machine default
                    </span>
                  </div>
                  <div className="mt-0.5 truncate text-[10px] text-[var(--muted)]">
                    Use whatever the host CLI picks. New sessions can still override.
                  </div>
                </div>
              </button>
            </li>
          )}
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
                    {/* Mirror the TUI's `Draws from usage credits` suffix on
                        per-model rows whose accelerated decoding is billed
                        from the usage-credit bucket rather than the standard
                        pool. Subdued amber to match the `fast` chip above. */}
                    {m.supportsFastMode && (
                      <div className="mt-0.5 truncate text-[9px] text-amber-200/80">
                        Draws from usage credits
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

      {(() => {
        // Pulled into an IIFE so TS narrows `onPickEffort` to a defined
        // local for the callback closures below. The top-level `cond &&`
        // narrowing doesn't reach into `() => onPickEffort(...)` because
        // those are separate function scopes.
        const pickEffort = onPickEffort;
        if (
          !pickEffort ||
          !activeModel?.supportsEffort ||
          !activeModel.supportedEffortLevels ||
          activeModel.supportedEffortLevels.length === 0
        ) {
          return null;
        }
        return (
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
                  onClick={() => pickEffort("auto")}
                  tone="adaptive"
                />
              )}
              {activeModel.supportedEffortLevels.map((level) => (
                <EffortChip
                  key={level}
                  label={EFFORT_LABEL[level]}
                  onClick={() => pickEffort(level)}
                  tone={level}
                />
              ))}
            </div>
            <div className="px-3 pb-2 text-[10px] text-[var(--muted)]">
              Applies on the next turn. If a turn is in flight, queues
              behind it.
            </div>
          </>
        );
      })()}
      {/* Dynamic Workflows (the SDK's `ultracode` flag) — Opus 4.8's
          xhigh-effort + parallel-subagent orchestration. Only shown on a
          live session with an xhigh-capable model; the SDK additionally
          requires a Workflows-enabled plan, which we surface in the
          sublabel rather than trying to detect client-side. */}
      {(() => {
        const toggle = onToggleUltracode;
        if (!toggle || !activeModel?.supportedEffortLevels?.includes("xhigh")) {
          return null;
        }
        return (
          <div className="border-t border-[var(--border)]/60 px-3 py-2">
            <button
              type="button"
              data-testid="model-picker-ultracode"
              data-enabled={ultracode ? "1" : "0"}
              aria-pressed={ultracode}
              onClick={() => toggle(!ultracode)}
              className={cn(
                "flex w-full items-center gap-2 rounded border px-2 py-1.5 text-left transition",
                ultracode
                  ? "border-[var(--accent)]/40 bg-[var(--accent)]/10"
                  : "border-[var(--border)] bg-[var(--panel-2)] hover:bg-[var(--panel)]",
              )}
            >
              <Workflow
                className={cn(
                  "h-3.5 w-3.5 shrink-0",
                  ultracode ? "text-[var(--accent)]" : "text-[var(--muted)]",
                )}
              />
              <span className="min-w-0 flex-1">
                <span className="block text-[11px] font-medium text-[var(--foreground)]">
                  Dynamic Workflows
                </span>
                <span className="block text-[9px] leading-tight text-[var(--muted)]">
                  xhigh effort + parallel subagents. Needs a Workflows-enabled plan.
                </span>
              </span>
              <span
                className={cn(
                  "relative h-4 w-7 shrink-0 rounded-full transition-colors",
                  ultracode ? "bg-[var(--accent)]" : "bg-[var(--border)]",
                )}
              >
                <span
                  className={cn(
                    "absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all",
                    ultracode ? "left-3.5" : "left-0.5",
                  )}
                />
              </span>
            </button>
          </div>
        );
      })()}
      {/* Fast mode (the SDK's `fastMode` flag) — accelerated decoding on
          supported models (Opus 4.8). Only shown on a live session with a
          fast-capable model; amber to match the per-model "fast" chip in the
          list above. */}
      {/* Advisor (experimental). The SDK's server-side escalation model —
          when the main model needs stronger judgment, it pings the advisor
          and resumes. Rendered as three fixed product-blessed options
          (Opus 4.8 / Sonnet 4.6 / No advisor) regardless of the active
          model's `supportsEffort` etc., because the advisor is a separate
          model, not a setting of the main one. Hidden when the surface
          didn't pass `onPickAdvisor` (e.g. workspace-defaults form).

          Copy lives in `lib/shared/advisor.ts` so this picker and the
          global Settings page render the same verbatim Claude Code message. */}
      {(() => {
        const pickAdvisor = onPickAdvisor;
        if (!pickAdvisor) return null;
        // Family-tolerant match — collapses aliases (`"opus"`,
        // `"sonnet"`), older full ids (`"claude-opus-4-7"`), and the
        // ADVISOR_ACTIVE_SENTINEL to the right product-blessed row so
        // the radio doesn't lie when the persisted value isn't a
        // verbatim match. The `null` row only wins when there's *no*
        // advisor configured anywhere. See `advisorFamily` doc for the
        // family rules; `isCustomAdvisor` returns true for advisors
        // outside the opus/sonnet families (e.g. haiku, custom plugin).
        const current = advisorFamily(advisorModel);
        const custom = isCustomAdvisor(advisorModel) ? (advisorModel ?? "") : null;
        return (
          <div className="border-t border-[var(--border)]/60 px-3 py-2">
            <div className="flex items-center gap-1.5">
              <Lightbulb className="h-3 w-3 text-[var(--accent)]" />
              <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--muted)]">
                {ADVISOR_COPY.header}
              </span>
            </div>
            <p className="mt-1.5 text-[10px] leading-snug text-[var(--muted)]">
              {ADVISOR_COPY.paragraph}
            </p>
            <p className="mt-1.5 text-[10px] italic leading-snug text-[var(--muted)]/80">
              {ADVISOR_COPY.perSessionNote}
            </p>
            <ul
              role="radiogroup"
              aria-label={ADVISOR_COPY.header}
              className="mt-2 space-y-1"
            >
              {ADVISOR_OPTIONS.map((opt) => {
                // "No advisor" (opt.value === null) wins ONLY when *no*
                // advisor is configured anywhere — not when `current` is
                // null because the value is custom (a different family).
                // Without this guard a user on `advisorModel: "haiku"`
                // would see "No advisor" wrongly checked while the
                // Custom row below shows their actual value.
                const isCurrent =
                  opt.value === null
                    ? current === null && custom === null
                    : opt.value === current;
                return (
                  <li key={opt.value ?? "none"}>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={isCurrent}
                      data-testid="model-picker-advisor"
                      data-advisor={opt.value ?? "none"}
                      data-current={isCurrent ? "1" : "0"}
                      onClick={() => pickAdvisor(opt.value)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded border px-2 py-1.5 text-left transition",
                        isCurrent
                          ? "border-[var(--accent)]/40 bg-[var(--accent)]/10"
                          : "border-[var(--border)] bg-[var(--panel-2)] hover:bg-[var(--panel)]",
                      )}
                    >
                      <Check
                        className={cn(
                          "h-3 w-3 shrink-0",
                          isCurrent ? "text-[var(--accent)]" : "text-transparent",
                        )}
                      />
                      <span className="flex-1 truncate text-[11px] text-[var(--foreground)]">
                        {opt.label}
                      </span>
                      {opt.recommended && (
                        <span className="shrink-0 rounded border border-[var(--accent)]/40 bg-[var(--accent)]/10 px-1 py-px text-[9px] text-[var(--accent)]">
                          recommended
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
              {/* Read-only "Custom" row — surfaces a non-listed advisor
                  value (haiku, hand-edited plugin id, etc.) so the user
                  can see what's actually persisted. Clicking one of the
                  three blessed rows above overwrites the value; the
                  Custom row itself isn't clickable because we have no
                  way to choose a single canonical replacement for it. */}
              {custom && (
                <li>
                  <div
                    data-testid="model-picker-advisor-custom"
                    data-advisor={custom}
                    title={`Custom advisor in settings.json — pick a row above to replace, or edit settings.json directly.`}
                    className="flex items-center gap-2 rounded border border-amber-500/30 bg-amber-500/5 px-2 py-1.5"
                  >
                    <Check className="h-3 w-3 shrink-0 text-amber-300" />
                    <span className="flex-1 truncate font-mono text-[10px] text-amber-200">
                      {custom}
                    </span>
                    <span className="shrink-0 rounded border border-amber-500/30 bg-amber-500/10 px-1 py-px text-[9px] text-amber-200">
                      custom
                    </span>
                  </div>
                </li>
              )}
            </ul>
            <p className="mt-2 text-[10px] leading-snug text-[var(--muted)]">
              {ADVISOR_COPY.recommended}
            </p>
            <a
              href={ADVISOR_COPY.learnMoreUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1.5 inline-flex items-center gap-1 text-[10px] text-[var(--accent)] hover:underline"
            >
              {ADVISOR_COPY.learnMoreLabel}
              <ExternalLink className="h-2.5 w-2.5" />
            </a>
          </div>
        );
      })()}
      {(() => {
        if (!onToggleFast || !activeModel?.supportsFastMode) {
          return null;
        }
        return (
          <div className="border-t border-[var(--border)]/60 px-3 py-2">
            <button
              type="button"
              data-testid="model-picker-fast"
              data-enabled={fastMode ? "1" : "0"}
              aria-pressed={fastMode}
              onClick={() => onToggleFast(!fastMode)}
              className={cn(
                "flex w-full items-center gap-2 rounded border px-2 py-1.5 text-left transition",
                fastMode
                  ? "border-amber-500/40 bg-amber-500/10"
                  : "border-[var(--border)] bg-[var(--panel-2)] hover:bg-[var(--panel)]",
              )}
            >
              <Zap
                className={cn(
                  "h-3.5 w-3.5 shrink-0",
                  fastMode ? "text-amber-300" : "text-[var(--muted)]",
                )}
              />
              <span className="min-w-0 flex-1">
                <span className="block text-[11px] font-medium text-[var(--foreground)]">
                  Fast mode
                </span>
                <span className="block text-[9px] leading-tight text-[var(--muted)]">
                  Accelerated responses on supported models.
                </span>
                {/* Mirror the TUI's `Draws from usage credits` confirmation
                    line under the Fast-mode toggle. Subdued amber so it reads
                    as a cost cue rather than a warning. */}
                <span className="mt-0.5 block text-[9px] leading-tight text-amber-200/80">
                  Draws from usage credits.
                </span>
              </span>
              <span
                className={cn(
                  "relative h-4 w-7 shrink-0 rounded-full transition-colors",
                  fastMode ? "bg-amber-500" : "bg-[var(--border)]",
                )}
              >
                <span
                  className={cn(
                    "absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all",
                    fastMode ? "left-3.5" : "left-0.5",
                  )}
                />
              </span>
            </button>
          </div>
        );
      })()}
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
