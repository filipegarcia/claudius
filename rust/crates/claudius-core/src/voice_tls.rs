//! The dictation socket's TLS ([`crate::voice_ws`]), and the Node / OpenSSL
//! words for a certificate it refuses.
//!
//! The chain is checked against the OS trust store (rustls-platform-verifier,
//! as [`crate::fetch`]) plus a [`Trust`]'s roots: without TS's `ca`, the
//! roots a process-env `NODE_EXTRA_CA_CERTS` added at boot
//! ([`crate::extra_ca_env::process_roots`], the list `fetch` trusts too, as
//! Node's default store holds them for every socket); with it, the PEM
//! [`crate::extra_ca_certs`] resolved from the user settings, parsed at each
//! open. A failure has to reach the composer as Node words it,
//! because CC 2.1.309's hint ([`crate::tls_cert_hint`]) keys off exactly
//! those codes and messages, so the verifier translates:
//!
//! - a certificate outside its validity window → `certificate has expired` /
//!   `certificate is not yet valid`. OpenSSL reports the *last* failure it
//!   saw, and a time failure comes after the chain lookup, so it wins over
//!   an untrusted chain; checked here first for the same reason;
//! - an untrusted chain, by its shape, the way `X509_verify_cert` labels it:
//!   a self-signed leaf is `self-signed certificate`
//!   (`DEPTH_ZERO_SELF_SIGNED_CERT`), a chain that carries its own root
//!   `self-signed certificate in certificate chain`, a lone leaf whose
//!   issuer is nowhere `unable to verify the first certificate`, and a
//!   longer chain `unable to get local issuer certificate`;
//! - a trusted chain for another name → Node's `checkServerIdentity`
//!   message, `Hostname/IP does not match certificate's altnames: …`.
//!
//! Recorded against the real `ws` on a local TLS server by
//! `rust/scripts/voice-golden.mjs` (a self-signed leaf; a CA-signed leaf
//! with no CA, a missing or wrong settings CA, the CA in the settings or in
//! the environment, an environment bundle Node reads in part, then garbles
//! or removes, the environment's bundle winning over the settings'; a
//! trusted leaf for another name), and against node 22's load of I19's
//! bundles (`claudius-core/tests/voice_extra_ca.rs`).
//!
//! Not mirrored: a handshake that fails for another reason (a TLS alert, no
//! shared cipher) is rustls's message, not OpenSSL's `write EPROTO …`. Not
//! recorded (written from Node's source): a chain that carries its own root,
//! a longer untrusted chain, the validity-window messages and the DNS / CN
//! halves of the name message.

use std::sync::{Arc, Mutex};

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, SignatureScheme};
use rustls_platform_verifier::Verifier;
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio_rustls::client::TlsStream;

use crate::log;

