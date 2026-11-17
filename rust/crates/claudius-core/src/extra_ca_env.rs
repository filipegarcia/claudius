//! The `NODE_EXTRA_CA_CERTS` bundle Node 22 loads from the real environment
//! (I19): the roots every server-side `fetch` trusts on top of the default
//! ones, which [`crate::fetch::HttpsClient`] adds to the OS trust store, and
//! so does the dictation socket when TS passes it no `ca`
//! ([`crate::voice_tls::Trust::Default`], I23). (The settings-only bundle
//! CC 2.1.307 gives that socket as `ca` is [`crate::extra_ca_certs`]'s,
//! D25.)
//!
//! Node (`src/crypto/crypto_context.cc`, `LoadCertsFromBIO`) reads the file
//! once per process, when `node:tls` first loads (which a server does at
//! boot; here: when the first [`crate::fetch::HttpsClient`] is built), with
//! OpenSSL's `PEM_read_bio_X509` in a loop:
//!
//! - unset or empty → nothing. Any other value is a path as given (no `~`
//!   expansion, no trim; relative to the cwd);
//! - a file that doesn't open → the warning, with OpenSSL's words for the
//!   errno (`error:80000002:system library::No such file or directory`,
//!   `…8000000D…::Permission denied`, `…80000014…::Not a directory`), and
//!   no extra roots. A directory opens but reads nothing: no roots, quietly;
//! - otherwise every certificate up to the first that fails to read is kept
//!   (the default roots stay either way). Running out of `-----BEGIN` lines
//!   is the normal end; a broken block ends the load with the warning
//!   (`bad end line`, `bad base64 decode`, `ASN1 lib`, `not proc type`,
//!   `bad decrypt`),
//!   though what came before it still counts; an empty block, or one whose
//!   lines all went into a header, ends it without one.
//!
//! The warning is Node's stderr line, `Warning: Ignoring extra certs from
//! `<path>`, load failed: <OpenSSL error>`, logged here at warn.
//!
//! The reader is OpenSSL 3.6's PEM parser (`crypto/pem/pem_lib.c`,
//! `crypto/evp/encode.c`): 254-byte `fgets` reads, a UTF-8 BOM dropped from
//! the first line each read starts on, trailing whitespace trimmed, blocks
//! of any label read through (base64 and all) and skipped unless they are
//! `CERTIFICATE` or `X509 CERTIFICATE`, the header / blank-line rules, and
//! `EVP_DecodeUpdate`'s base64. Recorded against node 22 (its OpenSSL
//! 3.6.5) by `rust/scripts/extra-ca-golden.mjs`, replayed by
//! `tests/fetch_client.rs`.
//!
//! Where it differs:
//! - `d2i_X509` is stood in for by rustls's trust-anchor parse (webpki) of
//!   the outer DER `SEQUENCE` (OpenSSL ignores bytes after it, so does this):
//!   a certificate one of them reads and the other doesn't ends the load
//!   here (`ASN1 lib`) where Node goes on, or the reverse;
//! - a `Proc-Type:` header (an encrypted PEM) is taken as one that fails to
//!   decrypt (`bad decrypt`, recorded for a well-formed one): OpenSSL tries
//!   the cipher with an empty password, which fails that way (or, now and
//!   then, as `ASN1 lib`), and has other errors for a malformed `Proc-Type`
//!   or `DEK-Info` line;
//! - trailing bytes from 0x80 up count as whitespace, as OpenSSL's `char`
//!   test does where `char` is signed (x86-64, Apple arm64), not on Linux
//!   arm64;
//! - a non-root CA in the bundle: Node (no `X509_V_FLAG_PARTIAL_CHAIN`)
//!   only trusts a chain that ends at a self-signed root, the OS verifiers
//!   take any anchor (not recorded; from Node's and OpenSSL's source).

use std::ffi::OsStr;
use std::io::Read;
use std::sync::{Arc, LazyLock};

use rustls::pki_types::CertificateDer;

use crate::{extra_ca_certs, log};

/// What loading the bundle gave.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ExtraCaLoad {
    /// The certificates read, in file order, up to the first that failed.
    pub certs: Vec<CertificateDer<'static>>,
    /// Node's stderr line (without its newline) when the load failed.
    pub warning: Option<String>,
}

