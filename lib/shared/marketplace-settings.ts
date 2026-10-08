/**
 * CC 2.1.223/2.1.232/2.1.238 (G1) — the real `settings.json` marketplace
 * shapes, and safe (lossless, non-corrupting) operations over them.
 *
 * The SDK models these three keys richly:
 *   - `extraKnownMarketplaces`: an object map `{ [name]: { source: <Source> } }`
 *   - `strictKnownMarketplaces` / `blockedMarketplaces`: arrays of `<Source>`
 *     objects (enterprise policy, honored only from managed settings)
 *
 * where `<Source>` is a wide discriminated union keyed by `source`
 * (`url`, `github`, `git`, `npm`, `file`, `directory`, `skills-dir`,
 * `hostPattern`, `pathPattern`, `settings`, …) and a url/github source may
 * carry `headers` (auth tokens) and `headersHelper`.
 *
 * Claudius previously typed these as `string[]` / `boolean`, so it (a) read a
 * real object/array config as empty and (b) *overwrote* it with a string array
 * on save — corrupting settings.json. This module fixes both:
 *   - read returns a REDACTED view (header values never leave the server)
 *   - edits are STRUCTURAL ops against the raw stored value, so untouched
 *     entries — and any source kind this code doesn't recognize — survive
 *     byte-for-byte.
 *
 * Pure + dependency-free so every operation is unit-testable.
 */

import { lintMarketplaceName } from "./plugin-ref-lint";

/** A source object; kept loose because the SDK union is wide and extensible. */
export type MarketplaceSource = Record<string, unknown> & { source?: unknown };

/** Redacted, browser-safe view of one source — never carries header values. */
export type MarketplaceSourceView = {
  /** `source.source` (e.g. "github"), "legacy" for an old Claudius shape, or "unknown". */
  kind: string;
  /** A readable identifier (repo, url, package, path, …). */
  label: string;
  /** Header NAMES only — values are withheld (they're auth tokens). */
  headerKeys: string[];
  /** Whether a `headersHelper` command is configured (its text is withheld). */
  hasHeadersHelper: boolean;
  /** True when stored in a pre-G1 Claudius shape (bare string / boolean). */
  legacy?: boolean;
};

export type ExtraMarketplaceView = MarketplaceSourceView & {
  /** The map key — what `plugin@<name>` refs resolve against. */
  name: string;
};

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** The discriminant, or `null` when the value isn't a recognizable source. */
export function sourceKind(source: unknown): string | null {
  if (!isObject(source)) return null;
  return typeof source.source === "string" ? source.source : null;
}

/** A readable one-line identifier for a source, by kind. */
export function sourceLabel(source: unknown): string {
  if (!isObject(source)) return typeof source === "string" ? source : "";
  const s = source as Record<string, unknown>;
  const str = (k: string) => (typeof s[k] === "string" ? (s[k] as string) : "");
  switch (s.source) {
    case "url":
    case "git":
      return str("url");
    case "github": {
      const repo = str("repo");
      const ref = str("ref");
      return ref ? `${repo}@${ref}` : repo;
    }
    case "npm": {
      const pkg = str("package");
      const version = str("version");
      return version ? `${pkg}@${version}` : pkg;
    }
    case "file":
    case "directory":
      return str("path");
    case "hostPattern":
      return str("hostPattern");
    case "pathPattern":
      return str("pathPattern");
    case "settings":
      return str("name");
    case "skills-dir":
      return "skills-dir";
    default:
      return typeof s.source === "string" ? s.source : "";
  }
}

/** Redact a source into a browser-safe view (no header values / helper text). */
export function redactSource(source: unknown): MarketplaceSourceView {
  const kind = sourceKind(source);
  if (kind === null) {
    // A bare string (legacy Claudius) or something unexpected.
    return {
      kind: typeof source === "string" ? "legacy" : "unknown",
      label: typeof source === "string" ? source : "",
      headerKeys: [],
      hasHeadersHelper: false,
      ...(typeof source === "string" ? { legacy: true } : {}),
    };
  }
  const s = source as Record<string, unknown>;
  const headers = isObject(s.headers) ? Object.keys(s.headers) : [];
  return {
    kind,
    label: sourceLabel(source),
    headerKeys: headers,
    hasHeadersHelper: typeof s.headersHelper === "string" && s.headersHelper.length > 0,
  };
}

/**
 * Redacted view of `extraKnownMarketplaces`. Handles the real object map, a
 * legacy `string[]` (flagged), and anything else (→ empty).
 */
export function readExtraMarketplaces(raw: unknown): ExtraMarketplaceView[] {
  if (Array.isArray(raw)) {
    // Legacy Claudius shape — bare strings, no names. Surfaced so the user can
    // see and remove them (they can't be safely migrated to named entries).
    return raw
      .filter((x): x is string => typeof x === "string")
      .map((label) => ({ name: label, kind: "legacy", label, headerKeys: [], hasHeadersHelper: false, legacy: true }));
  }
  if (!isObject(raw)) return [];
  const out: ExtraMarketplaceView[] = [];
  for (const [name, entry] of Object.entries(raw)) {
    const source = isObject(entry) ? (entry as Record<string, unknown>).source : undefined;
    out.push({ name, ...redactSource(source) });
  }
  return out;
}