/// The roots the socket trusts besides the OS store.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Trust {
    /// No `ca` option: Node's default store, which holds what a process-env
    /// `NODE_EXTRA_CA_CERTS` added once, at startup
    /// ([`crate::extra_ca_env::process_roots`]).
    Default(Arc<[CertificateDer<'static>]>),
    /// TS's `ca` (`[...rootCertificates, pem]`): the certificates of this
    /// PEM text, in place of the process's extra roots.
    Ca(String),
}

impl Trust {
    /// [`Trust::Default`] with the process's roots (read by the first
    /// caller, at boot in the binary).
    pub fn process_default() -> Trust {
        Trust::Default(crate::extra_ca_env::process_roots())
    }
}

/// Open the TLS half of the socket, or the JS error the TS's `ws.on("error")`
/// handler would see.
pub(crate) async fn wrap(
    tcp: TcpStream,
    host: &str,
    trust: &Trust,
) -> Result<TlsStream<TcpStream>, Value> {
    let failure = Arc::new(Mutex::new(None));
    let config = config(host, trust, Arc::clone(&failure))
        .map_err(|e| json!({"message": e.to_string(), "code": "ERR_TLS_CERT_ALTNAME_INVALID"}))?;
    let name = ServerName::try_from(host.to_owned())
        .map_err(|_| json!({"message": format!("Invalid host: {host}")}))?;
    match tokio_rustls::TlsConnector::from(Arc::new(config))
        .connect(name, tcp)
        .await
    {
        Ok(s) => Ok(s),
        Err(e) => Err(failure.lock().ok().and_then(|f| f.clone()).unwrap_or_else(
            || json!({"message": e.to_string(), "code": "ERR_SSL_PROTOCOL_ERROR"}),
        )),
    }
}

fn config(
    host: &str,
    trust: &Trust,
    failure: Arc<Mutex<Option<Value>>>,
) -> Result<ClientConfig, rustls::Error> {
    // Another provider installed first is fine, as in `fetch`.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let inner = match trust {
        Trust::Ca(pem) => {
            let roots: Vec<CertificateDer<'static>> =
                CertificateDer::pem_slice_iter(pem.as_bytes())
                    .filter_map(Result::ok)
                    .collect();
            Verifier::new_with_extra_roots(roots, Arc::clone(&provider))?
        }
        // No extra roots is `Verifier::new`.
        Trust::Default(roots) => {
            match Verifier::new_with_extra_roots(roots.iter().cloned(), Arc::clone(&provider)) {
                Ok(v) => v,
                // Roots the platform refuses (each one parsed as a
                // certificate) cost the extra roots, not the socket, as in
                // `fetch`: Node would still have its defaults.
                Err(e) if !roots.is_empty() => {
                    tracing::error!(
                        target: log::API,
                        "[voice] the NODE_EXTRA_CA_CERTS roots were refused ({e}); using the default roots only"
                    );
                    Verifier::new(Arc::clone(&provider))?
                }
                Err(e) => return Err(e),
            }
        }
    };
    let verifier = NodeVerifier {
        inner,
        host: host.to_owned(),
        failure,
    };
    let mut config = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_no_client_auth();
    // What Node's `https.request` offers.
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(config)
}

/// The platform verifier, with its failures reworded as Node's.
#[derive(Debug)]
struct NodeVerifier {
    inner: Verifier,
    host: String,
    /// The reworded failure, for the handshake error to carry out.
    failure: Arc<Mutex<Option<Value>>>,
}

impl NodeVerifier {
    fn fail(&self, message: &str, code: &str) -> rustls::Error {
        if let Ok(mut slot) = self.failure.lock() {
            *slot = Some(json!({"message": message, "code": code}));
        }
        rustls::Error::InvalidCertificate(rustls::CertificateError::Other(rustls::OtherError(
            Arc::new(CertFailure(message.to_owned())),
        )))
    }
}

#[derive(Debug)]
struct CertFailure(String);

impl std::fmt::Display for CertFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for CertFailure {}

impl ServerCertVerifier for NodeVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let chain: Vec<Cert> = std::iter::once(end_entity)
            .chain(intermediates)
            .map(|der| Cert::parse(der).unwrap_or_default())
            .collect();
        let secs = now.as_secs() as i64;
        for cert in &chain {
            if cert.not_after != 0 && secs > cert.not_after {
                return Err(self.fail("certificate has expired", "CERT_HAS_EXPIRED"));
            }
            if cert.not_before != 0 && secs < cert.not_before {
                return Err(self.fail("certificate is not yet valid", "CERT_NOT_YET_VALID"));
            }
        }
        match self.inner.verify_server_cert(
            end_entity,
            intermediates,
            server_name,
            ocsp_response,
            now,
        ) {
            Ok(v) => Ok(v),
            Err(rustls::Error::InvalidCertificate(
                rustls::CertificateError::NotValidForName
                | rustls::CertificateError::NotValidForNameContext { .. },
            )) => {
                let leaf = chain.first().cloned().unwrap_or_default();
                let message = format!(
                    "Hostname/IP does not match certificate's altnames: {}",
                    leaf.name_mismatch(&self.host)
                );
                Err(self.fail(&message, "ERR_TLS_CERT_ALTNAME_INVALID"))
            }
            Err(e) => {
                let (message, code) = untrusted_chain(&chain);
                // Only a trust failure is reworded; anything else (a bad
                // signature, a revoked certificate) keeps rustls's words.
                if matches!(
                    e,
                    rustls::Error::InvalidCertificate(
                        rustls::CertificateError::UnknownIssuer
                            | rustls::CertificateError::Other(_)
                    )
                ) {
                    return Err(self.fail(message, code));
                }
                Err(e)
            }
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.inner.supported_verify_schemes()
    }
}

