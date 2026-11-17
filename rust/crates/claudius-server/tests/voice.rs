//! The dictation routes (`GET /api/voice/stream`, `POST /api/voice/chunk`,
//! `POST /api/voice/close`) against the real binary, replaying
//! `fixtures/voice_golden.json` (recorded by `rust/scripts/voice-golden.mjs`
//! from the real TS routes, `voice-stream.ts` and `ws`).
//!
//! Each world gets the recorder's files, user settings
//! (`$HOME/.claude/settings.json`), accounts and environment (a
//! `NODE_EXTRA_CA_CERTS` the binary reads once, at boot, as Node does: I23),
//! and the same
//! fake upstream: raw RFC 6455 on 127.0.0.1, plain or TLS (certificates made
//! by `openssl` for the run, as the recorder makes them), picking its
//! scenario from the `language` query parameter, reached through
//! `VOICE_STREAM_BASE_URL`. Every step must answer what the TS answered:
//! status, content type and body text, the stream's text (without its
//! `: ping` heartbeats), and the upstream's log of each connection (the
//! request line and headers the socket wrote, the frames it sent, how it
//! closed).
#![cfg(unix)]

mod common;

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use common::{Server, World};
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use serde_json::{Value, json};

fn fixture() -> &'static Value {
    static F: OnceLock<Value> = OnceLock::new();
    F.get_or_init(|| {
        let path =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/voice_golden.json");
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    })
}

// ------------------------------------------------------------ certificates

/// The recorder's certificates, made once per test binary.
fn certs() -> &'static Path {
    static DIR: OnceLock<tempfile::TempDir> = OnceLock::new();
    DIR.get_or_init(|| {
        let dir = tempfile::tempdir().unwrap();
        let ssl = |args: &[&str]| {
            let out = std::process::Command::new("openssl")
                .args(args)
                .current_dir(dir.path())
                .output()
                .expect("openssl on PATH");
            assert!(
                out.status.success(),
                "openssl {args:?}: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        };
        for name in ["ca", "other"] {
            ssl(&[
                "req",
                "-x509",
                "-newkey",
                "rsa:2048",
                "-nodes",
                "-keyout",
                &format!("{name}.key"),
                "-out",
                &format!("{name}.pem"),
                "-days",
                "30",
                "-subj",
                &format!("/CN=Voice Golden {name}"),
                "-addext",
                "basicConstraints=critical,CA:TRUE",
                "-addext",
                "keyUsage=critical,keyCertSign,cRLSign",
            ]);
        }
        for (name, san) in [("leaf", "IP:127.0.0.1"), ("host", "DNS:localhost")] {
            std::fs::write(
                dir.path().join(format!("{name}.ext")),
                format!(
                    "subjectAltName={san}\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n"
                ),
            )
            .unwrap();
            ssl(&[
                "req",
                "-newkey",
                "rsa:2048",
                "-nodes",
                "-keyout",
                &format!("{name}.key"),
                "-out",
                &format!("{name}.csr"),
                "-subj",
                "/CN=127.0.0.1",
            ]);
            ssl(&[
                "x509",
                "-req",
                "-in",
                &format!("{name}.csr"),
                "-CA",
                "ca.pem",
                "-CAkey",
                "ca.key",
                "-set_serial",
                "2",
                "-out",
                &format!("{name}.pem"),
                "-days",
                "30",
                "-extfile",
                &format!("{name}.ext"),
            ]);
        }
        ssl(&[
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-keyout",
            "self.key",
            "-out",
            "self.pem",
            "-days",
            "30",
            "-subj",
            "/CN=127.0.0.1",
            "-addext",
            "subjectAltName=IP:127.0.0.1",
            "-addext",
            "extendedKeyUsage=serverAuth",
        ]);
        dir
    })
    .path()
}

fn tls_config(name: &str) -> Arc<rustls::ServerConfig> {
    let dir = certs();
    let chain: Vec<CertificateDer<'static>> =
        CertificateDer::pem_file_iter(dir.join(format!("{name}.pem")))
            .unwrap()
            .map(Result::unwrap)
            .collect();
    let key = PrivateKeyDer::from_pem_file(dir.join(format!("{name}.key"))).unwrap();
    Arc::new(
        rustls::ServerConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(chain, key)
        .unwrap(),
    )
}

// ---------------------------------------------------------- the fake server

const KEEPALIVE: &str = r#"{"type":"KeepAlive"}"#;

#[derive(Default)]
struct Conn {
    log: Vec<String>,
    done: bool,
}

type Logs = Arc<Mutex<HashMap<String, Conn>>>;

trait Io: Read + Write + Send {}
impl<T: Read + Write + Send> Io for T {}

/// An unmasked server frame.
fn frame(opcode: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = vec![0x80 | opcode];
    if payload.len() < 126 {
        out.push(payload.len() as u8);
    } else {
        out.push(126);
        out.extend_from_slice(&(payload.len() as u16).to_be_bytes());
    }
    out.extend_from_slice(payload);
    out
}

fn close_frame(code: u16, reason: &str) -> Vec<u8> {
    let mut p = code.to_be_bytes().to_vec();
    p.extend_from_slice(reason.as_bytes());
    frame(0x8, &p)
}

/// `URLSearchParams.get(key)` on a query.
fn query_param(query: &str, key: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        (form_decode(k) == key).then(|| form_decode(v))
    })
}

