//! `claudius_core::fetch::HttpsClient` against local raw servers: what it
//! sends (undici's default headers, unless the caller set them), how it
//! fails (`fetch failed` for a refused connection, a TLS handshake with a
//! plain-text server, a bad method and a server silent before the headers;
//! `terminated` for a body cut short or gone silent; undici's timeouts),
//! the dev/test base rewrite, the `ProfileFetch` adapter, the
//! certificate-trust verdict on a self-signed chain (CC 2.1.309), and a
//! process-env `NODE_EXTRA_CA_CERTS` bundle replayed against node 22 on a
//! TLS server whose leaf a test CA signed (I19,
//! `fixtures/extra_ca_golden.json`). The parity of answers with undici on
//! recorded responses is in claudius-server's `tests/accounts_oauth.rs`.
//! Nothing here leaves 127.0.0.1.

use std::ffi::OsStr;
use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, mpsc};
use std::time::{Duration, Instant};

use claudius_core::account_profile::ProfileFetch;
use claudius_core::extra_ca_env;
use claudius_core::fetch::{
    CONNECT_TIMEOUT, DEFAULT_HEADERS, FETCH_FAILED, Fetch, HttpsClient, READ_TIMEOUT, Request,
    TERMINATED, env_proxy_enabled,
};
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use serde_json::Value;

/// One connection: the raw request head + body it got, after answering
/// `reply` and closing.
fn one_shot(reply: &'static [u8]) -> (u16, mpsc::Receiver<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let (mut conn, _) = listener.accept().unwrap();
        let mut buf = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            let n = conn.read(&mut chunk).unwrap_or(0);
            buf.extend_from_slice(&chunk[..n]);
            if buf.first() == Some(&0x16) {
                break; // a TLS ClientHello: answer it in plain text
            }
            let text = String::from_utf8_lossy(&buf).into_owned();
            if let Some(at) = text.find("\r\n\r\n") {
                let len = text[..at]
                    .lines()
                    .find_map(|l| {
                        let (k, v) = l.split_once(':')?;
                        k.eq_ignore_ascii_case("content-length")
                            .then(|| v.trim().parse::<usize>().unwrap())
                    })
                    .unwrap_or(0);
                if buf.len() >= at + 4 + len || n == 0 {
                    break;
                }
            }
            if n == 0 {
                break;
            }
        }
        let _ = conn.write_all(reply);
        let _ = conn.shutdown(Shutdown::Write);
        let _ = tx.send(String::from_utf8_lossy(&buf).into_owned());
    });
    (port, rx)
}

/// One connection that reads the request head, writes `reply`, then stays
/// open and silent until the returned sender is dropped.
fn silent_after(reply: &'static [u8]) -> (u16, mpsc::Sender<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (hold, released) = mpsc::channel::<()>();
    std::thread::spawn(move || {
        let (mut conn, _) = listener.accept().unwrap();
        let mut head = Vec::new();
        let mut chunk = [0u8; 4096];
        while !head.windows(4).any(|w| w == b"\r\n\r\n") {
            match conn.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => head.extend_from_slice(&chunk[..n]),
            }
        }
        let _ = conn.write_all(reply);
        let _ = released.recv();
    });
    (port, hold)
}

fn header_lines(raw: &str) -> Vec<(String, String)> {
    raw.split("\r\n\r\n")
        .next()
        .unwrap()
        .lines()
        .skip(1)
        .map(|l| {
            let (k, v) = l.split_once(':').unwrap();
            (k.to_ascii_lowercase(), v.trim().to_owned())
        })
        .collect()
}

fn req(method: &str, url: String, headers: &[(&str, &str)], body: Option<&str>) -> Request {
    Request {
        method: method.into(),
        url,
        headers: headers
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect(),
        body: body.map(str::to_owned),
    }
}

