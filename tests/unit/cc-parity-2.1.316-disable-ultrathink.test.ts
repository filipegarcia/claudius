import { describe, expect, test } from "vitest";

import { Session } from "@/lib/server/session";
import { isUltrathinkDisabled, isUltrathinkDisabledFor } from "@/lib/shared/ultrathink-keyword";

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
