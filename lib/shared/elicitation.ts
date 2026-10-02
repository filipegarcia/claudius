/**
 * Helpers for MCP elicitation (`mcp_elicitation_request`) — shared by the
 * browser prompt and the `/elicitation` route.
 *
 * Everything an elicitation carries is authored by an MCP server, so it is
 * untrusted input: the URL is only ever made clickable after an http(s)
 * scheme check, and the form schema is reduced to the flat primitive subset
 * the MCP spec allows (string / number / integer / boolean / enum / multi-
 * select enum). Anything else is ignored rather than rendered.
 */
import type { ElicitationContent, ElicitationDecision } from "./events";

/** Max fields / options we render, and max value length we send back. */
const MAX_FIELDS = 50;
const MAX_OPTIONS = 200;
const MAX_VALUE_CHARS = 10_000;
/** Keys that would hit `Object.prototype` machinery on a plain-object write. */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * The URL of a `url`-mode elicitation as a parsed URL, or null when it isn't
 * http(s). Never link a `javascript:`/`data:`/`file:` URL an MCP server sent.
 */
export function safeElicitationUrl(raw: string | undefined): URL | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:" ? u : null;
  } catch {
    return null;
  }
}

export type ElicitationOption = { value: string; label: string };

export type ElicitationField =
  | { key: string; label: string; description?: string; required: boolean; kind: "string"; format?: string; minLength?: number; maxLength?: number; default?: string }
  | { key: string; label: string; description?: string; required: boolean; kind: "number"; integer: boolean; minimum?: number; maximum?: number; default?: number }
  | { key: string; label: string; description?: string; required: boolean; kind: "boolean"; default?: boolean }
  | { key: string; label: string; description?: string; required: boolean; kind: "enum"; options: ElicitationOption[]; default?: string }
  | { key: string; label: string; description?: string; required: boolean; kind: "multi-enum"; options: ElicitationOption[]; minItems?: number; maxItems?: number; default?: string[] };

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

/** `enum` (+ legacy `enumNames`) or `oneOf`/`anyOf` of `{ const, title }`. */
function readOptions(def: Record<string, unknown>): ElicitationOption[] | null {
  if (Array.isArray(def.enum)) {
    const names = Array.isArray(def.enumNames) ? def.enumNames : [];
    const out = def.enum
      .map((v, i) =>
        typeof v === "string" ? { value: v, label: typeof names[i] === "string" ? (names[i] as string) : v } : null,
      )
      .filter((o): o is ElicitationOption => !!o);
    return out.slice(0, MAX_OPTIONS);
  }
  const variants = Array.isArray(def.oneOf) ? def.oneOf : Array.isArray(def.anyOf) ? def.anyOf : null;
  if (variants) {
    const out = variants
      .map((v) =>
        isRecord(v) && typeof v.const === "string"
          ? { value: v.const, label: typeof v.title === "string" && v.title ? v.title : v.const }
          : null,
      )
      .filter((o): o is ElicitationOption => !!o);
    return out.slice(0, MAX_OPTIONS);
  }
  return null;
}

/**
 * Flatten a form-mode `requestedSchema` into renderable fields, in property
 * order. Unsupported property shapes are skipped.
 */
export function parseElicitationSchema(schema: Record<string, unknown> | undefined): ElicitationField[] {
  if (!isRecord(schema) || !isRecord(schema.properties)) return [];
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((r) => typeof r === "string") : []);
  const fields: ElicitationField[] = [];
  for (const [key, def] of Object.entries(schema.properties)) {
    if (fields.length >= MAX_FIELDS) break;
    if (UNSAFE_KEYS.has(key) || !isRecord(def)) continue;
    const base = {
      key,
      label: str(def.title) ?? key,
      ...(str(def.description) ? { description: str(def.description) } : {}),
      required: required.has(key),
    };
    if (def.type === "array") {
      const items = isRecord(def.items) ? def.items : null;
      const options = items ? readOptions(items) : null;
      if (!options || options.length === 0) continue;
      const dflt = Array.isArray(def.default) ? def.default.filter((d): d is string => typeof d === "string") : undefined;
      fields.push({
        ...base,
        kind: "multi-enum",
        options,
        ...(num(def.minItems) !== undefined ? { minItems: num(def.minItems) } : {}),
        ...(num(def.maxItems) !== undefined ? { maxItems: num(def.maxItems) } : {}),
        ...(dflt ? { default: dflt } : {}),
      });
      continue;
    }
    const options = readOptions(def);
    if (options && options.length > 0) {
      fields.push({ ...base, kind: "enum", options, ...(str(def.default) ? { default: str(def.default) } : {}) });
      continue;
    }
    if (def.type === "string") {
      fields.push({
        ...base,
        kind: "string",
        ...(str(def.format) ? { format: str(def.format) } : {}),
        ...(num(def.minLength) !== undefined ? { minLength: num(def.minLength) } : {}),
        ...(num(def.maxLength) !== undefined ? { maxLength: num(def.maxLength) } : {}),
        ...(typeof def.default === "string" ? { default: def.default } : {}),
      });
    } else if (def.type === "number" || def.type === "integer") {
      fields.push({
        ...base,
        kind: "number",
        integer: def.type === "integer",
        ...(num(def.minimum) !== undefined ? { minimum: num(def.minimum) } : {}),
        ...(num(def.maximum) !== undefined ? { maximum: num(def.maximum) } : {}),
        ...(num(def.default) !== undefined ? { default: num(def.default) } : {}),
      });
    } else if (def.type === "boolean") {
      fields.push({ ...base, kind: "boolean", ...(typeof def.default === "boolean" ? { default: def.default } : {}) });
    }
  }
  return fields;
}

