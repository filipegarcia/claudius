import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";

import { PermissionPrompt } from "@/components/chat/PermissionPrompt";
import { Session } from "@/lib/server/session";
import { openDb } from "@/lib/server/db";
import type { PermissionRequestEvent, ServerEvent } from "@/lib/shared/events";
import { HOOK_ASK_REASON_MAX, safetyAskReason } from "@/lib/shared/hook-ask";

import { makeTempHome, type TmpHome } from "./helpers/tmp-home";

/**
 * CC 2.1.329 — "[VSCode] Fixed the permission prompt for Bash, Edit, Write
 * and other built-in tools not showing why a safety check asks".
 *
 * The engine hands `canUseTool` its safety check's warning as
 * `decisionReason` (`decisionReasonType: "safetyCheck"`, or
 * `"subcommandResults"` for a compound Bash command). Claudius only read that
 * text for hook asks, so a safety-check card showed the title and subtitle
 * and never said why it was asking. In-browser check:
 * tests/e2e/cc-parity-2.1.329-permission-safety-reason.spec.ts.
 */

describe("safetyAskReason", () => {
  test("carries a safety check's reason, and a compound command's nested one", () => {
    expect(safetyAskReason("Claude requested permissions to edit .git/config, a sensitive file.", "safetyCheck")).toBe(
      "Claude requested permissions to edit .git/config, a sensitive file.",
    );
    expect(safetyAskReason("rm -rf on a path outside the project", "subcommandResults")).toBe(
      "rm -rf on a path outside the project",
    );
  });

  test("other kinds of ask carry nothing (a hook's reason has its own row)", () => {
    expect(safetyAskReason("deploy-guard: confirm", "hook")).toBeUndefined();
    expect(safetyAskReason("Matched rule Bash(rm:*)", "rule")).toBeUndefined();
    expect(safetyAskReason("anything", undefined)).toBeUndefined();
  });

  test("an empty or non-string reason carries nothing", () => {
    expect(safetyAskReason(undefined, "safetyCheck")).toBeUndefined();
    expect(safetyAskReason("  \u001b[0m ", "safetyCheck")).toBeUndefined();
    expect(safetyAskReason(42, "safetyCheck")).toBeUndefined();
  });

  test("strips ANSI and caps a runaway reason", () => {
    expect(safetyAskReason("\u001b[33mwarning:\u001b[0m sensitive path", "safetyCheck")).toBe("warning: sensitive path");
    const out = safetyAskReason("x".repeat(5000), "safetyCheck")!;
    expect(out.length).toBe(HOOK_ASK_REASON_MAX);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("the permission request carries it (session.ts)", () => {
  const CWD = "/tmp/fake-cc-parity-2-1-329-safety-reason-cwd";
  let tmp: TmpHome;
  beforeEach(async () => {
    tmp = makeTempHome();
    await openDb(CWD);
  });
  afterEach(() => tmp.restore());

  type Internals = {
    canUseTool: (toolName: string, input: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<PermissionResult>;
    broadcast: (ev: ServerEvent) => void;
    resolvePermission: Session["resolvePermission"];
  };

  test("a safetyCheck ask's request has safetyReason; a hook ask's doesn't", async () => {
    const s = new Session({ id: "safety-reason-test", cwd: CWD }) as unknown as Internals;
    const events: ServerEvent[] = [];
    const orig = s.broadcast.bind(s);
    s.broadcast = (ev) => {
      events.push(ev);
      orig(ev);
    };
    const ctx = (toolUseID: string, decisionReason: string, decisionReasonType: string) => ({
      signal: new AbortController().signal,
      toolUseID,
      suggestions: [],
      decisionReason,
      decisionReasonType,
    });

    const p1 = s.canUseTool("Bash", { command: "cat x | sh" }, ctx("tu-s", "\u001b[1mCommand could not be parsed\u001b[0m", "safetyCheck"));
    const p2 = s.canUseTool("Bash", { command: "ls" }, ctx("tu-h", "deploy-guard: confirm", "hook"));
    const reqs = events.filter((e): e is PermissionRequestEvent => e.type === "permission_request");
    expect(reqs).toHaveLength(2);
    expect(reqs[0].safetyReason).toBe("Command could not be parsed");
    expect(reqs[1].safetyReason).toBeUndefined();
    expect(reqs[1].hookAsk).toEqual({ reason: "deploy-guard: confirm" });

    for (const r of reqs) s.resolvePermission(r.requestId, { kind: "deny" });
    await Promise.all([p1, p2]);
  });
});

describe("permission prompt safety row", () => {
  const base: PermissionRequestEvent = {
    type: "permission_request",
    requestId: "r1",
    toolName: "Edit",
    toolUseId: "t1",
    input: { file_path: ".git/config" },
  };
  const render = (extra: Partial<PermissionRequestEvent>) =>
    renderToStaticMarkup(createElement(PermissionPrompt, { request: { ...base, ...extra }, onResolve: () => {} }));

  test("shows why the safety check asks", () => {
    const html = render({ safetyReason: "Claude requested permissions to edit .git/config, a sensitive file." });
    expect(html).toContain('data-testid="permission-safety-reason"');
    expect(html).toContain("Why Claude Code is asking:");
    expect(html).toContain("a sensitive file.");
  });

  test("hidden characters in the reason are shown and counted", () => {
    const html = render({ safetyReason: "edit con‮fig" });
    expect(html).toContain("Contains 1 hidden/bidi character");
  });

  test("skipped when it only repeats the subtitle, and absent for an ordinary ask", () => {
    expect(render({ safetyReason: "Same text", description: "Same text " })).not.toContain("permission-safety-reason");
    expect(render({})).not.toContain("permission-safety-reason");
  });
});
