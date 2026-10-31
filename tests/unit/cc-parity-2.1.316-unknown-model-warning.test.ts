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

// The engine's wording, except "Update Claudius" (Claudius bundles the
// engine) and the docs URL, which the notice renders as the "set the window"
// link instead of raw text.
const TEXT =
  'Claude Code doesn\'t recognize the model "my-gateway-model", so it assumes a context window of 200k tokens. Update Claudius, or set the window.';

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
    "anthropic.claude-opus-4-8-v1:0",
    "publishers/anthropic/models/claude-sonnet-5-5",
    "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-opus-4-8-v1:0",
    "claude-opus-4-8@20260101",
    "claude-opus-9-1", // a future version is still a Claude family id
    "claude-mythos-7",
    // Accepted trade-off (prefix-only check): a custom id that starts with a
    // family token reads as a future version of that family.
    "claude-sonnet-4-finetune",
    "sonnet-5.5", // bare gateway spelling
    "claude-3-5-sonnet-20241022",
    "claude-2.1",
    "acme-internal-coder", // listed by supportedModels()
    "claude-sonnet-5-5", // a row's resolvedModel
  ])("%s is recognized", (id) => {
    expect(isRecognizedModel(id, CATALOG)).toBe(true);
  });

  test.each([
    "my-gateway-model",
    "gpt-x",
    "llama-70b",
    "claude-custom",
    // The family token must start the id or follow `.` `/` `:` `@`.
    "my-claude-sonnet-4-finetune",
    "foo-claude-opus-5",
    "my-opus-4-x",
    "my-claude-3-5-sonnet",
  ])("%s is not recognized", (id) => {
    expect(isRecognizedModel(id, CATALOG)).toBe(false);
  });

  test("a settings.modelOverrides key or value is recognized", () => {
    const overrides = { "claude-opus-4-8": "arn:aws:bedrock:us-east-1:1:application-inference-profile/abc123" };
    expect(isRecognizedModel("arn:aws:bedrock:us-east-1:1:application-inference-profile/abc123", CATALOG, overrides)).toBe(true);
    expect(isRecognizedModel("ARN:aws:bedrock:us-east-1:1:application-inference-profile/ABC123[1m]", CATALOG, overrides)).toBe(true);
    expect(isRecognizedModel("my-gateway-model", CATALOG, { "my-gateway-model": "x" })).toBe(true);
    expect(isRecognizedModel("my-gateway-model", CATALOG, overrides)).toBe(false);
    expect(isRecognizedModel("my-gateway-model", CATALOG, "not-a-map")).toBe(false);
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
    expect(
      unknownModelWarning({ model: "my-gateway-model", env: {}, settings: { modelOverrides: { "claude-opus-4-8": "my-gateway-model" } } }),
    ).toBeNull();
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
// Every env gate `unknownModelWarningSuppressed` reads — cleared per test so a
// developer's shell (e.g. `DISABLE_AUTO_COMPACT=1`) can't suppress the
// warning the Session tests expect.
const GATE_ENV = [
  "CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT",
  "DISABLE_AUTO_COMPACT",
  "DISABLE_COMPACT",
  "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
  "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  tmp = makeTempHome();
  await openDb(CWD);
  savedEnv = {};
  for (const k of GATE_ENV) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  tmp.restore();
  for (const k of GATE_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
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
    const ev = lastModelChanged(session);
    expect(ev?.unrecognizedModelWarning).toBe(TEXT);
    // One server-minted id on both, so the client shows it at most once.
    const id = (result as { unrecognizedModelWarningId?: string }).unrecognizedModelWarningId;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(ev?.unrecognizedModelWarningId).toBe(id);
    // A second switch to the same id is a new warning with a new id.
    const again = await session.setModel("my-gateway-model", "chat_command");
    expect((again as { unrecognizedModelWarningId?: string }).unrecognizedModelWarningId).not.toBe(id);
  });

  test("a recognized id, or a picker switch, carries none", async () => {
    const session = makeSession();
    await session.setModel("claude-opus-9-1", "chat_command");
    expect(lastModelChanged(session)?.unrecognizedModelWarning).toBeUndefined();
    expect(lastModelChanged(session)?.unrecognizedModelWarningId).toBeUndefined();
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
