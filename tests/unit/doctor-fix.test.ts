import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Coverage for CC 2.1.205 parity ("/doctor ... can diagnose and fix
 * issues"): POST /api/doctor/fix — the Doctor page's "Fix" button action.
 *
 * Scoped to the fixed allowlist of check ids (`claude-dir`, `projects-dir`)
 * that map to safe, non-user-controlled mkdir targets under `homedir()`.
 * `os.homedir()` reads `$HOME` on POSIX at call time (not module load), so
 * pointing `HOME` at a throwaway temp dir exercises the real handler/real
 * filesystem without touching the actual developer/CI `~/.claude`.
 */

const { POST } = await import("@/app/api/doctor/fix/route");

function req(body: unknown): Request {
  return new Request("http://localhost/api/doctor/fix", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/doctor/fix", () => {
  const originalHome = process.env.HOME;
  let fakeHome: string;

  beforeEach(async () => {
    fakeHome = await fs.mkdtemp(join(tmpdir(), "claudius-doctor-fix-"));
    process.env.HOME = fakeHome;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await fs.rm(fakeHome, { recursive: true, force: true });
  });

  test("rejects an unknown check id", async () => {
    const res = await POST(req({ id: "not-a-real-check" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
  });

  test("rejects a malformed body", async () => {
    const res = await POST(new Request("http://localhost/api/doctor/fix", { method: "POST", body: "not json" }));
    expect(res.status).toBe(400);
  });

  test("creates ~/.claude when fixing claude-dir", async () => {
    const res = await POST(req({ id: "claude-dir" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; path: string };
    expect(body.ok).toBe(true);
    expect(body.path).toBe(join(fakeHome, ".claude"));
    const stat = await fs.stat(body.path);
    expect(stat.isDirectory()).toBe(true);
  });

  test("creates ~/.claude/projects (including the parent) when fixing projects-dir", async () => {
    const res = await POST(req({ id: "projects-dir" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; path: string };
    expect(body.ok).toBe(true);
    const stat = await fs.stat(join(fakeHome, ".claude", "projects"));
    expect(stat.isDirectory()).toBe(true);
  });

  test("is idempotent — fixing an already-fixed check still succeeds", async () => {
    await POST(req({ id: "claude-dir" }));
    const res = await POST(req({ id: "claude-dir" }));
    expect(res.status).toBe(200);
  });
});