/// `X509_verify_cert`'s label for a chain that leads to no trusted root.
fn untrusted_chain(chain: &[Cert]) -> (&'static str, &'static str) {
    let self_signed = |c: &Cert| !c.issuer.is_empty() && c.issuer == c.subject;
    match chain.first() {
        Some(leaf) if self_signed(leaf) => {
            ("self-signed certificate", "DEPTH_ZERO_SELF_SIGNED_CERT")
        }
        _ if chain.iter().any(self_signed) => (
            "self-signed certificate in certificate chain",
            "SELF_SIGNED_CERT_IN_CHAIN",
        ),
        _ if chain.len() <= 1 => (
            "unable to verify the first certificate",
            "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
        ),
        _ => (
            "unable to get local issuer certificate",
            "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
        ),
    }
}

// ────────────────────────────── the certificate ───────────────────────────

/// The fields the wording needs out of a DER certificate.
#[derive(Clone, Debug, Default, PartialEq)]
struct Cert {
    /// The `issuer` / `subject` Name, DER bytes and all, to compare.
    issuer: Vec<u8>,
    subject: Vec<u8>,
    /// `cert.subject.CN` (the last one, as Node's parser keeps it).
    common_name: Option<String>,
    /// `subjectAltName` dNSName entries.
    dns_names: Vec<String>,
    /// `subjectAltName` iPAddress entries, printed as Node prints them.
    ip_addresses: Vec<String>,
    /// `notBefore` / `notAfter` as epoch seconds (0 when unparsed).
    not_before: i64,
    not_after: i64,
}

impl Cert {
    /// `checkServerIdentity`'s `reason` for a certificate that doesn't
    /// cover `host`.
    fn name_mismatch(&self, host: &str) -> String {
        if host.parse::<std::net::IpAddr>().is_ok() {
            return format!(
                "IP: {host} is not in the cert's list: {}",
                self.ip_addresses.join(", ")
            );
        }
        if self.dns_names.is_empty() {
            return format!(
                "Host: {host}. is not cert's CN: {}",
                self.common_name.clone().unwrap_or_default()
            );
        }
        format!(
            "Host: {host}. is not in the cert's list: {}",
            self.dns_names.join(", ")
        )
    }

    fn parse(der: &CertificateDer<'_>) -> Option<Cert> {
        let (_, body, _) = tlv(der.as_ref())?;
        let (_, tbs, _) = tlv(body)?;
        let mut rest = tbs;
        // version [0] EXPLICIT, when present.
        if let Some((0xa0, _, after)) = tlv(rest) {
            rest = after;
        }
        let (_, _, rest) = tlv(rest)?; // serialNumber
        let (_, _, rest) = tlv(rest)?; // signature
        let issuer_start = rest;
        let (_, _, rest) = tlv(rest)?; // issuer
        let issuer = issuer_start[..issuer_start.len() - rest.len()].to_vec();
        let (_, validity, rest) = tlv(rest)?;
        let subject_start = rest;
        let (_, subject_body, rest) = tlv(rest)?;
        let subject = subject_start[..subject_start.len() - rest.len()].to_vec();
        let (_, _, rest) = tlv(rest)?; // subjectPublicKeyInfo
        let (not_before, not_after) = {
            let (tag, value, after) = tlv(validity)?;
            let before = asn1_time(tag, value).unwrap_or(0);
            let after = tlv(after)
                .and_then(|(tag, value, _)| asn1_time(tag, value))
                .unwrap_or(0);
            (before, after)
        };
        let mut cert = Cert {
            issuer,
            subject,
            common_name: common_name(subject_body),
            dns_names: Vec::new(),
            ip_addresses: Vec::new(),
            not_before,
            not_after,
        };
        // extensions [3] EXPLICIT, after the optional [1] and [2].
        let mut tail = rest;
        while let Some((tag, body, after)) = tlv(tail) {
            if tag == 0xa3 {
                if let Some((_, exts, _)) = tlv(body) {
                    cert.read_alt_names(exts);
                }
                break;
            }
            tail = after;
        }
        Some(cert)
    }