/// The process's bundle: read from `NODE_EXTRA_CA_CERTS` on first use, the
/// warning logged then, once.
static PROCESS: LazyLock<Arc<[CertificateDer<'static>]>> =
    LazyLock::new(|| load_logged(extra_ca_certs::env_os_value().as_deref()));

/// The roots a process-env `NODE_EXTRA_CA_CERTS` adds (the same list for
/// every caller; the file is read by the first one).
pub fn process_roots() -> Arc<[CertificateDer<'static>]> {
    Arc::clone(&PROCESS)
}

/// [`load`], with the warning logged as Node prints it.
pub fn load_logged(value: Option<&OsStr>) -> Arc<[CertificateDer<'static>]> {
    let loaded = load(value);
    if let Some(w) = &loaded.warning {
        tracing::warn!(target: log::API, "{w}");
    }
    loaded.certs.into()
}

/// Load the bundle a `NODE_EXTRA_CA_CERTS` value names, as Node does.
pub fn load(value: Option<&OsStr>) -> ExtraCaLoad {
    let Some(path) = value.filter(|v| !v.is_empty()) else {
        return ExtraCaLoad::default();
    };
    let warning = |err: &str| {
        Some(format!(
            "Warning: Ignoring extra certs from `{}`, load failed: {err}",
            path.to_string_lossy()
        ))
    };
    let mut file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(e) => {
            return ExtraCaLoad {
                certs: Vec::new(),
                warning: warning(&system_error(&e)),
            };
        }
    };
    // A read that fails (a directory) ends the file there, as `fgets`
    // returning NULL does; `read_to_end` keeps what it got before.
    let mut bytes = Vec::new();
    let _ = file.read_to_end(&mut bytes);
    let (certs, stop) = read_certs(&bytes);
    ExtraCaLoad {
        certs,
        warning: match stop {
            Stop::Error(e) => warning(e),
            Stop::Quiet => None,
        },
    }
}

/// `ERR_error_string_n` of the `ERR_LIB_SYS` error `fopen` leaves.
fn system_error(e: &std::io::Error) -> String {
    let Some(code) = e.raw_os_error() else {
        return format!("error:80000000:system library::{e}");
    };
    // `strerror`: std's message without its ` (os error N)` tail.
    let text = e.to_string();
    let text = text
        .strip_suffix(&format!(" (os error {code})"))
        .unwrap_or(&text)
        .to_owned();
    let packed = 0x8000_0000u32 | (code as u32 & 0x7FFF_FFFF);
    format!("error:{packed:08X}:system library::{text}")
}

/// OpenSSL's errors for a block that doesn't read.
const BAD_END_LINE: &str = "error:04800066:PEM routines::bad end line";
const BAD_BASE64_DECODE: &str = "error:04800064:PEM routines::bad base64 decode";
const NOT_PROC_TYPE: &str = "error:0480006B:PEM routines::not proc type";
const BAD_DECRYPT: &str = "error:04800065:PEM routines::bad decrypt";
const ASN1_LIB: &str = "error:0488000D:PEM routines::ASN1 lib";

/// Why the `PEM_read_bio_X509` loop ended.
#[derive(Debug, PartialEq, Eq)]
enum Stop {
    /// No more `-----BEGIN` lines (`PEM_R_NO_START_LINE`, the normal end),
    /// or a failure OpenSSL raises no error for.
    Quiet,
    /// The error `ERR_peek_last_error` sees.
    Error(&'static str),
}

/// `LoadCertsFromBIO`: every certificate until the loop stops, and why.
fn read_certs(bytes: &[u8]) -> (Vec<CertificateDer<'static>>, Stop) {
    let mut bio = Gets { rest: bytes };
    let mut certs = Vec::new();
    loop {
        match read_x509(&mut bio) {
            Ok(der) => certs.push(der),
            Err(stop) => return (certs, stop),
        }
    }
}

/// `BIO_gets(bp, buf, LINESIZE)` on a file BIO.
const LINESIZE: usize = 255;
const BOM: &[u8] = b"\xEF\xBB\xBF";

/// A file BIO's `fgets`, then `strlen`.
struct Gets<'a> {
    rest: &'a [u8],
}

