import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readSettings, writeSettings, SettingsParseError } from "@/lib/server/settings";
import { SLASH_COMMANDS } from "@/lib/shared/slash-commands";
import type { Job } from "@/lib/server/scheduler-store";

/**
 * CC 2.1.331 — "Fixed switching models failing with 'Settings file is not
 * valid JSON' when settings.json is empty or starts with a byte order mark".
 * Claudius's own `readSettings` refused both, so a model pick didn't persist
 * and every save to the scope was a 422.
 */
describe("readSettings — empty and BOM files (2.1.331)", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "claudius-settings-bom-"));
    mkdirSync(join(cwd, ".claude"), { recursive: true });
  });
  const file = () => join(cwd, ".claude", "settings.json");

  test("an empty or whitespace-only file reads as no settings", async () => {
    for (const body of ["", "\n", "  \r\n\t"]) {
      writeFileSync(file(), body);
      expect(await readSettings("project", cwd)).toEqual({});
    }
  });

  test("a leading byte order mark is ignored, and the next write drops it", async () => {
    writeFileSync(file(), '﻿{"model":"claude-opus-5"}\n');
    expect(await readSettings("project", cwd)).toEqual({ model: "claude-opus-5" });
    await writeSettings("project", cwd, { model: "claude-sonnet-5-5" });
    expect(readFileSync(file(), "utf8").charCodeAt(0)).not.toBe(0xfeff);
    expect(await readSettings("project", cwd)).toEqual({ model: "claude-sonnet-5-5" });
  });

  test("a genuinely broken file still refuses (never read as {})", async () => {
    writeFileSync(file(), '﻿{"model":');
    await expect(readSettings("project", cwd)).rejects.toBeInstanceOf(SettingsParseError);
  });
});

/**
 * CC 2.1.328 — "Changed `/code-review` on most models to report only bugs and
 * CLAUDE.md violations; run `/simplify` for reuse, simplification and
 * efficiency cleanups". The `/` picker shows Claudius's registry copy.
 */
describe("/simplify and /code-review copy (2.1.328)", () => {
  test("each says what it does now", () => {
    const simplify = SLASH_COMMANDS.find((c) => c.id === "simplify");
    const review = SLASH_COMMANDS.find((c) => c.id === "review");
    expect(simplify?.description).toMatch(/reuse, simplification, efficiency/);
    expect(simplify?.description).toMatch(/\/code-review/);
    expect(review?.aliases).toContain("code-review");
    expect(review?.description).toMatch(/bugs and CLAUDE\.md violations/);
  });
});

/**
 * CC 2.1.328 — "Fixed saving a scheduled task erasing the project's other
 * saved tasks when the scheduled tasks file can't be read". Claudius's own
 * `jobs.json` read a wrong-shape file as empty, and the next new job wrote
 * `{ jobs: [thatOne] }` over it.
 */
describe("scheduler jobs.json that can't be read (2.1.328)", () => {
  let home: string;
  let store: typeof import("@/lib/server/scheduler-store");
  const prevHome = process.env.HOME;
  const jobsFile = () => join(home, ".claude", "claudius", "schedule", "jobs.json");
  const job = (id: string): Job => ({
    id,
    name: id,
    cron: "0 * * * *",
    prompt: "p",
    cwd: home,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  });

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "claudius-sched-shape-"));
    process.env.HOME = home;
    vi.resetModules();
    store = await import("@/lib/server/scheduler-store");
    mkdirSync(join(home, ".claude", "claudius", "schedule"), { recursive: true });
  });
  afterAll(() => {
    process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  test("a missing file is still an empty list, and a create works", async () => {
    rmSync(jobsFile(), { force: true });
    expect(await store.listJobs()).toEqual([]);
    await store.saveJob(job("a"));
    expect((await store.listJobs()).map((j) => j.id)).toEqual(["a"]);
  });

  test.each([
    ["no jobs key", '{"job":[{"id":"x"}]}'],
    ["jobs is not a list", '{"jobs":{"x":{}}}'],
    ["a bare array", "[]"],
    ["not JSON", '{"jobs":[{"id":"x"},'],
  ])("%s: every write refuses and the file is left byte-identical", async (_label, body) => {
    writeFileSync(jobsFile(), body);
    await expect(store.listJobs()).rejects.toBeInstanceOf(store.JobsFileShapeError);
    await expect(store.saveJob(job("new"))).rejects.toBeInstanceOf(store.JobsFileShapeError);
    await expect(store.patchJob("x", { name: "y" })).rejects.toBeInstanceOf(store.JobsFileShapeError);
    await expect(store.deleteJob("x")).rejects.toBeInstanceOf(store.JobsFileShapeError);
    expect(readFileSync(jobsFile(), "utf8")).toBe(body);
  });

  test("the error names the file and says nothing was saved", async () => {
    writeFileSync(jobsFile(), '{"jobs":{}}');
    await expect(store.listJobs()).rejects.toThrow(/Couldn't read .*jobs\.json: .*Nothing was saved/);
  });

  test("a boot that hit an unreadable file is retried once it's fixed", async () => {
    vi.resetModules();
    const { scheduler } = await import("@/lib/server/scheduler");
    writeFileSync(jobsFile(), "[]");
    await expect(scheduler.boot()).rejects.toThrow(/jobs\.json/);
    writeFileSync(jobsFile(), JSON.stringify({ jobs: [] }));
    await expect(scheduler.boot()).resolves.toBeUndefined();
  });
});
