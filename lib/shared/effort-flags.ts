/**
 * CC 2.1.284 — Ultracode is an independent toggle that stays on at any effort.
 * The SDK's `applyFlagSettings` contract: an `effortLevel` sent WITHOUT an
 * `ultracode` key turns ultracode off; to change the level AND keep ultracode
 * on you must send both keys. This builds that payload so an effort change
 * preserves ultracode instead of silently clearing it.
 *
 * `level: "auto"` clears the effort override (null). `ultracode` is included
 * only when it's currently on — when off, omitting it is the correct no-op
 * (the SDK leaves an already-off toggle off).
 */
export type EffortFlagLevel = "low" | "medium" | "high" | "xhigh" | "max" | "auto";

export type EffortFlagSettings = {
  effortLevel: Exclude<EffortFlagLevel, "auto"> | null;
  ultracode?: boolean;
};

export function buildEffortFlagSettings(level: EffortFlagLevel, ultracode: boolean): EffortFlagSettings {
  const effortLevel = level === "auto" ? null : level;
  return ultracode ? { effortLevel, ultracode: true } : { effortLevel };
}

const EFFORT_LEVELS = new Set<EffortFlagLevel>(["low", "medium", "high", "xhigh", "max", "auto"]);

/**
 * CC 2.1.284 — parse a typed `/effort` command's args. Claude Code handles
 * `/effort <level>`, `/effort ultracode on|off`, and bare `/effort` (show
 * current). Previously Claudius forwarded `/effort` to the SDK, which rejects
 * it, so `/effort ultracode on` couldn't work. Pure, for unit tests; the
 * caller runs the resulting action and renders the toast.
 */
export type EffortCommand =
  // CC 2.1.257 — a trailing `s`/`session` sets the level for THIS SESSION ONLY
  // (not persisted to userSettings). Default `/effort <level>` still persists.
  | { kind: "level"; level: EffortFlagLevel; sessionOnly: boolean }
  | { kind: "ultracode"; on: boolean }
  | { kind: "show" }
  | { kind: "invalid"; message: string };

const EFFORT_USAGE =
  "Usage: /effort <low|medium|high|xhigh|max|auto> [s] or /effort ultracode on|off";

export function parseEffortArgs(args: string): EffortCommand {
  const a = args.trim().toLowerCase();
  if (!a) return { kind: "show" };
  const parts = a.split(/\s+/);
  if (parts[0] === "ultracode") {
    if (parts[1] === "on" || parts[1] === "off") return { kind: "ultracode", on: parts[1] === "on" };
    return { kind: "invalid", message: "Usage: /effort ultracode on|off" };
  }
  if (EFFORT_LEVELS.has(parts[0] as EffortFlagLevel)) {
    // Optional session-only modifier: `/effort high s` or `/effort high session`.
    if (parts.length === 1) return { kind: "level", level: parts[0] as EffortFlagLevel, sessionOnly: false };
    if (parts.length === 2 && (parts[1] === "s" || parts[1] === "session")) {
      return { kind: "level", level: parts[0] as EffortFlagLevel, sessionOnly: true };
    }
  }
  return { kind: "invalid", message: EFFORT_USAGE };
}
