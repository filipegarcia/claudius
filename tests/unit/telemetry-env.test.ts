import { describe, expect, test } from "vitest";
import { ignoredAttachmentsEnvKeys, ignoredTelemetryEnvKeys } from "@/lib/shared/telemetry-env";

/**
 * CC 2.1.282 (H13) — OTEL/telemetry env vars the engine ignores in
 * project/local settings.
 */
describe("ignoredTelemetryEnvKeys (H13)", () => {
  test("flags OTEL_* and the master telemetry toggle, preserving spelling", () => {
    const env = {
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
      OTEL_METRICS_EXPORTER: "otlp",
      CLAUDE_CODE_ENABLE_TELEMETRY: "1",
      PATH: "/usr/bin",
      MY_API_KEY: "x",
    };
    expect(ignoredTelemetryEnvKeys(env).sort()).toEqual([
      "CLAUDE_CODE_ENABLE_TELEMETRY",
      "OTEL_EXPORTER_OTLP_ENDPOINT",
      "OTEL_METRICS_EXPORTER",
    ]);
  });

  test("case-insensitive OTEL prefix / toggle", () => {
    expect(ignoredTelemetryEnvKeys({ otel_logs_exporter: "otlp" })).toEqual(["otel_logs_exporter"]);
  });

  test("no telemetry vars → empty", () => {
    expect(ignoredTelemetryEnvKeys({ PATH: "/bin", FOO: "bar" })).toEqual([]);
    expect(ignoredTelemetryEnvKeys(undefined)).toEqual([]);
    expect(ignoredTelemetryEnvKeys(null)).toEqual([]);
  });
});

/**
 * CC 2.1.290 — a repository's settings can no longer set
 * CLAUDE_CODE_DISABLE_ATTACHMENTS.
 */
describe("ignoredAttachmentsEnvKeys (CC 2.1.290)", () => {
  test("flags CLAUDE_CODE_DISABLE_ATTACHMENTS, preserving spelling", () => {
    expect(ignoredAttachmentsEnvKeys({ CLAUDE_CODE_DISABLE_ATTACHMENTS: "1", PATH: "/bin" })).toEqual([
      "CLAUDE_CODE_DISABLE_ATTACHMENTS",
    ]);
    expect(ignoredAttachmentsEnvKeys({ claude_code_disable_attachments: "1" })).toEqual([
      "claude_code_disable_attachments",
    ]);
  });

  test("ignores everything else, including the telemetry keys", () => {
    expect(ignoredAttachmentsEnvKeys({ OTEL_METRICS_EXPORTER: "otlp", CLAUDE_CODE_DISABLE_ATTACHMENTS_X: "1" })).toEqual([]);
    expect(ignoredAttachmentsEnvKeys(undefined)).toEqual([]);
    expect(ignoredAttachmentsEnvKeys(null)).toEqual([]);
  });
});
