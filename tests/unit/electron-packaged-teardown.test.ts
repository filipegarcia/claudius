import { afterEach, describe, expect, test, vi } from "vitest";

import { teardownPackaged, type LaunchedPackaged } from "../electron-packaged/launch";

// teardownPackaged used to `await app.close()` with no bound. When the packaged
// app wouldn't quit, the 150 s test timeout fired inside `afterEach` and the
// Linux AppImage smoke went red (flaky) even though every assertion had passed.

function fakeLaunched(close: () => Promise<void>) {
  const proc = { pid: 4242, exitCode: null as number | null, signalCode: null as string | null, kill: vi.fn() };
  const launched = { app: { close, process: () => proc } } as unknown as LaunchedPackaged;
  return { launched, proc };
}

describe("teardownPackaged", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("SIGKILLs the app when close() hangs past the bound", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { launched, proc } = fakeLaunched(() => new Promise<void>(() => {}));
    const done = teardownPackaged(launched);
    await vi.advanceTimersByTimeAsync(20_000);
    await done;
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("SIGKILLing pid 4242"));
  });

  test("doesn't kill an app that closes normally", async () => {
    const { launched, proc } = fakeLaunched(() => Promise.resolve());
    await teardownPackaged(launched);
    expect(proc.kill).not.toHaveBeenCalled();
  });

  test("doesn't kill when close() throws because the process already exited", async () => {
    const { launched, proc } = fakeLaunched(() => Promise.reject(new Error("Target closed")));
    await teardownPackaged(launched);
    expect(proc.kill).not.toHaveBeenCalled();
  });
});
