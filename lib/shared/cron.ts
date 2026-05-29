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

export const CRON_PRESETS: { label: string; cron: string }[] = [
  { label: "Every 5 min", cron: "*/5 * * * *" },
  { label: "Every 15 min", cron: "*/15 * * * *" },
  { label: "Hourly", cron: "0 * * * *" },
  { label: "Daily 9 AM", cron: "0 9 * * *" },
  { label: "Weekdays 9 AM", cron: "0 9 * * 1-5" },
  { label: "Mondays 9 AM", cron: "0 9 * * 1" },
];
