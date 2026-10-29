import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { accountsDir, addAccount } from "@/lib/server/accounts-store";
import { encodeProjectDir } from "@/lib/server/auto-memory";
import { dayKey } from "@/lib/server/cost-aggregate";
import { aggregateOverview } from "@/lib/server/cost-overview";
import { __resetPricingMemo } from "@/lib/server/litellm-pricing";
import { mergeSessionState } from "@/lib/server/sessions-db";
import { createWorkspace } from "@/lib/server/workspaces-store";
import { UNPINNED_ACCOUNT_KEY, type CostOverview } from "@/lib/shared/cost-overview";
import { makeTempHome, type TmpHome } from "./helpers/tmp-home";

/**
 * The Account page's cross-project overview: every `~/.claude/projects`
 * dir (workspace or not), subagent transcripts included, spend split by
 * project and by the account each session was pinned to.
 */

const DAY = 86_400_000;
let tmp: TmpHome;
let prevAccountsDir: string | undefined;

beforeEach(() => {
  tmp = makeTempHome();
  prevAccountsDir = process.env.CLAUDIUS_ACCOUNTS_DIR;
  process.env.CLAUDIUS_ACCOUNTS_DIR = join(tmp.home, ".claude", ".claudius");
  process.env.CLAUDIUS_DISABLE_PRICE_REFRESH = "1";
  __resetPricingMemo();
});

afterEach(() => {
  if (prevAccountsDir === undefined) delete process.env.CLAUDIUS_ACCOUNTS_DIR;
  else process.env.CLAUDIUS_ACCOUNTS_DIR = prevAccountsDir;
  tmp.restore();
});

/** One API call record; `costUSD` pins the price so the test needs no table. */
function call(id: string, ms: number, usd: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: new Date(ms).toISOString(),
    requestId: `req_${id}`,
    costUSD: usd,
    message: { id, model: "claude-opus-5-5", usage: { input_tokens: 10, output_tokens: 20 } },
    ...extra,
  });
}

function write(path: string, lines: string[]): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, lines.join("\n") + "\n");
}

