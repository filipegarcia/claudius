/**
 * CC 2.1.295 parity — "Fixed 'Fork conversation from here' and Rewind's
 * conversation restore failing with 'Message not found in session' after a
 * background agent's activity or one of the panel's own status lines".
 *
 * Claudius's analogue: the chat reducer mints display-only ids for some user
 * bubbles that don't exist verbatim in the session JSONL. The CC 2.1.285
 * trailing-text bubble (real prose typed after a leading CLI/IDE wrapper tag
 * like `<local-command-stdout>…`) is rendered under `${uuid}:trailing`, where
 * `uuid` is the wrapper record that actually carries the text. Sending that
 * synthetic id to `/api/sessions/fork` (`upToMessageId`) or the file-rewind
 * route (`userMessageId`) fails with "Message not found in session" because
 * the SDK looks it up by the on-disk record uuid.
 *
 * Both the minting (`trailingBubbleUuid`) and the mapping back to the backing
 * record (`forkableUuid`) live here so they can't drift apart.
 */

export const TRAILING_BUBBLE_SUFFIX = ":trailing";

/** Display id for the trailing-text bubble lifted out of record `uuid`. */
export function trailingBubbleUuid(uuid: string): string {
  return `${uuid}${TRAILING_BUBBLE_SUFFIX}`;
}

/**
 * Map a display-message uuid back to the JSONL record uuid the SDK can fork /
 * rewind at. Plain record uuids pass through unchanged; only a terminal
 * `:trailing` suffix is stripped (idempotent — a backing record uuid never
 * ends in it).
 */
export function forkableUuid(uuid: string): string {
  return uuid.endsWith(TRAILING_BUBBLE_SUFFIX)
    ? uuid.slice(0, -TRAILING_BUBBLE_SUFFIX.length)
    : uuid;
}

/** Toast copy when the fork request fails (shared with the e2e assertion). */
export function forkFailedMessage(error: string): string {
  return `Couldn't fork from here: ${error}`;
}
