import { describe, expect, test } from "vitest";

import {
  BACKGROUND_AGENT_KEEPALIVE_MS,
  hasLiveBackgroundAgent,
  isLiveBackgroundAgent,
} from "@/lib/server/background-agent-keepalive";
import { Session } from "@/lib/server/session";

/**
 * CC 2.1.319 parity — "Fixed /clear killing running commands of background
 * agents, teammates and workflows that keep running". Claudius's `/clear`
 * leaves the old session subscriber-less; the idle reaper now spares it
 * while a backgrounded agent is still running (reaper wiring is covered in
 * `session-manager.test.ts`).
 */
const NOW = 10 ** 12;

describe("isLiveBackgroundAgent", () => {
  test("a running backgrounded agent, workflow or unknown agentic type counts", () => {
    for (const taskType of ["local_agent", "local_workflow", "remote_agent", "in_process_teammate", undefined]) {
      expect(isLiveBackgroundAgent({ status: "running", taskType, isBackgrounded: true })).toBe(true);
    }
    expect(isLiveBackgroundAgent({ status: "pending", taskType: "local_agent", isBackgrounded: true })).toBe(true);
    expect(isLiveBackgroundAgent({ status: "paused", taskType: "local_agent", isBackgrounded: true })).toBe(true);
  });

  test("shells, monitors and MCP tasks stay reapable", () => {
    for (const taskType of ["local_bash", "local_monitor", "mcp_task"]) {
      expect(isLiveBackgroundAgent({ status: "running", taskType, isBackgrounded: true })).toBe(false);
    }
  });

  test("foreground, ambient and finished tasks don't count", () => {
    expect(isLiveBackgroundAgent({ status: "running", taskType: "local_agent" })).toBe(false);
    expect(isLiveBackgroundAgent({ status: "running", taskType: "local_agent", isBackgrounded: true, ambient: true })).toBe(false);
    for (const status of ["completed", "failed", "stopped", "killed"]) {
      expect(isLiveBackgroundAgent({ status, taskType: "local_agent", isBackgrounded: true })).toBe(false);
    }
  });
});

describe("hasLiveBackgroundAgent", () => {
  const live = [{ status: "running", taskType: "local_agent", isBackgrounded: true }];

  test("true while task events keep arriving", () => {
    expect(hasLiveBackgroundAgent(live, NOW - 1000, NOW)).toBe(true);
  });

  test("a long-silent agent is presumed hung, so one stuck agent can't pin the process", () => {
    expect(hasLiveBackgroundAgent(live, NOW - BACKGROUND_AGENT_KEEPALIVE_MS, NOW)).toBe(false);
  });

  test("Session.hasLiveBackgroundAgents is false once the process is gone", () => {
    const tasks = new Map([["t1", { taskId: "t1", ...live[0], innerMessages: [] }]]);
    const call = (done: boolean) =>
      Session.prototype.hasLiveBackgroundAgents.call(
        { done, taskMetaById: tasks, lastTaskEventAt: NOW - 1000 } as unknown as Session,
        NOW,
      );
    expect(call(false)).toBe(true);
    expect(call(true)).toBe(false);
  });
});
