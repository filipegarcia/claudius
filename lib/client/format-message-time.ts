// Time formatting for chat bubbles.
//
// Returns two strings:
//   - `short` — what's rendered in the bubble (kept small: HH:MM for today,
//     `MMM D HH:MM` for older). The chat is the user's primary context, so
//     the value should be skimmable rather than precise.
//   - `full`  — the long-form label used as the `title` (native tooltip) and
//     as the `aria-label`. Always carries the date so a hover reveals the
//     calendar context the short form drops.
//
// Designed to be cheap (no Intl allocation in the hot path) and resilient:
// non-finite / undefined inputs return `null` so callers can branch on
// "stamp present?" without first inspecting `message.createdAt` themselves.
//
// CC 2.1.257 (F4): an optional `ClockOptions` (resolved from `timeFormat` /
// `timeZone`) overrides the hour cycle and time zone. The default (empty)
// call keeps the locale-default singletons and is byte-identical to before.

import type { ClockOptions } from "@/lib/shared/time-format";

export type FormattedMessageTime = {
  /** Compact label rendered in the bubble. */
  short: string;
  /** Like `short` but with seconds appended — used at ultra-verbose. */
  shortWithSeconds: string;
  /** Full date+time used for `title` / `aria-label`. */
  full: string;
};

type FormatterBundle = {
  short: Intl.DateTimeFormat;
  shortWithSeconds: Intl.DateTimeFormat;
  shortWithDate: Intl.DateTimeFormat;
  shortWithDateAndSeconds: Intl.DateTimeFormat;
  full: Intl.DateTimeFormat;
};

function buildBundle(opts: ClockOptions): FormatterBundle {
  const { hourCycle, timeZone } = opts;
  const tz = timeZone ? { timeZone } : {};
  const hc = hourCycle ? { hourCycle } : {};
  return {
    short: new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", ...hc, ...tz }),
    shortWithSeconds: new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      ...hc,
      ...tz,
    }),
    shortWithDate: new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      ...hc,
      ...tz,
    }),
    shortWithDateAndSeconds: new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      ...hc,
      ...tz,
    }),
    full: new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      ...hc,
      ...tz,
    }),
  };
}

// The locale-default bundle (no overrides) is the hot path — kept as a module
// singleton exactly as before. Non-default bundles are built once per distinct
// (hourCycle, timeZone) pair and cached, so repeated bubble renders stay cheap.
const DEFAULT_BUNDLE = buildBundle({});
const bundleCache = new Map<string, FormatterBundle>();

function bundleFor(opts: ClockOptions): FormatterBundle {
  const key = `${opts.hourCycle ?? ""}|${opts.timeZone ?? ""}`;
  if (key === "|") return DEFAULT_BUNDLE;
  let bundle = bundleCache.get(key);
  if (!bundle) {
    bundle = buildBundle(opts);
    bundleCache.set(key, bundle);
  }
  return bundle;
}

// "Same calendar day?" — compared in the *target* zone so a UTC override
// doesn't label a late-evening-local message with the next day's wall clock
// and no date. With no zone override we keep the original local comparison
// (byte-identical default behavior).
const DAY_KEY_FMT = new Map<string, Intl.DateTimeFormat>();
function dayKey(d: Date, timeZone: string): string {
  let fmt = DAY_KEY_FMT.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    DAY_KEY_FMT.set(timeZone, fmt);
  }
  return fmt.format(d);
}

function isSameDay(d: Date, now: Date, timeZone?: string): boolean {
  if (timeZone) return dayKey(d, timeZone) === dayKey(now, timeZone);
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

export function formatMessageTime(
  at: number | undefined,
  opts: ClockOptions = {},
): FormattedMessageTime | null {
  if (typeof at !== "number" || !Number.isFinite(at)) return null;
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  const sameDay = isSameDay(d, now, opts.timeZone);
  const b = bundleFor(opts);
  const short = sameDay ? b.short.format(d) : b.shortWithDate.format(d);
  const shortWithSeconds = sameDay
    ? b.shortWithSeconds.format(d)
    : b.shortWithDateAndSeconds.format(d);
  const full = b.full.format(d);
  return { short, shortWithSeconds, full };
}

/**
 * CC 2.1.257 (F4) — the StatusLine turn-completion clock ("done 9:05 PM").
 * Keeps its own `{ hour: "numeric", minute: "2-digit" }` shape (a `9:05 PM`
 * look, not the bubbles' 2-digit `09:05`) and layers the resolved clock
 * overrides on top. Returns `null` for a missing/invalid stamp.
 */
export function formatClockTime(at: number | undefined, opts: ClockOptions = {}): string | null {
  if (typeof at !== "number" || !Number.isFinite(at)) return null;
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return null;
  const { hourCycle, timeZone } = opts;
  return new Intl.DateTimeFormat([], {
    hour: "numeric",
    minute: "2-digit",
    ...(hourCycle ? { hourCycle } : {}),
    ...(timeZone ? { timeZone } : {}),
  }).format(d);
}