impl<'a> Gets<'a> {
    /// The next read: up to and including a `\n`, at most 254 bytes, cut at
    /// a NUL. `None` at the end (or when the read is empty, which a leading
    /// NUL makes it, and which OpenSSL takes for the end too).
    fn gets(&mut self) -> Option<&'a [u8]> {
        let max = (LINESIZE - 1).min(self.rest.len());
        let end = self.rest[..max]
            .iter()
            .position(|&b| b == b'\n')
            .map_or(max, |i| i + 1);
        let (chunk, rest) = self.rest.split_at(end);
        self.rest = rest;
        let len = chunk.iter().position(|&b| b == 0).unwrap_or(chunk.len());
        (len > 0).then(|| &chunk[..len])
    }
}

/// `sanitize_line` with `PEM_FLAG_EAY_COMPATIBLE`: a BOM dropped from the
/// first line a read starts on, trailing whitespace (anything up to `' '`,
/// and from 0x80 up: a signed `char`) trimmed, one `\n` put back. (OpenSSL
/// also wants more than the BOM on the line; a lone BOM trims away anyway.)
fn sanitize(chunk: &[u8], first: bool) -> Vec<u8> {
    let chunk = match chunk.strip_prefix(BOM) {
        Some(rest) if first => rest,
        _ => chunk,
    };
    let keep = chunk
        .iter()
        .rposition(|&b| b > b' ' && b < 0x80)
        .map_or(0, |i| i + 1);
    let mut line = chunk[..keep].to_vec();
    line.push(b'\n');
    line
}

