import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";

const { resolveSettingsMock } = vi.hoisted(() => ({ resolveSettingsMock: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", async (importActual) => ({
  ...(await importActual<typeof import("@anthropic-ai/claude-agent-sdk")>()),
  resolveSettings: resolveSettingsMock,
}));

import { PermissionPrompt } from "@/components/chat/PermissionPrompt";
import { Session } from "@/lib/server/session";
import { openDb } from "@/lib/server/db";
import { managedRulesOnlyFromSources, resolveManagedRulesOnly } from "@/lib/server/managed-permission-policy";
import type { PermissionRequestEvent, ServerEvent } from "@/lib/shared/events";

import { makeTempHome, type TmpHome } from "./helpers/tmp-home";

/**
 * CC 2.1.331 — "[VSCode] Changed permission cards to show only Yes and No
 * when `allowManagedPermissionRulesOnly` is set and the card would offer an
 * allow rule".
 *
 * Under that managed policy the engine ignores allow rules from user,
 * project and local settings, yet Claudius's card still offered "Always
 * (session/project/user)". A click wrote a rule that never took effect, and
 * the next identical call asked again. In-browser check:
 * tests/e2e/cc-parity-2.1.331-permission-managed-only.spec.ts.
 */

describe("managedRulesOnlyFromSources", () => {
  test("on only when a managed source sets it to true", () => {
    expect(managedRulesOnlyFromSources([{ source: "managed", settings: { allowManagedPermissionRulesOnly: true } }])).toBe(true);
    expect(
      managedRulesOnlyFromSources([
        { source: "user", settings: {} },
        { source: "managed", settings: { allowManagedPermissionRulesOnly: true } },
      ]),
    ).toBe(true);
  });

  test("the same key outside managed settings doesn't count (the engine ignores it too)", () => {
    for (const source of ["user", "project", "local", "flag"]) {
      expect(managedRulesOnlyFromSources([{ source, settings: { allowManagedPermissionRulesOnly: true } }])).toBe(false);
    }
  });

  test("false, a non-boolean or no managed source is off", () => {
    expect(managedRulesOnlyFromSources([{ source: "managed", settings: { allowManagedPermissionRulesOnly: false } }])).toBe(false);
    expect(managedRulesOnlyFromSources([{ source: "managed", settings: { allowManagedPermissionRulesOnly: "true" } }])).toBe(false);
    expect(managedRulesOnlyFromSources([{ source: "managed", settings: undefined }])).toBe(false);
    expect(managedRulesOnlyFromSources([])).toBe(false);
  });
});

describe("resolveManagedRulesOnly", () => {
  afterEach(() => resolveSettingsMock.mockReset());

  test("reads the managed tier of resolveSettings for the cwd", async () => {
    resolveSettingsMock.mockResolvedValue({
      sources: [{ source: "managed", settings: { allowManagedPermissionRulesOnly: true } }],
    });
    await expect(resolveManagedRulesOnly("/some/cwd")).resolves.toBe(true);
    expect(resolveSettingsMock).toHaveBeenCalledWith({ cwd: "/some/cwd" });
  });

  test("a resolveSettings failure reads as off", async () => {
    resolveSettingsMock.mockRejectedValue(new Error("alpha API unavailable"));
    await expect(resolveManagedRulesOnly("/some/cwd")).resolves.toBe(false);
  });
});

describe("the permission request carries it (session.ts)", () => {
  const CWD = "/tmp/fake-cc-parity-2-1-331-managed-only-cwd";
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
    managedRulesOnly: boolean;
  };

  test("set on the request while the policy is on, absent while it's off", async () => {
    const s = new Session({ id: "managed-only-test", cwd: CWD }) as unknown as Internals;
    const events: ServerEvent[] = [];
    const orig = s.broadcast.bind(s);
    s.broadcast = (ev) => {
      events.push(ev);
      orig(ev);
    };
    const ctx = (toolUseID: string) => ({ signal: new AbortController().signal, toolUseID, suggestions: [] });

    const p1 = s.canUseTool("Bash", { command: "ls" }, ctx("tu-off"));
    s.managedRulesOnly = true;
    const p2 = s.canUseTool("Bash", { command: "pwd" }, ctx("tu-on"));
    const reqs = events.filter((e): e is PermissionRequestEvent => e.type === "permission_request");
    expect(reqs.map((r) => r.managedRulesOnly)).toEqual([undefined, true]);

    for (const r of reqs) s.resolvePermission(r.requestId, { kind: "deny" });
    await Promise.all([p1, p2]);
  });
});

describe("permission card under managed-only rules", () => {
  const base: PermissionRequestEvent = {
    type: "permission_request",
    requestId: "r1",
    toolName: "Bash",
    toolUseId: "t1",
    input: { command: "git status" },
    suggestedRules: [{ toolName: "Bash", ruleContent: "git status:*" }],
  };
  const render = (extra: Partial<PermissionRequestEvent>) =>
    renderToStaticMarkup(
      createElement(PermissionPrompt, {
        request: { ...base, ...extra },
        onResolve: () => {},
        autoModeAvailable: true,
        onSwitchToAutoMode: () => {},
      }),
    );

  test("only Allow once and Deny; no Always buttons, rule hint or auto-mode tip", () => {
    const html = render({ managedRulesOnly: true });
    expect(html).toContain("Allow once");
    expect(html).toContain("Deny");
    expect(html).not.toContain("Always (");
    expect(html).not.toContain('data-testid="permission-always-rule"');
    expect(html).not.toContain('data-testid="permission-auto-mode-tip"');
  });

  test("without the policy the Always buttons, rule hint and tip are still offered", () => {
    const html = render({});
    expect(html).toContain("Always (session)");
    expect(html).toContain("Always (project)");
    expect(html).toContain("Always (user)");
    expect(html).toContain('data-testid="permission-always-rule"');
    expect(html).toContain('data-testid="permission-auto-mode-tip"');
  });
});
