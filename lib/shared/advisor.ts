/**
 * Single source of truth for the "Advisor" feature surface — the fixed
 * three-option choice (Opus 4.8 / Sonnet 5 / none) and the verbatim copy
 * Claude Code's CLI shows in its advisor picker. Imported by both the
 * SessionCard's ModelPicker (per-session pick) and the global Settings page
 * (persisted default in settings.json), so the two surfaces can't drift.
 *
 * Mechanism: the SDK exposes `Settings.advisorModel` (see
 * `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`) — a model id the
 * SDK uses for its server-side advisor escalation. The runtime accepts any
 * model id, but the Claude Code product surface intentionally narrows the
 * UI to these three values (the picker the user is mirroring shows exactly
 * Opus 4.8, Sonnet 5, or "No advisor"). We don't derive this list from
 * `supportedModels()` — it's a fixed product choice, not an enumeration of
 * everything the SDK could route to.
 *
 * SDK 0.3.197 bump: the SDK's own `Options.model` / prompt-hook / agent-hook
 * doc examples replaced every `claude-sonnet-4-6` with `claude-sonnet-5`
 * (`sdk.d.ts`), and the `xhigh` effort-tier doc gained "Sonnet 5" alongside
 * Fable 5 / Opus 4.7+. That's the SDK's canonical "current Sonnet" id
 * moving forward, so the product-blessed advisor value tracks it here.
 */

/** Model id corresponding to "Opus 4.8" in the picker. */
export const ADVISOR_OPUS_VALUE = "claude-opus-4-8";
/** Model id corresponding to "Sonnet 5" in the picker. */
export const ADVISOR_SONNET_VALUE = "claude-sonnet-5";
/**
 * Model id corresponding to "Fable 5" in the picker. Claude Code 2.1.232
 * re-offers Fable 5 as an advisor option, but *only for orgs that have
 * access to it* — so unlike Opus/Sonnet this row is conditional: it's shown
 * only when the org's `supportedModels()` advertises a Fable model (see
 * `hasFableModel` / `advisorOptions`). The runtime accepts any advisor id;
 * the gating is a product-surface choice mirroring the CLI.
 */
export const ADVISOR_FABLE_VALUE = "claude-fable-5";

export type AdvisorChoice =
  | typeof ADVISOR_OPUS_VALUE
  | typeof ADVISOR_SONNET_VALUE
  | typeof ADVISOR_FABLE_VALUE
  | null;

export type AdvisorOption = {
  /** The persisted `advisorModel` value. `null` clears the setting (no advisor). */
  value: AdvisorChoice;
  /** Short label shown in the radio/picker row, e.g. "Opus 4.8". */
  label: string;
  /** Whether this is the option Claude Code marks recommended in its TUI. */
  recommended?: boolean;
};

/**
 * Order matches the Claude Code CLI exactly:
 *   1. Opus 4.8 (recommended)
 *   2. Sonnet 5
 *   3. No advisor
 *
 * Keep this ordering stable — both the SessionCard picker and the Settings
 * page iterate this array directly to render their radio rows.
 */
export const ADVISOR_OPTIONS: AdvisorOption[] = [
  { value: ADVISOR_OPUS_VALUE, label: "Opus 4.8", recommended: true },
  { value: ADVISOR_SONNET_VALUE, label: "Sonnet 5" },
  { value: null, label: "No advisor" },
];

/**
 * The optional "Fable 5" row. Kept out of the base `ADVISOR_OPTIONS` so
 * that surfaces which can't verify org access (and the two e2e specs that
 * assert exactly three rows) keep their existing shape. Surfaces with an
 * authoritative model list splice this in via `advisorOptions(true)`.
 */
export const ADVISOR_FABLE_OPTION: AdvisorOption = {
  value: ADVISOR_FABLE_VALUE,
  label: "Fable 5",
};

/**
 * Every advisor value the pickers may legitimately write back — the three
 * product-blessed choices plus Fable. The advisor POST route uses this to
 * allowlist an incoming pick. Fable is always accepted at the write layer
 * (the runtime tolerates any advisor id, and gating access at write-time
 * would need a live `supportedModels()` probe); the *UI* is what withholds
 * the Fable row from orgs without access.
 */
export const ADVISOR_PICKABLE_VALUES: ReadonlyArray<AdvisorChoice> = [
  ADVISOR_OPUS_VALUE,
  ADVISOR_SONNET_VALUE,
  ADVISOR_FABLE_VALUE,
  null,
];

