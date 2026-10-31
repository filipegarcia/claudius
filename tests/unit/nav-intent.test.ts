import { describe, expect, it, vi } from "vitest";
import { markNavigating, navIntentSeq, withNavIntent } from "@/lib/client/nav-intent";

type Router = Parameters<typeof withNavIntent>[0];

function fakeRouter(onNav: (method: string, seqAtCall: number, args: unknown[]) => void): Router {
  return {
    push: (...args: unknown[]) => onNav("push", navIntentSeq(), args),
    replace: (...args: unknown[]) => onNav("replace", navIntentSeq(), args),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  } as unknown as Router;
}

describe("nav-intent", () => {
  it("markNavigating bumps the monotonic sequence", () => {
    const a = navIntentSeq();
    markNavigating();
    markNavigating();
    expect(navIntentSeq()).toBe(a + 2);
  });

  it("push/replace record the intent BEFORE navigating and pass args through", () => {
    const calls: Array<{ method: string; seqAtCall: number; args: unknown[] }> = [];
    const r = withNavIntent(fakeRouter((method, seqAtCall, args) => calls.push({ method, seqAtCall, args })));
    const before = navIntentSeq();
    r.push("/usage", { scroll: false });
    r.replace("/settings");
    expect(calls).toEqual([
      // The `?session=` writer's timer must already see the bump when the
      // push starts its (async) RSC fetch.
      { method: "push", seqAtCall: before + 1, args: ["/usage", { scroll: false }] },
      { method: "replace", seqAtCall: before + 2, args: ["/settings", undefined] },
    ]);
  });

  it("other router methods are untouched and record nothing", () => {
    const base = fakeRouter(() => {});
    const r = withNavIntent(base);
    const before = navIntentSeq();
    r.back();
    r.refresh();
    r.prefetch("/usage");
    expect(navIntentSeq()).toBe(before);
    expect(base.back).toHaveBeenCalledOnce();
    expect(base.refresh).toHaveBeenCalledOnce();
    expect(base.prefetch).toHaveBeenCalledWith("/usage");
  });
});
