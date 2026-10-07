import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Job } from "@/lib/server/scheduler-store";

/**
 * CC 2.1.292 parity — "saved tasks ignoring later creates and deletes after
 * two writes to the tasks file milliseconds apart". Claudius's own scheduler
 * had the same shape: unserialized read-modify-write of `jobs.json`, and a
 * run writing its start-of-run job snapshot back on finish (resurrecting a
 * job deleted mid-run, reverting a mid-run disable).
 */

let home: string;
let store: typeof import("@/lib/server/scheduler-store");
const prevHome = process.env.HOME;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "claudius-sched-"));
  process.env.HOME = home;
  vi.resetModules();
  store = await import("@/lib/server/scheduler-store");
});

afterAll(() => {
  process.env.HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

function job(id: string, over: Partial<Job> = {}): Job {
  return {
    id,
    name: id,
    cron: "0 * * * *",
    prompt: "p",
    cwd: home,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

describe("scheduler-store jobs.json writes", () => {
  test("patchJob on a deleted job writes nothing and returns null", async () => {
    await store.saveJob(job("gone"));
    const snapshot = await store.getJob("gone");
    expect(await store.deleteJob("gone")).toBe(true);
    // A run that started before the delete finishes now.
    const out = await store.patchJob("gone", { lastStatus: "success", lastRunAt: 5 });
    expect(out).toBeNull();
    expect(snapshot).not.toBeNull();
    expect(await store.getJob("gone")).toBeNull();
  });

  test("patchJob keeps fields changed after the caller's snapshot", async () => {
    await store.saveJob(job("edit"));
    await store.patchJob("edit", { enabled: false, prompt: "new" }); // user edits mid-run
    const after = await store.patchJob("edit", { lastStatus: "success" }); // run finishes
    expect(after).toMatchObject({ enabled: false, prompt: "new", lastStatus: "success" });
  });

  test("concurrent writes milliseconds apart are all kept", async () => {
    await store.saveJob(job("base"));
    await Promise.all([
      store.saveJob(job("c1")),
      store.patchJob("base", { lastStatus: "running" }),
      store.saveJob(job("c2")),
      store.deleteJob("base"),
      store.saveJob(job("c3")),
    ]);
    const ids = (await store.listJobs()).map((j) => j.id).sort();
    expect(ids).toEqual(expect.arrayContaining(["c1", "c2", "c3"]));
    expect(ids).not.toContain("base");
  });
});
