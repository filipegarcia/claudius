import { EventEmitter } from "node:events";

import { afterEach, describe, expect, test, vi } from "vitest";

import { teardownPackaged, type LaunchedPackaged } from "../electron-packaged/launch";

// teardownPackaged used to `await app.close()` with no bound. When the packaged
// app wouldn't quit, the 150 s test timeout fired inside `afterEach` and the
// Linux AppImage smoke went red (flaky) even though every assertion had passed.
//
// The bound's SIGKILL then hit only the main pid. On Linux the orphaned
// next-server kept Playwright's stdio pipes open, the process never emitted
// `close`, and Playwright's worker teardown hung for 150 s instead
// (v0.3.332.0, v0.3.332.2). So teardown kills the whole process group and
// makes sure `close` fires.

function fakeLaunched(close: () => Promise<void>) {
  const stdio = [null, { destroy: vi.fn() }, { destroy: vi.fn() }, { destroy: vi.fn() }, { destroy: vi.fn() }];
  const proc = Object.assign(new EventEmitter(), {
    pid: 4242,
    exitCode: null as number | null,
    signalCode: null as string | null,
    kill: vi.fn(),
    stdio,
  });
  const launched = {
    app: { close, process: () => proc },
    readLogs: () => "boot log tail",
  } as unknown as LaunchedPackaged;
  return { launched, proc };
}

const hang = () => new Promise<void>(() => {});

describe("teardownPackaged", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("SIGKILLs the app's whole process group when close() hangs past the bound", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const { launched, proc } = fakeLaunched(hang);
    const done = teardownPackaged(launched);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(kill).toHaveBeenCalledWith(-4242, "SIGKILL");
    // proc.kill() would set proc.killed and stop Playwright's own group kill.
    expect(proc.kill).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("SIGKILLing process group 4242"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("boot log tail"));
    proc.emit("close", null, "SIGKILL");
    await done;
    for (const s of proc.stdio.slice(1)) expect(s?.destroy).not.toHaveBeenCalled();
  });

  test("destroys every stdio pipe when close never fires after the kill", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(process, "kill").mockImplementation(() => true);
    const { launched, proc } = fakeLaunched(hang);
    const done = teardownPackaged(launched);
    await vi.advanceTimersByTimeAsync(20_000 + 10_000);
    await done;
    // Node counts one close per piped fd, so stdout/stderr alone isn't enough.
    for (const s of proc.stdio.slice(1)) expect(s?.destroy).toHaveBeenCalled();
  });

  test("falls back to killing the pid when the group kill is refused", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    });
    const { launched, proc } = fakeLaunched(hang);
    const done = teardownPackaged(launched);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
    proc.emit("close", null, "SIGKILL");
    await done;
  });

  test("doesn't kill an app that closes normally", async () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const { launched, proc } = fakeLaunched(() => Promise.resolve());
    await teardownPackaged(launched);
    expect(kill).not.toHaveBeenCalled();
    expect(proc.kill).not.toHaveBeenCalled();
  });

  test("doesn't kill when close() throws because the process already exited", async () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const { launched, proc } = fakeLaunched(() => Promise.reject(new Error("Target closed")));
    await teardownPackaged(launched);
    expect(kill).not.toHaveBeenCalled();
    expect(proc.kill).not.toHaveBeenCalled();
  });
});
