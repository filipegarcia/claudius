/**
 * CC 2.1.316 parity — "Fixed /model <id> not warning when the model isn't
 * recognized by this version and auto-compact will assume a 200K context
 * window".
 *
 * The engine only warns from its own terminal `/model` command (bundle fn
 * `i6n`). Claudius handles `/model <id>` itself (ChatSurface →
 * `Session.setModel` → `query.setModel()`), so the warning never reached the
 * chat. This is Claudius's copy: the server decides with these pure helpers
 * and rides the text on the `model_changed` broadcast / route response.
 *
 * Claudius can't see the engine's model catalog, so "recognized" is
 * deliberately generous — a stale hand list would warn on every new model.
 * An id is recognized when ANY of: it's a model alias; it matches a
 * `supportedModels()` row (`value` or `resolvedModel`); or it parses as a
 * Claude family id of any version (`claude-opus-9-1`, Bedrock / Vertex
 * wrappers, dotted gateway spellings, legacy `claude-3-5-sonnet`). Only ids
 * outside all of those (`my-gateway-model`, `gpt-x`) warn.
 */

import { canonicalModelId } from "./advisor";
import { normalizeDottedModelVersion, stripOneMTag } from "./model-id";

/** Docs anchor the engine links (verbatim, `fIo` in the 2.1.316 bundle). */
export const UNKNOWN_MODEL_WINDOW_DOCS_URL =
  "https://code.claude.com/docs/en/model-config#correct-the-window-for-a-gateway-or-custom-model-id";

/** The window auto-compact assumes for a model it doesn't know. */
export const UNKNOWN_MODEL_ASSUMED_WINDOW = 200_000;

const MODEL_ALIASES = new Set([
  "default",
  "opus",
  "sonnet",
  "haiku",
  "fable",
  "mythos",
  "best",
  "opusplan",
]);

/** Bare gateway spellings (`sonnet-5.5`, `opus-4-8`) of a known family. */
const BARE_FAMILY_VERSION = /(?:^|[^a-z])(?:opus|sonnet|haiku|fable|mythos)-\d/;
/** Legacy ids: `claude-3-5-sonnet-…`, `claude-instant-1.2`, `claude-2.1`. */
const LEGACY_CLAUDE = /claude-(?:\d+(?:[-.]\d+)?-(?:opus|sonnet|haiku)\b|instant\b|[12](?:\.\d)?$)/;

type CatalogRow = { value: string; resolvedModel?: string };

export function isRecognizedModel(
  id: string | null | undefined,
  models?: readonly CatalogRow[] | null,
): boolean {
  if (typeof id !== "string" || !id.trim()) return true; // nothing to warn about
  const bare = stripOneMTag(id).toLowerCase();
  if (MODEL_ALIASES.has(bare)) return true;
  if (
    models?.some(
      (m) =>
        stripOneMTag(m.value).toLowerCase() === bare ||
        (!!m.resolvedModel && stripOneMTag(m.resolvedModel).toLowerCase() === bare),
    )
  ) {
    return true;
  }
  if (canonicalModelId(normalizeDottedModelVersion(bare))) return true;
  return BARE_FAMILY_VERSION.test(bare) || LEGACY_CLAUDE.test(bare);
}

const TRUTHY = /^(?:1|true|yes|on)$/i;
function envOn(v: string | undefined): boolean {
  return typeof v === "string" && TRUTHY.test(v.trim());
}
function positiveNumber(v: unknown): boolean {
  const n = typeof v === "string" ? Number(v.trim()) : v;
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

/**
 * The engine's gates, as far as Claudius can see them. No warning when:
 * - `CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT` is set (the engine
 *   then waits for the API instead of assuming a window);
 * - a window is configured — `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, a numeric
 *   top-level `autoCompactWindow`, or `modelSettings.<model>.autoCompactWindow`;
 * - `CLAUDE_CODE_MAX_CONTEXT_TOKENS` is set (the engine skips the notice for a
 *   gateway id when it is);
 * - auto-compact is off (`autoCompactEnabled: false`, `DISABLE_AUTO_COMPACT`,
 *   `DISABLE_COMPACT`) — there's no auto-compact to assume a window for.
 */
export function unknownModelWarningSuppressed(
  model: string,
  env: Record<string, string | undefined>,
  settings: Record<string, unknown> | null | undefined,
): boolean {
  if (envOn(env.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT)) return true;
  if (envOn(env.DISABLE_AUTO_COMPACT) || envOn(env.DISABLE_COMPACT)) return true;
  if (positiveNumber(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW)) return true;
  if (positiveNumber(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS)) return true;
  const s = settings ?? {};
  if (s.autoCompactEnabled === false) return true;
  if (positiveNumber(s.autoCompactWindow)) return true;
  const perModel = s.modelSettings;
  if (perModel && typeof perModel === "object") {
    const entry = (perModel as Record<string, unknown>)[model];
    if (entry && typeof entry === "object" && positiveNumber((entry as Record<string, unknown>).autoCompactWindow)) {
      return true;
    }
  }
  return false;
}

/** The engine's `ef`: keep only id-safe characters, cap at 128. */
function displayModelId(model: string): string {
  const cleaned = model.replace(/[^A-Za-z0-9._:/@[\]-]/g, "");
  if (!cleaned) return "(unrecognized model name)";
  return cleaned.length > 128 ? `${cleaned.slice(0, 128)}…` : cleaned;
}

/** The engine's compact token count (`200000` → `200k`). */
function compactTokens(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1_000) return `${+(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Verbatim engine text (`i6n` in the 2.1.316 bundle). */
export function unknownModelWarningText(model: string, window = UNKNOWN_MODEL_ASSUMED_WINDOW): string {
  return `Claude Code doesn't recognize the model "${displayModelId(model)}", so it assumes a context window of ${compactTokens(window)} tokens. Update Claude Code, or see ${UNKNOWN_MODEL_WINDOW_DOCS_URL} to set the window.`;
}

/**
 * The warning for a `/model <id>` switch, or `null`. A `[1m]`-tagged id is
 * skipped: the engine honours the 1M opt-in there instead of assuming 200k,
 * and Claudius can't tell what window it would assume.
 */
export function unknownModelWarning(opts: {
  model: string | null | undefined;
  models?: readonly CatalogRow[] | null;
  env: Record<string, string | undefined>;
  settings?: Record<string, unknown> | null;
}): string | null {
  const { model } = opts;
  if (typeof model !== "string" || !model.trim()) return null;
  if (/\[1m\]$/i.test(model.trim())) return null;
  if (isRecognizedModel(model, opts.models)) return null;
  if (unknownModelWarningSuppressed(model, opts.env, opts.settings)) return null;
  return unknownModelWarningText(model);
}
