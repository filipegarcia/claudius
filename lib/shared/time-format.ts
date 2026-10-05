/**
 * CC 2.1.257 (F4) — the `timeFormat` / `timeZone` settings drive Claudius's
 * own clocks (message-bubble timestamps and the StatusLine turn-completion
 * clock), not just the bundled CLI's TUI.
 *
 * This module resolves those two string settings into the subset of
 * `Intl.DateTimeFormat` options the clocks apply. Pure + dependency-free so
 * the mapping and the time-zone validation are unit-testable in the node env.
 */

/** The `Intl.DateTimeFormat` overrides a resolved time setting contributes. */
export type ClockOptions = {
  /**
   * Explicit hour cycle. We use `hourCycle` rather than `hour12` on purpose:
   * `hour12: false` resolves to `h23` *or* `h24` depending on engine/locale,
   * so midnight can render as `24:05`. `h23` pins "00–23"; `h12` pins the
   * 12-hour clock. (`hour12` would also override `hourCycle` if both were set,
   * so only one is ever present.)
   */
  hourCycle?: "h12" | "h23";
  /** IANA time zone, e.g. "UTC" or "Europe/Dublin". Validated before it's set. */
  timeZone?: string;
};

/**
 * True when `tz` is a time zone `Intl.DateTimeFormat` accepts. `settings.json`
 * is hand-editable, so an unknown name must be rejected here — otherwise it
 * reaches `new Intl.DateTimeFormat(...)` at render time and throws a
 * `RangeError` that crashes every timestamp.
 */
export function isValidTimeZone(tz: string): boolean {
  try {
    // Constructing with the zone is the probe; a bad name throws RangeError.
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Map `timeFormat` + `timeZone` to the clock overrides.
 *
 * - `"12-hour"` → `hourCycle: "h12"`
 * - `"24-hour"` → `hourCycle: "h23"`
 * - `"24-hour-utc"` → `hourCycle: "h23"` + `timeZone: "UTC"`
 * - `"auto"` / unset / a strftime pattern (contains `%`) → no hour-cycle
 *   override (follow the locale). A strftime pattern can't be reproduced with
 *   `Intl`, so only the hour cycle falls back to auto — an explicit `timeZone`
 *   is still honored.
 *
 * An explicit `timeZone` applies in every case except `"24-hour-utc"` (which
 * already forces UTC). Invalid zone names are dropped (treated as unset).
 * Returns an empty object when nothing applies — callers then take the
 * locale-default singleton path, byte-identical to the pre-F4 behavior.
 */
export function resolveClockOptions(timeFormat?: string, timeZone?: string): ClockOptions {
  const out: ClockOptions = {};
  switch (timeFormat) {
    case "12-hour":
      out.hourCycle = "h12";
      break;
    case "24-hour":
      out.hourCycle = "h23";
      break;
    case "24-hour-utc":
      out.hourCycle = "h23";
      out.timeZone = "UTC";
      break;
    // "auto", undefined, and strftime patterns: no hour-cycle override.
  }
  if (!out.timeZone && typeof timeZone === "string" && timeZone.trim() !== "") {
    const tz = timeZone.trim();
    if (isValidTimeZone(tz)) out.timeZone = tz;
  }
  return out;
}
