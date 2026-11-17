//! CC 2.1.309's certificate-failure hints: port of
//! `lib/shared/tls-cert-hint.ts`.
//!
//! An error is a CA-trust failure when it, or the error on its `cause` (two
//! levels down at most), carries one of OpenSSL's "the chain doesn't lead to
//! a trusted root" codes, or a `message` in Node's / OpenSSL's words for
//! them. An expired certificate or a hostname mismatch is not one: a CA
//! bundle can't fix those, so they keep the raw message.
//!
//! Errors are taken as the JS values the TS reads (`{code, message, cause}`
//! objects): a value that isn't an object (or array) ends the walk, and a
//! `code` or `message` that isn't a string is skipped. The message test is
//! the TS's case-insensitive regex; its pattern is ASCII, so JS's
//! non-Unicode `i` flag is ASCII case folding (`(?i-u)`).
//!
//! Two readers, because the two backends learn different things about a
//! failed handshake:
//!
//! - [`is_ca_trust_failure`] is the TS predicate over a Node-shaped error,
//!   which is what the dictation socket ([`crate::voice_tls`]) builds and
//!   what the account goldens record.
//! - [`is_ca_trust_failure_native`] is what [`crate::fetch::HttpsClient`]
//!   uses (account sign-in and profile lookup, R08): it walks the `reqwest`
//!   error's source chain for the certificate verifier's verdict
//!   (rustls-platform-verifier). Only "the chain doesn't lead to a trusted
//!   root", which is what every code in [`CA_TRUST_CODES`] means, counts:
//!   `UnknownIssuer` (webpki on Linux, and macOS's
//!   `errSecCreateChainFailed`), or a platform verdict that the TS message
//!   test matches or that carries Apple's `errSecNotTrusted` status. On
//!   macOS an untrusted root (a self-signed chain, a TLS-inspecting proxy's
//!   CA) arrives as `CertificateError::Other("“host” certificate is not
//!   trusted: -67843")`. An expired certificate, a hostname mismatch or
//!   Apple's "not standards compliant" keeps the raw message, as in TS.
//!   [`crate::fetch::FetchError::ca_trust`] carries the verdict, and
//!   [`own_request_hint_for`] turns it into the hint.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

/// `CA_TRUST_CODES`: OpenSSL / Node codes for "the chain doesn't lead to a
/// trusted root".
pub const CA_TRUST_CODES: [&str; 6] = [
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "UNABLE_TO_GET_ISSUER_CERT",
    "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
    "CERT_UNTRUSTED",
];

/// `CA_TRUST_MESSAGE` (a fixed pattern, never built from input).
static CA_TRUST_MESSAGE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i-u)unable to verify the first certificate|unable to verify leaf signature|self[- ]signed certificate|unable to get (?:local )?issuer certificate|certificate (?:is )?(?:not )?(?:un)?trusted",
    )
    .expect("fixed pattern")
});

/// The dictation hint when an extra CA bundle was already in effect.
pub const HINT_EXTRA_CA_CONFIGURED: &str = "Dictation couldn't connect — certificate not trusted even with NODE_EXTRA_CA_CERTS. Check it has your proxy's CA.";
/// The dictation hint when none was.
pub const HINT_NO_EXTRA_CA: &str = "Dictation couldn't connect — certificate not trusted. Set NODE_EXTRA_CA_CERTS to your proxy's CA bundle and try again.";
/// What the log form adds to [`HINT_NO_EXTRA_CA`].
const LOG_SUFFIX: &str =
    " It can be set in the environment or in the env block of ~/.claude/settings.json.";
/// `ownRequestCertFailureHint`'s text.
pub const OWN_REQUEST_HINT: &str = "The server's certificate isn't trusted, usually because a TLS-inspecting proxy is in the way. Start Claudius with NODE_EXTRA_CA_CERTS set to the proxy's CA bundle.";

/// `CA_TRUST_CODES.has(code)`.
pub fn is_ca_trust_code(code: &str) -> bool {
    CA_TRUST_CODES.contains(&code)
}

/// `CA_TRUST_MESSAGE.test(message)`.
pub fn is_ca_trust_message(message: &str) -> bool {
    CA_TRUST_MESSAGE.is_match(message)
}

