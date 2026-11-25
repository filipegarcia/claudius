import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StatusOverlay } from "@/components/overlays/StatusOverlay";
import { planModeModel, planModeNote } from "@/lib/shared/model-recognition";

/**
 * CC 2.1.329 — "Fixed `/status` not naming the model that opusplan and haiku
 * use in plan mode".
 *
 * Claudius's /status printed the model setting raw: `opusplan` said nothing
 * about plan-mode turns running on Opus, `haiku` nothing about them running
 * on Sonnet. The engine's rule (`ype`) and wording (`HFa`) are ported.
 */

const CATALOG = [
  { value: "default", resolvedModel: "claude-sonnet-5-5" },
  { value: "opus", resolvedModel: "claude-opus-5-5" },
  { value: "opus[1m]", resolvedModel: "claude-opus-5-5[1m]" },
  { value: "sonnet", resolvedModel: "claude-sonnet-5-5" },
  { value: "haiku", resolvedModel: "claude-haiku-4-5" },
];

describe("planModeModel — the engine's ype()", () => {
  test.each([
    ["opusplan", { family: "opus", upTo200k: true }],
    ["opusplan[1m]", { family: "opus", upTo200k: true }],
    ["haiku", { family: "sonnet", upTo200k: false }],
    ["sonnet", null],
    ["opus", null],
    ["claude-haiku-4-5", null],
    ["default", null],
    [null, null],
  ])("%s → %j", (setting, expected) => {
    expect(planModeModel(setting)).toEqual(expected);
  });
});

describe("planModeNote — the engine's /status suffix", () => {
  test("names the version from the session catalog", () => {
    expect(planModeNote("opusplan", CATALOG)).toBe("Opus 5.5 in plan mode, up to 200k tokens");
    expect(planModeNote("opusplan[1m]", CATALOG)).toBe("Opus 5.5 in plan mode, up to 200k tokens");
    expect(planModeNote("haiku", CATALOG)).toBe("Sonnet 5.5 in plan mode");
  });

  test("without a catalog, names the family", () => {
    expect(planModeNote("opusplan")).toBe("Opus in plan mode, up to 200k tokens");
    expect(planModeNote("haiku", [])).toBe("Sonnet in plan mode");
  });

  test("other models have no note", () => {
    expect(planModeNote("sonnet", CATALOG)).toBeNull();
    expect(planModeNote("claude-haiku-4-5", CATALOG)).toBeNull();
  });
});

describe("the /status Model row", () => {
  const render = (model: string | null, permissionMode: "default" | "plan" = "default") =>
    renderToStaticMarkup(
      createElement(StatusOverlay, {
        sessionId: "s1",
        cwd: "/repo",
        model,
        permissionMode,
        ready: true,
        pending: false,
        toolCount: 0,
        agentCount: 0,
        skillCount: 0,
        slashCount: 0,
        mainAgent: null,
        agentCwd: null,
        account: null,
        onClose: () => {},
      }),
    );

  test("opusplan and haiku name their plan-mode model", () => {
    expect(render("opusplan")).toContain("opusplan</code>");
    expect(render("opusplan")).toContain(" · Opus in plan mode, up to 200k tokens");
    expect(render("haiku")).toContain(" · Sonnet in plan mode");
  });

  test("the note stands out while in plan mode", () => {
    expect(render("opusplan", "plan")).toMatch(/data-testid="status-plan-mode-model" class="text-\[var\(--accent\)\]"/);
    expect(render("opusplan")).toMatch(/data-testid="status-plan-mode-model" class="text-\[var\(--muted\)\]"/);
  });

  test("other models show no note", () => {
    expect(render("claude-sonnet-5-5")).not.toContain("status-plan-mode-model");
    expect(render("claude-haiku-4-5")).not.toContain("in plan mode");
  });
});
