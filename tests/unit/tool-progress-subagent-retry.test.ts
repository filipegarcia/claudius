import { describe, expect, test } from "vitest";
import { toolProgressInfoFromSdkMessage } from "@/lib/client/use-session";

/**
 * Coverage for the SDK 0.3.214 `tool_progress` additions: `subagent_type`
 * and `subagent_retry` let a client show one of several parallel subagents
 * waiting out an API rate-limit retry (distinct from the existing global
 * `apiRetry` indicator, which can only represent the main thread).
 */
describe("toolProgressInfoFromSdkMessage", () => {
  test("maps the base fields unchanged (pre-0.3.214 shape)", () => {
    const info = toolProgressInfoFromSdkMessage({
      tool_use_id: "toolu_1",
      tool_name: "Bash",
      elapsed_time_seconds: 4.2,
      parent_tool_use_id: null,
    });
    expect(info).toEqual({
      toolUseId: "toolu_1",
      toolName: "Bash",
      elapsedSeconds: 4.2,
      parentToolUseId: null,
      subagentType: undefined,
      subagentRetry: undefined,
    });
  });

  test("maps subagent_type through untouched", () => {
    const info = toolProgressInfoFromSdkMessage({
      tool_use_id: "toolu_2",
      tool_name: "Read",
      elapsed_time_seconds: 1,
      parent_tool_use_id: "toolu_task",
      subagent_type: "code-reviewer",
    });
    expect(info.subagentType).toBe("code-reviewer");
    expect(info.subagentRetry).toBeUndefined();
  });

  test("snake_case → camelCase for subagent_retry, including a null error_status", () => {
    const info = toolProgressInfoFromSdkMessage({
      tool_use_id: "toolu_3",
      tool_name: "WebFetch",
      elapsed_time_seconds: 12,
      parent_tool_use_id: "toolu_task",
      subagent_retry: {
        agent_id: "agent_abc",
        attempt: 2,
        max_retries: 5,
        retry_delay_ms: 4000,
        error_status: null,
        error_category: "connection_error",
      },
    });
    expect(info.subagentRetry).toEqual({
      agentId: "agent_abc",
      attempt: 2,
      maxRetries: 5,
      retryDelayMs: 4000,
      errorStatus: null,
      errorCategory: "connection_error",
    });
  });

  test("maps a numeric error_status (HTTP 429) through", () => {
    const info = toolProgressInfoFromSdkMessage({
      tool_use_id: "toolu_4",
      tool_name: "Bash",
      elapsed_time_seconds: 8,
      parent_tool_use_id: "toolu_task",
      subagent_retry: {
        agent_id: "agent_def",
        attempt: 1,
        max_retries: 5,
        retry_delay_ms: 1000,
        error_status: 429,
        error_category: "rate_limit",
      },
    });
    expect(info.subagentRetry?.errorStatus).toBe(429);
  });
});