/// `isCaTrustFailure(err)`.
pub fn is_ca_trust_failure(err: &Value) -> bool {
    let mut cur = Some(err);
    for _ in 0..3 {
        let Some(v @ (Value::Object(_) | Value::Array(_))) = cur else {
            return false;
        };
        if let Some(Value::String(code)) = v.get("code")
            && is_ca_trust_code(code)
        {
            return true;
        }
        if let Some(Value::String(message)) = v.get("message")
            && is_ca_trust_message(message)
        {
            return true;
        }
        cur = v.get("cause");
    }
    false
}

/// `tlsCertFailureHint(err, { extraCaConfigured })`: the composer's one-line
/// hint for a CA-trust failure, `None` for any other error.
pub fn tls_cert_failure_hint(err: &Value, extra_ca_configured: bool) -> Option<&'static str> {
    if !is_ca_trust_failure(err) {
        return None;
    }
    Some(if extra_ca_configured {
        HINT_EXTRA_CA_CONFIGURED
    } else {
        HINT_NO_EXTRA_CA
    })
}

/// `tlsCertFailureLogHint(err, { extraCaConfigured })`: the server-log form,
/// which also says where the variable can be set when none is.
pub fn tls_cert_failure_log_hint(err: &Value, extra_ca_configured: bool) -> Option<String> {
    let hint = tls_cert_failure_hint(err, extra_ca_configured)?;
    Some(if extra_ca_configured {
        hint.to_owned()
    } else {
        format!("{hint}{LOG_SUFFIX}")
    })
}

/// `ownRequestCertFailureHint(err)`: for Claudius's own HTTPS requests to
/// Anthropic, which only see a `NODE_EXTRA_CA_CERTS` set in the environment.
pub fn own_request_cert_failure_hint(err: &Value) -> Option<&'static str> {
    own_request_hint_for(is_ca_trust_failure(err))
}

/// `ownRequestCertFailureHint` once the failure is classified, e.g. by
/// [`is_ca_trust_failure_native`] ([`crate::fetch::FetchError::ca_trust`]).
pub fn own_request_hint_for(ca_trust: bool) -> Option<&'static str> {
    ca_trust.then_some(OWN_REQUEST_HINT)
}

/// The tail rustls-platform-verifier gives a macOS verdict it has no
/// variant for (`"{description}: {status}"`): `errSecNotTrusted`.
const APPLE_NOT_TRUSTED: &str = ": -67843";

