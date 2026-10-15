import { CronExpressionParser } from "cron-parser";
import cronstrue from "cronstrue";

export type ParseResult =
  | { ok: true; cron: string }
  | { ok: false; error: string };

export function validateCron(input: string): ParseResult {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, error: "cron expression is required" };
  // Reject 6-field (seconds) input cleanly — we only support 5-field.
  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) {
    return { ok: false, error: `expected 5 fields, got ${parts.length}` };
  }
  try {
    CronExpressionParser.parse(trimmed);
    return { ok: true, cron: trimmed };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function describeCron(cron: string): string {
  try {
    return cronstrue.toString(cron, { use24HourTimeFormat: false });
  } catch {
    return "invalid expression";
  }
}

export function nextFires(cron: string, count = 5, from: Date = new Date()): Date[] {
  try {
    const it = CronExpressionParser.parse(cron, { currentDate: from });
    const out: Date[] = [];
    for (let i = 0; i < count; i++) {
      const d = it.next();
      out.push(d.toDate());
    }
    return out;
  } catch {
    return [];
  }
}

export function nextFireMs(cron: string, from: Date = new Date()): number | null {
  const arr = nextFires(cron, 1, from);
  if (arr.length === 0) return null;
  return arr[0].getTime();
}

/** A last fire older than this no longer anchors the next one (daily + slack). */
export const FIRE_ANCHOR_MAX_AGE_MS = 25 * 60 * 60 * 1000;
/**
 * A slot this close after the anchor is the slot that fire served: the
 * scheduler starts a run up to 250ms ahead of its slot, so without this a
 * fast run would re-arm onto the very slot it just ran for.
 */
const ANCHOR_SLOT_TOLERANCE_MS = 1_000;
/** Bound on slots stepped from the anchor (every-minute cron over 25h ≈ 1500). */
const MAX_ANCHOR_STEPS = 5_000;

/**
 * CC 2.1.299 parity — "Fixed scheduled tasks and loops firing again after
 * every turn, or firing early, during the repeated hour when daylight saving
 * time ends". The next fire time for a job that last fired at `anchorMs`.
 *
 * `nextFireMs(cron)` computed from *now* has no memory of the last fire, and
 * cron-parser resolves a fixed wall-clock time against the *current* offset:
 * with TZ=America/New_York, `30 1 * * *` fires at 05:30Z (01:30 EDT), and a
 * re-arm at 06:15Z (01:15 EST, inside the repeated hour) lands on 06:30Z
 * (01:30 EST) — the same wall-clock minute again, an hour later.
 *
 * Instead we step cron-parser's iterator forward from the last fire until a
 * slot is past `nowMs`. Iterating continuously, cron-parser keeps the
 * classic (Vixie) cron semantics across the fall-back:
 *  - a fixed-hour schedule (`30 1 * * *`, `*\/30 1 * * *`) fires only in the
 *    first copy of the repeated hour — once per local wall-clock time;
 *  - a wildcard-hour schedule (`0 * * * *`, `*\/15 * * * *`) keeps firing on
 *    elapsed time through both copies (hourly fires at 01:00 EDT *and*
 *    01:00 EST — they're an hour apart, so neither is early or a repeat).
 * Outside a DST transition the slots are the same instants either way, so
 * this returns exactly what `nextFireMs(cron, now)` would.
 *
 * No anchor (never fired), a stale one (> FIRE_ANCHOR_MAX_AGE_MS) or one in
 * the future (clock moved back) falls back to stepping from now. `tz` is for
 * tests; the scheduler resolves cron in the server's local timezone.
 */
export function nextFireAfter(
  cron: string,
  anchorMs: number | null | undefined,
  nowMs: number = Date.now(),
  tz?: string,
): number | null {
  const anchored =
    typeof anchorMs === "number" &&
    Number.isFinite(anchorMs) &&
    anchorMs <= nowMs &&
    nowMs - anchorMs < FIRE_ANCHOR_MAX_AGE_MS;
  const start = anchored ? anchorMs : nowMs;
  try {
    const it = CronExpressionParser.parse(cron, {
      currentDate: new Date(start),
      ...(tz ? { tz } : {}),
    });
    let prev = -Infinity;
    for (let i = 0; i < MAX_ANCHOR_STEPS; i++) {
      const t = it.next().getTime();
      // cron-parser can stall, handing back the same slot on every call
      // (seen around Australia/Lord_Howe's 30-minute DST shift) — each call
      // slow, so spinning to MAX_ANCHOR_STEPS would wedge the event loop.
      if (t <= prev) break;
      prev = t;
      if (t <= nowMs) continue;
      if (anchored && t - anchorMs < ANCHOR_SLOT_TOLERANCE_MS) continue;
      return t;
    }
  } catch {
    return null;
  }
  // A stalled iterator (above), or — unreachable for any real 5-field cron
  // within the anchor window — running out of steps; stay safe.
  return nextFireMs(cron, new Date(nowMs));
}

export const CRON_PRESETS: { label: string; cron: string }[] = [
  { label: "Every 5 min", cron: "*/5 * * * *" },
  { label: "Every 15 min", cron: "*/15 * * * *" },
  { label: "Hourly", cron: "0 * * * *" },
  { label: "Daily 9 AM", cron: "0 9 * * *" },
  { label: "Weekdays 9 AM", cron: "0 9 * * 1-5" },
  { label: "Mondays 9 AM", cron: "0 9 * * 1" },
];
