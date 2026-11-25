import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PermissionMode, PermissionResult } from "@anthropic-ai/claude-agent-sdk";

import { PlanOverlay } from "@/components/overlays/PlanOverlay";
import { openDb } from "@/lib/server/db";
import { Session } from "@/lib/server/session";
import { getSessionState } from "@/lib/server/sessions-db";
import type { ServerEvent } from "@/lib/shared/events";
import { readPermissionModeRecord } from "@/lib/shared/permission-mode-record";

import { makeTempHome, type TmpHome } from "./helpers/tmp-home";

/**
 * CC 2.1.328 — "Changed plan mode and Bash prompts for Opus 4.6 and Sonnet
 * 4.6 on third-party providers to use and offer auto mode, as on newer
 * models; `disableAutoMode` turns both off".
 *
 * Claudius's plan approval (PlanOverlay) only had "Accept & execute", and
 * `resolvePlan` always switched to `acceptEdits`, so no model ever got the
 * CLI's "Yes, and use auto mode". Accepting with `mode: "auto"` now executes
 * in auto: the SDK's setMode, the mode record and `mode_changed` all say
 * auto. The same two gates as a manual switch to auto apply: the user's
 * `disableAutoMode`, and a model whose catalog row says it can't run auto.
 * In-browser check: tests/e2e/cc-parity-2.1.328-plan-accept-auto.spec.ts.
 */

const CWD = "/tmp/claudius-cc-parity-328-plan-auto";

let tmp: TmpHome;
beforeEach(async () => {
  tmp = makeTempHome();
  await openDb(CWD);
});
afterEach(() => tmp.restore());

type Internals = Pick<Session, "resolvePlan"> & {
  query: { setPermissionMode: (m: PermissionMode) => Promise<void>; supportedModels: () => Promise<unknown[]> } | null;
  pendingPlans: Map<string, { requestId: string; toolUseId: string; plan: string; resolve: (r: PermissionResult) => void }>;
  broadcast: (ev: ServerEvent) => void;
};

function setup(id: string, models: unknown[] = []) {
  const s = new Session({ id, cwd: CWD, model: "claude-sonnet-4-6", permissionMode: "plan" }) as unknown as Internals;
  s.query = { setPermissionMode: async () => {}, supportedModels: async () => models };
  const events: ServerEvent[] = [];
  const orig = s.broadcast.bind(s);
  s.broadcast = (ev) => {
    events.push(ev);
    orig(ev);
  };
  let result: PermissionResult | undefined;
  s.pendingPlans.set("req", {
    requestId: "req",
    toolUseId: "tool",
    plan: "1. do it",
    resolve: (r) => {
      result = r;
    },
  });
  return { s, events, result: () => result };
}

async function recordedMode(id: string): Promise<string | undefined> {
  for (let i = 0; i < 50; i++) {
    const rec = readPermissionModeRecord(await getSessionState(CWD, id));
    if (rec) return rec.mode;
    await new Promise((r) => setTimeout(r, 10));
  }
  return undefined;
}

const setModeOf = (r: PermissionResult | undefined) =>
  r?.behavior === "allow" ? r.updatedPermissions?.find((u) => u.type === "setMode") : undefined;
const modeChanged = (events: ServerEvent[]) =>
  events.filter((e): e is Extract<ServerEvent, { type: "mode_changed" }> => e.type === "mode_changed").map((e) => e.mode);

describe("resolvePlan with mode: auto", () => {
  test("executes the plan in auto: setMode, the mode record and mode_changed", async () => {
    const { s, events, result } = setup("s-auto");
    expect(await s.resolvePlan("req", { kind: "accept", mode: "auto" })).toBe(true);
    expect(setModeOf(result())).toMatchObject({ type: "setMode", mode: "auto", destination: "session" });
    expect(modeChanged(events)).toEqual(["auto"]);
    expect(await recordedMode("s-auto")).toBe("auto");
  });

  test("a plain accept still switches to acceptEdits", async () => {
    const { s, events, result } = setup("s-plain");
    await s.resolvePlan("req", { kind: "accept" });
    expect(setModeOf(result())).toMatchObject({ mode: "acceptEdits" });
    expect(modeChanged(events)).toEqual(["acceptEdits"]);
  });

  test("falls back to acceptEdits when the user's disableAutoMode is set", async () => {
    mkdirSync(join(tmp.home, ".claude"), { recursive: true });
    writeFileSync(join(tmp.home, ".claude", "settings.json"), JSON.stringify({ disableAutoMode: "disable" }));
    const { s, events, result } = setup("s-disabled");
    await s.resolvePlan("req", { kind: "accept", mode: "auto" });
    expect(setModeOf(result())).toMatchObject({ mode: "acceptEdits" });
    expect(modeChanged(events)).toEqual(["acceptEdits"]);
    expect(await recordedMode("s-disabled")).toBe("acceptEdits");
  });

  test("falls back to acceptEdits on a model whose catalog says it can't run auto", async () => {
    const { s, result } = setup("s-unsupported", [{ value: "claude-sonnet-4-6", displayName: "Sonnet 4.6", supportsAutoMode: false }]);
    await s.resolvePlan("req", { kind: "accept", mode: "auto" });
    expect(setModeOf(result())).toMatchObject({ mode: "acceptEdits" });
  });

  test("an edited plan still ships with auto", async () => {
    const { s, result } = setup("s-edited");
    await s.resolvePlan("req", { kind: "accept", mode: "auto", editedPlan: "1. do it better" });
    const r = result();
    expect(r?.behavior === "allow" && r.updatedInput).toMatchObject({ plan: "1. do it better" });
    expect(setModeOf(r)).toMatchObject({ mode: "auto" });
  });
});

describe("PlanOverlay", () => {
  const plan = { requestId: "req", toolUseId: "tool", plan: "1. do it" };
  const render = (autoModeAvailable: boolean) =>
    renderToStaticMarkup(
      createElement(PlanOverlay, { plan, autoModeAvailable, onAccept: () => {}, onReject: () => {}, onClose: () => {} }),
    );

  test("offers Accept & use auto mode first when auto is available", () => {
    const html = render(true);
    expect(html).toContain('data-testid="plan-accept-auto"');
    expect(html.indexOf("plan-accept-auto")).toBeLessThan(html.indexOf('data-testid="plan-accept"'));
  });

  test("no auto option when disableAutoMode is set", () => {
    const html = render(false);
    expect(html).not.toContain("plan-accept-auto");
    expect(html).toContain('data-testid="plan-accept"');
  });
});