/// The verifier's verdict behind a `reqwest` failure: whether the chain was
/// refused for want of a trusted root. The error is wrapped several times
/// (reqwest → hyper → `io::Error` → `rustls::Error`), so the source chain is
/// walked, unwrapping `io::Error`s on the way.
pub fn is_ca_trust_failure_native(err: &(dyn std::error::Error + 'static)) -> bool {
    let mut cur: Option<&(dyn std::error::Error + 'static)> = Some(err);
    // One hop per wrapper; a handshake error is 3-5 deep.
    for _ in 0..10 {
        let e = match cur {
            Some(e) => e,
            None => return false,
        };
        if let Some(tls) = e.downcast_ref::<rustls::Error>()
            && is_untrusted_root(tls)
        {
            return true;
        }
        if let Some(io) = e.downcast_ref::<std::io::Error>()
            && let Some(inner) = io.get_ref()
        {
            if let Some(tls) = inner.downcast_ref::<rustls::Error>()
                && is_untrusted_root(tls)
            {
                return true;
            }
            cur = Some(inner);
            continue;
        }
        cur = e.source();
    }
    false
}

/// The verifier refused the chain for want of a trusted root.
fn is_untrusted_root(e: &rustls::Error) -> bool {
    match e {
        rustls::Error::InvalidCertificate(rustls::CertificateError::UnknownIssuer) => true,
        // A platform verdict rustls has no variant for, in the OS's words
        // (macOS: `errSecNotTrusted`, "certificate is not trusted"): the TS
        // message fallback decides, as it does for a Node message. The
        // verifier appends Apple's status code, which also holds where
        // Security.framework's wording is localized.
        rustls::Error::InvalidCertificate(rustls::CertificateError::Other(other)) => {
            let message = other.to_string();
            is_ca_trust_message(&message) || message.ends_with(APPLE_NOT_TRUSTED)
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn codes_messages_and_causes() {
        assert!(is_ca_trust_failure(
            &json!({"code": "SELF_SIGNED_CERT_IN_CHAIN"})
        ));
        assert!(is_ca_trust_failure(
            &json!({"message": "Unable To Verify The First Certificate"})
        ));
        assert!(is_ca_trust_failure(
            &json!({"message": "x", "cause": {"cause": {"code": "CERT_UNTRUSTED"}}})
        ));
        // Three levels at most.
        assert!(!is_ca_trust_failure(
            &json!({"cause": {"cause": {"cause": {"code": "CERT_UNTRUSTED"}}}})
        ));
        assert!(!is_ca_trust_failure(&json!("self-signed certificate")));
        assert!(!is_ca_trust_failure(&json!({"code": 1, "message": null})));
        // ASCII case folding only, as JS's non-Unicode `i`.
        assert!(!is_ca_trust_failure(
            &json!({"message": "\u{17f}elf-signed certificate"})
        ));
        assert_eq!(
            tls_cert_failure_log_hint(&json!({"code": "CERT_UNTRUSTED"}), false).as_deref(),
            Some(format!("{HINT_NO_EXTRA_CA}{LOG_SUFFIX}").as_str())
        );
        assert_eq!(
            tls_cert_failure_hint(&json!({"code": "CERT_HAS_EXPIRED"}), true),
            None
        );
    }

    #[test]
    fn the_message_pattern_is_case_insensitive_over_ascii() {
        assert!(is_ca_trust_message(
            "Unable To Verify The First Certificate"
        ));
        assert!(is_ca_trust_message("x self signed certificate in chain"));
        assert!(is_ca_trust_message("CERTIFICATE IS NOT TRUSTED"));
        assert!(is_ca_trust_message("certificate untrusted"));
        assert!(!is_ca_trust_message("certificate has expired"));
        assert!(!is_ca_trust_message("hostname/IP does not match"));
        // A non-ASCII unit that folds to ASCII is not canonicalized by a
        // non-`u` `i` regex, so it doesn't match.
        assert!(!is_ca_trust_message("certificate is not trus\u{0131}ed"));
    }

    /// The native reader finds the verifier's verdict through the wrappers.
    #[test]
    fn the_native_walk_unwraps_io_errors() {
        let tls = rustls::Error::InvalidCertificate(rustls::CertificateError::UnknownIssuer);
        let io = std::io::Error::other(tls);
        let outer = std::io::Error::new(std::io::ErrorKind::ConnectionAborted, io);
        assert!(is_ca_trust_failure_native(&outer));
        let expired = std::io::Error::other(rustls::Error::InvalidCertificate(
            rustls::CertificateError::Expired,
        ));
        assert!(!is_ca_trust_failure_native(&expired));
        assert!(!is_ca_trust_failure_native(&std::io::Error::other("nope")));
    }

    /// macOS's verdicts arrive as `Other`, in Security.framework's words
    /// (these are the ones `tests/fetch_client.rs` gets from a self-signed
    /// certificate): only "not trusted" is a missing trust anchor.
    #[test]
    fn the_native_walk_reads_platform_verdicts_by_their_wording() {
        let other = |m: &str| {
            std::io::Error::other(rustls::Error::InvalidCertificate(
                rustls::CertificateError::Other(rustls::OtherError(std::sync::Arc::new(
                    std::io::Error::other(m.to_owned()),
                ))),
            ))
        };
        assert!(is_ca_trust_failure_native(&other(
            "\u{201c}localhost\u{201d} certificate is not trusted: -67843"
        )));
        // Localized wording still carries the status code.
        assert!(is_ca_trust_failure_native(&other(
            "O certificado \u{201c}localhost\u{201d} n\u{e3}o \u{e9} fidedigno: -67843"
        )));
        assert!(!is_ca_trust_failure_native(&other(
            "\u{201c}localhost\u{201d} certificate is not standards compliant: -67901"
        )));
        assert!(!is_ca_trust_failure_native(&other(
            "\u{201c}localhost\u{201d} certificate has expired: -67818"
        )));
        let mismatch = std::io::Error::other(rustls::Error::InvalidCertificate(
            rustls::CertificateError::NotValidForName,
        ));
        assert!(!is_ca_trust_failure_native(&mismatch));
    }

    #[test]
    fn the_classified_hint_is_the_own_request_one() {
        assert_eq!(own_request_hint_for(true), Some(OWN_REQUEST_HINT));
        assert_eq!(own_request_hint_for(false), None);
        assert_eq!(
            own_request_cert_failure_hint(&json!({"code": "DEPTH_ZERO_SELF_SIGNED_CERT"})),
            Some(OWN_REQUEST_HINT)
        );
    }
}