fn form_decode(s: &str) -> String {
    let b = s.as_bytes();
    let hex = |i: usize| b.get(i).and_then(|c| char::from(*c).to_digit(16));
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        match (b[i], hex(i + 1), hex(i + 2)) {
            (b'+', ..) => out.push(b' '),
            (b'%', Some(hi), Some(lo)) => {
                out.push((hi * 16 + lo) as u8);
                i += 2;
            }
            (c, ..) => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The fake upstream on a free port; `tls` serves that certificate.
fn start_upstream(tls: Option<Arc<rustls::ServerConfig>>) -> (u16, Logs) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let logs: Logs = Arc::default();
    let shared = Arc::clone(&logs);
    std::thread::spawn(move || {
        for tcp in listener.incoming() {
            let Ok(tcp) = tcp else { continue };
            let (logs, tls) = (Arc::clone(&shared), tls.clone());
            std::thread::spawn(move || {
                let io: Box<dyn Io> = match tls {
                    Some(cfg) => Box::new(rustls::StreamOwned::new(
                        rustls::ServerConnection::new(cfg).unwrap(),
                        tcp,
                    )),
                    None => Box::new(tcp),
                };
                serve(io, &logs);
            });
        }
    });
    (port, logs)
}

fn serve(mut io: Box<dyn Io>, logs: &Logs) {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 65536];
    // The request head.
    let end = loop {
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i;
        }
        match io.read(&mut chunk) {
            Ok(0) | Err(_) => return,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
    };
    let head: String = buf[..end].iter().map(|&b| char::from(b)).collect();
    buf.drain(..end + 4);
    let mut lines = head.split("\r\n");
    let request_line = lines.next().unwrap_or_default().to_owned();
    let path = request_line.split(' ').nth(1).unwrap_or_default();
    let query = path.split_once('?').map_or("", |(_, q)| q);
    let lang = query_param(query, "language").unwrap_or_default();
    let mut log = vec![format!("request {request_line}")];
    let mut key = String::new();
    for line in lines {
        let (name, value) = line.split_once(':').unwrap_or((line, ""));
        let value = value.trim();
        if name.eq_ignore_ascii_case("sec-websocket-key") {
            key = value.to_owned();
            log.push(format!("header {name}: <key>"));
        } else {
            log.push(format!("header {name}: {value}"));
        }
    }
    let push = |entry: String| {
        logs.lock()
            .unwrap()
            .entry(lang.clone())
            .or_default()
            .log
            .push(entry);
    };
    for entry in log {
        push(entry);
    }
    let mut keepalive = false;
    let finish = |eof: bool, keepalive: bool| {
        let mut map = logs.lock().unwrap();
        let conn = map.entry(lang.clone()).or_default();
        if eof {
            conn.log.push("eof".into());
        }
        if keepalive {
            conn.log.push("keepalive".into());
        }
        conn.done = true;
    };
    let accept = tungstenite::handshake::derive_accept_key(key.as_bytes());
    let ok = |extra: &str| {
        format!(
            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n{extra}\r\n"
        )
        .into_bytes()
    };
    let with = |head: Vec<u8>, frames: &[u8]| [head, frames.to_vec()].concat();
    let scenario: String = lang.chars().take_while(char::is_ascii_lowercase).collect();
    let reply: Vec<u8> = match scenario.as_str() {
        "multi" => [
            ok(""),
            frame(0x1, b"line one\nline two"),
            frame(0x2, &[1, 2, 3]),
            frame(0x9, b"hi"),
            frame(0x1, br#"{"type":"TranscriptInterim","data":"x"}"#),
            close_frame(4001, "bye \u{e9}"),
        ]
        .concat(),
        "reject" => b"HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}".to_vec(),
        "badaccept" => b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: bm90IHRoZSBhY2NlcHQ=\r\n\r\n".to_vec(),
        "badupgrade" => String::from_utf8(ok(""))
            .unwrap()
            .replacen("Upgrade: websocket", "Upgrade: h2c", 1)
            .into_bytes(),
        "protocol" => ok("Sec-WebSocket-Protocol: chat\r\n"),
        "extensions" => ok("Sec-WebSocket-Extensions: permessage-deflate\r\n"),
        "hangup" => return finish(false, false),
        "garbage" => b"NOPE\r\n\r\n".to_vec(),
        "rsv" => with(ok(""), &[0xa1, 0x01, 0x78]),
        "badutf" => with(ok(""), &[0x81, 0x02, 0x61, 0xff]),
        "badclose" => with(ok(""), &[0x88, 0x02, 0x03, 0xed]),
        "masked" => with(ok(""), &[0x81, 0x81, 1, 2, 3, 4, 0x78 ^ 1]),
        "big" => with(ok(""), &[0x81, 127, 0, 0, 0, 0, 0x06, 0x40, 0x00, 0x01]),
        _ => ok(""),
    };
    if io.write_all(&reply).and_then(|()| io.flush()).is_err() {
        return finish(true, keepalive);
    }
    // The client's frames.
    loop {
        while let Some((op, payload, used)) = parse_frame(&buf) {
            buf.drain(..used);
            match op {
                0x1 => {
                    let text = String::from_utf8_lossy(&payload).into_owned();
                    if text == KEEPALIVE {
                        keepalive = true;
                        continue;
                    }
                    push(format!("text {text}"));
                    if text == r#"{"type":"CloseStream"}"# {
                        let out = [
                            frame(
                                0x1,
                                br#"{"type":"TranscriptText","data":"final \"text\" \u00e9"}"#,
                            ),
                            frame(0x1, br#"{"type":"TranscriptEndpoint"}"#),
                            close_frame(1000, ""),
                        ]
                        .concat();
                        let _ = io.write_all(&out).and_then(|()| io.flush());
                    }
                }
                0x2 => {
                    let hex: String = payload.iter().take(8).map(|b| format!("{b:02x}")).collect();
                    push(format!("binary {} {hex}", payload.len()));
                    let reply = format!(
                        r#"{{"type":"TranscriptInterim","data":"{} bytes"}}"#,
                        payload.len()
                    );
                    let _ = io
                        .write_all(&frame(0x1, reply.as_bytes()))
                        .and_then(|()| io.flush());
                }
                0xa => push(format!("pong {}", String::from_utf8_lossy(&payload))),
                0x8 => {
                    push(if payload.len() >= 2 {
                        format!(
                            "close {} {}",
                            u16::from_be_bytes([payload[0], payload[1]]),
                            String::from_utf8_lossy(&payload[2..])
                        )
                    } else {
                        "close".into()
                    });
                    return finish(false, keepalive);
                }
                other => push(format!("opcode {other}")),
            }
        }
        match io.read(&mut chunk) {
            Ok(0) | Err(_) => return finish(true, keepalive),
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
    }
}

/// One (masked) client frame: opcode, unmasked payload, bytes used.
fn parse_frame(buf: &[u8]) -> Option<(u8, Vec<u8>, usize)> {
    if buf.len() < 2 {
        return None;
    }
    let op = buf[0] & 0x0f;
    let mut len = usize::from(buf[1] & 0x7f);
    let mut off = 2;
    if len == 126 {
        len = usize::from(u16::from_be_bytes([*buf.get(2)?, *buf.get(3)?]));
        off = 4;
    } else if len == 127 {
        len = u64::from_be_bytes(buf.get(2..10)?.try_into().ok()?) as usize;
        off = 10;
    }
    let masked = buf[1] & 0x80 != 0;
    let start = off + if masked { 4 } else { 0 };
    let total = start + len;
    if buf.len() < total {
        return None;
    }
    let mut payload = buf[start..total].to_vec();
    if masked {
        let mask = &buf[off..off + 4];
        for (i, b) in payload.iter_mut().enumerate() {
            *b ^= mask[i & 3];
        }
    }
    Some((op, payload, total))
}

// ------------------------------------------------------------- the client

/// A response head: status and the headers, lower-cased names.
fn read_head(s: &mut TcpStream) -> (u16, HashMap<String, String>, Vec<u8>) {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let end = loop {
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i;
        }
        let n = s.read(&mut chunk).unwrap();
        assert!(n > 0, "no response head");
        buf.extend_from_slice(&chunk[..n]);
    };
    let head = String::from_utf8_lossy(&buf[..end]).into_owned();
    let rest = buf[end + 4..].to_vec();
    let mut lines = head.split("\r\n");
    let status = lines
        .next()
        .unwrap()
        .split(' ')
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    let headers = lines
        .filter_map(|l| {
            let (k, v) = l.split_once(':')?;
            Some((k.trim().to_ascii_lowercase(), v.trim().to_owned()))
        })
        .collect();
    (status, headers, rest)
}

/// Reads a chunked body into `text` as it arrives; `ended` at its last
/// chunk (or the socket's end).
#[derive(Default)]
struct Body {
    text: String,
    ended: bool,
}

fn read_chunked(mut s: TcpStream, mut buf: Vec<u8>, body: Arc<Mutex<Body>>) {
    let mut chunk = [0u8; 65536];
    let mut raw = Vec::new();
    loop {
        // Every complete chunk in `buf`.
        while let Some(i) = buf.windows(2).position(|w| w == b"\r\n") {
            let size =
                usize::from_str_radix(String::from_utf8_lossy(&buf[..i]).trim(), 16).unwrap();
            if buf.len() < i + 2 + size + 2 {
                break;
            }
            raw.extend_from_slice(&buf[i + 2..i + 2 + size]);
            buf.drain(..i + 2 + size + 2);
            let mut b = body.lock().unwrap();
            b.text = String::from_utf8_lossy(&raw).into_owned();
            if size == 0 {
                b.ended = true;
                return;
            }
        }
        match s.read(&mut chunk) {
            Ok(0) | Err(_) => {
                body.lock().unwrap().ended = true;
                return;
            }
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
    }
}

/// The whole body of a response that ends with the connection.
fn read_body(s: &mut TcpStream, headers: &HashMap<String, String>, mut rest: Vec<u8>) -> String {
    s.read_to_end(&mut rest).unwrap_or_default();
    if headers.get("transfer-encoding").map(String::as_str) == Some("chunked") {
        let mut raw = Vec::new();
        let mut buf = &rest[..];
        while let Some(i) = buf.windows(2).position(|w| w == b"\r\n") {
            let size =
                usize::from_str_radix(String::from_utf8_lossy(&buf[..i]).trim(), 16).unwrap();
            if size == 0 {
                break;
            }
            raw.extend_from_slice(&buf[i + 2..i + 2 + size]);
            buf = &buf[i + 2 + size + 2..];
        }
        return String::from_utf8_lossy(&raw).into_owned();
    }
    String::from_utf8_lossy(&rest).into_owned()
}

struct Stream {
    sock: TcpStream,
    body: Arc<Mutex<Body>>,
}

fn unpinged(text: &str) -> String {
    text.replace(": ping\n\n", "")
}

fn wait_for(what: &str, timeout: Duration, mut f: impl FnMut() -> bool) {
    let t0 = Instant::now();
    while !f() {
        assert!(t0.elapsed() < timeout, "timed out: {what}");
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn post(port: u16, step: &Value) -> Value {
    let path = step["path"].as_str().unwrap();
    let body: Vec<u8> = if let Some(fill) = step["fill"].as_array() {
        vec![fill[0].as_u64().unwrap() as u8; fill[1].as_u64().unwrap() as usize]
    } else if let Some(hex) = step["hex"].as_str() {
        (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
            .collect()
    } else {
        Vec::new()
    };
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    let mut req = format!("POST {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n");
    let payload = if step["cl"] == json!(false) {
        req.push_str("Transfer-Encoding: chunked\r\n\r\n");
        let mut p = format!("{:x}\r\n", body.len()).into_bytes();
        p.extend_from_slice(&body);
        p.extend_from_slice(b"\r\n0\r\n\r\n");
        p
    } else {
        req.push_str(&format!("Content-Length: {}\r\n\r\n", body.len()));
        body
    };
    let mut w = s.try_clone().unwrap();
    let writer = std::thread::spawn(move || {
        let _ = w
            .write_all(req.as_bytes())
            .and_then(|()| w.write_all(&payload));
    });
    let (status, headers, rest) = read_head(&mut s);
    let text = read_body(&mut s, &headers, rest);
    let _ = writer.join();
    json!({"status": status, "type": headers.get("content-type"), "body": text})
}

// ---------------------------------------------------------------- replay

fn replay(name: &str) {
    let w = fixture()["worlds"]
        .as_array()
        .unwrap()
        .iter()
        .find(|w| w["name"] == name)
        .unwrap_or_else(|| panic!("no world {name}"));
    let world = World::new();
    // `homedir()` is the world's state home (`CLAUDIUS_STATE_HOME`).
    let home = world.home.clone();
    let accounts = world.root.path().join("accounts");
    std::fs::create_dir_all(&accounts).unwrap();
    for (rel, src) in w["files"].as_object().unwrap() {
        let bytes = match src["text"].as_str() {
            Some(t) => t.as_bytes().to_vec(),
            None => {
                let pem = certs().join(format!("{}.pem", src["cert"].as_str().unwrap()));
                let text = |k: &str| src[k].as_str().unwrap_or_default().as_bytes().to_vec();
                [text("before"), std::fs::read(pem).unwrap(), text("after")].concat()
            }
        };
        std::fs::write(home.join(rel), bytes).unwrap();
    }
    if !w["settings"].is_null() {
        std::fs::create_dir_all(home.join(".claude")).unwrap();
        std::fs::write(
            home.join(".claude/settings.json"),
            serde_json::to_string_pretty(&w["settings"]).unwrap(),
        )
        .unwrap();
    }
    let accounts_path = accounts.join("accounts.json");
    std::fs::write(
        &accounts_path,
        serde_json::to_string_pretty(&fixture()["accounts"]).unwrap(),
    )
    .unwrap();

    let upstream = w["upstream"].as_str().unwrap();
    let (base, port, logs) = match upstream {
        "plain" => {
            let (port, logs) = start_upstream(None);
            (format!("ws://127.0.0.1:{port}"), Some(port), Some(logs))
        }
        "refused" => {
            let port = common::free_port();
            (format!("ws://127.0.0.1:{port}"), Some(port), None)
        }
        "badurl" => ("not a url".to_owned(), None, None),
        tls => {
            let cert = tls.strip_prefix("tls:").unwrap();
            let (port, logs) = start_upstream(Some(tls_config(cert)));
            (format!("wss://127.0.0.1:{port}"), Some(port), Some(logs))
        }
    };
    let norm = |s: &str| match port {
        Some(p) => s.replace(&format!(":{p}"), ":<port>"),
        None => s.to_owned(),
    };
    let home_s = home.display().to_string();
    let accounts_s = accounts.display().to_string();
    let extra_ca = match w["envRaw"]["NODE_EXTRA_CA_CERTS"].as_str() {
        Some(raw) => raw.to_owned(),
        None => w["env"]["NODE_EXTRA_CA_CERTS"]
            .as_str()
            .map(|rel| home.join(rel).display().to_string())
            .unwrap_or_default(),
    };
    let server = Server::spawn(
        &world,
        &[
            ("HOME", &home_s),
            ("CLAUDIUS_ACCOUNTS_DIR", &accounts_s),
            ("VOICE_STREAM_BASE_URL", &base),
            // Empty is unset for the TS and here alike.
            ("NODE_EXTRA_CA_CERTS", &extra_ca),
        ],
    );

    let mut streams: HashMap<String, Stream> = HashMap::new();
    let steps = w["steps"].as_array().unwrap();
    let results = w["results"].as_array().unwrap();
    for (i, (step, want)) in steps.iter().zip(results).enumerate() {
        let got = match step["op"].as_str().unwrap() {
            "accounts" => {
                if step["remove"] == json!(true) {
                    let _ = std::fs::remove_file(&accounts_path);
                } else if let Some(text) = step["text"].as_str() {
                    std::fs::write(&accounts_path, text).unwrap();
                } else {
                    std::fs::write(
                        &accounts_path,
                        serde_json::to_string_pretty(&step["json"]).unwrap(),
                    )
                    .unwrap();
                }
                Value::Null
            }
            "file" => {
                let path = home.join(step["path"].as_str().unwrap());
                if step["remove"] == json!(true) {
                    std::fs::remove_file(path).unwrap();
                } else {
                    std::fs::write(path, step["text"].as_str().unwrap()).unwrap();
                }
                Value::Null
            }
            "open" => {
                let mut s = TcpStream::connect(("127.0.0.1", server.port)).unwrap();
                write!(
                    s,
                    "GET /api/voice/stream?{} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
                    step["q"].as_str().unwrap()
                )
                .unwrap();
                let (status, headers, rest) = read_head(&mut s);
                let h = |k: &str| json!(headers.get(k));
                if status == 200 {
                    let body = Arc::new(Mutex::new(Body::default()));
                    let reader = s.try_clone().unwrap();
                    let shared = Arc::clone(&body);
                    std::thread::spawn(move || read_chunked(reader, rest, shared));
                    streams.insert(
                        step["s"].as_str().unwrap().to_owned(),
                        Stream { sock: s, body },
                    );
                    json!({"status": status, "type": h("content-type"), "cache": h("cache-control"),
                        "connection": h("connection"), "buffering": h("x-accel-buffering")})
                } else {
                    // Keep-alive: the body is as long as Content-Length says.
                    let len: usize = headers["content-length"].parse().unwrap();
                    let mut body = rest;
                    while body.len() < len {
                        let mut chunk = [0u8; 4096];
                        let n = s.read(&mut chunk).unwrap();
                        assert!(n > 0);
                        body.extend_from_slice(&chunk[..n]);
                    }
                    json!({"status": status, "type": h("content-type"),
                        "body": String::from_utf8_lossy(&body)})
                }
            }
            "wait" => {
                let st = &streams[step["s"].as_str().unwrap()];
                let needle = step["needle"].as_str().unwrap();
                wait_for(
                    &format!("{needle} on step {i}"),
                    Duration::from_secs(10),
                    || st.body.lock().unwrap().text.contains(needle),
                );
                Value::Null
            }
            "drain" => {
                let st = &streams[step["s"].as_str().unwrap()];
                wait_for(
                    &format!("end of stream, step {i}"),
                    Duration::from_secs(60),
                    || st.body.lock().unwrap().ended,
                );
                let text = st.body.lock().unwrap().text.clone();
                let mut got = json!({"text": norm(&unpinged(&text))});
                if want.get("pinged").is_some() {
                    got["pinged"] = json!(text.contains(": ping\n\n"));
                }
                got
            }
            "abort" => {
                let st = &streams[step["s"].as_str().unwrap()];
                let text = st.body.lock().unwrap().text.clone();
                st.sock.shutdown(Shutdown::Both).unwrap();
                json!({"text": norm(&unpinged(&text))})
            }
            "upstream" => {
                let logs = logs.as_ref().unwrap();
                let lang = step["lang"].as_str().unwrap();
                wait_for(&format!("upstream {lang}"), Duration::from_secs(10), || {
                    logs.lock().unwrap().get(lang).is_some_and(|c| c.done)
                });
                let log = logs.lock().unwrap()[lang].log.clone();
                json!(log.iter().map(|l| norm(l)).collect::<Vec<_>>())
            }
            "settle" => {
                std::thread::sleep(Duration::from_millis(step["ms"].as_u64().unwrap()));
                Value::Null
            }
            "post" => post(server.port, step),
            other => panic!("unknown op {other}"),
        };
        assert_eq!(&got, want, "world {name}, step {i}: {step}");
    }
}

#[test]
fn main_world() {
    replay("main");
}

#[test]
fn refused() {
    replay("refused");
}

#[test]
fn bad_url() {
    replay("bad-url");
}

#[test]
fn tls_self_signed() {
    replay("tls-self-signed");
}

#[test]
fn tls_leaf_untrusted() {
    replay("tls-leaf-untrusted");
}

#[test]
fn tls_settings_ca() {
    replay("tls-settings-ca");
}

#[test]
fn tls_settings_wrong_ca() {
    replay("tls-settings-wrong-ca");
}

#[test]
fn tls_env_ca() {
    replay("tls-env-ca");
}

#[test]
fn tls_wrong_host() {
    replay("tls-wrong-host");
}

#[test]
fn tls_env_ca_read_once() {
    replay("tls-env-ca-read-once");
}

#[test]
fn tls_env_ca_then_bad_der() {
    replay("tls-env-ca-then-bad-der");
}

#[test]
fn tls_env_bad_der_then_ca() {
    replay("tls-env-bad-der-then-ca");
}

#[test]
fn tls_env_and_settings() {
    replay("tls-env-and-settings");
}

#[test]
fn tls_env_blank_and_settings() {
    replay("tls-env-blank-and-settings");
}

// ------------------------------------------ the process's bundle (I23)

const I19_CA: &[u8] = include_bytes!("../../claudius-core/tests/fixtures/tls/extra_ca_cert.der");
const I19_LEAF: &[u8] =
    include_bytes!("../../claudius-core/tests/fixtures/tls/extra_ca_leaf_cert.der");
const I19_LEAF_KEY: &[u8] =
    include_bytes!("../../claudius-core/tests/fixtures/tls/extra_ca_leaf_key.der");

/// I23: a real-environment `NODE_EXTRA_CA_CERTS` reaches the socket as the
/// binary read it at boot (I19's `process_roots()`, which the HTTPS client
/// shares), with Node's rules: the CA before a broken block is kept and
/// Node's warning is logged once, at boot. Opens after the bundle is
/// garbled, then removed, still trust the CA and log nothing more. The fake
/// upstream presents I19's CA-signed leaf.
#[test]
fn the_env_bundle_is_read_once_at_boot() {
    let config = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .unwrap()
    .with_no_client_auth()
    .with_single_cert(
        vec![CertificateDer::from(I19_LEAF.to_vec())],
        PrivateKeyDer::Pkcs8(I19_LEAF_KEY.to_vec().into()),
    )
    .unwrap();
    let (upstream, logs) = start_upstream(Some(Arc::new(config)));
    let world = World::new();
    let accounts = world.root.path().join("accounts");
    std::fs::create_dir_all(&accounts).unwrap();
    std::fs::write(
        accounts.join("accounts.json"),
        serde_json::to_string_pretty(&fixture()["accounts"]).unwrap(),
    )
    .unwrap();
    let b64 = claudius_core::settings_export::base64(I19_CA);
    let lines: Vec<&str> = b64
        .as_bytes()
        .chunks(64)
        .map(|l| std::str::from_utf8(l).unwrap())
        .collect();
    let bundle = world.root.path().join("bundle.pem");
    std::fs::write(
        &bundle,
        format!(
            "-----BEGIN CERTIFICATE-----\n{}\n-----END CERTIFICATE-----\n\
             -----BEGIN CERTIFICATE-----\nAAAAAAAA\n-----END CERTIFICATE-----\n",
            lines.join("\n")
        ),
    )
    .unwrap();
    let base = format!("wss://127.0.0.1:{upstream}");
    let server = Server::spawn(
        &world,
        &[
            ("HOME", world.home.to_str().unwrap()),
            ("CLAUDIUS_ACCOUNTS_DIR", accounts.to_str().unwrap()),
            ("VOICE_STREAM_BASE_URL", &base),
            ("NODE_EXTRA_CA_CERTS", bundle.to_str().unwrap()),
        ],
    );
    // As read, then garbled, then gone.
    for i in 0..3 {
        match i {
            1 => std::fs::write(&bundle, "garbage\n").unwrap(),
            2 => std::fs::remove_file(&bundle).unwrap(),
            _ => {}
        }
        let (id, lang) = (format!("bootRead000{i}"), format!("en-{i}"));
        let mut s = TcpStream::connect(("127.0.0.1", server.port)).unwrap();
        write!(
            s,
            "GET /api/voice/stream?id={id}&lang={lang} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n"
        )
        .unwrap();
        let (status, _, rest) = read_head(&mut s);
        assert_eq!(status, 200, "open {i}");
        let body = Arc::new(Mutex::new(Body::default()));
        let (reader, shared) = (s.try_clone().unwrap(), Arc::clone(&body));
        std::thread::spawn(move || read_chunked(reader, rest, shared));
        wait_for(&format!("open {i}"), Duration::from_secs(20), || {
            let b = body.lock().unwrap();
            b.text.contains("event: ") || b.ended
        });
        let text = unpinged(&body.lock().unwrap().text);
        assert_eq!(
            text,
            format!("retry: 3600000\n\nevent: ready\ndata: {{\"id\":\"{id}\"}}\n\n"),
            "open {i}"
        );
        s.shutdown(Shutdown::Both).unwrap();
        wait_for(&format!("upstream {i}"), Duration::from_secs(10), || {
            logs.lock().unwrap().get(&lang).is_some_and(|c| c.done)
        });
    }
    let (_, log, _) = server.stop(Duration::from_secs(10));
    let want = format!(
        "Warning: Ignoring extra certs from `{}`, load failed: error:0488000D:PEM routines::ASN1 lib",
        bundle.display()
    );
    assert_eq!(log.matches(&want).count(), 1, "{log}");
    assert_eq!(log.matches("Ignoring extra certs").count(), 1, "{log}");
    assert!(!log.contains("upstream error"), "{log}");
}

#[test]
fn every_world_is_replayed() {
    let names: Vec<&str> = fixture()["worlds"]
        .as_array()
        .unwrap()
        .iter()
        .map(|w| w["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        names,
        [
            "main",
            "refused",
            "bad-url",
            "tls-self-signed",
            "tls-leaf-untrusted",
            "tls-settings-ca",
            "tls-settings-wrong-ca",
            "tls-env-ca",
            "tls-wrong-host",
            "tls-env-ca-read-once",
            "tls-env-ca-then-bad-der",
            "tls-env-bad-der-then-ca",
            "tls-env-and-settings",
            "tls-env-blank-and-settings"
        ]
    );
}
