/**
 * CC 2.1.326 parity — "Fixed `/clear --help` and other built-in commands
 * running at an idle prompt instead of showing usage; added `/help <command>`",
 * and "Fixed `/goal clear` … not sticking".
 *
 * Claudius dispatches its own (`native` / `external`) commands in
 * `ChatSurface.handleSend`, which used to run them whatever the arguments:
 * `/clear --help` cleared the session and `/rename --help` renamed it to
 * "--help". Now `--help` / `-h` opens the Help overlay on that command, as
 * `/help <command>` does. Commands the engine handles (`sdk`) are still
 * forwarded, because the engine answers their `--help` itself.
 *
 * Pure so the parsing is unit-testable.
 */

import type { SlashCommand } from "@/lib/shared/slash-commands";

/** Whether a command's argument string asks for its usage (`--help` / `-h`), not a run. */
export function isHelpRequest(args: string): boolean {
  const a = args.trim().toLowerCase();
  return a === "--help" || a === "-h";
}

/**
 * The command a `/help <command>` argument names, without its slash and
 * lowercased (`/help /Clear` → `clear`). `null` for a bare `/help`.
 */
export function helpTopic(args: string): string | null {
  const first = args.trim().split(/\s+/)[0] ?? "";
  const name = first.replace(/^\/+/, "").toLowerCase();
  return name || null;
}

/** The command a topic names, by primary name or alias. */
export function findHelpTopic<T extends Pick<SlashCommand, "name" | "aliases">>(all: readonly T[], topic: string): T | undefined {
  const t = topic.toLowerCase();
  return all.find((c) => c.name.toLowerCase() === t) ?? all.find((c) => (c.aliases ?? []).some((a) => a.toLowerCase() === t));
}

/** `Usage: /name <args>`, the first line of a command's help card. */
export function usageLine(cmd: Pick<SlashCommand, "name" | "argsHint">): string {
  return `/${cmd.name}${cmd.argsHint ? ` ${cmd.argsHint}` : ""}`;
}

/** Whether `/goal <args>` means "clear the goal" rather than "set the goal to this text". */
export function isGoalClear(args: string): boolean {
  return /^(clear|off|reset|none)$/i.test(args.trim());
}