/** Raw form state: text inputs hold strings, checkboxes booleans, multi-selects arrays. */
export type ElicitationFormValues = Record<string, string | boolean | string[]>;

export function initialFormValues(fields: ElicitationField[]): ElicitationFormValues {
  const out: ElicitationFormValues = {};
  for (const f of fields) {
    if (f.kind === "boolean") out[f.key] = f.default ?? false;
    else if (f.kind === "multi-enum") out[f.key] = f.default ?? [];
    else if (f.kind === "number") out[f.key] = f.default !== undefined ? String(f.default) : "";
    else out[f.key] = f.default ?? "";
  }
  return out;
}

/**
 * Validate form state against the fields and build the `content` to send.
 * Returns per-field error messages instead when anything is invalid.
 */
export function buildElicitationContent(
  fields: ElicitationField[],
  values: ElicitationFormValues,
): { ok: true; content: ElicitationContent } | { ok: false; errors: Record<string, string> } {
  const content: ElicitationContent = {};
  const errors: Record<string, string> = {};
  for (const f of fields) {
    const v = values[f.key];
    if (f.kind === "boolean") {
      content[f.key] = v === true;
      continue;
    }
    if (f.kind === "multi-enum") {
      const picked = Array.isArray(v) ? v.filter((x) => f.options.some((o) => o.value === x)) : [];
      if (f.required && picked.length === 0) errors[f.key] = "Pick at least one";
      else if (f.minItems !== undefined && picked.length > 0 && picked.length < f.minItems) errors[f.key] = `Pick at least ${f.minItems}`;
      else if (f.maxItems !== undefined && picked.length > f.maxItems) errors[f.key] = `Pick at most ${f.maxItems}`;
      if (picked.length > 0) content[f.key] = picked;
      continue;
    }
    const text = typeof v === "string" ? v.trim() : "";
    if (!text) {
      if (f.required) errors[f.key] = "Required";
      continue;
    }
    if (f.kind === "number") {
      const n = Number(text);
      if (!Number.isFinite(n)) errors[f.key] = "Enter a number";
      else if (f.integer && !Number.isInteger(n)) errors[f.key] = "Enter a whole number";
      else if (f.minimum !== undefined && n < f.minimum) errors[f.key] = `Must be at least ${f.minimum}`;
      else if (f.maximum !== undefined && n > f.maximum) errors[f.key] = `Must be at most ${f.maximum}`;
      else content[f.key] = n;
      continue;
    }
    if (f.kind === "enum") {
      if (!f.options.some((o) => o.value === text)) errors[f.key] = "Pick an option";
      else content[f.key] = text;
      continue;
    }
    if (f.minLength !== undefined && text.length < f.minLength) errors[f.key] = `At least ${f.minLength} characters`;
    else if (f.maxLength !== undefined && text.length > f.maxLength) errors[f.key] = `At most ${f.maxLength} characters`;
    else content[f.key] = text.slice(0, MAX_VALUE_CHARS);
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, content };
}

/**
 * Narrow an untrusted request body to an `ElicitationDecision`, or null.
 * Content values must be the MCP primitives (string / finite number /
 * boolean / string[]); anything else rejects the whole decision.
 */
export function parseElicitationDecision(raw: unknown): ElicitationDecision | null {
  if (!isRecord(raw)) return null;
  if (raw.action === "decline" || raw.action === "cancel") return { action: raw.action };
  if (raw.action !== "accept") return null;
  if (raw.content === undefined) return { action: "accept" };
  if (!isRecord(raw.content)) return null;
  const entries = Object.entries(raw.content);
  if (entries.length > MAX_FIELDS) return null;
  const content: ElicitationContent = {};
  for (const [k, v] of entries) {
    if (UNSAFE_KEYS.has(k)) return null;
    if (typeof v === "string") {
      if (v.length > MAX_VALUE_CHARS) return null;
      content[k] = v;
    } else if (typeof v === "boolean") {
      content[k] = v;
    } else if (typeof v === "number") {
      if (!Number.isFinite(v)) return null;
      content[k] = v;
    } else if (Array.isArray(v)) {
      if (v.length > MAX_OPTIONS || !v.every((x) => typeof x === "string" && x.length <= MAX_VALUE_CHARS)) return null;
      content[k] = v as string[];
    } else {
      return null;
    }
  }
  return { action: "accept", content };
}