#[tokio::test]
async fn sends_undicis_defaults_after_the_callers_headers() {
    let (port, rx) =
        one_shot(b"HTTP/1.1 201 Made It\r\ncontent-length: 2\r\nconnection: close\r\n\r\nhi");
    let client = HttpsClient::new();
    let res = client
        .fetch(&req(
            "POST",
            format!("http://127.0.0.1:{port}/x?y=1"),
            &[("Content-Type", "application/json")],
            Some("{\"a\":1}"),
        ))
        .await
        .unwrap();
    assert_eq!(
        (res.status, res.status_text.as_str(), res.body.clone()),
        (201, "Made It", Ok(b"hi".to_vec()))
    );
    assert!(res.ok());
    let raw = rx.recv().unwrap();
    assert!(raw.starts_with("POST /x?y=1 HTTP/1.1\r\n"), "{raw}");
    assert!(raw.ends_with("\r\n\r\n{\"a\":1}"), "{raw}");
    let lines = header_lines(&raw);
    for (k, v) in DEFAULT_HEADERS.iter().chain(&[
        ("content-type", "application/json"),
        ("content-length", "7"),
    ]) {
        assert!(
            lines.contains(&((*k).to_owned(), (*v).to_owned())),
            "{k}: {lines:?}"
        );
    }
    // Nothing here decompresses, so nothing asks for compression.
    assert!(lines.contains(&("accept-encoding".into(), "identity".into())));
    let names: Vec<&str> = lines.iter().map(|(k, _)| k.as_str()).collect();
    assert!(
        !names.contains(&"referer") && !names.contains(&"connection"),
        "{names:?}"
    );
}