    /// The `subjectAltName` extension's dNSName and iPAddress entries.
    fn read_alt_names(&mut self, mut exts: &[u8]) {
        while let Some((_, ext, after)) = tlv(exts) {
            exts = after;
            let Some((_, oid, rest)) = tlv(ext) else {
                continue;
            };
            if oid != [0x55, 0x1d, 0x11] {
                continue;
            }
            // The value is an OCTET STRING, after an optional `critical`.
            let octets = match tlv(rest) {
                Some((0x01, _, after)) => tlv(after),
                other => other,
            };
            let Some((_, der, _)) = octets else { continue };
            let Some((_, mut names, _)) = tlv(der) else {
                continue;
            };
            while let Some((tag, value, after)) = tlv(names) {
                names = after;
                match tag {
                    0x82 => self
                        .dns_names
                        .push(String::from_utf8_lossy(value).into_owned()),
                    0x87 => {
                        if let Some(ip) = ip_address(value) {
                            self.ip_addresses.push(ip);
                        }
                    }
                    _ => {}
                }
            }
        }
    }
}

/// One DER tag-length-value: `(tag, contents, what follows)`.
fn tlv(der: &[u8]) -> Option<(u8, &[u8], &[u8])> {
    let tag = *der.first()?;
    let first = usize::from(*der.get(1)?);
    let (len, start) = if first < 0x80 {
        (first, 2)
    } else {
        let n = first & 0x7f;
        if n == 0 || n > 4 {
            return None;
        }
        let mut len = 0usize;
        for i in 0..n {
            len = len << 8 | usize::from(*der.get(2 + i)?);
        }
        (len, 2 + n)
    };
    let end = start.checked_add(len)?;
    if end > der.len() {
        return None;
    }
    Some((tag, &der[start..end], &der[end..]))
}

/// The last `CN` of a Name (`SEQUENCE OF RDN`).
fn common_name(mut name: &[u8]) -> Option<String> {
    let mut cn = None;
    while let Some((_, rdn, after)) = tlv(name) {
        name = after;
        let mut attrs = rdn;
        while let Some((_, attr, next)) = tlv(attrs) {
            attrs = next;
            if let Some((_, oid, rest)) = tlv(attr)
                && oid == [0x55, 0x04, 0x03]
                && let Some((_, value, _)) = tlv(rest)
            {
                cn = Some(String::from_utf8_lossy(value).into_owned());
            }
        }
    }
    cn
}

/// An iPAddress general name, as Node prints it.
fn ip_address(bytes: &[u8]) -> Option<String> {
    match bytes.len() {
        4 => Some(std::net::Ipv4Addr::from([bytes[0], bytes[1], bytes[2], bytes[3]]).to_string()),
        16 => {
            let octets: [u8; 16] = bytes.try_into().ok()?;
            Some(std::net::Ipv6Addr::from(octets).to_string())
        }
        _ => None,
    }
}

