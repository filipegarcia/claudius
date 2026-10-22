/**
 * CC 2.1.309 parity — "[VSCode] Added a log warning that says what to do when
 * dictation or the extension's own requests fail certificate verification,
 * such as behind a TLS-inspecting proxy."
 *
 * Claudius proxies dictation itself (`lib/server/voice-stream.ts`). When the
 * upstream WebSocket's TLS handshake fails because the presented chain isn't
 * trusted, all the user used to see was Node's raw message ("unable to verify
 * the first certificate") on the mic's tooltip. This turns a CA-trust failure
 * into one actionable sentence; the proxy logs it and forwards it to the
 * composer.
 *
 * Only failures a CA bundle can fix are matched — an expired certificate or a
 * hostname mismatch is not a missing trust anchor, so those keep the raw
 * message.
 */

/** OpenSSL / Node error codes for "the chain doesn't lead to a trusted root". */
const CA_TRUST_CODES = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_UNTRUSTED",
]);

/**
 * Message fallback for runtimes that drop `err.code` (the Bun branch of
 * `openUpstream` rewraps the event into a plain `Error`). Matches Node's and
 * OpenSSL's wording for the same codes.
 */
const CA_TRUST_MESSAGE =
  /unable to verify the first certificate|unable to verify leaf signature|self[- ]signed certificate|unable to get (?:local )?issuer certificate|certificate (?:is )?(?:not )?(?:un)?trusted/i;

export function isCaTrustFailure(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && CA_TRUST_CODES.has(code)) return true;
  const message = (err as { message?: unknown }).message;
  return typeof message === "string" && CA_TRUST_MESSAGE.test(message);
}

/**
 * The hint for a CA-trust failure, or `null` when `err` isn't one.
 *
 * `extraCaConfigured` — whether an extra CA bundle was already in effect for
 * the socket (`NODE_EXTRA_CA_CERTS` in the real environment, or the
 * settings-only bundle `resolveExtraCaCerts` applied). Then the advice is to
 * check the bundle, not to set one.
 */
export function tlsCertFailureHint(
  err: unknown,
  opts: { extraCaConfigured: boolean },
): string | null {
  if (!isCaTrustFailure(err)) return null;
  if (opts.extraCaConfigured) {
    return (
      "Dictation couldn't verify the server's certificate even with NODE_EXTRA_CA_CERTS set. " +
      "Check that the bundle includes the CA of your TLS-inspecting proxy, then try again."
    );
  }
  return (
    "Dictation couldn't verify the server's certificate, usually because a TLS-inspecting proxy is in the way. " +
    "Set NODE_EXTRA_CA_CERTS to the proxy's CA bundle (in your environment or the env block of ~/.claude/settings.json), then try again."
  );
}
