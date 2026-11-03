import { describe, expect, test } from "vitest";
import { describeSessionWritesLost } from "@/lib/shared/session-writes-lost";

/**
 * SDK 0.3.317 — `system/session_writes_lost`: the CLI could not save part of
 * the transcript and/or ~/.claude.json because the disk was full (ENOSPC) or
 * its quota was used up (EDQUOT).
 */
describe("describeSessionWritesLost", () => {
  test("transcript loss on a full disk warns that a resume may be incomplete", () => {
    const { label, detail } = describeSessionWritesLost({
      error_code: "ENOSPC",
      lost: ["transcript"],
      transcript_session_ids: ["s1"],
    });
    expect(label).toBe("Couldn't save the session transcript: the disk is full");
    expect(detail).toContain("Free up disk space.");
    expect(detail).toContain("Resuming the session may miss part of the conversation.");
  });

  test("global_config-only loss on a quota error omits the resume warning", () => {
    const { label, detail } = describeSessionWritesLost({ error_code: "EDQUOT", lost: ["global_config"] });
    expect(label).toBe("Couldn't save changes to ~/.claude.json: the disk quota is used up");
    expect(detail).not.toContain("Resuming");
  });

  test("both kinds are joined", () => {
    const { label } = describeSessionWritesLost({ error_code: "ENOSPC", lost: ["transcript", "global_config"] });
    expect(label).toContain("the session transcript and changes to ~/.claude.json");
  });

  test("tolerates unknown codes and malformed fields", () => {
    const { label } = describeSessionWritesLost({ error_code: "EWHAT", lost: "nope" });
    expect(label).toBe("Couldn't save session data: the disk could not be written");
    const unknownKind = describeSessionWritesLost({ error_code: "ENOSPC", lost: ["something_new"] });
    expect(unknownKind.label).toContain("something_new");
  });
});
