/**
 * CC 2.1.316 parity — "Improved SSL certificate errors to name the likely
 * causes, among them a server that leaves out an intermediate certificate,
 * and the fix for each".
 *
 * Pins `certFailureCause` (code → cause, message fallback, `cause` walking)
 * and that every hint names its own cause and fix.
 */
import { describe, expect, it } from "vitest";
import {
  certFailureCause,
  isCaTrustFailure,
  ownRequestCertFailureHint,
  tlsCertFailureHint,
  tlsCertFailureLogHint,
  type CertFailureCause,
} from "@/lib/shared/tls-cert-hint";

const withCode = (code: string, message = "x") => Object.assign(new Error(message), { code });

const SAMPLE: Record<CertFailureCause, Error> = {
  "incomplete-chain": withCode("UNABLE_TO_VERIFY_LEAF_SIGNATURE", "unable to verify the first certificate"),
  "untrusted-ca": withCode("SELF_SIGNED_CERT_IN_CHAIN", "self-signed certificate in certificate chain"),
  "broken-local-ca": withCode("UNABLE_TO_GET_ISSUER_CERT", "unable to get issuer certificate"),
};

describe("certFailureCause (CC 2.1.316)", () => {
  it("maps each OpenSSL code to its cause", () => {
    expect(certFailureCause(withCode("UNABLE_TO_VERIFY_LEAF_SIGNATURE"))).toBe("incomplete-chain");
    expect(certFailureCause(withCode("UNABLE_TO_GET_ISSUER_CERT_LOCALLY"))).toBe("incomplete-chain");
    expect(certFailureCause(withCode("SELF_SIGNED_CERT_IN_CHAIN"))).toBe("untrusted-ca");
    expect(certFailureCause(withCode("DEPTH_ZERO_SELF_SIGNED_CERT"))).toBe("untrusted-ca");
    expect(certFailureCause(withCode("CERT_UNTRUSTED"))).toBe("untrusted-ca");
    expect(certFailureCause(withCode("UNABLE_TO_GET_ISSUER_CERT"))).toBe("broken-local-ca");
  });

  it("falls back to the message when the code is gone (Bun rewrap), local issuer first", () => {
    expect(certFailureCause(new Error("unable to get local issuer certificate"))).toBe("incomplete-chain");
    expect(certFailureCause(new Error("unable to get issuer certificate"))).toBe("broken-local-ca");
    expect(certFailureCause(new Error("unable to verify the first certificate"))).toBe("incomplete-chain");
    expect(certFailureCause(new Error("self signed certificate"))).toBe("untrusted-ca");
    expect(certFailureCause(new Error("certificate not trusted"))).toBe("untrusted-ca");
  });

  it("sees through fetch's TypeError('fetch failed') wrapper", () => {
    const wrapped = new TypeError("fetch failed", { cause: withCode("UNABLE_TO_GET_ISSUER_CERT") });
    expect(certFailureCause(wrapped)).toBe("broken-local-ca");
    const deeper = new Error("outer", { cause: new TypeError("fetch failed", { cause: SAMPLE["incomplete-chain"] }) });
    expect(certFailureCause(deeper)).toBe("incomplete-chain");
  });

  it("ignores failures that aren't about the chain of trust", () => {
    expect(certFailureCause(withCode("CERT_HAS_EXPIRED", "certificate has expired"))).toBeNull();
    expect(certFailureCause(withCode("ERR_TLS_CERT_ALTNAME_INVALID", "Hostname/IP does not match"))).toBeNull();
    expect(certFailureCause(new Error("socket hang up"))).toBeNull();
    expect(certFailureCause(null)).toBeNull();
    expect(isCaTrustFailure(new Error("ECONNRESET"))).toBe(false);
    expect(isCaTrustFailure(SAMPLE["broken-local-ca"])).toBe(true);
  });
});

describe("cert hints by cause (CC 2.1.316)", () => {
  it("keeps every composer hint within the one-line footer (≤120 chars)", () => {
    for (const err of Object.values(SAMPLE)) {
      for (const extraCaConfigured of [false, true]) {
        const hint = tlsCertFailureHint(err, { extraCaConfigured })!;
        expect(hint).toBeTruthy();
        expect(hint.length).toBeLessThanOrEqual(120);
      }
    }
  });

  it("names the missing intermediate for an incomplete chain, with the full-chain fix in the long forms", () => {
    const err = SAMPLE["incomplete-chain"];
    expect(tlsCertFailureHint(err, { extraCaConfigured: false })).toContain("intermediate");
    expect(tlsCertFailureHint(err, { extraCaConfigured: true })).toContain("intermediate");
    const log = tlsCertFailureLogHint(err, { extraCaConfigured: false })!;
    expect(log).toContain("full chain");
    expect(log).toContain("NODE_EXTRA_CA_CERTS");
    expect(log).toContain("~/.claude/settings.json");
    const own = ownRequestCertFailureHint(new TypeError("fetch failed", { cause: err }))!;
    expect(own).toContain("leaves out an intermediate certificate");
    expect(own).toContain("full chain");
    expect(own).toContain("Start Claudius with NODE_EXTRA_CA_CERTS");
  });

  it("keeps the proxy / NODE_EXTRA_CA_CERTS advice for an untrusted authority", () => {
    const err = SAMPLE["untrusted-ca"];
    expect(tlsCertFailureHint(err, { extraCaConfigured: false })).toContain("Set NODE_EXTRA_CA_CERTS");
    expect(ownRequestCertFailureHint(err)).toContain("TLS-inspecting proxy");
    expect(tlsCertFailureHint(err, { extraCaConfigured: false })).not.toContain("intermediate");
  });

  it("tells the user to fix the local CA list — never a proxy — when a trusted CA lacks its issuer", () => {
    const err = SAMPLE["broken-local-ca"];
    const texts = [
      tlsCertFailureHint(err, { extraCaConfigured: false })!,
      tlsCertFailureHint(err, { extraCaConfigured: true })!,
      tlsCertFailureLogHint(err, { extraCaConfigured: false })!,
      tlsCertFailureLogHint(err, { extraCaConfigured: true })!,
      ownRequestCertFailureHint(err)!,
    ];
    for (const text of texts) {
      expect(text).toContain("issuer");
      expect(text.toLowerCase()).not.toContain("proxy");
      expect(text).not.toContain("Set NODE_EXTRA_CA_CERTS");
    }
    expect(texts[0]).toContain("missing its issuer");
    expect(texts[2]).toContain("leftover from a renewal");
    expect(texts[4]).toContain("add its issuer");
  });
});
