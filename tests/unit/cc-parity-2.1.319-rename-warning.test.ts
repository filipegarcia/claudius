import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * CC 2.1.319 parity — "Fixed `/rename` reporting plain success when the new
 * name could not be saved to the session transcript; it now warns that the
 * new name may not last".
 *
 * Claudius's index takes the name either way, but the JSONL `custom-title`
 * line is what the CLI and `--resume` read. `Session.rename` and the non-live
 * route now return `warning` when that append failed on a transcript that
 * exists (and the engine didn't take the name itself); the "no JSONL yet"
 * case stays plain success (it is re-mirrored at the next turn).
 */

const sdk = vi.hoisted(() => ({ renameError: null as Error | null, indexed: 0 }));

vi.mock("@/lib/server/sessions-db", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/server/sessions-db")>();
  return { ...real, retitleIndexedSession: async () => sdk.indexed };
});

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const real = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  return {
    ...real,
    renameSession: async () => {
      if (sdk.renameError) throw sdk.renameError;
    },
  };
});

import { Session } from "@/lib/server/session";
import { openDb } from "@/lib/server/db";
import {
  isMissingTranscriptError,
  RENAME_MAY_NOT_LAST_WARNING,
  renameToastText,
} from "@/lib/shared/rename-warning";
import { makeTempHome, type TmpHome } from "./helpers/tmp-home";

const CWD = "/tmp/fake-session-rename-warning-cwd";
const ID = "0f9a7c2e-3b1d-4e5f-8a6b-2c3d4e5f6a7b";

let tmp: TmpHome;

beforeEach(async () => {
  tmp = makeTempHome();
  sdk.renameError = null;
  sdk.indexed = 0;
  await openDb(CWD);
});

afterEach(() => {
  tmp.restore();
});

describe("rename-warning helpers", () => {
  test("only the SDK's 'Session … not found' counts as no transcript yet", () => {
    expect(isMissingTranscriptError(new Error(`Session ${ID} not found in project directory for /x`))).toBe(true);
    expect(isMissingTranscriptError(new Error(`Session ${ID} not found (no projects directory)`))).toBe(true);
    expect(isMissingTranscriptError(new Error("EACCES: permission denied, open '/x.jsonl'"))).toBe(false);
    expect(isMissingTranscriptError(new Error("ENOSPC: no space left on device, write"))).toBe(false);
    expect(isMissingTranscriptError(undefined)).toBe(false);
  });

  test("toast text", () => {
    expect(renameToastText()).toBe("Renamed");
    expect(renameToastText(RENAME_MAY_NOT_LAST_WARNING)).toBe(
      "Renamed — the new name may not last: the session transcript could not be updated",
    );
  });
});

describe("Session.rename", () => {
  function makeSession() {
    return new Session({ id: ID, cwd: CWD });
  }

  test("a transcript write that fails for a real reason warns", async () => {
    sdk.renameError = new Error("EACCES: permission denied, open '/x.jsonl'");
    await expect(makeSession().rename("New name")).resolves.toEqual({ ok: true, warning: RENAME_MAY_NOT_LAST_WARNING });
  });

  test("no transcript yet is plain success (re-mirrored next turn)", async () => {
    sdk.renameError = new Error(`Session ${ID} not found in project directory for ${CWD}`);
    await expect(makeSession().rename("New name")).resolves.toEqual({ ok: true });
  });

  test("a successful write is plain success", async () => {
    await expect(makeSession().rename("New name")).resolves.toEqual({ ok: true });
  });

  test("no warning when the engine took the name (it persists the title itself)", async () => {
    sdk.renameError = new Error("EACCES: permission denied");
    const s = makeSession();
    (s as unknown as { query: unknown }).query = { renameSession: async () => ({}) };
    await expect(s.rename("New name")).resolves.toEqual({ ok: true });
  });
});

describe("POST /api/sessions/rename (session not live)", () => {
  async function post(body: unknown) {
    const { POST } = await import("@/app/api/sessions/rename/route");
    const res = await POST(new Request("http://x/api/sessions/rename", { method: "POST", body: JSON.stringify(body) }));
    return { status: res.status, json: await res.json() };
  }

  test("no index row + failed write is still an error", async () => {
    sdk.renameError = new Error("EACCES: permission denied");
    const r = await post({ sessionId: ID, title: "New name" });
    expect(r.status).toBe(500);
  });

  test("a successful write is plain ok", async () => {
    const r = await post({ sessionId: ID, title: "New name" });
    expect(r).toEqual({ status: 200, json: { ok: true } });
  });

  test("indexed + failed transcript write → ok with the warning", async () => {
    sdk.indexed = 1;
    sdk.renameError = new Error("ENOSPC: no space left on device, write");
    const r = await post({ sessionId: ID, title: "New name" });
    expect(r).toEqual({ status: 200, json: { ok: true, warning: RENAME_MAY_NOT_LAST_WARNING } });
  });

  test("indexed + no transcript yet → plain ok", async () => {
    sdk.indexed = 1;
    sdk.renameError = new Error(`Session ${ID} not found (no projects directory)`);
    const r = await post({ sessionId: ID, title: "New name" });
    expect(r).toEqual({ status: 200, json: { ok: true } });
  });
});
