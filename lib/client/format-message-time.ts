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

export type FormattedMessageTime = {
  /** Compact label rendered in the bubble. */
  short: string;
  /** Full date+time used for `title` / `aria-label`. */
  full: string;
};

const SHORT_FMT = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
});

const SHORT_WITH_DATE_FMT = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

const FULL_FMT = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

export function formatMessageTime(at: number | undefined): FormattedMessageTime | null {
  if (typeof at !== "number" || !Number.isFinite(at)) return null;
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const short = sameDay ? SHORT_FMT.format(d) : SHORT_WITH_DATE_FMT.format(d);
  const full = FULL_FMT.format(d);
  return { short, full };
}
