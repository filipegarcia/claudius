//! I19: the binary's outbound client (`AppState::https`: sign-in, the
//! profile lookup, the updater changelog, LiteLLM prices, community) trusts
//! the bundle a process-env `NODE_EXTRA_CA_CERTS` names on top of the OS
//! store, read once at boot, with Node's stderr warning for one that doesn't
//! load. The probe is sign-in's token exchange (CC 2.1.309's hint tells the
//! user to set the variable), sent to a local rustls server whose leaf the
//! test CA signed (`CLAUDIUS_DEV_FETCH_BASE`). What Node does with each kind
//! of bundle is replayed in claudius-core's `tests/fetch_client.rs`.
#![cfg(unix)]

mod common;

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;
use std::time::Duration;

use claudius_agent::js;
use common::{Server, World, http};
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use serde_json::json;

const CA_CERT: &[u8] = include_bytes!("../../claudius-core/tests/fixtures/tls/extra_ca_cert.der");
const LEAF_CERT: &[u8] =
    include_bytes!("../../claudius-core/tests/fixtures/tls/extra_ca_leaf_cert.der");
const LEAF_KEY: &[u8] =
    include_bytes!("../../claudius-core/tests/fixtures/tls/extra_ca_leaf_key.der");

/// The token endpoint: TLS with the CA-signed leaf, a 401 to every request.
fn token_server() -> u16 {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = rustls::ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(
            vec![CertificateDer::from(LEAF_CERT.to_vec())],
            PrivateKeyDer::Pkcs8(LEAF_KEY.to_vec().into()),
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
    let mut got = Vec::new();
    let mut chunk = [0u8; 4096];
    // The head and the JSON body (no `}` in the head).
    while !(got.windows(4).any(|w| w == b"\r\n\r\n") && got.ends_with(b"}")) {
        match s.read(&mut chunk) {
            Ok(0) | Err(_) => return,
            Ok(n) => got.extend_from_slice(&chunk[..n]),
        }
    }
    let _ = s.write_all(
        b"HTTP/1.1 401 Unauthorized\r\ncontent-type: application/json\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}",
    );
    s.conn.send_close_notify();
    let _ = s.flush();
}

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

/// The binary with dev routes on, outbound requests sent to `base`, and
/// `NODE_EXTRA_CA_CERTS` set to `bundle` (`""` is unset to Node).
fn spawn(world: &World, base: &str, bundle: &str) -> Server {
    let accounts = world.home.join("accounts");
    Server::spawn(
        world,
        &[
            ("CLAUDIUS_DEV", "1"),
            ("CLAUDIUS_DEV_FETCH_BASE", base),
            ("CLAUDIUS_ACCOUNTS_DIR", accounts.to_str().unwrap()),
            ("NODE_USE_ENV_PROXY", ""),
            ("NODE_EXTRA_CA_CERTS", bundle),
        ],
    )
}

/// Sign-in's `start` then `complete`: the complete's `(status, body)`.
fn sign_in(port: u16) -> (u16, String) {
    let (status, body) = http(port, "POST", "/api/accounts/oauth", r#"{"action":"start"}"#);
    assert_eq!(status, 200, "{body}");
    let flow = js::json_parse(&body).unwrap()["flowId"].clone();
    let complete = json!({"action": "complete", "flowId": flow, "code": "c", "label": "L"});
    http(port, "POST", "/api/accounts/oauth", &complete.to_string())
}

#[test]
fn the_env_bundle_is_trusted_by_the_servers_client() {
    let base = format!("https://127.0.0.1:{}", token_server());
    let dir = tempfile::tempdir().unwrap();
    let bundle = dir.path().join("ca.pem");
    std::fs::write(&bundle, pem(CA_CERT)).unwrap();
    for (value, want) in [
        // Trusted: the endpoint's own refusal.
        (
            bundle.to_str().unwrap(),
            "{\"error\":\"Invalid authorization code. The codes expire fast \u{2014} try signing in again.\"}",
        ),
        // Untrusted: the CC 2.1.309 hint, which says to set the variable.
        (
            "",
            "{\"error\":\"Sign-in couldn't reach Anthropic. The server's certificate isn't trusted, usually because a TLS-inspecting proxy is in the way. Start Claudius with NODE_EXTRA_CA_CERTS set to the proxy's CA bundle.\"}",
        ),
    ] {
        let world = World::new();
        let server = spawn(&world, &base, value);
        assert_eq!(sign_in(server.port), (400, want.to_owned()), "{value:?}");
        let (_, log, _) = server.stop(Duration::from_secs(10));
        assert!(!log.contains("Ignoring extra certs"), "{value:?}: {log}");
    }
}

/// Node's warning, logged once as the server boots (before any request),
/// then the default roots: sign-in still gets the hint.
#[test]
fn a_bundle_that_does_not_load_warns_at_boot() {
    let base = format!("https://127.0.0.1:{}", token_server());
    let world = World::new();
    let missing = world.root.path().join("missing.pem");
    let want = format!(
        "Warning: Ignoring extra certs from `{}`, load failed: error:80000002:system library::No such file or directory",
        missing.display()
    );
    let server = spawn(&world, &base, missing.to_str().unwrap());
    let (_, log, _) = server.stop(Duration::from_secs(10));
    assert_eq!(log.matches(&want).count(), 1, "{log}");

    let world = World::new();
    let server = spawn(&world, &base, missing.to_str().unwrap());
    let (status, body) = sign_in(server.port);
    assert_eq!(status, 400);
    assert!(
        body.contains("Start Claudius with NODE_EXTRA_CA_CERTS"),
        "{body}"
    );
    let (_, log, _) = server.stop(Duration::from_secs(10));
    assert_eq!(log.matches(&want).count(), 1, "{log}");
}
