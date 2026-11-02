import { describe, expect, test, vi } from "vitest";

import { Session } from "@/lib/server/session";
import {
  isUltrathinkDisabled,
  isUltrathinkDisabledFor,
  resolveUltrathinkDisabled,
} from "@/lib/shared/ultrathink-keyword";

/**
 * CC 2.1.316 parity — "Added CLAUDE_CODE_DISABLE_ULTRATHINK, which turns the
 * ultrathink keyword off".
 *
 * The engine's gate is `!process.env.CLAUDE_CODE_DISABLE_ULTRATHINK`, so any
 * non-empty value disables the keyword ("0" and "false" included) and only an
 * unset / empty variable leaves it on. Claudius injects its own ultrathink
 * reminder in `Session.sendInput`, gated on the `ultrathinkDisabled` flag that
 * `start()` resolves from the effective env. The session cases below set that
 * private flag directly (no SDK subprocess) and read the message pushed onto
 * the private `inputQueue`, like `session-send-now-priority.test.ts`.
 */

describe("isUltrathinkDisabled", () => {
  test("any non-empty value disables the keyword, including 0 and false", () => {
    expect(isUltrathinkDisabled({ CLAUDE_CODE_DISABLE_ULTRATHINK: "1" })).toBe(true);
    expect(isUltrathinkDisabled({ CLAUDE_CODE_DISABLE_ULTRATHINK: "0" })).toBe(true);
    expect(isUltrathinkDisabled({ CLAUDE_CODE_DISABLE_ULTRATHINK: "false" })).toBe(true);
    expect(isUltrathinkDisabled({ CLAUDE_CODE_DISABLE_ULTRATHINK: "yes" })).toBe(true);
  });

  test("unset or empty leaves the keyword on", () => {
    expect(isUltrathinkDisabled({})).toBe(false);
    expect(isUltrathinkDisabled({ CLAUDE_CODE_DISABLE_ULTRATHINK: undefined })).toBe(false);
    expect(isUltrathinkDisabled({ CLAUDE_CODE_DISABLE_ULTRATHINK: "" })).toBe(false);
  });
});

describe("isUltrathinkDisabledFor (query env + settings env blocks)", () => {
  test("the query env alone decides when no settings scope sets the variable", () => {
    expect(isUltrathinkDisabledFor({ CLAUDE_CODE_DISABLE_ULTRATHINK: "1" })).toBe(true);
    expect(isUltrathinkDisabledFor({}, [{}, { env: {} }, { model: "x" }])).toBe(false);
  });

  test("a settings env block disables it", () => {
    expect(isUltrathinkDisabledFor({}, [{ env: { CLAUDE_CODE_DISABLE_ULTRATHINK: "0" } }])).toBe(true);
  });

  test("later scopes win: local empty string re-enables a user-scope value", () => {
    expect(
      isUltrathinkDisabledFor({}, [
        { env: { CLAUDE_CODE_DISABLE_ULTRATHINK: "1" } },
        {},
        { env: { CLAUDE_CODE_DISABLE_ULTRATHINK: "" } },
      ]),
    ).toBe(false);
    expect(
      isUltrathinkDisabledFor({ CLAUDE_CODE_DISABLE_ULTRATHINK: "" }, [
        {},
        { env: { CLAUDE_CODE_DISABLE_ULTRATHINK: "true" } },
      ]),
    ).toBe(true);
  });

  test("a malformed env block adds nothing", () => {
    expect(isUltrathinkDisabledFor({}, [{ env: "CLAUDE_CODE_DISABLE_ULTRATHINK=1" }, null])).toBe(false);
  });
});

const DISABLE = "CLAUDE_CODE_DISABLE_ULTRATHINK";

/** Fake settings layers keyed by scope; a scope set to an Error rejects. */
function fakeScopes(layers: Partial<Record<"project" | "local", unknown>>) {
  return vi.fn(async (scope: "project" | "local") => {
    const layer = layers[scope];
    if (layer instanceof Error) throw layer;
    return layer ?? {};
  });
}