#[tokio::test]
async fn a_header_the_caller_sets_replaces_the_default() {
    let (port, rx) = one_shot(b"HTTP/1.1 200 OK\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
    HttpsClient::new()
        .fetch(&req(
            "GET",
            format!("http://127.0.0.1:{port}/"),
            &[
                ("User-Agent", "claudius-test"),
                ("ACCEPT", "application/json"),
            ],
            None,
        ))
        .await
        .unwrap();
    let lines = header_lines(&rx.recv().unwrap());
    let all = |name: &str| -> Vec<&str> {
        lines
            .iter()
            .filter(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
            .collect()
    };
    assert_eq!(all("user-agent"), ["claudius-test"]);
    assert_eq!(all("accept"), ["application/json"]);
    assert_eq!(all("sec-fetch-mode"), ["cors"]);
}

#[tokio::test]
async fn failures_read_like_undicis() {
    let client = HttpsClient::new();
    // Refused.
    let port = {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };
    let refused = client
        .fetch(&req("GET", format!("http://127.0.0.1:{port}/"), &[], None))
        .await;
    assert_eq!(refused.unwrap_err().message, FETCH_FAILED);
    // TLS against a server that answers in plain text.
    let (port, _rx) =
        one_shot(b"HTTP/1.1 200 OK\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
    let tls = client
        .fetch(&req("GET", format!("https://127.0.0.1:{port}/"), &[], None))
        .await;
    let tls = tls.unwrap_err();
    assert_eq!(tls.message, FETCH_FAILED);
    // Not a missing trust anchor, so no CC 2.1.309 hint (an untrusted chain
    // is `a_self_signed_chain_is_a_trust_failure`).
    assert!(!tls.ca_trust, "{tls:?}");
    // What `new Request` refuses, in undici's words (node 22).
    for (method, url, want) in [
        (
            "GE T",
            "http://127.0.0.1:9/",
            "'GE T' is not a valid HTTP method.",
        ),
        ("", "http://127.0.0.1:9/", "'' is not a valid HTTP method."),
        (
            "G\u{e9}T",
            "http://127.0.0.1:9/",
            "'G\u{e9}T' is not a valid HTTP method.",
        ),
        (
            "TRACK ",
            "http://127.0.0.1:9/",
            "'TRACK ' is not a valid HTTP method.",
        ),
        (
            "a@b",
            "http://127.0.0.1:9/",
            "'a@b' is not a valid HTTP method.",
        ),
        (
            "CONNECT",
            "http://127.0.0.1:9/",
            "'CONNECT' HTTP method is unsupported.",
        ),
        (
            "track",
            "http://127.0.0.1:9/",
            "'track' HTTP method is unsupported.",
        ),
        ("GET", "nope", "Failed to parse URL from nope"),
    ] {
        let bad = client.fetch(&req(method, url.into(), &[], None)).await;
        assert_eq!(bad.unwrap_err().message, want, "{method} {url}");
    }
    // A scheme fetch can't speak.
    let ftp = client
        .fetch(&req("GET", "ftp://127.0.0.1:9/".into(), &[], None))
        .await;
    assert_eq!(ftp.unwrap_err().message, FETCH_FAILED);
    // Headers, then the body breaks off.
    let (port, _rx) =
        one_shot(b"HTTP/1.1 200 OK\r\ncontent-length: 10\r\nconnection: close\r\n\r\nabc");
    let cut = client
        .fetch(&req("GET", format!("http://127.0.0.1:{port}/"), &[], None))
        .await
        .unwrap();
    assert_eq!(cut.body, Err(TERMINATED.to_owned()));
    assert_eq!(cut.text(), Err(TERMINATED.to_owned()));
    assert_eq!(cut.json(), Err(TERMINATED.to_owned()));
}

#[tokio::test]
async fn standard_methods_are_uppercased() {
    let (port, rx) = one_shot(b"HTTP/1.1 200 OK\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
    HttpsClient::new()
        .fetch(&req(
            "pOsT",
            format!("http://127.0.0.1:{port}/"),
            &[],
            Some(""),
        ))
        .await
        .unwrap();
    assert!(rx.recv().unwrap().starts_with("POST / HTTP/1.1\r\n"));
    let (port, rx) = one_shot(b"HTTP/1.1 200 OK\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
    HttpsClient::new()
        .fetch(&req(
            "patch",
            format!("http://127.0.0.1:{port}/"),
            &[],
            Some(""),
        ))
        .await
        .unwrap();
    assert!(rx.recv().unwrap().starts_with("patch / HTTP/1.1\r\n"));
}

#[test]
fn the_base_rewrite() {
    let c = HttpsClient::new().with_base("http://127.0.0.1:9/");
    for (url, want) in [
        (
            "https://platform.claude.com/v1/oauth/token",
            "http://127.0.0.1:9/platform.claude.com/v1/oauth/token",
        ),
        (
            "https://api.anthropic.com:8443/api/oauth/profile?x=1&y",
            "http://127.0.0.1:9/api.anthropic.com:8443/api/oauth/profile?x=1&y",
        ),
        ("http://h/", "http://127.0.0.1:9/h/"),
        ("not a url", "not a url"),
        ("data:text/plain,x", "data:text/plain,x"),
    ] {
        assert_eq!(c.target(url), want, "{url}");
    }
    assert_eq!(
        HttpsClient::new().target("https://platform.claude.com/x"),
        "https://platform.claude.com/x"
    );
}

#[test]
fn proxies_only_with_node_use_env_proxy_1() {
    assert!(env_proxy_enabled(Some("1")));
    for v in [
        None,
        Some("0"),
        Some("true"),
        Some(""),
        Some("yes"),
        Some(" 1"),
    ] {
        assert!(!env_proxy_enabled(v), "{v:?}");
    }
}

#[tokio::test]
async fn the_profile_fetch_adapter() {
    let client = HttpsClient::new();
    let get = |port: u16| format!("http://127.0.0.1:{port}/api/oauth/profile");
    let auth = vec![("Authorization".to_owned(), "Bearer FAKE-token".to_owned())];
    // A 2xx: the body.
    let (port, rx) =
        one_shot(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}");
    let ok = client.get(&get(port), &auth).await.unwrap();
    assert_eq!((ok.status, ok.body), (200, b"{}".to_vec()));
    let raw = rx.recv().unwrap();
    assert!(
        raw.starts_with("GET /api/oauth/profile HTTP/1.1\r\n"),
        "{raw}"
    );
    assert!(header_lines(&raw).contains(&("authorization".into(), "Bearer FAKE-token".into())));
    // A 2xx whose body breaks off rejects, as `res.json()` inside the try.
    let (port, _rx) =
        one_shot(b"HTTP/1.1 200 OK\r\ncontent-length: 9\r\nconnection: close\r\n\r\n{");
    assert_eq!(
        client.get(&get(port), &auth).await.unwrap_err().message,
        TERMINATED
    );
    // Otherwise a broken body doesn't matter (the lookup never reads it).
    let (port, _rx) =
        one_shot(b"HTTP/1.1 503 Busy\r\ncontent-length: 9\r\nconnection: close\r\n\r\n{");
    let busy = client.get(&get(port), &auth).await.unwrap();
    assert_eq!((busy.status, busy.body), (503, Vec::new()));
}

/// undici's timeouts: 10 s to connect, and 300 s of silence, which fails the
/// fetch before the headers (`fetch failed`) and the body read after them
/// (`terminated`). Replayed here with a 300 ms read timeout.
#[tokio::test]
async fn silence_times_out_like_undicis() {
    assert_eq!(CONNECT_TIMEOUT, Duration::from_secs(10));
    assert_eq!(READ_TIMEOUT, Duration::from_secs(300));
    assert_eq!(
        HttpsClient::new().timeouts(),
        (CONNECT_TIMEOUT, READ_TIMEOUT)
    );
    let read = Duration::from_millis(300);
    let client = HttpsClient::new().with_timeouts(CONNECT_TIMEOUT, read);
    assert_eq!(client.timeouts(), (CONNECT_TIMEOUT, read));
    let get = |port: u16| req("GET", format!("http://127.0.0.1:{port}/"), &[], None);
    // Well past the 300 ms, well short of the 10 s connect timeout.
    let bound = Duration::from_secs(8);

    // No answer at all.
    let (port, _hold) = silent_after(b"");
    let t = Instant::now();
    let silent = tokio::time::timeout(bound, client.fetch(&get(port)))
        .await
        .expect("the read timeout fires");
    assert_eq!(silent.unwrap_err().message, FETCH_FAILED);
    assert!(t.elapsed() >= read, "{:?}", t.elapsed());

    // The headers and part of the body, then nothing.
    let (port, _hold) = silent_after(b"HTTP/1.1 200 OK\r\ncontent-length: 10\r\n\r\nabc");
    let t = Instant::now();
    let stalled = tokio::time::timeout(bound, client.fetch(&get(port)))
        .await
        .expect("the read timeout fires")
        .unwrap();
    assert_eq!((stalled.status, stalled.status_text.as_str()), (200, "OK"));
    assert_eq!(stalled.body, Err(TERMINATED.to_owned()));
    assert!(t.elapsed() >= read, "{:?}", t.elapsed());
}

/// `tests/fixtures/tls/self_signed_cert.der` (EC P-256, CN and SAN
/// `localhost` / `127.0.0.1`) and its key.
const SELF_CERT: &[u8] = include_bytes!("fixtures/tls/self_signed_cert.der");
const SELF_KEY: &[u8] = include_bytes!("fixtures/tls/self_signed_key.der");
/// I19's test CA, a leaf it signed (SAN `localhost` / `127.0.0.1`) and an
/// unrelated CA (`rust/scripts/extra-ca-golden.mjs --make-certs`).
const CA_CERT: &[u8] = include_bytes!("fixtures/tls/extra_ca_cert.der");
const OTHER_CA_CERT: &[u8] = include_bytes!("fixtures/tls/extra_ca_other_cert.der");
const LEAF_CERT: &[u8] = include_bytes!("fixtures/tls/extra_ca_leaf_cert.der");
const LEAF_KEY: &[u8] = include_bytes!("fixtures/tls/extra_ca_leaf_key.der");

/// A TLS server (rustls) presenting `cert` to every connection, until the
/// test ends: once the handshake is through, it answers the request with a
/// 200 `ok` and closes. Every certificate here is valid 2019 to 2119, issued
/// before Apple's validity-length rules apply, so macOS judges it on trust
/// alone.
fn tls_server(cert: &[u8], key: &[u8]) -> u16 {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = rustls::ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(
            vec![CertificateDer::from(cert.to_vec())],
            PrivateKeyDer::Pkcs8(key.to_vec().into()),
        )
        .unwrap();
    let config = Arc::new(config);
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for conn in listener.incoming() {
            let Ok(conn) = conn else { return };
            let config = config.clone();
            std::thread::spawn(move || serve_tls(conn, config));
        }
    });
    port
}

fn serve_tls(mut conn: TcpStream, config: Arc<rustls::ServerConfig>) {
    let mut tls = rustls::ServerConnection::new(config).unwrap();
    let mut s = rustls::Stream::new(&mut tls, &mut conn);
    let mut head = Vec::new();
    let mut chunk = [0u8; 1024];
    // A client that refuses the chain ends the handshake here.
    while !head.windows(4).any(|w| w == b"\r\n\r\n") {
        match s.read(&mut chunk) {
            Ok(0) | Err(_) => return,
            Ok(n) => head.extend_from_slice(&chunk[..n]),
        }
    }
    let _ = s.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok");
    s.conn.send_close_notify();
    let _ = s.flush();
}

fn self_signed_server() -> u16 {
    tls_server(SELF_CERT, SELF_KEY)
}

/// CC 2.1.309: a chain without a trusted root (here self-signed; undici's
/// `cause.code` is `DEPTH_ZERO_SELF_SIGNED_CERT`, which TS's
/// `isCaTrustFailure` matches) is still `fetch failed`, with the trust
/// verdict the account callers turn into their hint. On macOS the verdict is
/// Security.framework's `errSecNotTrusted`, on Linux webpki's
/// `UnknownIssuer`.
#[tokio::test]
async fn a_self_signed_chain_is_a_trust_failure() {
    let port = self_signed_server();
    let client = HttpsClient::new();
    for host in ["127.0.0.1", "localhost"] {
        let err = client
            .fetch(&req("GET", format!("https://{host}:{port}/"), &[], None))
            .await
            .unwrap_err();
        assert_eq!(err.message, FETCH_FAILED, "{host}");
        assert!(err.ca_trust, "{host}: {err:?}");
    }
    // The profile adapter carries the verdict too.
    let err = client
        .get(&format!("https://127.0.0.1:{port}/api/oauth/profile"), &[])
        .await
        .unwrap_err();
    assert_eq!((err.message.as_str(), err.ca_trust), (FETCH_FAILED, true));
}

// ------------------------------------------- NODE_EXTRA_CA_CERTS (I19)

fn extra_ca_fixture() -> Value {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/extra_ca_golden.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// Standard base64 (the fixture's bytes).
fn unbase64(s: &str) -> Vec<u8> {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::new();
    let (mut acc, mut bits) = (0u32, 0);
    for c in s.bytes().filter(|&c| c != b'=') {
        let v = ALPHABET.iter().position(|&a| a == c).expect("base64") as u32;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    out
}

/// The fixture names of the certificates a load kept.
fn cert_names(certs: &[CertificateDer<'static>]) -> Vec<String> {
    certs
        .iter()
        .map(|c| {
            let name = [
                ("ca", CA_CERT),
                ("other", OTHER_CA_CERT),
                ("self", SELF_CERT),
            ]
            .iter()
            .find(|(_, der)| c.as_ref() == *der)
            .map_or("?", |(n, _)| n);
            name.to_owned()
        })
        .collect()
}

/// `p` relative to the test's cwd, through `..`s up to `/`.
fn relative_to_cwd(p: &Path) -> String {
    let cwd = std::env::current_dir().unwrap();
    let ups = cwd.components().count() - 1;
    format!(
        "{}{}",
        "../".repeat(ups),
        p.strip_prefix("/").unwrap().display()
    )
}

#[cfg(unix)]
fn chmod(p: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(p, std::fs::Permissions::from_mode(mode)).unwrap();
}

/// Every case of `fixtures/extra_ca_golden.json` (recorded by
/// `rust/scripts/extra-ca-golden.mjs` from node 22 processes started with
/// that `NODE_EXTRA_CA_CERTS`), against rustls servers presenting the same
/// certificates: the same certificates kept, the same warning (Node's stderr
/// line) and the same fetch outcomes, a rejection's trust verdict being
/// what TS's `isCaTrustFailure` said of undici's error. Node reads the file
/// when `tls` first loads; a client here, when it's built, so a `tls` step
/// (and the first `fetch`) builds it.
#[cfg(unix)]
#[tokio::test]
async fn node_extra_ca_certs_replay_node() {
    let fx = extra_ca_fixture();
    let ports = [
        ("leaf", tls_server(LEAF_CERT, LEAF_KEY)),
        ("self", tls_server(SELF_CERT, SELF_KEY)),
    ];
    let mut failures = Vec::new();
    for case in fx["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let mut path = dir.path().join("ca.pem");
        let env = &case["env"];
        let bytes = || unbase64(env["bytes"].as_str().unwrap());
        let value = match env["kind"].as_str().unwrap() {
            "unset" => None,
            "raw" => Some(env["value"].as_str().unwrap().to_owned()),
            "file" => {
                std::fs::write(&path, bytes()).unwrap();
                Some(path.display().to_string())
            }
            "unreadable" => {
                std::fs::write(&path, bytes()).unwrap();
                chmod(&path, 0);
                if std::fs::read(&path).is_ok() {
                    eprintln!("{name}: skipped (the file still reads: root?)");
                    continue;
                }
                Some(path.display().to_string())
            }
            "relative" => {
                std::fs::write(&path, bytes()).unwrap();
                Some(relative_to_cwd(&path))
            }
            "missing" => Some(path.display().to_string()),
            "dir" => {
                std::fs::create_dir(&path).unwrap();
                Some(path.display().to_string())
            }
            "notdir" => {
                std::fs::write(dir.path().join("file"), CA_CERT).unwrap();
                path = dir.path().join("file").join("ca.pem");
                Some(path.display().to_string())
            }
            k => panic!("{name}: env kind {k}"),
        };
        let mut client: Option<HttpsClient> = None;
        let mut stderr = String::new();
        let mut build = |client: &mut Option<HttpsClient>| {
            if client.is_none() {
                let loaded = extra_ca_env::load(value.as_deref().map(OsStr::new));
                let c = HttpsClient::new().with_node_extra_ca_certs(value.as_deref());
                assert_eq!(c.extra_roots(), loaded.certs.as_slice(), "{name}");
                if let Some(w) = loaded.warning {
                    stderr.push_str(&w);
                    stderr.push('\n');
                }
                *client = Some(c);
            }
        };
        let steps = case["steps"].as_array().unwrap();
        let wants = case["results"].as_array().unwrap();
        assert_eq!(steps.len(), wants.len(), "{name}");
        for (i, (step, want)) in steps.iter().zip(wants).enumerate() {
            let step = step.as_str().unwrap();
            match step {
                "tls" => build(&mut client),
                "write" => {
                    std::fs::write(&path, unbase64(case["later"].as_str().unwrap())).unwrap()
                }
                "rm" => std::fs::remove_file(&path).unwrap(),
                _ => {
                    let server = step.strip_prefix("fetch:").unwrap();
                    let port = ports.iter().find(|(n, _)| *n == server).unwrap().1;
                    build(&mut client);
                    let got = client
                        .as_ref()
                        .unwrap()
                        .fetch(&req("GET", format!("https://127.0.0.1:{port}/"), &[], None))
                        .await;
                    let got = match got {
                        Ok(res) => serde_json::json!({
                            "ok": true,
                            "status": res.status,
                            "body": res.text().unwrap(),
                        }),
                        Err(e) => serde_json::json!({
                            "ok": false,
                            "message": e.message,
                            "caTrust": e.ca_trust,
                        }),
                    };
                    let mut want = want.clone();
                    if let Some(w) = want.as_object_mut() {
                        w.remove("code");
                    }
                    if got != want {
                        failures.push(format!("{name} step {i} ({step}): got {got}, want {want}"));
                    }
                }
            }
        }
        if let Some(v) = &value {
            stderr = stderr.replace(&format!("`{v}`"), "`<value>`");
        }
        if stderr != case["stderr"].as_str().unwrap() {
            failures.push(format!(
                "{name}: warning {stderr:?}, want {:?}",
                case["stderr"]
            ));
        }
        let extra = client.as_ref().map(|c| cert_names(c.extra_roots()));
        let want_extra: Option<Vec<String>> =
            serde_json::from_value(case["extra"].clone()).unwrap();
        if extra != want_extra {
            failures.push(format!("{name}: kept {extra:?}, want {want_extra:?}"));
        }
        if env["kind"] == "unreadable" {
            chmod(&path, 0o600);
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// The OS store stays: a client with the bundle still refuses a chain
/// neither trusts as a trust failure (R08's verdict, CC 2.1.309's hint),
/// and one without it refuses the CA-signed leaf the same way.
#[tokio::test]
async fn an_untrusted_chain_is_still_a_trust_failure() {
    let leaf = tls_server(LEAF_CERT, LEAF_KEY);
    let selfs = self_signed_server();
    let dir = tempfile::tempdir().unwrap();
    let bundle = dir.path().join("ca.pem");
    std::fs::write(&bundle, pem(CA_CERT)).unwrap();
    let with = HttpsClient::new().with_node_extra_ca_certs(Some(bundle.to_str().unwrap()));
    let without = HttpsClient::new().with_node_extra_ca_certs(None);
    let get = |port: u16, host: &str| req("GET", format!("https://{host}:{port}/"), &[], None);
    for host in ["127.0.0.1", "localhost"] {
        let ok = with.fetch(&get(leaf, host)).await.unwrap();
        assert_eq!(
            (ok.status, ok.text().unwrap().as_str()),
            (200, "ok"),
            "{host}"
        );
        for (client, port) in [(&with, selfs), (&without, leaf)] {
            let err = client.fetch(&get(port, host)).await.unwrap_err();
            assert_eq!(
                (err.message.as_str(), err.ca_trust),
                (FETCH_FAILED, true),
                "{host}"
            );
        }
    }
    // The profile adapter goes through the same roots.
    let ok = with
        .get(&format!("https://localhost:{leaf}/api/oauth/profile"), &[])
        .await
        .unwrap();
    assert_eq!((ok.status, ok.body), (200, b"ok".to_vec()));
}

/// The bundle is read when the client is built, not per request (Node:
/// once per process); `with_base` and `with_timeouts` keep it.
#[tokio::test]
async fn the_bundle_is_read_once_when_the_client_is_built() {
    let leaf = tls_server(LEAF_CERT, LEAF_KEY);
    let dir = tempfile::tempdir().unwrap();
    let bundle = dir.path().join("ca.pem");
    std::fs::write(&bundle, pem(CA_CERT)).unwrap();
    let client = HttpsClient::new()
        .with_node_extra_ca_certs(Some(bundle.to_str().unwrap()))
        .with_timeouts(CONNECT_TIMEOUT, READ_TIMEOUT)
        .with_base(format!("https://127.0.0.1:{leaf}"));
    std::fs::write(&bundle, "garbage\n").unwrap();
    assert_eq!(cert_names(client.extra_roots()), ["ca"]);
    for _ in 0..2 {
        let res = client
            .fetch(&req("GET", "https://api.anthropic.com/x".into(), &[], None))
            .await
            .unwrap();
        assert_eq!(res.status, 200);
        std::fs::remove_file(&bundle).ok();
    }
    // Every `new()` shares the process's one list.
    let (a, b) = (HttpsClient::new(), HttpsClient::new());
    assert!(std::ptr::eq(a.extra_roots(), b.extra_roots()));
    assert_eq!(a.extra_roots(), extra_ca_env::process_roots().as_ref());
}

/// `der` as a PEM `CERTIFICATE` block.
fn pem(der: &[u8]) -> String {
    let b64 = claudius_core::settings_export::base64(der);
    let lines: Vec<&str> = b64
        .as_bytes()
        .chunks(64)
        .map(|l| std::str::from_utf8(l).unwrap())
        .collect();
    format!(
        "-----BEGIN CERTIFICATE-----\n{}\n-----END CERTIFICATE-----\n",
        lines.join("\n")
    )
}