/// A UTCTime (`YYMMDDhhmmssZ`) or GeneralizedTime (`YYYYMMDDhhmmssZ`) as
/// epoch seconds.
fn asn1_time(tag: u8, value: &[u8]) -> Option<i64> {
    let text = std::str::from_utf8(value).ok()?;
    let digits = text.strip_suffix('Z')?;
    let (year, rest) = match tag {
        0x17 if digits.len() == 12 => {
            let yy: i64 = digits[..2].parse().ok()?;
            // RFC 5280: 00-49 is 2000-2049, 50-99 is 1950-1999.
            (if yy < 50 { 2000 + yy } else { 1900 + yy }, &digits[2..])
        }
        0x18 if digits.len() == 14 => (digits[..4].parse().ok()?, &digits[4..]),
        _ => return None,
    };
    let part = |i: usize| -> Option<i64> { rest.get(i..i + 2)?.parse().ok() };
    let (month, day, hour, min, sec) = (part(0)?, part(2)?, part(4)?, part(6)?, part(8)?);
    Some(days_from_civil(year, month, day) * 86_400 + hour * 3_600 + min * 60 + sec)
}

/// Days between 1970-01-01 and the given date (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = y - i64::from(m <= 2);
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_openssl_label_for_a_chain_shape() {
        let signed = |issuer: &str, subject: &str| Cert {
            issuer: issuer.as_bytes().to_vec(),
            subject: subject.as_bytes().to_vec(),
            ..Cert::default()
        };
        assert_eq!(
            untrusted_chain(&[signed("a", "a")]).1,
            "DEPTH_ZERO_SELF_SIGNED_CERT"
        );
        assert_eq!(
            untrusted_chain(&[signed("ca", "leaf"), signed("ca", "ca")]).1,
            "SELF_SIGNED_CERT_IN_CHAIN"
        );
        assert_eq!(
            untrusted_chain(&[signed("ca", "leaf")]).1,
            "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
        );
        assert_eq!(
            untrusted_chain(&[signed("mid", "leaf"), signed("ca", "mid")]).1,
            "UNABLE_TO_GET_ISSUER_CERT_LOCALLY"
        );
        // A certificate that didn't parse has empty names, which must not
        // read as self-signed.
        assert_eq!(
            untrusted_chain(&[Cert::default()]).1,
            "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
        );
    }

    /// Process roots the platform verifier refuses (the loader only keeps
    /// ones that parse, so this is a safety net) cost the extra roots, not
    /// the socket; a settings bundle's still fails it, as since D25.
    #[test]
    fn refused_process_roots_fall_back_to_the_default_roots() {
        let slot = || Arc::new(Mutex::new(None));
        let junk = || vec![CertificateDer::from(vec![1, 2, 3])];
        let none: Arc<[CertificateDer<'static>]> = Arc::from(Vec::new());
        assert!(config("h", &Trust::Default(none), slot()).is_ok());
        assert!(config("h", &Trust::Default(junk().into()), slot()).is_ok());
        let pem = "-----BEGIN CERTIFICATE-----\nAQID\n-----END CERTIFICATE-----\n";
        assert!(config("h", &Trust::Ca(pem.into()), slot()).is_err());
    }

    #[test]
    fn dates_and_names() {
        assert_eq!(asn1_time(0x17, b"700101000000Z"), Some(0));
        assert_eq!(asn1_time(0x17, b"260101000000Z"), Some(1_767_225_600));
        assert_eq!(asn1_time(0x18, b"20260101000000Z"), Some(1_767_225_600));
        assert_eq!(asn1_time(0x17, b"491231235959Z"), Some(2_524_607_999));
        assert_eq!(asn1_time(0x17, b"500101000000Z"), Some(-631_152_000));
        assert_eq!(asn1_time(0x17, b"bogus"), None);
        assert_eq!(ip_address(&[127, 0, 0, 1]).as_deref(), Some("127.0.0.1"));
        assert_eq!(ip_address(&[1, 2]), None);

        let cert = Cert {
            common_name: Some("127.0.0.1".into()),
            ip_addresses: vec!["127.0.0.1".into()],
            ..Cert::default()
        };
        assert_eq!(
            cert.name_mismatch("localhost"),
            "Host: localhost. is not cert's CN: 127.0.0.1"
        );
        assert_eq!(
            cert.name_mismatch("127.0.0.2"),
            "IP: 127.0.0.2 is not in the cert's list: 127.0.0.1"
        );
    }
}
