import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { Session } from "@/lib/server/session";
import { openDb } from "@/lib/server/db";
import {
  isFeedbackRefused,
  noteFeedbackRefused,
  resetSurveyThrottle,
  shouldOfferSurvey,
  surveyAllowedForProvider,
} from "@/lib/server/feedback-survey";
import type { ServerEvent } from "@/lib/shared/events";

import { makeTempHome, type TmpHome } from "./helpers/tmp-home";

/**
 * CC 2.1.319 parity:
 * - "Fixed Claude-drafted feedback, surveys and /feedback continuing to appear
 *   after the server refused feedback for your organization";
 * - "Fixed Claude drafting feedback on third-party gateways, where it can't be
 *   sent".
 *
 * Claudius rolls its own session-quality survey nudge (`feedback-survey.ts` +
 * `Session.maybeOfferFeedbackSurvey`). It read the org's refusal for the
 * banner (CC 2.1.309) but never remembered it, so the nudge came back every
 * 6h; and it was offered on Bedrock / Vertex / Foundry / gateway sessions,
 * where the forward can't reach Anthropic.
 */
const CWD = "/tmp/fake-session-feedback-refused-cwd";

let tmp: TmpHome;

beforeEach(async () => {
  tmp = makeTempHome();
  resetSurveyThrottle();
  await openDb(CWD);
});

afterEach(() => {
  resetSurveyThrottle();
  tmp.restore();
});

const base = { rate: 1, isError: false, sawUserInput: true, now: 10 ** 12, lastShownAt: 0, random: 0 };

describe("shouldOfferSurvey — 2.1.319 gates", () => {
  test("refused → never offered", () => {
    expect(shouldOfferSurvey(base)).toBe(true);
    expect(shouldOfferSurvey({ ...base, refused: true })).toBe(false);
  });

  test("only first-party (or unknown) providers get the nudge", () => {
    expect(surveyAllowedForProvider(undefined)).toBe(true);
    expect(surveyAllowedForProvider(null)).toBe(true);
    expect(surveyAllowedForProvider("firstParty")).toBe(true);
    for (const p of ["bedrock", "vertex", "foundry", "mantle", "anthropicAws", "anthropicGoogleCloud", "gateway"]) {
      expect(surveyAllowedForProvider(p)).toBe(false);
      expect(shouldOfferSurvey({ ...base, apiProvider: p })).toBe(false);
    }
  });

  test("the latch is process-wide and reset by the test seam", () => {
    expect(isFeedbackRefused()).toBe(false);
    noteFeedbackRefused();
    expect(isFeedbackRefused()).toBe(true);
    resetSurveyThrottle();
    expect(isFeedbackRefused()).toBe(false);
  });
});

type Internals = {
  query: unknown;
  sawUserInput: boolean;
  broadcast: (ev: ServerEvent) => void;
  maybeOfferFeedbackSurvey: (m: unknown) => Promise<void>;
  submitFeedback: Session["submitFeedback"];
};

function makeSession(query: Record<string, unknown>): { s: Internals; surveys: () => number } {
  const s = new Session({ id: "feedback-refused-test", cwd: CWD }) as unknown as Internals;
  const events: ServerEvent[] = [];
  s.broadcast = (ev) => {
    events.push(ev);
  };
  s.query = query;
  s.sawUserInput = true;
  return { s, surveys: () => events.filter((e) => e.type === "feedback_survey").length };
}

/** `feedbackSurveyRate: 1` in user settings so the roll always passes. */
async function alwaysRoll() {
  const { writeSettings } = await import("@/lib/server/settings");
  await writeSettings("user", CWD, { feedbackSurveyRate: 1 } as never);
}

describe("Session — survey nudge wiring", () => {
  test("an org refusal stops the nudge; a reasonless failure does not", async () => {
    await alwaysRoll();
    const { s, surveys } = makeSession({
      accountInfo: async () => ({ apiProvider: "firstParty" }),
      submitFeedback: async () => ({ feedback_id: null, failure_reason: "http_error" }),
    });
    await s.submitFeedback("hi");
    expect(isFeedbackRefused()).toBe(false);

    (s.query as Record<string, unknown>).submitFeedback = async () => ({
      feedback_id: null,
      unavailable_reason: "Your organization does not accept feedback.",
    });
    const res = await s.submitFeedback("hi");
    expect(res).toEqual({ forwarded: false, reason: "Your organization does not accept feedback." });
    expect(isFeedbackRefused()).toBe(true);

    await s.maybeOfferFeedbackSurvey({ type: "result", is_error: false });
    expect(surveys()).toBe(0);
  });

  test("a first-party session is still offered the nudge", async () => {
    await alwaysRoll();
    const { s, surveys } = makeSession({ accountInfo: async () => ({ apiProvider: "firstParty" }) });
    await s.maybeOfferFeedbackSurvey({ type: "result", is_error: false });
    expect(surveys()).toBe(1);
  });

  test("a Bedrock session is not offered the nudge", async () => {
    await alwaysRoll();
    let asked = 0;
    const { s, surveys } = makeSession({
      accountInfo: async () => {
        asked++;
        return { apiProvider: "bedrock" };
      },
    });
    await s.maybeOfferFeedbackSurvey({ type: "result", is_error: false });
    await s.maybeOfferFeedbackSurvey({ type: "result", is_error: false });
    expect(surveys()).toBe(0);
    expect(asked).toBe(1); // asked once per session
  });
});
