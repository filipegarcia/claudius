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
 *
 * CC 2.1.304 — like `/autocompact` and (now) `CLAUDE_CODE_AUTO_COMPACT_WINDOW`,
 * a `k` or `M` suffix (any case) scales the number: `200k` → 200,000 and
 * `1M` / `1.5m` → 1,000,000 / 1,500,000. Before this, `200k` was silently
 * dropped here. Pass `allowAuto: false` for fields that only take a number
 * (the top-level `autoCompactWindow`), so `auto` there is ignored, not saved.
 */
export function parseAutoCompactWindowInput(
  raw: string,
  { allowAuto = true }: { allowAuto?: boolean } = {},
): ParsedAutoCompactWindow {
  const t = raw.trim();
  if (t === "") return { kind: "remove" };
  if (/^auto$/i.test(t)) return allowAuto ? { kind: "set", value: "auto" } : { kind: "ignore" };
  const suffixed = /^(\d+(?:\.\d+)?|\.\d+)\s*([kKmM])$/.exec(t);
  if (suffixed) {
    const scale = suffixed[2].toLowerCase() === "k" ? 1_000 : 1_000_000;
    return { kind: "set", value: Math.round(Number(suffixed[1]) * scale) };
  }
  const n = Number(t);
  if (Number.isFinite(n)) return { kind: "set", value: n };
  return { kind: "ignore" };
}

/**
 * The warning to show under a window input as the user types, mirroring CC
 * 2.1.304's "warns when a value is out of range or ignored":
 * - `"ignored"` — the text doesn't parse, so the stored value is left as is;
 * - `"out-of-range"` — it parses to a token count outside 100k–1M;
 * - `null` — blank, `auto`, or an in-range count.
 */
export function autoCompactWindowInputWarning(
  raw: string,
  opts: { allowAuto?: boolean } = {},
): "ignored" | "out-of-range" | null {
  const parsed = parseAutoCompactWindowInput(raw, opts);
  if (parsed.kind === "ignore") return "ignored";
  if (parsed.kind === "set" && isAutoCompactWindowOutOfRange(parsed.value)) return "out-of-range";
  return null;
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
