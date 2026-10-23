import { describe, expect, it } from "vitest";

import {
  DANGEROUS_RM_REWRITE_HINT,
  bypassDangerousRmDenial,
} from "@/lib/shared/dangerous-rm-deny";
import {
  FEEDBACK_REASON_MAX,
  feedbackRefusalReason,
  interpretFeedbackResponse,
} from "@/lib/shared/feedback-refusal";
import { isHistoryWorthyDbRow } from "@/lib/shared/session-history";
import {
  isCaTrustFailure,
  ownRequestCertFailureHint,
  tlsCertFailureHint,
  tlsCertFailureLogHint,
} from "@/lib/shared/tls-cert-hint";

// The `decision_reason` forms the engine (CC 2.1.309) forwards to canUseTool
// for its dangerous-removal checks: `Dangerous ${rm|rmdir} operation <detail>`.
const RM_WORKSPACE = "Dangerous rm operation on working directory or its ancestor: .";
const RMDIR_CRITICAL = "Dangerous rmdir operation on critical path: /usr";
const RM_UNCHECKED =
  "Dangerous rm operation not ruled out — some nested commands or function substitutions could not be analyzed";
const RM_SHELL_C =
  "Dangerous rm operation in a shell -c script, on a target built from a value known only when it runs";
const RM_DERIVED_VAR =
  "Dangerous rm operation on possibly-empty variable path: ${OUT}/x (use a literal path: $OUT is set in this command from `mktemp -d`, which can print nothing)";

describe("bypassDangerousRmDenial (CC 2.1.309)", () => {
  it("denies a dangerous rm safety check in bypass mode, with the engine reason and a rewrite hint", () => {
    const msg = bypassDangerousRmDenial({
      permissionMode: "bypassPermissions",
      decisionReason: RM_WORKSPACE,
      decisionReasonType: "safetyCheck",
    });
    expect(msg).not.toBeNull();
    expect(msg!.startsWith(RM_WORKSPACE)).toBe(true);
    expect(msg!.endsWith(DANGEROUS_RM_REWRITE_HINT)).toBe(true);
    // The engine's own advice wins; the generic hint never suggests a guard
    // (it can't help when the variable is set in the same command).
    expect(DANGEROUS_RM_REWRITE_HINT).not.toContain("${");
  });

  it("covers rmdir, compound commands and the could-not-check variant", () => {
    for (const [reason, type] of [
      [RMDIR_CRITICAL, "safetyCheck"],
      [RM_WORKSPACE, "subcommandResults"],
      [RM_UNCHECKED, "safetyCheck"],
      [RM_SHELL_C, "safetyCheck"],
      [RM_DERIVED_VAR, "subcommandResults"],
    ] as const) {
      expect(
        bypassDangerousRmDenial({ permissionMode: "bypassPermissions", decisionReason: reason, decisionReasonType: type }),
      ).not.toBeNull();
    }
  });

  it("leaves every other mode on the normal prompt", () => {
    for (const mode of ["default", "acceptEdits", "plan", "auto", "dontAsk"]) {
      expect(
        bypassDangerousRmDenial({ permissionMode: mode, decisionReason: RM_WORKSPACE, decisionReasonType: "safetyCheck" }),
      ).toBeNull();
    }
  });

  it("never auto-denies an ask a user rule forced", () => {
    expect(
      bypassDangerousRmDenial({
        permissionMode: "bypassPermissions",
        decisionReason: RM_WORKSPACE,
        decisionReasonType: "safetyCheck",
        matchedAskRule: { source: "userSettings", toolName: "Bash", ruleContent: "rm:*" },
      }),
    ).toBeNull();
  });

  it("ignores other safety checks and non-safety reasons", () => {
    expect(
      bypassDangerousRmDenial({
        permissionMode: "bypassPermissions",
        decisionReason: "Claude requested permissions to edit .git/config, which is a sensitive file.",
        decisionReasonType: "safetyCheck",
      }),
    ).toBeNull();
    expect(
      bypassDangerousRmDenial({ permissionMode: "bypassPermissions", decisionReason: RM_WORKSPACE, decisionReasonType: "hook" }),
    ).toBeNull();
    expect(
      bypassDangerousRmDenial({ permissionMode: "bypassPermissions", decisionReason: undefined, decisionReasonType: "safetyCheck" }),
    ).toBeNull();
  });

  it("strips ANSI from the engine reason", () => {
    const msg = bypassDangerousRmDenial({
      permissionMode: "bypassPermissions",
      decisionReason: `\u001b[1m${RMDIR_CRITICAL}\u001b[0m`,
      decisionReasonType: "safetyCheck",
    });
    expect(msg).not.toContain("\u001b");
    expect(msg!.startsWith("Dangerous rmdir operation")).toBe(true);
  });
});

