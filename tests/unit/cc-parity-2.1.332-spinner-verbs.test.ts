import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { resolveSettings } from "@anthropic-ai/claude-agent-sdk";

import { Session, resolveSpinnerVerbsSetting } from "@/lib/server/session";
import { openDb } from "@/lib/server/db";
import { normalizeSpinnerVerbs, pickSpinnerVerb } from "@/lib/shared/spinner-verbs";
import type { ServerEvent } from "@/lib/shared/events";

import { makeTempHome, type TmpHome } from "./helpers/tmp-home";

/**
 * CC 2.1.332 — "[VSCode] Fixed `spinnerVerbs` from Claude Code user and
 * managed settings being ignored". Engine rule: "replace" uses only the verbs
 * (an empty list falls back to the defaults), "append" adds them to the
 * defaults. Claudius's default line "Claude is working…" stands in for the
 * engine's default verbs.
 */
describe("normalizeSpinnerVerbs", () => {
  test("replace and append", () => {
    expect(normalizeSpinnerVerbs({ mode: "replace", verbs: ["Pondering", " Brewing "] })).toEqual({
      verbs: ["Pondering", "Brewing"],
      includeDefault: false,
    });
    expect(normalizeSpinnerVerbs({ mode: "append", verbs: ["Pondering"] })).toEqual({
      verbs: ["Pondering"],
      includeDefault: true,
    });
  });
  test("unset, malformed or empty → undefined (the default line stays)", () => {
    expect(normalizeSpinnerVerbs(undefined)).toBeUndefined();
    expect(normalizeSpinnerVerbs({ mode: "replace", verbs: [] })).toBeUndefined();
    expect(normalizeSpinnerVerbs({ mode: "replace", verbs: ["", "  ", 3] })).toBeUndefined();
    expect(normalizeSpinnerVerbs({ mode: "shuffle", verbs: ["Pondering"] })).toBeUndefined();
    expect(normalizeSpinnerVerbs({ verbs: ["Pondering"] })).toBeUndefined();
  });
});

describe("pickSpinnerVerb", () => {
  const replace = { verbs: ["Pondering", "Brewing"], includeDefault: false };
  const append = { verbs: ["Pondering"], includeDefault: true };
  test("replace only ever picks a configured verb", () => {
    expect(pickSpinnerVerb(replace, 0)).toBe("Pondering");
    expect(pickSpinnerVerb(replace, 0.99)).toBe("Brewing");
  });
  test("append keeps the default line in the pool (null)", () => {
    expect(pickSpinnerVerb(append, 0)).toBe("Pondering");
    expect(pickSpinnerVerb(append, 0.75)).toBeNull();
  });
  test("no setting → the default line", () => {
    expect(pickSpinnerVerb(null, 0.3)).toBeNull();
    expect(pickSpinnerVerb(undefined, 0.3)).toBeNull();
  });
});

describe("resolveSpinnerVerbsSetting — managed settings count too", () => {
  test("a managed spinnerVerbs reaches the session (real SDK merge)", async () => {
    const managed = { mode: "replace" as const, verbs: ["Auditing"] };
    const value = await resolveSpinnerVerbsSetting("/tmp", undefined, (opts) =>
      // The server-managed policy source (`serverManagedSettings`); user files skipped.
      resolveSettings({ ...opts, settingSources: [], serverManagedSettings: { spinnerVerbs: managed } }),
    );
    expect(value).toEqual(managed);
  });
  test("falls back to the user-scope value when resolution fails", async () => {
    const user = { mode: "append", verbs: ["Pondering"] };
    const value = await resolveSpinnerVerbsSetting("/tmp", user, () => Promise.reject(new Error("alpha API gone")));
    expect(value).toEqual(user);
  });
});

describe("the tips frame carries spinnerVerbs", () => {
  const CWD = "/tmp/fake-spinner-verbs-cwd";
  let tmp: TmpHome;
  beforeEach(async () => {
    tmp = makeTempHome();
    await openDb(CWD);
  });
  afterEach(() => tmp.restore());

  function tipsFrame(session: Session): Extract<ServerEvent, { type: "tips" }> | undefined {
    const seen: ServerEvent[] = [];
    const unsubscribe = session.subscribe((ev) => {
      seen.push(ev);
    });
    unsubscribe();
    return seen.find((e): e is Extract<ServerEvent, { type: "tips" }> => e.type === "tips");
  }

  test("set → on the frame; unset → absent", () => {
    const session = new Session({ id: "spinner-verbs-test", cwd: CWD });
    expect(tipsFrame(session)?.spinnerVerbs).toBeUndefined();
    (session as unknown as { spinnerVerbs: unknown }).spinnerVerbs = { verbs: ["Auditing"], includeDefault: false };
    expect(tipsFrame(session)?.spinnerVerbs).toEqual({ verbs: ["Auditing"], includeDefault: false });
  });
});
