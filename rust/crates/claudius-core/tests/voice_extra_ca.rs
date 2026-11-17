//! I23: the dictation socket (`voice_ws`) without TS's `ca` trusts what
//! Node's default store holds, the OS store plus the roots a process-env
//! `NODE_EXTRA_CA_CERTS` added once ([`Trust::Default`] over
//! `extra_ca_env`). Replayed against every case of I19's
//! `fixtures/extra_ca_golden.json` (node 22 processes started with that
//! `NODE_EXTRA_CA_CERTS`, then fetching): the socket, given the roots
//! `extra_ca_env::load` read for that value, must open where Node's fetch
//! got through, and fail with the same `code` (the one `ws` would carry, as
//! both sit on Node's default secure context) and the same trust verdict
//! where it didn't. The file is read once, before the first socket, so a
//! case's later `write` / `rm` must change nothing. The servers are rustls
//! WebSocket servers presenting I19's CA-signed leaf or R08's self-signed
//! one. The binary's wiring (`process_roots()` at boot, no re-read per open)
//! is replayed against the TS in claudius-server's `tests/voice.rs`.
#![cfg(unix)]

use std::ffi::OsStr;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use claudius_core::extra_ca_env;
use claudius_core::tls_cert_hint::is_ca_trust_failure;
use claudius_core::voice_ws::{self, Event, Trust};
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use serde_json::{Value, json};

const SELF_CERT: &[u8] = include_bytes!("fixtures/tls/self_signed_cert.der");
const SELF_KEY: &[u8] = include_bytes!("fixtures/tls/self_signed_key.der");
const LEAF_CERT: &[u8] = include_bytes!("fixtures/tls/extra_ca_leaf_cert.der");
const LEAF_KEY: &[u8] = include_bytes!("fixtures/tls/extra_ca_leaf_key.der");
const CA_CERT: &[u8] = include_bytes!("fixtures/tls/extra_ca_cert.der");

/// A WebSocket server over TLS presenting `cert`: every connection that
/// gets through the handshake is upgraded, then held until the client
/// goes.
fn wss_server(cert: &[u8], key: &[u8]) -> u16 {
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
            std::thread::spawn(move || serve(conn, config));
        }
    });
    port
}

fn serve(mut conn: TcpStream, config: Arc<rustls::ServerConfig>) {
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
    let head = String::from_utf8_lossy(&head).into_owned();
    let key = head
        .lines()
        .find_map(|l| {
            let (k, v) = l.split_once(':')?;
            k.eq_ignore_ascii_case("sec-websocket-key")
                .then(|| v.trim().to_owned())
        })
        .unwrap_or_default();
    let accept = tungstenite::handshake::derive_accept_key(key.as_bytes());
    let reply = format!(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n"
    );
    if s.write_all(reply.as_bytes())
        .and_then(|()| s.flush())
        .is_err()
    {
        return;
    }
    while matches!(s.read(&mut chunk), Ok(n) if n > 0) {}
}

/// The socket's first event, `{"ok": true}` for `open`, else the error's
/// `code` and trust verdict, as the fixture records a fetch.
async fn first_event(port: u16, trust: &Trust) -> Value {
    let url = format!("wss://127.0.0.1:{port}/api/ws/speech_to_text/voice_stream");
    let (upstream, mut events) = voice_ws::open(&url, &[], trust.clone(), None).unwrap();
    let ev = tokio::time::timeout(Duration::from_secs(20), events.recv())
        .await
        .expect("an event within 20 s");
    match ev {
        Some(Event::Open) => {
            upstream.close(1000, "done");
            json!({"ok": true})
        }
        Some(Event::Error(err)) => json!({
            "ok": false,
            "code": err["code"],
            "caTrust": is_ca_trust_failure(&err),
        }),
        other => panic!("unexpected first event {other:?}"),
    }
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

fn chmod(p: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(p, std::fs::Permissions::from_mode(mode)).unwrap();
}

#[tokio::test]
async fn the_default_store_holds_what_node_loaded() {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/extra_ca_golden.json");
    let fx: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let ports = [
        ("leaf", wss_server(LEAF_CERT, LEAF_KEY)),
        ("self", wss_server(SELF_CERT, SELF_KEY)),
    ];
    let (mut failures, mut sockets, mut skipped) = (Vec::new(), 0, 0);
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
                    skipped += fetches(case);
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
        // Node reads the file when `tls` first loads (a `tls` step, or the
        // first fetch); the process keeps that list.
        let mut trust: Option<Trust> = None;
        let load = |trust: &mut Option<Trust>| {
            trust.get_or_insert_with(|| {
                let loaded = extra_ca_env::load(value.as_deref().map(OsStr::new));
                Trust::Default(loaded.certs.into())
            });
        };
        let steps = case["steps"].as_array().unwrap();
        let wants = case["results"].as_array().unwrap();
        for (i, (step, want)) in steps.iter().zip(wants).enumerate() {
            let step = step.as_str().unwrap();
            match step {
                "tls" => load(&mut trust),
                "write" => {
                    std::fs::write(&path, unbase64(case["later"].as_str().unwrap())).unwrap()
                }
                "rm" => std::fs::remove_file(&path).unwrap(),
                _ => {
                    let server = step.strip_prefix("fetch:").unwrap();
                    let port = ports.iter().find(|(n, _)| *n == server).unwrap().1;
                    load(&mut trust);
                    let got = first_event(port, trust.as_ref().unwrap()).await;
                    sockets += 1;
                    let want = if want["ok"] == json!(true) {
                        json!({"ok": true})
                    } else {
                        json!({"ok": false, "code": want["code"], "caTrust": want["caTrust"]})
                    };
                    if got != want {
                        failures.push(format!("{name} step {i} ({step}): got {got}, want {want}"));
                    }
                }
            }
        }
        if env["kind"] == "unreadable" {
            chmod(&path, 0o600);
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
    let all: usize = fx["cases"].as_array().unwrap().iter().map(fetches).sum();
    assert_eq!((sockets + skipped, all), (57, 57));
}

/// A case's `fetch:` steps.
fn fetches(case: &Value) -> usize {
    case["steps"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|s| s.as_str().unwrap().starts_with("fetch:"))
        .count()
}

/// What `voice_stream` hands the socket without a settings-only bundle:
/// the process's list (read once), shared with `fetch::HttpsClient`.
#[test]
fn the_process_default_is_the_process_roots() {
    let Trust::Default(roots) = Trust::process_default() else {
        panic!("not the default store");
    };
    assert!(Arc::ptr_eq(&roots, &extra_ca_env::process_roots()));
    let client = claudius_core::fetch::HttpsClient::new();
    assert_eq!(client.extra_roots(), &roots[..]);
}
