import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { otelEndpointNotices } from "@/lib/shared/telemetry-env";

/**
 * CC 2.1.328 — "Added a notice in `/status` and `claude doctor` when an
 * OpenTelemetry exporter has no endpoint and its data would likely be lost".
 *
 * Claudius draws its own /doctor and /status, so the engine's notice never
 * reached either. `otelEndpointNotices` ports the engine's rule and copy; the
 * shared config-file problem list (behind /api/doctor/files and /api/doctor)
 * carries it, so /status counts and shows it and /doctor lists it.
 */

const { listConfigFileProblems, configFileChecks, telemetryEnv } = await import("@/lib/server/config-file-problems");
const filesRoute = await import("@/app/api/doctor/files/route");

const ON = { CLAUDE_CODE_ENABLE_TELEMETRY: "1" };

describe("otelEndpointNotices — the engine's rule", () => {
  test("telemetry off, or no otlp exporter: no notice", () => {
    expect(otelEndpointNotices({ OTEL_METRICS_EXPORTER: "otlp" })).toEqual([]);
    expect(otelEndpointNotices({ CLAUDE_CODE_ENABLE_TELEMETRY: "0", OTEL_METRICS_EXPORTER: "otlp" })).toEqual([]);
    expect(otelEndpointNotices({ ...ON })).toEqual([]);
    expect(otelEndpointNotices({ ...ON, OTEL_METRICS_EXPORTER: "console" })).toEqual([]);
    expect(otelEndpointNotices({ ...ON, OTEL_METRICS_EXPORTER: "otlp", ENABLE_BETA_TRACING_DETAILED: "1" })).toEqual([]);
  });

  test("an otlp exporter with no endpoint and no protocol: telemetry can't start", () => {
    expect(otelEndpointNotices({ ...ON, OTEL_METRICS_EXPORTER: "otlp" })).toEqual([
      "OpenTelemetry: No endpoint or protocol is set for metrics, so telemetry can't start. " +
        "Set OTEL_EXPORTER_OTLP_ENDPOINT or OTEL_EXPORTER_OTLP_METRICS_ENDPOINT, or take otlp out of " +
        "OTEL_METRICS_EXPORTER. Then restart Claude Code.",
    ]);
    // "true"/"yes"/"on" count as on; the exporter list is comma-separated.
    expect(
      otelEndpointNotices({ CLAUDE_CODE_ENABLE_TELEMETRY: " Yes ", OTEL_METRICS_EXPORTER: "console, otlp", OTEL_LOGS_EXPORTER: "otlp" }),
    ).toEqual([
      "OpenTelemetry: No endpoint or protocol is set for metrics and logs, so telemetry can't start. " +
        "Set OTEL_EXPORTER_OTLP_ENDPOINT or OTEL_EXPORTER_OTLP_METRICS_ENDPOINT and OTEL_EXPORTER_OTLP_LOGS_ENDPOINT, " +
        "or take otlp out of OTEL_METRICS_EXPORTER and OTEL_LOGS_EXPORTER. Then restart Claude Code.",
    ]);
  });

  test("a shared or per-signal endpoint silences it", () => {
    const env = { ...ON, OTEL_METRICS_EXPORTER: "otlp", OTEL_LOGS_EXPORTER: "otlp" };
    expect(otelEndpointNotices({ ...env, OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4317" })).toEqual([]);
    expect(
      otelEndpointNotices({
        ...env,
        OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://c:4317",
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://c:4317",
      }),
    ).toEqual([]);
  });

  test("traces count only with the enhanced-telemetry beta", () => {
    const env = { ...ON, OTEL_TRACES_EXPORTER: "otlp" };
    expect(otelEndpointNotices(env)).toEqual([]);
    expect(otelEndpointNotices({ ...env, CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "1" })).toEqual([
      "OpenTelemetry: No endpoint or protocol is set for traces, so metrics and traces aren't sent. " +
        "Set OTEL_EXPORTER_OTLP_ENDPOINT or OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, or take otlp out of " +
        "OTEL_TRACES_EXPORTER. Then restart Claude Code.",
    ]);
    expect(otelEndpointNotices({ ...env, ENABLE_ENHANCED_TELEMETRY_BETA: "true" })).toHaveLength(1);
  });

  test("with a protocol set, a signal without an endpoint beside one with its own goes to localhost", () => {
    const env = {
      ...ON,
      OTEL_METRICS_EXPORTER: "otlp",
      OTEL_LOGS_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_PROTOCOL: "grpc",
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://c:4317",
    };
    expect(otelEndpointNotices(env)).toEqual([
      "OpenTelemetry: No endpoint is set for logs, so they go to localhost, where they're lost unless a " +
        "collector is running. Set OTEL_EXPORTER_OTLP_ENDPOINT or OTEL_EXPORTER_OTLP_LOGS_ENDPOINT, or take otlp " +
        "out of OTEL_LOGS_EXPORTER. Then restart Claude Code.",
    ]);
    // A per-signal protocol counts too.
    const { OTEL_EXPORTER_OTLP_PROTOCOL: _drop, ...noShared } = env;
    void _drop;
    expect(otelEndpointNotices({ ...noShared, OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "http/protobuf" })[0]).toContain(
      "No endpoint is set for logs, so they go to localhost",
    );
    // With a protocol but no signal having its own endpoint, the engine says nothing.
    expect(
      otelEndpointNotices({ ...ON, OTEL_METRICS_EXPORTER: "otlp", OTEL_EXPORTER_OTLP_PROTOCOL: "grpc" }),
    ).toEqual([]);
  });
});

describe("the doctor / status problem list", () => {
  const originalHome = process.env.HOME;
  let fakeHome: string;

  beforeEach(async () => {
    fakeHome = await fs.mkdtemp(join(tmpdir(), "claudius-otel-home-"));
    process.env.HOME = fakeHome;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await fs.rm(fakeHome, { recursive: true, force: true });
  });

  test("the notice is a telemetry problem with a warn check, and the file rows stay ok", async () => {
    const problems = await listConfigFileProblems([], { env: { ...ON, OTEL_METRICS_EXPORTER: "otlp" } });
    expect(problems).toEqual([
      expect.objectContaining({ kind: "telemetry", scope: "user", name: "OpenTelemetry", path: "env:OpenTelemetry" }),
    ]);
    expect(problems[0].reason).toMatch(/^OpenTelemetry: No endpoint or protocol is set for metrics/);
    const checks = configFileChecks(problems);
    expect(checks.map((c) => [c.id, c.status])).toEqual([
      ["config-file:telemetry", "warn"],
      ["config-file:agents-skills", "ok"],
      ["config-file:keybindings", "ok"],
    ]);
    expect(checks[0]).toMatchObject({
      label: "OpenTelemetry exporter has no endpoint",
      detail: problems[0].reason,
      link: { href: "/settings", label: "Open Settings → Environment" },
      category: "config-files",
    });
  });

  test("without an env the lister reports files only", async () => {
    expect(await listConfigFileProblems([])).toEqual([]);
  });

  test("telemetryEnv layers user settings.env over the process env (project scope is not read)", async () => {
    await fs.mkdir(join(fakeHome, ".claude"), { recursive: true });
    await fs.writeFile(
      join(fakeHome, ".claude", "settings.json"),
      JSON.stringify({ env: { CLAUDE_CODE_ENABLE_TELEMETRY: "1", OTEL_LOGS_EXPORTER: "otlp" } }),
    );
    const env = await telemetryEnv();
    expect(env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe("1");
    expect(env.OTEL_LOGS_EXPORTER).toBe("otlp");
    expect(env.HOME).toBe(fakeHome);
  });

  test("GET /api/doctor/files counts the notice from user settings", async () => {
    await fs.mkdir(join(fakeHome, ".claude"), { recursive: true });
    await fs.writeFile(
      join(fakeHome, ".claude", "settings.json"),
      JSON.stringify({ env: { CLAUDE_CODE_ENABLE_TELEMETRY: "1", OTEL_METRICS_EXPORTER: "otlp" } }),
    );
    const res = await filesRoute.GET(new Request("http://localhost/api/doctor/files?workspaceId=none"));
    const body = (await res.json()) as { problems: Array<{ kind: string; reason: string }>; checks: Array<{ id: string }> };
    const telemetry = body.problems.filter((p) => p.kind === "telemetry");
    expect(telemetry).toHaveLength(1);
    expect(telemetry[0].reason).toContain("so telemetry can't start");
    expect(body.checks.map((c) => c.id)).toContain("config-file:telemetry");
  });
});