/**
 * The advisor options to render, given whether the org has Fable access.
 * When `includeFable` is true the Fable row is inserted just before the
 * terminal "No advisor" row (most-capable escalation target listed after
 * the recommended Opus/Sonnet pair, before "off"). When false the list is
 * the base three — identical to `ADVISOR_OPTIONS`.
 */
export function advisorOptions(includeFable: boolean): AdvisorOption[] {
  if (!includeFable) return ADVISOR_OPTIONS;
  return [
    { value: ADVISOR_OPUS_VALUE, label: "Opus 4.8", recommended: true },
    { value: ADVISOR_SONNET_VALUE, label: "Sonnet 5" },
    ADVISOR_FABLE_OPTION,
    { value: null, label: "No advisor" },
  ];
}

/**
 * Minimal shape of a `supportedModels()` entry we need to detect Fable
 * access without importing the SDK's `ModelInfo` into shared code.
 */
type ModelLike = { value?: string | null; resolvedModel?: string | null };

/**
 * `true` when the given `supportedModels()` list advertises a Fable model —
 * i.e. the org has access to Fable and it may be offered as an advisor.
 * Matches both the bare `"fable"` alias and any `claude-fable-*` wire id, on
 * either the row's `value` or its `resolvedModel`.
 */
export function hasFableModel(models: ReadonlyArray<ModelLike> | null | undefined): boolean {
  if (!Array.isArray(models)) return false;
  const isFable = (raw: string | null | undefined): boolean => {
    if (typeof raw !== "string" || raw.length === 0) return false;
    const id = raw.toLowerCase();
    return id === "fable" || id.startsWith("claude-fable") || id.startsWith("fable-");
  };
  return models.some((m) => isFable(m?.value) || isFable(m?.resolvedModel));
}

/** Verbatim copy from the Claude Code CLI's advisor picker. */
export const ADVISOR_COPY = {
  header: "Advisor (experimental)",
  paragraph:
    "When Claude needs stronger judgment — a complex decision, an ambiguous failure, a problem it's circling without progress — it escalates to the advisor model for guidance, then resumes. The advisor runs server-side and uses additional tokens.",
  recommended:
    "Recommended setup: Sonnet as the main model with Opus as the advisor. For certain workloads this gives near-Opus performance with reduced token usage.",
  learnMoreLabel: "Learn more",
  learnMoreUrl: "https://claude.com/blog/the-advisor-strategy",
  /**
   * Clarifier shown inside the SessionCard's picker. The advisor is a
   * connection-level setting (one value in `~/.claude/settings.json`
   * applies across every session), so picking here both *applies to the
   * current turn* via the SDK's flag layer AND *persists globally* — same
   * as editing it in the main Settings page. This wording matches the
   * Claude Code CLI's mental model and avoids implying a per-session
   * override that doesn't exist as a separate concept here.
   */
  perSessionNote:
    "Applies to this session immediately and persists as the global default — same value as Settings → Model & behavior.",
} as const;

/**
 * Strict normalization into one of our three known `AdvisorChoice` values
 * — `null` for anything else. Used at the *POST* layer to constrain what
 * the picker writes back over the wire: even if the user is currently on
 * a custom advisor id, clicking a radio row sends a clean product-blessed
 * value, never an alias. For *display* / row-highlight, use
 * `advisorFamily` instead (it's tolerant of aliases and older ids).
 */
export function normalizeAdvisorChoice(raw: unknown): AdvisorChoice {
  if (raw === ADVISOR_OPUS_VALUE) return ADVISOR_OPUS_VALUE;
  if (raw === ADVISOR_SONNET_VALUE) return ADVISOR_SONNET_VALUE;
  if (raw === ADVISOR_FABLE_VALUE) return ADVISOR_FABLE_VALUE;
  return null;
}

/**
 * Family-tolerant matcher for radio-row highlighting. Maps any advisor
 * value the user might carry — Claude Code aliases (`"opus"`, `"sonnet"`),
 * older full ids (`"claude-opus-4-7"`), the sentinel from
 * `parseInitSystemMessage` — to the corresponding product-blessed
 * `AdvisorChoice`. Returns `null` only when the value is empty, sentinel-
 * but-unknown-family, or a string from a different family (e.g. Haiku).
 *
 * The picker uses this to mark the right row as "current" when the user's
 * actual `advisorModel` isn't a verbatim match for our three options.
 * Without it, a user with `advisorModel: "opus"` would see the
 * "advisor: opus" badge on the closed card AND "No advisor" checked
 * inside the picker — the exact contradiction the user reported.
 */
