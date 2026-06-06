import { describe, expect, test } from "vitest";
import {
  formatBashIOBlock,
  pendingBashBlockCount,
  queueBashBlock,
  takePendingBashBlocks,
} from "@/lib/server/pending-bash-output";

/**
 * Pure-function fence around the `!`-mode bash IO queue. The wiring in
 * `Session.sendInput` (drain alongside `takePendingReminders`) is covered
 * by integration / manual flow. Here we only assert the queue's
 * contract: per-host isolation, FIFO ordering, single-drain semantics, and
 * the IO-block formatter that produces the canonical `<bash-input>` /
 * `<bash-stdout>` / `<bash-stderr>` wrapper.
 */

describe("pending-bash-output queue", () => {
  test("returns null when nothing is queued", () => {
    const host = { id: "h1" };
    expect(takePendingBashBlocks(host)).toBeNull();
    expect(pendingBashBlockCount(host)).toBe(0);
  });

  test("drains queued blocks in FIFO and clears the queue", () => {
    const host = { id: "h2" };
    queueBashBlock(host, "<bash-input>a</bash-input><bash-stdout></bash-stdout><bash-stderr></bash-stderr>");
    queueBashBlock(host, "<bash-input>b</bash-input><bash-stdout></bash-stdout><bash-stderr></bash-stderr>");
    expect(pendingBashBlockCount(host)).toBe(2);

    const drained = takePendingBashBlocks(host);
    expect(drained).not.toBeNull();
    // FIFO: a before b. Joined with `\n` between blocks, trailing `\n`.
    expect(drained).toBe(
      "<bash-input>a</bash-input><bash-stdout></bash-stdout><bash-stderr></bash-stderr>" +
        "\n" +
        "<bash-input>b</bash-input><bash-stdout></bash-stdout><bash-stderr></bash-stderr>" +
        "\n",
    );
    // Second drain finds the queue empty — single-shot semantics.
    expect(takePendingBashBlocks(host)).toBeNull();
    expect(pendingBashBlockCount(host)).toBe(0);
  });

  test("queues are isolated per host", () => {
    const a = { id: "a" };
    const b = { id: "b" };
    queueBashBlock(a, "block-a");
    expect(pendingBashBlockCount(a)).toBe(1);
    expect(pendingBashBlockCount(b)).toBe(0);
    // Draining a doesn't touch b.
    takePendingBashBlocks(a);
    queueBashBlock(b, "block-b");
    expect(takePendingBashBlocks(b)).toContain("block-b");
  });
});

describe("formatBashIOBlock", () => {
  test("produces the canonical Claude Code wrapper shape", () => {
    const block = formatBashIOBlock("ls -la", {
      stdout: "file.txt\n",
      stderr: "",
    });
    expect(block).toBe(
      "<bash-input>ls -la</bash-input>\n" +
        "<bash-stdout>file.txt\n</bash-stdout><bash-stderr></bash-stderr>",
    );
  });

  test("preserves stderr verbatim", () => {
    const block = formatBashIOBlock("false", {
      stdout: "",
      stderr: "command failed\n",
    });
    expect(block).toContain("<bash-stderr>command failed\n</bash-stderr>");
  });
});
