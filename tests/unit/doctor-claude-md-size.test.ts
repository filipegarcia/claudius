import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Coverage for CC 2.1.206 parity ("/doctor ... proposes trimming checked-in
 * CLAUDE.md files by cutting content Claude could derive from the
 * codebase"): GET /api/doctor gains a per-workspace `claude-md-size:<id>`
 * warn check when a workspace's checked-in CLAUDE.md content (the `project`
 * + `project-claude` scopes) crosses the line-count threshold.
 *
 * `os.homedir()` is read at call time by both the workspaces store and this
 * check, so pointing `HOME` at a throwaway temp dir exercises the real
 * handler against a real (fake) workspace list without touching the actual
 * developer/CI `~/.claude/.claudius/workspaces.json`.
 */

const { GET } = await import("@/app/api/doctor/route");
const { createWorkspace, updateWorkspace } = await import("@/lib/server/workspaces-store");

type Check = {
  id: string;
  label: string;
  status: string;
  detail?: string;
  link?: { href: string; label: string };
};

async function runChecks(): Promise<Check[]> {
  const res = await GET();
  const body = (await res.json()) as { checks: Check[] };
  return body.checks;
}

describe("GET /api/doctor — claude-md-size check", () => {
  const originalHome = process.env.HOME;
  let fakeHome: string;
  let projectDir: string;

  beforeEach(async () => {
    fakeHome = await fs.mkdtemp(join(tmpdir(), "claudius-doctor-claudemd-"));
    process.env.HOME = fakeHome;
    projectDir = await fs.mkdtemp(join(tmpdir(), "claudius-doctor-project-"));
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await fs.rm(fakeHome, { recursive: true, force: true });
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  test("omits the check for a workspace with no CLAUDE.md", async () => {
    await createWorkspace({ name: "Empty project", rootPath: projectDir });
    const checks = await runChecks();
    expect(checks.some((c) => c.id.startsWith("claude-md-size:"))).toBe(false);
  });

  test("omits the check for a workspace with a small CLAUDE.md", async () => {
    await fs.writeFile(join(projectDir, "CLAUDE.md"), "# Short\n\nJust a few lines.\n", "utf8");
    await createWorkspace({ name: "Small project", rootPath: projectDir });
    const checks = await runChecks();
    expect(checks.some((c) => c.id.startsWith("claude-md-size:"))).toBe(false);
  });

  test("warns and links to Memory for a workspace with an oversized checked-in CLAUDE.md", async () => {
    const bigContent = Array.from({ length: 400 }, (_, i) => `Line ${i} of house style.`).join("\n");
    await fs.writeFile(join(projectDir, "CLAUDE.md"), bigContent, "utf8");
    const ws = await createWorkspace({ name: "Big project", rootPath: projectDir });

    const checks = await runChecks();
    const check = checks.find((c) => c.id === `claude-md-size:${ws.id}`);
    expect(check).toBeDefined();
    expect(check?.status).toBe("warn");
    expect(check?.label).toContain("Big project");
    expect(check?.detail).toContain("400 lines");
    expect(check?.detail).toContain("1 checked-in file");
    expect(check?.link).toEqual({ href: `/${ws.id}/memory`, label: "Review in Memory" });
  });

  test("combines project + .claude/CLAUDE.md scopes toward the threshold", async () => {
    const half = Array.from({ length: 200 }, (_, i) => `Line ${i}`).join("\n");
    await fs.writeFile(join(projectDir, "CLAUDE.md"), half, "utf8");
    await fs.mkdir(join(projectDir, ".claude"), { recursive: true });
    await fs.writeFile(join(projectDir, ".claude", "CLAUDE.md"), half, "utf8");
    const ws = await createWorkspace({ name: "Split project", rootPath: projectDir });

    const checks = await runChecks();
    const check = checks.find((c) => c.id === `claude-md-size:${ws.id}`);
    expect(check).toBeDefined();
    expect(check?.detail).toContain("2 checked-in files");
  });

  test("does not overcount a trailing newline (matches wc -l, not split('\\n').length)", async () => {
    // Exactly 300 lines, written the way editors normally do (trailing \n).
    // A naive `content.split("\n").length` would report 301 and false-trip
    // the >300 threshold on a file that is exactly at the line, not over it.
    const exactlyThreshold = Array.from({ length: 300 }, (_, i) => `Line ${i}`).join("\n") + "\n";
    await fs.writeFile(join(projectDir, "CLAUDE.md"), exactlyThreshold, "utf8");
    const ws = await createWorkspace({ name: "Exactly at threshold", rootPath: projectDir });

    const checks = await runChecks();
    expect(checks.find((c) => c.id === `claude-md-size:${ws.id}`)).toBeUndefined();
  });

  test("skips customization workspaces (not a user project)", async () => {
    const bigContent = Array.from({ length: 400 }, (_, i) => `Line ${i}`).join("\n");
    await fs.writeFile(join(projectDir, "CLAUDE.md"), bigContent, "utf8");
    const ws = await createWorkspace({ name: "Dogfood workspace", rootPath: projectDir });
    await updateWorkspace(ws.id, { kind: "customization" });

    const checks = await runChecks();
    expect(checks.find((c) => c.id === `claude-md-size:${ws.id}`)).toBeUndefined();
  });
});