describe("tlsCertFailureHint (CC 2.1.309 dictation cert warning)", () => {
  const leaf = Object.assign(new Error("unable to verify the first certificate"), {
    code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  });

  it("matches CA-trust failures by code and by message (Bun rewraps without a code)", () => {
    expect(isCaTrustFailure(leaf)).toBe(true);
    expect(isCaTrustFailure(Object.assign(new Error("x"), { code: "SELF_SIGNED_CERT_IN_CHAIN" }))).toBe(true);
    expect(isCaTrustFailure(new Error("self signed certificate in certificate chain"))).toBe(true);
    expect(isCaTrustFailure(new Error("unable to get local issuer certificate"))).toBe(true);
  });

  it("leaves failures a CA bundle can't fix alone", () => {
    expect(isCaTrustFailure(Object.assign(new Error("certificate has expired"), { code: "CERT_HAS_EXPIRED" }))).toBe(false);
    expect(
      isCaTrustFailure(Object.assign(new Error("Hostname/IP does not match certificate's altnames"), { code: "ERR_TLS_CERT_ALTNAME_INVALID" })),
    ).toBe(false);
    expect(isCaTrustFailure(new Error("socket hang up"))).toBe(false);
    expect(tlsCertFailureHint(new Error("ECONNRESET"), { extraCaConfigured: false })).toBeNull();
  });

  it("tells the user to set NODE_EXTRA_CA_CERTS when none is configured", () => {
    const hint = tlsCertFailureHint(leaf, { extraCaConfigured: false })!;
    expect(hint).toContain("Set NODE_EXTRA_CA_CERTS");
    // Short enough for the composer's one-line footer.
    expect(hint.length).toBeLessThanOrEqual(120);
    // The server log adds where the variable can live.
    expect(tlsCertFailureLogHint(leaf, { extraCaConfigured: false })).toContain("~/.claude/settings.json");
  });

  it("sees through fetch's TypeError wrapper (code on `cause`) for Claudius's own requests", () => {
    const wrapped = new TypeError("fetch failed", { cause: leaf });
    expect(isCaTrustFailure(wrapped)).toBe(true);
    expect(ownRequestCertFailureHint(wrapped)).toContain("Start Claudius with NODE_EXTRA_CA_CERTS");
    expect(ownRequestCertFailureHint(new TypeError("fetch failed", { cause: new Error("ECONNREFUSED") }))).toBeNull();
  });

  it("tells the user to check the bundle when one is already applied", () => {
    const hint = tlsCertFailureHint(leaf, { extraCaConfigured: true })!;
    expect(hint).toContain("even with NODE_EXTRA_CA_CERTS");
    expect(hint).not.toContain("Set NODE_EXTRA_CA_CERTS");
  });
});

describe("feedbackRefusalReason (CC 2.1.309)", () => {
  it("keeps the server's reason from an Error or a string", () => {
    expect(feedbackRefusalReason(new Error("Your organization does not accept feedback."))).toBe(
      "Your organization does not accept feedback.",
    );
    expect(feedbackRefusalReason("Feedback is disabled by your organization's policy.")).toBe(
      "Feedback is disabled by your organization's policy.",
    );
  });

  it("flattens ANSI, control characters and whitespace", () => {
    expect(feedbackRefusalReason(new Error("\u001b[31mNot\naccepted\u0007  here\u001b[0m"))).toBe("Not accepted here");
  });

  it("returns undefined when there's nothing to show", () => {
    expect(feedbackRefusalReason(new Error("   "))).toBeUndefined();
    expect(feedbackRefusalReason({ code: 403 })).toBeUndefined();
    expect(feedbackRefusalReason(null)).toBeUndefined();
  });

  it("drops the CLI's trailing bug-report pointer (the banner links to issues)", () => {
    expect(
      feedbackRefusalReason("/feedback requires Anthropic credentials (OAuth or API key). Report issues at https://github.com/anthropics/claude-code/issues"),
    ).toBe("/feedback requires Anthropic credentials (OAuth or API key).");
  });

  it("caps by code point so an emoji is never cut in half", () => {
    const long = "🚫".repeat(FEEDBACK_REASON_MAX + 10);
    const out = feedbackRefusalReason(new Error(long))!;
    expect(Array.from(out)).toHaveLength(FEEDBACK_REASON_MAX);
    expect(out.endsWith("…")).toBe(true);
    expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(out)).toBe(false);
  });
});

describe("interpretFeedbackResponse (CC 2.1.309 — refusals resolve, they don't reject)", () => {
  it("reads an org refusal from a resolved response", () => {
    expect(
      interpretFeedbackResponse({ feedback_id: null, unavailable_reason: "Your organization does not accept feedback." }),
    ).toEqual({ forwarded: false, reason: "Your organization does not accept feedback." });
    expect(
      interpretFeedbackResponse({
        feedback_id: null,
        is_zdr_org: true,
        failure_reason: "http_error",
        status_code: 403,
        unavailable_reason: "Feedback collection is not available for organizations with custom data retention policies.",
      }),
    ).toEqual({
      forwarded: false,
      reason: "Feedback collection is not available for organizations with custom data retention policies.",
    });
  });

  it("treats a failure code alone as not sent, without a reason", () => {
    expect(interpretFeedbackResponse({ feedback_id: null, failure_reason: "http_error", status_code: 503 })).toEqual({
      forwarded: false,
    });
  });

  it("treats a feedback id, or an older SDK's empty answer, as sent", () => {
    expect(interpretFeedbackResponse({ feedback_id: "fb_123" })).toEqual({ forwarded: true });
    expect(interpretFeedbackResponse(undefined)).toEqual({ forwarded: true });
    expect(interpretFeedbackResponse({})).toEqual({ forwarded: true });
  });
});

describe("isHistoryWorthyDbRow (CC 2.1.309 empty Untitled sessions)", () => {
  const notLive = () => false;
  it("drops an untitled DB-only row that isn't open", () => {
    expect(isHistoryWorthyDbRow({ id: "a", title: null }, notLive)).toBe(false);
    expect(isHistoryWorthyDbRow({ id: "a", title: "   " }, notLive)).toBe(false);
  });
  it("keeps a renamed-before-first-turn row", () => {
    expect(isHistoryWorthyDbRow({ id: "a", title: "Release prep" }, notLive)).toBe(true);
  });
  it("keeps the user's currently-open empty session", () => {
    expect(isHistoryWorthyDbRow({ id: "a", title: null }, (id) => id === "a")).toBe(true);
  });
});
