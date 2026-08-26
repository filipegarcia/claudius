/**
 * `/model` picker curation — Claude Code 2.1.243: "Added modelPicker
 * setting: curate the /model picker with an ordered, labeled list of
 * models (any id spelling, including Vertex/Bedrock ids), appended to or
 * replacing the built-in lineup."
 *
 * Claudius already has its own model list surfaces (`ModelPicker.tsx`,
 * `/api/models`, `/api/sessions/[id]/model`) built on the SDK's
 * `supportedModels()` (plus a couple of always-shown aliases). This module
 * is a pure post-process applied to whatever list those routes already
 * built, so curation composes with the existing augmentation logic instead
 * of replacing it.
 */
import type { ModelPickerSettings } from "./settings";

/** Mirror of the SDK's `ModelInfo` shape — kept minimal, matches the routes' local type. */
export type CuratedModelInfo = {
  value: string;
  displayName: string;
  description: string;
  resolvedModel?: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: Array<"low" | "medium" | "high" | "xhigh" | "max">;
  supportsAdaptiveThinking?: boolean;
  supportsFastMode?: boolean;
  supportsAutoMode?: boolean;
};

/**
 * Apply `modelPicker` curation to a model list.
 *
 *   - `mode: "replace"` — return ONLY the curated entries (in the order
 *     configured), each rendered as a minimal `ModelInfo` row.
 *   - `mode: "append"` (default/absent) — return the original list with
 *     curated entries appended, skipping any curated id already present
 *     (exact `value` match) so a curated row can't shadow a richer SDK
 *     entry for the same model.
 *
 * `undefined`/empty settings return `models` unchanged.
 */
export function applyModelPickerCuration(
  models: CuratedModelInfo[],
  picker: ModelPickerSettings | undefined,
): CuratedModelInfo[] {
  const entries = picker?.entries?.filter((e) => e.id && e.id.trim().length > 0) ?? [];
  if (entries.length === 0) return models;

  const curated: CuratedModelInfo[] = entries.map((e) => ({
    value: e.id,
    displayName: e.label?.trim() || e.id,
    description: "Curated model (modelPicker setting).",
  }));

  if (picker?.mode === "replace") return curated;

  const existing = new Set(models.map((m) => m.value));
  return [...models, ...curated.filter((c) => !existing.has(c.value))];
}