/**
 * Redacted view of a policy list (`strictKnownMarketplaces` /
 * `blockedMarketplaces`): the real array of source objects, or a legacy
 * boolean / `string[]` (flagged).
 */
export function readPolicyMarketplaces(raw: unknown): MarketplaceSourceView[] {
  if (Array.isArray(raw)) return raw.map((entry) => redactSource(entry));
  if (typeof raw === "boolean") {
    // Legacy Claudius `strictKnownMarketplaces: boolean`.
    return raw ? [{ kind: "legacy", label: "true", headerKeys: [], hasHeadersHelper: false, legacy: true }] : [];
  }
  return [];
}

/** True when `extraKnownMarketplaces` is stored in the legacy (array) shape. */
export function isLegacyExtra(raw: unknown): boolean {
  return Array.isArray(raw);
}

export type AddResult =
  | { ok: true; value: Record<string, { source: MarketplaceSource }> }
  | { ok: false; error: string };

/**
 * Validate a user-supplied source for `add-extra`. Only the two UI-addable
 * kinds are accepted here; richer kinds (headers, npm, patterns, …) are edited
 * directly in settings.json and preserved by the remove/add ops untouched.
 */
export function validateAddSource(source: unknown): { ok: true } | { ok: false; error: string } {
  const kind = sourceKind(source);
  if (kind === "github") {
    const repo = (source as Record<string, unknown>).repo;
    if (typeof repo !== "string" || !/^[^/\s]+\/[^/\s*]+$/.test(repo)) {
      return { ok: false, error: "GitHub source needs an owner/repo (no wildcard)." };
    }
    return { ok: true };
  }
  if (kind === "url") {
    const url = (source as Record<string, unknown>).url;
    if (typeof url !== "string" || !/^https?:\/\//.test(url)) {
      return { ok: false, error: "URL source needs an http(s) marketplace.json URL." };
    }
    return { ok: true };
  }
  return { ok: false, error: "Unsupported source kind for add; edit settings.json directly." };
}

/**
 * Add (or replace) one named entry in `extraKnownMarketplaces`, preserving
 * every other entry byte-for-byte. Refuses when the stored value is the legacy
 * array shape (names can't be reconstructed — the user removes those first).
 */
export function addExtraMarketplace(raw: unknown, name: string, source: MarketplaceSource): AddResult {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, error: "A marketplace name is required." };
  // CC 2.1.295 parity — refuse a name no plugin can be installed under (or a
  // reserved Anthropic name from a non-Anthropic source) instead of
  // "succeeding". Add path only; already-stored entries are left alone.
  const nameLint = lintMarketplaceName(trimmed, source);
  if (nameLint) return { ok: false, error: nameLint.message };
  if (isLegacyExtra(raw)) {
    return { ok: false, error: "Legacy string entries are present — remove them before adding named marketplaces." };
  }
  const valid = validateAddSource(source);
  if (!valid.ok) return valid;
  const base = isObject(raw) ? (raw as Record<string, { source: MarketplaceSource }>) : {};
  // Refuse to overwrite an existing entry — silently replacing it would drop
  // its `headers`/`headersHelper`/ref, the exact corruption G1 set out to fix.
  // `Object.hasOwn`, not `in` — `in` sees inherited keys, so a (valid) name
  // like "constructor" would be refused as "already exists".
  if (Object.hasOwn(base, trimmed)) {
    return { ok: false, error: `A marketplace named "${trimmed}" already exists — remove it first.` };
  }
  return { ok: true, value: { ...base, [trimmed]: { source } } };
}

/**
 * Remove one entry from `extraKnownMarketplaces` by name (object map) or by
 * value (legacy array). Returns the next value, or `undefined` when the
 * container is now empty (so the caller drops the key entirely).
 */
export function removeExtraMarketplace(
  raw: unknown,
  name: string,
): Record<string, unknown> | unknown[] | undefined {
  if (Array.isArray(raw)) {
    const next = raw.filter((x) => x !== name);
    return next.length ? next : undefined;
  }
  if (isObject(raw)) {
    const next = { ...(raw as Record<string, unknown>) };
    delete next[name];
    return Object.keys(next).length ? next : undefined;
  }
  return undefined;
}

/**
 * Remove the policy entry at `index` from a `strictKnownMarketplaces` /
 * `blockedMarketplaces` array (preserving the others). A legacy boolean/other
 * shape has no indexable entries, so any removal clears the key (→ undefined).
 */
export function removePolicyMarketplace(raw: unknown, index: number): unknown[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const next = raw.filter((_, i) => i !== index);
  return next.length ? next : undefined;
}
