/**
 * CC 2.1.319 parity — "Fixed `/clear` killing running commands of background
 * agents, teammates and workflows that keep running".
 *
 * Claudius's `/clear` doesn't end the old session — it starts a new one and
 * leaves the old one with no subscribers. But the idle reaper
 * (`SessionManager.scheduleReap`) then ends that SDK process after the reap
 * window, which kills every background agent / workflow / teammate still
 * running in it (and their commands) — the same loss, just delayed. The
 * reaper already spares a session with a pending prompt or an armed loop;
 * this is the third guard: a live, non-process background task.
 *
 * - Shells and monitors (`local_bash`, `local_monitor`) and MCP tasks don't
 *   count: the reaper's documented rule is that a runaway command with no
 *   watcher stays reapable.
 * - `ambient` tasks (live-update watchers) don't count either.
 * - Bounded: if no task event has arrived for
 *   {@link BACKGROUND_AGENT_KEEPALIVE_MS}, the agent is presumed hung and the
 *   session becomes reapable again, so one stuck agent can't pin an SDK
 *   process forever.
 */

/** Task types that are processes, not agents — never keep a session alive. */
export const NON_AGENT_TASK_TYPES: ReadonlySet<string> = new Set(["local_bash", "local_monitor", "mcp_task"]);

/** Silence after which a "running" background agent is presumed hung. */
export const BACKGROUND_AGENT_KEEPALIVE_MS = 4 * 60 * 60 * 1000;

export type KeepaliveTask = {
  status: string;
  taskType?: string;
  isBackgrounded?: boolean;
  ambient?: boolean;
};

export function isLiveBackgroundAgent(t: KeepaliveTask): boolean {
  if (!t.isBackgrounded) return false;
  if (t.ambient) return false;
  if (t.taskType && NON_AGENT_TASK_TYPES.has(t.taskType)) return false;
  return t.status === "running" || t.status === "pending" || t.status === "paused";
}

export function hasLiveBackgroundAgent(
  tasks: Iterable<KeepaliveTask>,
  lastTaskEventAt: number,
  now: number,
): boolean {
  if (now - lastTaskEventAt >= BACKGROUND_AGENT_KEEPALIVE_MS) return false;
  for (const t of tasks) if (isLiveBackgroundAgent(t)) return true;
  return false;
}
