/**
 * CC 2.1.288 (F8) — per-model `autoCompactWindow` overrides. `/autocompact`
 * saves the chosen window under `modelSettings.<model>.autoCompactWindow`
 * (`'auto' | number`), which *replaces* the top-level `autoCompactWindow` for
 * that model. The Settings "Context & compaction" section surfaces these so
 * editing the top-level value isn't a silent no-op for a model the user has
 * already run `/autocompact` on.
 *
 * `modelSettings.<model>` also carries `effortLevel` / `maxEffortLevel`, so the
 * write helpers merge into the model's object and prune empties rather than
 * replacing it. Pure + dependency-free so the merge/parse logic is unit-tested.
 */

/** The documented per-model window range, in tokens. */
export const AUTO_COMPACT_WINDOW_MIN = 100_000;
export const AUTO_COMPACT_WINDOW_MAX = 1_000_000;

export type PerModelAutoCompact = { model: string; window: unknown };

/** The outcome of parsing a free-text window input. */
export type ParsedAutoCompactWindow =
  | { kind: "remove" } // empty → delete the override
  | { kind: "set"; value: "auto" | number }
  | { kind: "ignore" }; // invalid keystroke → leave the stored value untouched

/**
 * Parse a window input: blank removes the override, `"auto"` (any case) is the
 * model-tuned window, a finite number is a token count, and anything else is
 * ignored (so a transient invalid keystroke doesn't wipe the stored value).
 */
export function parseAutoCompactWindowInput(raw: string): ParsedAutoCompactWindow {
  const t = raw.trim();
  if (t === "") return { kind: "remove" };
  if (/^auto$/i.test(t)) return { kind: "set", value: "auto" };
  const n = Number(t);
  if (Number.isFinite(n)) return { kind: "set", value: n };
  return { kind: "ignore" };
}

/** True when a numeric window is outside the documented 100k–1M range. */
export function isAutoCompactWindowOutOfRange(value: unknown): boolean {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    (value < AUTO_COMPACT_WINDOW_MIN || value > AUTO_COMPACT_WINDOW_MAX)
  );
}

/** List the per-model `autoCompactWindow` overrides present in `modelSettings`. */
export function readPerModelAutoCompact(modelSettings: unknown): PerModelAutoCompact[] {
  if (!modelSettings || typeof modelSettings !== "object") return [];
  const out: PerModelAutoCompact[] = [];
  for (const [model, v] of Object.entries(modelSettings as Record<string, unknown>)) {
    if (v && typeof v === "object" && "autoCompactWindow" in (v as object)) {
      out.push({ model, window: (v as Record<string, unknown>).autoCompactWindow });
    }
  }
  return out;
}

/**
 * Return the next `modelSettings` after setting (or, with `value === undefined`,
 * removing) one model's `autoCompactWindow`. The model's other per-model fields
 * (`effortLevel` / `maxEffortLevel`) are preserved; a model object left empty is
 * dropped, and an empty map returns `undefined` so the key disappears from
 * settings.json entirely.
 */
export function setModelAutoCompactWindow(
  modelSettings: unknown,
  model: string,
  value: "auto" | number | undefined,
): Record<string, unknown> | undefined {
  const base =
    modelSettings && typeof modelSettings === "object"
      ? (modelSettings as Record<string, unknown>)
      : {};
  const next: Record<string, unknown> = { ...base };
  const existing = next[model];
  const modelObj: Record<string, unknown> =
    existing && typeof existing === "object" ? { ...(existing as Record<string, unknown>) } : {};
  if (value === undefined) {
    delete modelObj.autoCompactWindow;
  } else {
    modelObj.autoCompactWindow = value;
  }
  if (Object.keys(modelObj).length === 0) {
    delete next[model];
  } else {
    next[model] = modelObj;
  }
  return Object.keys(next).length === 0 ? undefined : next;
}
