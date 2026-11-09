/**
 * Eligibility logic for the CLI-style feedback nudge.
 *
 * The CLI shows its session-quality survey "when eligible" with a probability
 * set by `feedbackSurveyRate` (the SDK documents 0.05 as a reasonable start).
 * That heuristic lives only in the CLI TUI — it's never emitted as a
 * programmatic event — so we replicate it here: after a (successful) turn
 * finishes, roll the dice, subject to a per-process throttle so a chatty
 * session doesn't get nagged every few turns.
 *
 * The decision is a pure function so it's unit-testable; the throttle
 * timestamp is module state (shared across all sessions in the process).
 */

/** SDK's suggested starting probability when the setting is absent. */
export const DEFAULT_FEEDBACK_SURVEY_RATE = 0.05;

/** Minimum gap between nudges across the whole process. */
export const SURVEY_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h

let lastShownAt = 0;

export function getLastSurveyShownAt(): number {
  return lastShownAt;
}

export function noteSurveyShown(now: number): void {
  lastShownAt = now;
}

/**
 * CC 2.1.319 parity — "Fixed Claude-drafted feedback, surveys and /feedback
 * continuing to appear after the server refused feedback for your
 * organization". Once a forward comes back refused (`unavailable_reason` —
 * not a transport failure), the nudge stops for the rest of the process:
 * re-asking every 6h for feedback the org won't take is pure nagging. A
 * process-wide latch, like the throttle above; a restart (e.g. after switching
 * to an account whose org does accept feedback) clears it.
 */
let feedbackRefused = false;

export function noteFeedbackRefused(): void {
  feedbackRefused = true;
}

export function isFeedbackRefused(): boolean {
  return feedbackRefused;
}

/** Test seam — reset the process-wide throttle (and the refusal latch). */
export function resetSurveyThrottle(): void {
  lastShownAt = 0;
  feedbackRefused = false;
}

/**
 * CC 2.1.319 parity — "Fixed Claude drafting feedback on third-party
 * gateways, where it can't be sent". The survey forwards through the engine
 * to Anthropic, which only works on the Anthropic API (`apiProvider:
 * "firstParty"` in the SDK's `accountInfo()`). Bedrock, Vertex, Foundry,
 * Mantle, the AWS / Google Cloud marketplace offerings and gateway sign-ins
 * can't send it, so the nudge isn't offered there. An unknown provider (an
 * older SDK, or `accountInfo()` failing) keeps the old behaviour.
 */
export function surveyAllowedForProvider(apiProvider: unknown): boolean {
  if (typeof apiProvider !== "string" || !apiProvider) return true;
  return apiProvider === "firstParty";
}

/** Clamp an arbitrary settings value into a usable [0, 1] probability. */
export function coerceSurveyRate(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return DEFAULT_FEEDBACK_SURVEY_RATE;
  }
  if (raw < 0) return 0;
  if (raw > 1) return 1;
  return raw;
}

export type SurveyDecisionInput = {
  /** Probability in [0, 1]. */
  rate: number;
  /** The turn that just finished ended in an error. */
  isError: boolean;
  /** A real user prompt was seen in this process (not an automated run). */
  sawUserInput: boolean;
  now: number;
  lastShownAt: number;
  /** Defaults to {@link SURVEY_MIN_INTERVAL_MS}. */
  minIntervalMs?: number;
  /** Injectable roll for tests; defaults to Math.random(). */
  random?: number;
  /** The org refused a forward earlier in this process (see {@link noteFeedbackRefused}). */
  refused?: boolean;
  /** `accountInfo().apiProvider`, when known (see {@link surveyAllowedForProvider}). */
  apiProvider?: string;
};

export function shouldOfferSurvey(opts: SurveyDecisionInput): boolean {
  const minIntervalMs = opts.minIntervalMs ?? SURVEY_MIN_INTERVAL_MS;
  if (opts.isError) return false;
  if (!opts.sawUserInput) return false;
  if (opts.refused) return false;
  if (!surveyAllowedForProvider(opts.apiProvider)) return false;
  if (opts.rate <= 0) return false;
  if (opts.now - opts.lastShownAt < minIntervalMs) return false;
  const roll = opts.random ?? Math.random();
  return roll < opts.rate;
}