export function advisorFamily(raw: unknown): AdvisorChoice {
  if (typeof raw !== "string" || raw.length === 0) return null;
  // Exact product-blessed ids — the cheapest match.
  if (raw === ADVISOR_OPUS_VALUE) return ADVISOR_OPUS_VALUE;
  if (raw === ADVISOR_SONNET_VALUE) return ADVISOR_SONNET_VALUE;
  if (raw === ADVISOR_FABLE_VALUE) return ADVISOR_FABLE_VALUE;
  // The sentinel means "advisor is on but we don't know which family" —
  // intentionally returns null so no row gets a stale check; the badge
  // is the surface that should communicate the on-but-unknown state.
  if (raw === ADVISOR_ACTIVE_SENTINEL) return null;
  // Strip the `claude-` prefix once and lowercase so `claude-opus-4-7`,
  // `claude-Opus-4`, `opus`, `OPUS` all collapse to the same family
  // bucket. We test the *raw* family token at the start of the string
  // (an id like `claude-opus-…` has `opus` right after the prefix).
  const lower = raw.toLowerCase().replace(/^claude-/, "");
  if (lower === "opus" || lower.startsWith("opus-") || lower.startsWith("opus.")) {
    return ADVISOR_OPUS_VALUE;
  }
  if (lower === "sonnet" || lower.startsWith("sonnet-") || lower.startsWith("sonnet.")) {
    return ADVISOR_SONNET_VALUE;
  }
  if (lower === "fable" || lower.startsWith("fable-") || lower.startsWith("fable.")) {
    return ADVISOR_FABLE_VALUE;
  }
  // Different family (haiku, custom plugin id, etc.) — render as "Custom"
  // in the picker rather than misleadingly checking an opus/sonnet row.
  return null;
}

/**
 * `true` when the value is a configured advisor that *isn't* one of the
 * recognized opus/sonnet families. Drives the "Custom: <value>" row in
 * the picker — same shape the global Settings page already uses for
 * hand-edited overrides.
 */
export function isCustomAdvisor(raw: unknown): boolean {
  if (typeof raw !== "string" || raw.length === 0) return false;
  if (raw === ADVISOR_ACTIVE_SENTINEL) return false;
  return advisorFamily(raw) === null;
}

/** Short label suitable for a compact pill / badge (e.g. "opus", "sonnet"). */
export function shortAdvisorLabel(value: AdvisorChoice): string | null {
  if (value === ADVISOR_OPUS_VALUE) return "opus";
  if (value === ADVISOR_SONNET_VALUE) return "sonnet";
  if (value === ADVISOR_FABLE_VALUE) return "fable";
  return null;
}

/**
 * Sentinel that use-session.ts writes into the `advisorModel` state when
 * the SDK reports the advisor tool is registered but we don't yet know
 * the actual model id (the init message doesn't carry it). Treated as a
 * "yes, on, but unspecified" signal by the badge — never sent over the
 * wire to the POST endpoint (the picker only emits real model ids).
 */
export const ADVISOR_ACTIVE_SENTINEL = "(active)";

/**
 * Short, human-readable badge text for *any* advisor model value — the
 * three known options get the curated label ("opus" / "sonnet"); the
 * `ADVISOR_ACTIVE_SENTINEL` collapses to "on" (we know it's enabled but
 * not which model); a string we don't recognize (a model alias like
 * `"opus"` itself, an older full id like `"claude-opus-4-7"`, or a
 * hand-edited custom value) gets a best-effort short form: strip the
 * `claude-` prefix, drop a trailing 8-digit date stamp, and truncate to
 * something pill-sized.
 *
 * This is what the SessionCard's badge renders. It is intentionally
 * stricter than `shortAdvisorLabel` (which returns `null` for unknown
 * values) — the user has the advisor on and deserves to see it, even if
 * the exact id wasn't one of the three product-blessed options. Returns
 * `null` only when the value is empty / null / not a string.
 */
export function badgeAdvisorLabel(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  if (raw === ADVISOR_ACTIVE_SENTINEL) return "on";
  if (raw === ADVISOR_OPUS_VALUE) return "opus";
  if (raw === ADVISOR_SONNET_VALUE) return "sonnet";
  if (raw === ADVISOR_FABLE_VALUE) return "fable";
  // Best-effort compact form for any other string: matches the
  // `shortModel()` helper in SessionCard.tsx so the advisor pill reads
  // the same way as the main model row above it.
  const short = raw.replace(/^claude-/, "").replace(/-\d{8}$/, "");
  // Keep the badge from blowing up if someone sets a 60-char custom id.
  return short.length > 16 ? `${short.slice(0, 14)}…` : short;
}
