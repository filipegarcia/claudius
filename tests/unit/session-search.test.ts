import { describe, expect, test } from "vitest";
import { parseSessionQuery, scoreSession } from "@/lib/shared/session-search";

/**
 * CC 2.1.287/2.1.288 (H1) — ranked session name search + `n:` names-only.
 */
describe("parseSessionQuery (H1)", () => {
  test("a leading n: switches to names-only and strips the prefix", () => {
    expect(parseSessionQuery("n:deploy")).toEqual({ text: "deploy", namesOnly: true });
    expect(parseSessionQuery("N: deploy ")).toEqual({ text: "deploy", namesOnly: true });
  });
  test("no prefix → normal search", () => {
    expect(parseSessionQuery("  deploy ")).toEqual({ text: "deploy", namesOnly: false });
  });
});

describe("scoreSession (H1)", () => {
  const s = (f: Partial<Parameters<typeof scoreSession>[0]>) => ({ sessionId: "sess_abc", ...f });

  test("title exact > prefix > substring > first-prompt > id", () => {
    expect(scoreSession(s({ customTitle: "deploy" }), "deploy")).toBe(100);
    expect(scoreSession(s({ customTitle: "deploy checks" }), "deploy")).toBe(80);
    expect(scoreSession(s({ customTitle: "run deploy now" }), "deploy")).toBe(60);
    expect(scoreSession(s({ firstPrompt: "please deploy the app" }), "deploy")).toBe(40);
    expect(scoreSession({ sessionId: "sess_deploy_1" }, "deploy")).toBe(20);
  });

  test("best tier across title fields wins", () => {
    // customTitle substring (60) vs claudiusTitle prefix (80) → 80.
    expect(scoreSession(s({ customTitle: "x deploy", claudiusTitle: "deploy run" }), "deploy")).toBe(80);
  });

  test("no match → null", () => {
    expect(scoreSession(s({ customTitle: "nothing here" }), "deploy")).toBeNull();
  });

  test("namesOnly ignores the session id", () => {
    expect(scoreSession({ sessionId: "sess_deploy" }, "deploy", true)).toBeNull();
    expect(scoreSession({ sessionId: "sess_deploy" }, "deploy", false)).toBe(20);
  });

  test("ranking a list: exact title sorts above a first-prompt hit", () => {
    const list = [
      s({ firstPrompt: "deploy please", sessionId: "a" }),
      s({ customTitle: "deploy", sessionId: "b" }),
    ];
    const ranked = list
      .map((x) => ({ x, score: scoreSession(x, "deploy") }))
      .filter((r) => r.score != null)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .map((r) => r.x.sessionId);
    expect(ranked).toEqual(["b", "a"]);
  });
});