describe("aggregateOverview", () => {
  let overview: CostOverview;
  let ids: { alpha: string; beta: string; notes: string; legacy: string; work: string; personal: string };
  const now = Date.now();

  beforeEach(async () => {
    const projects = join(tmp.home, ".claude", "projects");
    const alphaRoot = join(tmp.home, "work", "alpha");
    const notesRoot = join(tmp.home, "notes");
    ids = {
      alpha: encodeProjectDir(alphaRoot),
      beta: encodeProjectDir("/x/beta"),
      notes: encodeProjectDir(notesRoot),
      legacy: encodeProjectDir("/legacy"),
      work: "",
      personal: "",
    };
    const ws = await createWorkspace({ name: "Alpha", rootPath: alphaRoot });
    expect(ws.rootPath).toBe(alphaRoot);
    ids.work = (await addAccount({ label: "Work", kind: "oauth-token", secret: "tok-work" })).profile.id;
    ids.personal = (await addAccount({ label: "Personal", kind: "oauth-token", secret: "tok-personal" }))
      .profile.id;

    // Alpha (a workspace): s-a1 is pinned to Work — one call split across two
    // content-block records, one more call, and a subagent call; s-a2 is
    // pinned to a profile that no longer exists, and replays beta's call.
    write(join(projects, ids.alpha, "s-a1.jsonl"), [
      call("a1-1", now, 1.0),
      call("a1-1", now, 1.0),
      call("a1-2", now, 0.5),
    ]);
    write(join(projects, ids.alpha, "s-a1", "subagents", "agent-x.jsonl"), [call("a1-sub", now, 2.0)]);
    write(join(projects, ids.alpha, "s-a2.jsonl"), [call("dup", now - 41 * DAY, 8.0), call("a2-1", now - 3 * DAY, 4.0)]);
    await mergeSessionState(alphaRoot, "s-a1", { accountProfileId: ids.work });
    await mergeSessionState(alphaRoot, "s-a2", { accountProfileId: "acc_gone0000000" });

    // Beta: never a workspace; its cwd comes from the transcript.
    write(join(projects, ids.beta, "s-b1.jsonl"), [
      call("b1-1", now - 42 * DAY, 0.5, { cwd: "/x/beta" }),
      call("dup", now - 41 * DAY, 8.0, { cwd: "/x/beta" }),
    ]);

    // ~/notes: an unpinned session here, and one in the Personal profile's
    // own (non-symlinked) projects dir under the same project.
    write(join(projects, ids.notes, "s-c1.jsonl"), [call("c1-1", now, 0.25, { cwd: notesRoot })]);
    const personalProjects = join(accountsDir(), "profiles", ids.personal, "projects");
    write(join(personalProjects, ids.notes, "s-p1.jsonl"), [call("p1-1", now, 3.0, { cwd: notesRoot })]);
    // A project only that profile ever ran.
    write(join(personalProjects, ids.legacy, "s-l1.jsonl"), [call("l1-1", now, 0.75, { cwd: "/legacy" })]);

    // A project dir with no transcripts is left out.
    mkdirSync(join(projects, "-empty-project"), { recursive: true });

    overview = await aggregateOverview();
  });

  test("totals cover every project, subagents included, each call once", () => {
    expect(overview.totalUsd).toBeCloseTo(20.0, 10);
    expect(overview.todayUsd).toBeCloseTo(7.5, 10);
    expect(overview.weekUsd).toBeCloseTo(11.5, 10);
    expect(overview.monthUsd).toBeCloseTo(11.5, 10);
    const sum = (xs: Array<{ usd: number }>) => xs.reduce((a, x) => a + x.usd, 0);
    expect(sum(overview.days)).toBeCloseTo(20.0, 10);
    expect(sum(overview.projects)).toBeCloseTo(20.0, 10);
    expect(sum(overview.accounts)).toBeCloseTo(20.0, 10);
    expect(overview.accountsConfigured).toBe(2);
  });

  test("projects: workspace name, else the transcript cwd; most expensive first", () => {
    const rows = overview.projects.map((p) => [p.key, p.label, p.usd, p.sessions]);
    expect(rows).toEqual([
      [ids.beta, "/x/beta", 8.5, 1],
      [ids.alpha, "Alpha", 7.5, 2],
      [ids.notes, "~/notes", 3.25, 2],
      [ids.legacy, "/legacy", 0.75, 1],
    ]);
    const alpha = overview.projects.find((p) => p.key === ids.alpha)!;
    expect(alpha.workspaceId).toMatch(/^wks_/);
    expect(alpha.cwd).toBe(join(tmp.home, "work", "alpha"));
    expect(overview.projects.find((p) => p.key === ids.beta)!.workspaceId).toBeNull();
  });

  test("accounts: session pins, a profile's own projects dir, removed profiles, unpinned", () => {
    const rows = overview.accounts.map((a) => [a.key, a.label, a.usd, a.sessions, a.removed]);
    expect(rows).toEqual([
      [UNPINNED_ACCOUNT_KEY, "No profile", 8.75, 2, false],
      ["acc_gone0000000", "Removed account (acc_gone0000)", 4.0, 1, true],
      [ids.personal, "Personal", 3.75, 2, false],
      [ids.work, "Work", 3.5, 1, false],
    ]);
  });

  test("days split by project and by account", () => {
    const today = overview.days.find((d) => d.date === dayKey(now))!;
    expect(today.usd).toBeCloseTo(7.5, 10);
    expect(today.byProject).toEqual({ [ids.alpha]: 3.5, [ids.notes]: 3.25, [ids.legacy]: 0.75 });
    expect(today.byAccount).toEqual({ [ids.work]: 3.5, [UNPINNED_ACCOUNT_KEY]: 0.25, [ids.personal]: 3.75 });
    // The replayed call counts once, for beta (whose file starts earlier).
    const replayDay = overview.days.find((d) => d.date === dayKey(now - 41 * DAY))!;
    expect(replayDay.byProject).toEqual({ [ids.beta]: 8.0 });
    expect(overview.days.map((d) => d.date)).toEqual([...overview.days.map((d) => d.date)].sort());
  });

  test("reading it creates no project DB and no stray project dir", () => {
    const projects = join(tmp.home, ".claude", "projects");
    expect(existsSync(join(projects, ids.beta, ".claudius.db"))).toBe(false);
    expect(existsSync(join(projects, ids.notes, ".claudius.db"))).toBe(false);
    expect(existsSync(join(projects, ids.legacy))).toBe(false);
  });
});
