import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ElicitationRequest, ElicitationResult, PermissionResult } from "@anthropic-ai/claude-agent-sdk";

import { Session } from "@/lib/server/session";
import { openDb } from "@/lib/server/db";
import type { ServerEvent } from "@/lib/shared/events";

import { makeTempHome, type TmpHome } from "./helpers/tmp-home";

/**
 * Server half of the prompt queue + MCP elicitation:
 *
 * - concurrent permission requests stay independently pending, and every
 *   exit from the pending set (answer, abort, drain) broadcasts
 *   `prompt_settled` so other tabs drop the dead prompt;
 * - `onElicitation` parks MCP form / URL requests the same way and resolves
 *   them with the user's `ElicitResult` (previously the SDK auto-declined
 *   every elicitation because no handler was wired).
 */
const CWD = "/tmp/fake-session-prompt-queue-cwd";

let tmp: TmpHome;

beforeEach(async () => {
  tmp = makeTempHome();
  await openDb(CWD);
});

afterEach(() => {
  tmp.restore();
});

type Internals = {
  canUseTool: (toolName: string, input: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<PermissionResult>;
  onElicitation: (req: ElicitationRequest, opts: { signal: AbortSignal; requestId: string }) => Promise<ElicitationResult>;
  broadcast: (ev: ServerEvent) => void;
  drainPendingDecisions: (reason: string) => void;
  resolvePermission: Session["resolvePermission"];
  resolveElicitation: Session["resolveElicitation"];
  getStatus: () => "running" | "idle";
  hasPendingUserPrompts: () => boolean;
};

function makeSession(): { s: Internals; events: ServerEvent[] } {
  const s = new Session({ id: "prompt-queue-test", cwd: CWD }) as unknown as Internals;
  const events: ServerEvent[] = [];
  const orig = s.broadcast.bind(s);
  s.broadcast = (ev) => {
    events.push(ev);
    orig(ev);
  };
  return { s, events };
}

function ctx(toolUseID: string, signal = new AbortController().signal) {
  return { signal, toolUseID, suggestions: [] };
}

const settled = (events: ServerEvent[]) =>
  events.filter((e): e is Extract<ServerEvent, { type: "prompt_settled" }> => e.type === "prompt_settled");
const requests = (events: ServerEvent[]) =>
  events.filter((e): e is Extract<ServerEvent, { type: "permission_request" }> => e.type === "permission_request");

describe("permission queue — server side", () => {
  test("two concurrent requests stay pending independently; answering one settles only it", async () => {
    const { s, events } = makeSession();
    const p1 = s.canUseTool("Bash", { command: "ls" }, ctx("tu1"));
    const p2 = s.canUseTool("Bash", { command: "pwd" }, ctx("tu2"));
    const [r1, r2] = requests(events);
    expect(r1.toolUseId).toBe("tu1");
    expect(r2.toolUseId).toBe("tu2");

    expect(s.resolvePermission(r1.requestId, { kind: "allow_once" })).toBe(true);
    await expect(p1).resolves.toMatchObject({ behavior: "allow" });
    expect(settled(events)).toEqual([{ type: "prompt_settled", kind: "permission", requestId: r1.requestId }]);
    // The second one is still waiting — the bug was the UI losing it.
    expect(s.hasPendingUserPrompts()).toBe(true);

    expect(s.resolvePermission(r2.requestId, { kind: "deny" })).toBe(true);
    await expect(p2).resolves.toMatchObject({ behavior: "deny" });
    expect(settled(events).map((e) => e.requestId)).toEqual([r1.requestId, r2.requestId]);
    expect(s.hasPendingUserPrompts()).toBe(false);
  });

  test("an aborted tool call settles its prompt", async () => {
    const { s, events } = makeSession();
    const ac = new AbortController();
    const p = s.canUseTool("Bash", { command: "sleep 9" }, ctx("tu1", ac.signal));
    const [req] = requests(events);
    ac.abort();
    await expect(p).resolves.toMatchObject({ behavior: "deny", message: "Aborted" });
    expect(settled(events)).toEqual([{ type: "prompt_settled", kind: "permission", requestId: req.requestId }]);
  });
});

describe("MCP elicitation", () => {
  const formReq: ElicitationRequest = {
    serverName: "acme",
    message: "Which project?",
    mode: "form",
    requestedSchema: { type: "object", properties: { project: { type: "string" } } },
  };

  test("broadcasts the request, blocks status, and resolves with the user's content", async () => {
    const { s, events } = makeSession();
    const p = s.onElicitation(formReq, { signal: new AbortController().signal, requestId: "sdk-1" });
    const req = events.find((e) => e.type === "mcp_elicitation_request");
    expect(req).toMatchObject({ serverName: "acme", message: "Which project?", mode: "form" });
    expect(s.getStatus()).toBe("running");
    expect(s.hasPendingUserPrompts()).toBe(true);

    const requestId = (req as { requestId: string }).requestId;
    expect(s.resolveElicitation(requestId, { action: "accept", content: { project: "web" } })).toBe(true);
    await expect(p).resolves.toEqual({ action: "accept", content: { project: "web" } });
    expect(settled(events)).toEqual([{ type: "prompt_settled", kind: "elicitation", requestId }]);
    expect(s.hasPendingUserPrompts()).toBe(false);
    // Second answer for the same id is a 404 at the route layer.
    expect(s.resolveElicitation(requestId, { action: "decline" })).toBe(false);
  });

  test("forwards url-mode fields", () => {
    const { s, events } = makeSession();
    void s.onElicitation(
      { serverName: "gh", message: "Sign in", mode: "url", url: "https://github.com/login", elicitationId: "e1" },
      { signal: new AbortController().signal, requestId: "sdk-2" },
    );
    expect(events.find((e) => e.type === "mcp_elicitation_request")).toMatchObject({
      mode: "url",
      url: "https://github.com/login",
      elicitationId: "e1",
    });
  });

  test("abort and drain answer cancel and settle", async () => {
    const { s, events } = makeSession();
    const ac = new AbortController();
    const aborted = s.onElicitation(formReq, { signal: ac.signal, requestId: "sdk-3" });
    const drained = s.onElicitation(formReq, { signal: new AbortController().signal, requestId: "sdk-4" });
    ac.abort();
    await expect(aborted).resolves.toEqual({ action: "cancel" });
    s.drainPendingDecisions("session closed");
    await expect(drained).resolves.toEqual({ action: "cancel" });
    expect(settled(events)).toHaveLength(2);
    expect(s.hasPendingUserPrompts()).toBe(false);
  });
});
