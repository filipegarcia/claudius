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
 * Only chain-of-trust failures are matched — an expired certificate or a
 * hostname mismatch is not a trust problem, so those keep the raw message.
 *
 * CC 2.1.316 parity — "Improved SSL certificate errors to name the likely
 * causes, among them a server that leaves out an intermediate certificate,
 * and the fix for each". The engine now splits the old one-size "behind a
 * TLS-inspecting proxy, set NODE_EXTRA_CA_CERTS" advice by error code.
 * Every Claudius caller connects to Anthropic (dictation's
 * wss://api.anthropic.com, OAuth sign-in, the profile fetch), whose chain the
 * user can't change, so Claudius weighs the causes accordingly:
 *  - incomplete chain (UNABLE_TO_VERIFY_LEAF_SIGNATURE,
 *    UNABLE_TO_GET_ISSUER_CERT_LOCALLY): for these hosts almost always a
 *    TLS-inspecting proxy or private CA, so the composer one-liner is the
 *    proxy / NODE_EXTRA_CA_CERTS advice, word for word the untrusted-authority
 *    text. Only the longer log / own-request forms add, briefly, the
 *    engine's missing-intermediate cause — as the gateway case, where a
 *    server the user points Claudius at must send its full chain;
 *  - untrusted authority (self-signed in chain, ...): the proxy / private-CA
 *    advice as before;
 *  - broken local CA (UNABLE_TO_GET_ISSUER_CERT): a CA Claudius trusts is
 *    missing its own issuer, often a renewal leftover — remove it or add its
 *    issuer; a proxy has nothing to do with it. Claudius's Node server trusts
 *    its bundled roots plus the NODE_EXTRA_CA_CERTS file (not the OS store),
 *    so the fix points at that file.
 */

export type CertFailureCause = "incomplete-chain" | "untrusted-ca" | "broken-local-ca";

/** OpenSSL / Node error codes for "the chain doesn't lead to a trusted root", by cause. */
const CAUSE_BY_CODE = new Map<string, CertFailureCause>([
  ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "incomplete-chain"],
  ["UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "incomplete-chain"],
  ["SELF_SIGNED_CERT_IN_CHAIN", "untrusted-ca"],
  ["DEPTH_ZERO_SELF_SIGNED_CERT", "untrusted-ca"],
  ["CERT_UNTRUSTED", "untrusted-ca"],
  ["UNABLE_TO_GET_ISSUER_CERT", "broken-local-ca"],
]);

/**
 * Message fallback for runtimes that drop `err.code` (the Bun branch of
 * `openUpstream` rewraps the event into a plain `Error`). Matches Node's and
 * OpenSSL's wording for the same codes. Order matters: "unable to get local
 * issuer certificate" must be tried before the bare "issuer" form.
 */
const CAUSE_BY_MESSAGE: Array<[RegExp, CertFailureCause]> = [
  [/unable to get local issuer certificate/i, "incomplete-chain"],
  [/unable to verify the first certificate|unable to verify leaf signature/i, "incomplete-chain"],
  [/unable to get issuer certificate/i, "broken-local-ca"],
  [/self[- ]signed certificate|certificate (?:is )?(?:not )?(?:un)?trusted/i, "untrusted-ca"],
];

/**
 * CC 2.1.316 — which chain-of-trust failure `err` is, or `null` when it isn't
 * one. `fetch` (undici) wraps the TLS error as `TypeError("fetch failed")`
 * with the real one on `cause`, so walk a couple of levels.
 */
export function certFailureCause(err: unknown): CertFailureCause | null {
  let cur: unknown = err;
  for (let depth = 0; depth < 3 && cur && typeof cur === "object"; depth++) {
    const code = (cur as { code?: unknown }).code;
    const byCode = typeof code === "string" ? CAUSE_BY_CODE.get(code) : undefined;
    if (byCode) return byCode;
    const message = (cur as { message?: unknown }).message;
    if (typeof message === "string") {
      for (const [re, cause] of CAUSE_BY_MESSAGE) if (re.test(message)) return cause;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

export function isCaTrustFailure(err: unknown): boolean {
  return certFailureCause(err) !== null;
}

/**
 * The hint for a chain-of-trust failure, or `null` when `err` isn't one. Kept
 * short (≤120 chars): it's shown in the composer's one-line footer status
 * slot, so it gives the fix and the log carries the fuller explanation.
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
  switch (certFailureCause(err)) {
    // An incomplete chain to Anthropic's hosts is the proxy / private-CA case
    // for the user, so it gets the untrusted-authority one-liner verbatim.
    case "incomplete-chain":
    case "untrusted-ca":
      return opts.extraCaConfigured
        ? "Dictation couldn't connect — certificate not trusted even with NODE_EXTRA_CA_CERTS. Check it has your proxy's CA."
        : "Dictation couldn't connect — certificate not trusted. Set NODE_EXTRA_CA_CERTS to your proxy's CA bundle and try again.";
    case "broken-local-ca":
      return opts.extraCaConfigured
        ? "Dictation couldn't connect — a CA in your NODE_EXTRA_CA_CERTS file is missing its issuer. Remove it or add its issuer."
        : "Dictation couldn't connect — a trusted CA is missing its issuer. To fix, add its issuer to a NODE_EXTRA_CA_CERTS file.";
    default:
      return null;
  }
}

/** Where `NODE_EXTRA_CA_CERTS` can live for the dictation socket. */
const WHERE_TO_SET =
  "It can be set in the environment or in the env block of ~/.claude/settings.json.";

/** CC 2.1.316 — the engine's missing-intermediate cause, as the gateway case. */
const GATEWAY_INTERMEDIATE =
  "If you point Claudius at a gateway, that server may be leaving out an intermediate certificate — it must send its full chain.";

/** CC 2.1.316 — what a CA "missing its issuer" means and where to fix it. */
const BROKEN_LOCAL_CA =
  "A CA certificate Claudius trusts (its bundled roots plus the NODE_EXTRA_CA_CERTS file) is missing its own issuer, often a leftover from a renewal: remove it from the NODE_EXTRA_CA_CERTS file or add its issuer there.";

/**
 * The longer server-log form: the composer hint plus where the variable can
 * live and, by cause, the engine's fuller explanation. Claudius applies a
 * user-settings `env.NODE_EXTRA_CA_CERTS` to the dictation socket itself (CC
 * 2.1.307, `lib/server/extra-ca-certs.ts`), so either place works without a
 * restart.
 */
export function tlsCertFailureLogHint(
  err: unknown,
  opts: { extraCaConfigured: boolean },
): string | null {
  const hint = tlsCertFailureHint(err, opts);
  if (!hint) return null;
  const where = opts.extraCaConfigured ? [] : [WHERE_TO_SET];
  switch (certFailureCause(err)) {
    case "incomplete-chain":
      // Proxy / NODE_EXTRA_CA_CERTS advice first; the intermediate case last.
      return [hint, ...where, GATEWAY_INTERMEDIATE].join(" ");
    case "broken-local-ca":
      return [hint, BROKEN_LOCAL_CA, ...where].join(" ");
    default:
      return [hint, ...where].join(" ");
  }
}

/**
 * For Claudius's own HTTPS requests to Anthropic (account sign-in / profile),
 * which — unlike the dictation socket — only see a `NODE_EXTRA_CA_CERTS`
 * present in the environment when Claudius started. Kept short: it renders
 * inline in the /usage account header.
 */
export function ownRequestCertFailureHint(err: unknown): string | null {
  const proxy =
    "The server's certificate isn't trusted, usually because a TLS-inspecting proxy is in the way. Start Claudius with NODE_EXTRA_CA_CERTS set to the proxy's CA bundle.";
  switch (certFailureCause(err)) {
    case "incomplete-chain":
      // Sign-in / profile URLs are fixed to api.anthropic.com, so the
      // intermediate case is only a network gateway in between — one sentence.
      return `${proxy} Behind a gateway, it must send its full chain, intermediate certificate included.`;
    case "untrusted-ca":
      return proxy;
    case "broken-local-ca":
      return "A CA certificate Claudius trusts is missing its own issuer, often a leftover from a renewal. Remove it from the NODE_EXTRA_CA_CERTS file or add its issuer there, then restart Claudius.";
    default:
      return null;
  }
}
