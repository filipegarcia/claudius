import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { Session } from "@/lib/server/session";
import { openDb } from "@/lib/server/db";
import type { ServerEvent } from "@/lib/shared/events";
import {
  isRecognizedModel,
  unknownModelWarning,
  unknownModelWarningSuppressed,
  unknownModelWarningText,
} from "@/lib/shared/model-recognition";

import { makeTempHome, type TmpHome } from "./helpers/tmp-home";

/**
 * CC 2.1.316 — "Fixed /model <id> not warning when the model isn't recognized
 * by this version and auto-compact will assume a 200K context window".
 * Claudius runs `/model <id>` itself, so it carries its own copy of the
 * engine's warning. Recognition is generous on purpose: only ids that are no
 * alias, no catalog row and no Claude family id warn.
 */
const CATALOG = [
  { value: "sonnet", resolvedModel: "claude-sonnet-5-5" },
  { value: "acme-internal-coder" },
];

const TEXT =
  'Claude Code doesn\'t recognize the model "my-gateway-model", so it assumes a context window of 200k tokens. Update Claude Code, or see https://code.claude.com/docs/en/model-config#correct-the-window-for-a-gateway-or-custom-model-id to set the window.';

describe("isRecognizedModel", () => {
  test.each([
    "opus",
    "opus[1m]",
    "OpusPlan",
    "default",
    "best",
    "fable",
    "claude-opus-4.8",
    "claude-opus-4-8-20260101",
    "us.anthropic.claude-sonnet-5-5-v1:0",
    "claude-opus-4-8@20260101",
    "claude-opus-9-1", // a future version is still a Claude family id
    "claude-mythos-7",
    "sonnet-5.5", // bare gateway spelling
    "claude-3-5-sonnet-20241022",
    "claude-2.1",
    "acme-internal-coder", // listed by supportedModels()
    "claude-sonnet-5-5", // a row's resolvedModel
  ])("%s is recognized", (id) => {
    expect(isRecognizedModel(id, CATALOG)).toBe(true);
  });

  test.each(["my-gateway-model", "gpt-x", "llama-70b", "claude-custom"])("%s is not recognized", (id) => {
    expect(isRecognizedModel(id, CATALOG)).toBe(false);
  });
});

describe("unknownModelWarningText", () => {
  test("verbatim engine copy", () => {
    expect(unknownModelWarningText("my-gateway-model")).toBe(TEXT);
  });

  test("sanitizes the id like the engine", () => {
    expect(unknownModelWarningText("bad id<script>")).toContain('the model "badidscript"');
    expect(unknownModelWarningText("   ")).toContain('the model "(unrecognized model name)"');
    expect(unknownModelWarningText("x".repeat(200))).toContain(`"${"x".repeat(128)}…"`);
  });
});

describe("unknownModelWarningSuppressed", () => {
  const m = "my-gateway-model";
  test("no gates → not suppressed", () => {
    expect(unknownModelWarningSuppressed(m, {}, {})).toBe(false);
    expect(unknownModelWarningSuppressed(m, { CLAUDE_CODE_MAX_CONTEXT_TOKENS: "0" }, { autoCompactEnabled: true })).toBe(false);
  });

  test.each([
    [{ CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1" }, {}],
    [{ CLAUDE_CODE_AUTO_COMPACT_WINDOW: "500000" }, {}],
    [{ CLAUDE_CODE_MAX_CONTEXT_TOKENS: "400000" }, {}],
    [{ DISABLE_AUTO_COMPACT: "true" }, {}],
    [{ DISABLE_COMPACT: "1" }, {}],
    [{}, { autoCompactEnabled: false }],
    [{}, { autoCompactWindow: 300000 }],
    [{}, { modelSettings: { "my-gateway-model": { autoCompactWindow: 128000 } } }],
  ])("env %j / settings %j suppress", (env, settings) => {
    expect(unknownModelWarningSuppressed(m, env, settings)).toBe(true);
  });

  test("a per-model window for another model doesn't suppress", () => {
    expect(
      unknownModelWarningSuppressed(m, {}, { modelSettings: { "other-model": { autoCompactWindow: 128000 } } }),
    ).toBe(false);
  });
});

describe("unknownModelWarning", () => {
  test("warns only for an unrecognized id with no gate", () => {
    expect(unknownModelWarning({ model: "my-gateway-model", models: CATALOG, env: {} })).toBe(TEXT);
    expect(unknownModelWarning({ model: "claude-opus-9-1", models: CATALOG, env: {} })).toBeNull();
    expect(unknownModelWarning({ model: "acme-internal-coder", models: CATALOG, env: {} })).toBeNull();
    expect(
      unknownModelWarning({
        model: "my-gateway-model",
        env: { CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1" },
      }),
    ).toBeNull();
    expect(unknownModelWarning({ model: "my-gateway-model", env: {}, settings: { autoCompactEnabled: false } })).toBeNull();
  });

  test("skips [1m]-tagged and empty ids", () => {
    expect(unknownModelWarning({ model: "my-gateway-model[1m]", env: {} })).toBeNull();
    expect(unknownModelWarning({ model: "", env: {} })).toBeNull();
    expect(unknownModelWarning({ model: undefined, env: {} })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Session wiring — fake `query`, same pattern as
// cc-parity-2.1.299-auto-mode-model-switch.test.ts.

const CWD = "/tmp/fake-session-unknown-model-cwd";
let tmp: TmpHome;
const savedEnv = process.env.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT;

beforeEach(async () => {
  tmp = makeTempHome();
  await openDb(CWD);
  delete process.env.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT;
});

afterEach(() => {
  tmp.restore();
  if (savedEnv === undefined) delete process.env.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT;
  else process.env.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT = savedEnv;
});

type SessionInternals = Pick<Session, "setModel"> & {
  model?: string;
  query: { setModel: (m?: string) => Promise<void>; supportedModels: () => Promise<typeof CATALOG> } | null;
  buffer: ServerEvent[];
};

function makeSession(): SessionInternals {
  const session = new Session({ id: "unknown-model-316", cwd: CWD }) as unknown as SessionInternals;
  session.model = "sonnet";
  session.query = { setModel: async () => {}, supportedModels: async () => CATALOG };
  return session;
}

function lastModelChanged(session: SessionInternals) {
  return session.buffer.filter((e) => e.type === "model_changed").at(-1) as
    | Extract<ServerEvent, { type: "model_changed" }>
    | undefined;
}

describe("Session.setModel — unknown-model warning", () => {
  test("a /model chat command to an unknown id carries the warning on the broadcast and the result", async () => {
    const session = makeSession();
    const result = await session.setModel("my-gateway-model", "chat_command");
    expect(result).toMatchObject({ ok: true, unrecognizedModelWarning: TEXT });
    expect(lastModelChanged(session)?.unrecognizedModelWarning).toBe(TEXT);
  });

  test("a recognized id, or a picker switch, carries none", async () => {
    const session = makeSession();
    await session.setModel("claude-opus-9-1", "chat_command");
    expect(lastModelChanged(session)?.unrecognizedModelWarning).toBeUndefined();
    const picker = await session.setModel("my-gateway-model", "picker");
    expect(picker).not.toHaveProperty("unrecognizedModelWarning");
    expect(lastModelChanged(session)?.unrecognizedModelWarning).toBeUndefined();
  });

  test("the disable env var suppresses it", async () => {
    process.env.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT = "1";
    const session = makeSession();
    await session.setModel("my-gateway-model", "chat_command");
    expect(lastModelChanged(session)?.unrecognizedModelWarning).toBeUndefined();
  });
});