/// `PEM_read_bio_X509`: the next `CERTIFICATE` block's certificate.
fn read_x509(bio: &mut Gets<'_>) -> Result<CertificateDer<'static>, Stop> {
    // `pem_bytes_read_bio_flags`: blocks of another label are read (and
    // must read) and skipped.
    let Block { header, data, .. } = loop {
        let block = read_block(bio)?;
        if block.name == b"CERTIFICATE" || block.name == b"X509 CERTIFICATE" {
            break block;
        }
    };
    // `PEM_get_EVP_CIPHER_INFO`: a header can only be an encrypted PEM's.
    if !header.is_empty() {
        return Err(if header.starts_with(b"Proc-Type:") {
            Stop::Error(BAD_DECRYPT)
        } else {
            Stop::Error(NOT_PROC_TYPE)
        });
    }
    // `d2i_X509`: one DER object; what follows it is ignored.
    let der = der_object(&data).ok_or(Stop::Error(ASN1_LIB))?;
    let der = CertificateDer::from(der.to_vec());
    rustls::RootCertStore::empty()
        .add(der.clone())
        .map_err(|_| Stop::Error(ASN1_LIB))?;
    Ok(der)
}

/// The outer DER `SEQUENCE` at the start of `der`.
fn der_object(der: &[u8]) -> Option<&[u8]> {
    let (&tag, rest) = der.split_first()?;
    let (&first, rest) = rest.split_first()?;
    if tag != 0x30 {
        return None;
    }
    let (len, rest) = match first {
        0..=0x7F => (usize::from(first), rest),
        0x81..=0x84 => {
            let n = usize::from(first & 0x7F);
            let (bytes, rest) = rest.split_at_checked(n)?;
            let len = bytes.iter().fold(0usize, |l, &b| (l << 8) | usize::from(b));
            (len, rest)
        }
        _ => return None,
    };
    let head = der.len() - rest.len();
    der.get(..head.checked_add(len)?)
}

/// Where the lines of a block go (`get_header_and_data`'s states).
#[derive(Clone, Copy, PartialEq, Eq)]
enum Header {
    Maybe,
    In,
    Post,
}

/// A PEM block as `PEM_read_bio_ex` returns it.
struct Block {
    /// The label (`CERTIFICATE`).
    name: Vec<u8>,
    /// The lines before the blank line, if any.
    header: Vec<u8>,
    /// The base64-decoded data.
    data: Vec<u8>,
}

/// `PEM_read_bio_ex`: the next block.
fn read_block(bio: &mut Gets<'_>) -> Result<Block, Stop> {
    // `get_name`.
    let mut first = true;
    let name = loop {
        let Some(chunk) = bio.gets() else {
            return Err(Stop::Quiet);
        };
        let line = sanitize(chunk, first);
        first = false;
        if line.starts_with(b"-----BEGIN ") && line.ends_with(b"-----\n") {
            break line[11..line.len() - 6].to_vec();
        }
    };
    // `get_header_and_data`: lines go to the header until a blank line; a
    // block with no blank line and no `:` line is all data.
    let (mut header, mut data) = (Vec::new(), Vec::new());
    let mut got = Header::Maybe;
    let (mut partial, mut end) = (false, false);
    loop {
        let Some(chunk) = bio.gets() else {
            return Err(Stop::Error(BAD_END_LINE));
        };
        let prev_partial = partial;
        partial = chunk.len() == LINESIZE - 1 && chunk[LINESIZE - 2] != b'\n';
        if got == Header::Maybe && chunk.contains(&b':') {
            got = Header::In;
        }
        let line = sanitize(chunk, false);
        if line == b"\n" {
            // The rest of a line read in two parts isn't a blank line.
            if !prev_partial {
                if got == Header::Post {
                    return Err(Stop::Error(BAD_END_LINE));
                }
                got = Header::Post;
            }
            continue;
        }
        if let Some(tail) = line.strip_prefix(b"-----END ") {
            let closes = tail
                .strip_prefix(name.as_slice())
                .is_some_and(|t| t.starts_with(b"-----\n"));
            if !closes {
                return Err(Stop::Error(BAD_END_LINE));
            }
            if got == Header::Maybe {
                std::mem::swap(&mut header, &mut data);
            }
            break;
        } else if end {
            return Err(Stop::Error(BAD_END_LINE));
        }
        if got == Header::Post {
            data.extend_from_slice(&line);
            // Only an encrypted block's lines are length-checked.
            if line.len() > 65 {
                return Err(Stop::Quiet);
            }
            end = line.len() < 65;
        } else {
            header.extend_from_slice(&line);
        }
    }
    if data.is_empty() {
        return Err(Stop::Quiet);
    }
    let data = decode_base64(&data).ok_or(Stop::Error(BAD_BASE64_DECODE))?;
    Ok(Block { name, header, data })
}

/// `data_ascii2bin`'s classes.
const B64_WS: u8 = 0xE0;
const B64_EOLN: u8 = 0xF0;
const B64_CR: u8 = 0xF1;
const B64_EOF: u8 = 0xF2;
const B64_ERROR: u8 = 0xFF;

/// `conv_ascii2bin(a, data_ascii2bin)`.
fn ascii2bin(a: u8) -> u8 {
    match a {
        b'A'..=b'Z' => a - b'A',
        b'a'..=b'z' => a - b'a' + 26,
        b'0'..=b'9' => a - b'0' + 52,
        b'+' => 62,
        b'/' => 63,
        b'=' => 0,
        b'\t' | b' ' => B64_WS,
        b'\n' => B64_EOLN,
        b'\r' => B64_CR,
        b'-' => B64_EOF,
        _ => B64_ERROR,
    }
}

/// `B64_BASE64(v)`.
fn is_base64(v: u8) -> bool {
    (v | 0x13) != 0xF3
}

/// `EVP_DecodeUpdate` over the whole data, then `EVP_DecodeFinal`: base64
/// whose whitespace is skipped, `=` only at the end (at most two), a `-`
/// ending the input, whole 4-character groups. `None` where OpenSSL fails.
/// (OpenSSL decodes as each 64 characters fill up, with the `=` count so
/// far; that comes to the same bytes.)
fn decode_base64(input: &[u8]) -> Option<Vec<u8>> {
    let mut values = Vec::with_capacity(input.len());
    let mut eof = 0usize;
    for &c in input {
        let v = ascii2bin(c);
        if v == B64_ERROR {
            return None;
        }
        if c == b'=' {
            eof += 1;
        } else if eof > 0 && is_base64(v) {
            // Data after padding.
            return None;
        }
        if eof > 2 {
            return None;
        }
        if v == B64_EOF {
            break;
        }
        if is_base64(v) {
            values.push(v);
        }
    }
    if values.len() % 4 != 0 {
        return None;
    }
    // Every group gives 3 bytes, the last `3 - eof` (`=` reads as 0).
    let groups = values.len() / 4;
    let mut out = Vec::with_capacity(groups * 3);
    for (i, g) in values.chunks_exact(4).enumerate() {
        let l = (u32::from(g[0]) << 18)
            | (u32::from(g[1]) << 12)
            | (u32::from(g[2]) << 6)
            | u32::from(g[3]);
        let bytes = [(l >> 16) as u8, (l >> 8) as u8, l as u8];
        let n = if i + 1 == groups { 3 - eof } else { 3 };
        out.extend_from_slice(&bytes[..n]);
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_like_evp_decode() {
        let d = |s: &str| decode_base64(s.as_bytes());
        assert_eq!(d("aGk=\n"), Some(b"hi".to_vec()));
        assert_eq!(d("aG k=\n"), Some(b"hi".to_vec()));
        assert_eq!(d("a\tG\rk=\n"), Some(b"hi".to_vec()));
        assert_eq!(d("aA======\n"), None);
        assert_eq!(d("aGk=aGk=\n"), None);
        assert_eq!(d("+/+/\n"), Some(vec![0xFB, 0xFF, 0xBF]));
        assert_eq!(d("aGk\n"), None);
        assert_eq!(d("aG\n"), None);
        assert_eq!(d("aGkhaG\n"), None);
        assert_eq!(d("aA==\n"), Some(b"h".to_vec()));
        assert_eq!(d("aA==aGk=\n"), None);
        assert_eq!(d("aA===\n"), None);
        assert_eq!(d("aGk*\n"), None);
        assert_eq!(d("aGkh-junk"), Some(b"hi!".to_vec()));
        assert_eq!(d("aGk-"), None);
        // Many groups (OpenSSL: past its 64-character buffer).
        let long = "QUFB".repeat(20);
        assert_eq!(d(&long), Some(b"AAA".repeat(20)));
    }

    #[test]
    fn gets_reads_like_fgets() {
        let line = [b'a'; 300];
        let mut g = Gets { rest: &line };
        assert_eq!(g.gets().map(<[u8]>::len), Some(254));
        assert_eq!(g.gets().map(<[u8]>::len), Some(46));
        assert_eq!(g.gets(), None);
        let mut g = Gets {
            rest: b"ab\0c\nde\n\0x\n",
        };
        assert_eq!(g.gets(), Some(&b"ab"[..]));
        assert_eq!(g.gets(), Some(&b"de\n"[..]));
        assert_eq!(g.gets(), None);
    }

    #[test]
    fn sanitize_trims_like_eay_compatible() {
        assert_eq!(sanitize(b"ab \t\r\n", false), b"ab\n");
        assert_eq!(sanitize(b"ab\xC3\xA9\n", false), b"ab\n");
        assert_eq!(sanitize(b" \n", false), b"\n");
        assert_eq!(sanitize(b"\xEF\xBB\xBFab\n", true), b"ab\n");
        assert_eq!(sanitize(b"\xEF\xBB\xBFab\n", false), b"\xEF\xBB\xBFab\n");
        assert_eq!(sanitize(b"\xEF\xBB\xBF", true), b"\n");
    }

    #[test]
    fn der_object_takes_the_outer_sequence() {
        assert_eq!(der_object(&[0x30, 2, 1, 2, 9]), Some(&[0x30, 2, 1, 2][..]));
        assert_eq!(
            der_object(&[0x30, 0x81, 1, 7, 9]),
            Some(&[0x30, 0x81, 1, 7][..])
        );
        assert_eq!(der_object(&[0x30, 3, 1, 2]), None);
        assert_eq!(der_object(&[0x31, 0]), None);
        assert_eq!(der_object(&[0x30, 0x80, 0, 0]), None);
        assert_eq!(der_object(&[0x30]), None);
    }

    #[test]
    fn system_errors_read_like_openssls() {
        let e = std::io::Error::from_raw_os_error(2);
        assert_eq!(
            system_error(&e),
            "error:80000002:system library::No such file or directory"
        );
        let e = std::io::Error::from_raw_os_error(13);
        assert_eq!(
            system_error(&e),
            "error:8000000D:system library::Permission denied"
        );
    }

    #[test]
    fn unset_and_empty_load_nothing() {
        assert_eq!(load(None), ExtraCaLoad::default());
        assert_eq!(load(Some(OsStr::new(""))), ExtraCaLoad::default());
    }
}