describe("resolveUltrathinkDisabled (Session.start() resolution)", () => {
  test("the query env is the baseline when no scope sets the variable", async () => {
    const readScope = fakeScopes({});
    await expect(
      resolveUltrathinkDisabled({ queryEnv: { [DISABLE]: "1" }, restricted: false, userSettings: {}, readScope }),
    ).resolves.toBe(true);
    await expect(
      resolveUltrathinkDisabled({ queryEnv: {}, restricted: false, userSettings: {}, readScope }),
    ).resolves.toBe(false);
    expect(readScope.mock.calls.map((c) => c[0])).toEqual(["project", "local", "project", "local"]);
  });

  test("precedence is query env < user < project < local", async () => {
    // user disables, local re-enables with "".
    await expect(
      resolveUltrathinkDisabled({
        queryEnv: {},
        restricted: false,
        userSettings: { env: { [DISABLE]: "1" } },
        readScope: fakeScopes({ local: { env: { [DISABLE]: "" } } }),
      }),
    ).resolves.toBe(false);
    // project disables over a query env that leaves it on.
    await expect(
      resolveUltrathinkDisabled({
        queryEnv: { [DISABLE]: "" },
        restricted: false,
        userSettings: {},
        readScope: fakeScopes({ project: { env: { [DISABLE]: "0" } } }),
      }),
    ).resolves.toBe(true);
    // local disables over a project that re-enabled a user value.
    await expect(
      resolveUltrathinkDisabled({
        queryEnv: {},
        restricted: false,
        userSettings: { env: { [DISABLE]: "1" } },
        readScope: fakeScopes({ project: { env: { [DISABLE]: "" } }, local: { env: { [DISABLE]: "yes" } } }),
      }),
    ).resolves.toBe(true);
    // user re-enables a query-env value.
    await expect(
      resolveUltrathinkDisabled({
        queryEnv: { [DISABLE]: "1" },
        restricted: false,
        userSettings: { env: { [DISABLE]: "" } },
        readScope: fakeScopes({}),
      }),
    ).resolves.toBe(false);
  });

  test("a scope whose read rejects adds nothing", async () => {
    await expect(
      resolveUltrathinkDisabled({
        queryEnv: {},
        restricted: false,
        userSettings: { env: { [DISABLE]: "1" } },
        readScope: fakeScopes({ project: new Error("EACCES"), local: new Error("bad json") }),
      }),
    ).resolves.toBe(true);
    await expect(
      resolveUltrathinkDisabled({
        queryEnv: {},
        restricted: false,
        userSettings: {},
        readScope: fakeScopes({ project: new Error("EACCES"), local: { env: { [DISABLE]: "1" } } }),
      }),
    ).resolves.toBe(true);
  });

  test("restricted mode counts only the query env and reads no settings scope", async () => {
    const readScope = fakeScopes({ project: { env: { [DISABLE]: "1" } }, local: { env: { [DISABLE]: "1" } } });
    await expect(
      resolveUltrathinkDisabled({
        queryEnv: {},
        restricted: true,
        userSettings: { env: { [DISABLE]: "1" } },
        readScope,
      }),
    ).resolves.toBe(false);
    await expect(
      resolveUltrathinkDisabled({
        queryEnv: { [DISABLE]: "1" },
        restricted: true,
        userSettings: { env: { [DISABLE]: "" } },
        readScope,
      }),
    ).resolves.toBe(true);
    expect(readScope).not.toHaveBeenCalled();
  });
});

type Pushed = { type: string; message: { content: unknown } };
type SessionInternals = {
  ultrathinkDisabled: boolean;
  inputQueue: { next: () => Promise<IteratorResult<Pushed>> };
  sendInput: (text: string) => void;
};

let n = 0;
function makeSession(): SessionInternals {
  n += 1;
  return new Session({
    id: `disable-ultrathink-test-${n}`,
    cwd: "/tmp/fake-disable-ultrathink-cwd",
  }) as unknown as SessionInternals;
}

async function pushedText(session: SessionInternals): Promise<string> {
  const r = await session.inputQueue.next();
  const content = r.value.message.content;
  return typeof content === "string" ? content : JSON.stringify(content);
}

describe("Session.sendInput with CLAUDE_CODE_DISABLE_ULTRATHINK", () => {
  test("control: the ultrathink reminder rides the turn when the keyword is on", async () => {
    const session = makeSession();
    session.ultrathinkDisabled = false;
    session.sendInput("please ultrathink this problem");
    const text = await pushedText(session);
    expect(text).toContain("please ultrathink this problem");
    expect(text).toContain("deeper reasoning");
  });

  test("no ultrathink reminder is queued when the keyword is disabled", async () => {
    const session = makeSession();
    session.ultrathinkDisabled = true;
    session.sendInput("please ultrathink this problem");
    const text = await pushedText(session);
    expect(text).toContain("please ultrathink this problem");
    expect(text).not.toContain("deeper reasoning");
  });
});
