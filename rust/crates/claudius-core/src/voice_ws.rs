//! The dictation proxy's upstream WebSocket: the part of the `ws` package
//! (8.21.0) `lib/server/voice-stream.ts` uses, over tokio.
//!
//! `openUpstream` opens one client socket to the voice endpoint with the
//! account's bearer token and relays its text frames. What reaches the
//! composer is `ws`'s own wording, so this mirrors `ws` and the Node layers
//! under it rather than wrapping a Rust WebSocket client:
//!
//! - the request `ws` writes, byte for byte: `GET <path> HTTP/1.1`, the
//!   caller's headers in their order, then `Sec-WebSocket-Version: 13`,
//!   `Sec-WebSocket-Key` (16 random bytes, base64), `Connection: Upgrade`,
//!   `Upgrade: websocket` and Node's `Host` (no port when it's the scheme's
//!   default). Header values go out as Node writes them (latin-1), and one
//!   Node refuses (a byte outside `\t`, `\x20`-`\x7e`, `\x80`-`\xff`, which
//!   a hand-edited token can hold) is the `TypeError` it throws;
//! - `connect ECONNREFUSED 127.0.0.1:1234` / `getaddrinfo ENOTFOUND host`
//!   and their `code`s, as Node's net layer words them; several addresses
//!   that all fail are Node's `AggregateError`, whose `message` is empty;
//! - llhttp's parse errors (`Parse Error: Invalid header token`), and
//!   `ws`'s four handshake checks in `ws`'s order (`Invalid Upgrade
//!   header`, `Invalid Sec-WebSocket-Accept header`, `Server sent a
//!   subprotocol but none was requested`, `Server sent a
//!   Sec-WebSocket-Extensions header but no extension was requested`);
//! - a response that isn't an upgrade (any non-101 status, a 101 without
//!   `Connection: upgrade` and a non-empty `Upgrade`) hangs the socket in
//!   CONNECTING forever, because the TS listens for `unexpected-response`
//!   and swallows it. Mirrored, bug included (see the module's note);
//! - the receiver's frame checks with `ws`'s messages and close codes
//!   (`Invalid WebSocket frame: RSV2 and RSV3 must be clear`, `…: invalid
//!   opcode 3`, `…: invalid status code 1005`, `…: invalid UTF-8 sequence`,
//!   and the unprefixed `Max payload size exceeded`, …),
//!   its 100 MiB `maxPayload`, its auto-pong, its close echo (the peer's
//!   code and reason, or an empty frame for 1005), its 30 s close timer,
//!   and `close` with 1006 and no reason when the socket ends without one;
//! - `readyState`, which the TS reads before every send.
//!
//! Certificates are checked against the OS trust store
//! (rustls-platform-verifier, as [`crate::fetch`]) plus the [`Trust`]'s
//! roots (the process's `NODE_EXTRA_CA_CERTS` ones, or the PEM
//! [`crate::extra_ca_certs`] resolved), and a failure is reported in Node's
//! words (`self-signed certificate`,
//! `DEPTH_ZERO_SELF_SIGNED_CERT`), which is what
//! [`crate::tls_cert_hint`] keys the composer's hint off.
//!
//! Where it differs from the TS (none is reachable from the UI):
//! * Node checks its bundled Mozilla root list, this the OS trust store, so
//!   a chain only one of them trusts fails on the other ([`crate::fetch`]
//!   has the same difference). TS also *replaces* the trust store with
//!   `[...rootCertificates, pem]` for a settings-only bundle; here the
//!   bundle is added to the OS roots (and, as there, the process's
//!   `NODE_EXTRA_CA_CERTS` roots are left out: `rootCertificates` is
//!   Node's bundled list alone).
//! * A TLS failure that is neither a trust, validity nor name failure
//!   (an alert during the handshake, say) is rustls's message, not
//!   OpenSSL's (`write EPROTO …`).
//! * `ws`'s `permessage-deflate`, subprotocols, redirects, `ws+unix:` and
//!   basic-auth URLs aren't implemented: the TS turns the first two off and
//!   never builds the rest. A redirect is therefore an unexpected response
//!   (which hangs) rather than a followed one — TS doesn't follow either
//!   (`followRedirects` defaults to false), it reports `Unexpected server
//!   response: 302`… which it then swallows, so both hang.
//! * The receiver's `maxFragments` / `maxBufferedChunks` back-pressure
//!   limits (a message in more than 1024 fragments) aren't mirrored.

use std::io;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::sync::atomic::{AtomicU8, Ordering};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tungstenite::protocol::frame::coding::{Control, Data, OpCode};
use tungstenite::protocol::frame::{Frame, FrameHeader};

use crate::node_err;
pub use crate::voice_tls::Trust;

/// `WebSocket.CONNECTING`.
pub const CONNECTING: u8 = 0;
/// `WebSocket.OPEN`.
pub const OPEN: u8 = 1;
/// `WebSocket.CLOSING`.
pub const CLOSING: u8 = 2;
/// `WebSocket.CLOSED`.
pub const CLOSED: u8 = 3;

/// `ws`'s default `maxPayload`.
pub const MAX_PAYLOAD: usize = 100 * 1024 * 1024;
/// `ws`'s default `closeTimeout`: how long a close frame waits for its echo
/// before the socket is destroyed.
pub const CLOSE_TIMEOUT: Duration = Duration::from_secs(30);
/// Node's `--max-http-header-size`.
const MAX_HEADER_SIZE: usize = 16 * 1024;

/// What the TS's `ws.on(…)` handlers hear.
#[derive(Clone, Debug, PartialEq)]
pub enum Event {
    /// `"open"`.
    Open,
    /// `"message"` with `isBinary` false. A binary message is dropped, as
    /// the TS's handler drops it.
    Text(String),
    /// `"error"`, as the JS error object the TS reads (`message`, `code`,
    /// `cause`).
    Error(Value),
    /// `"close"`.
    Close { code: u16, reason: String },
}

#[derive(Debug)]
enum Cmd {
    Text(String),
    Binary(Vec<u8>),
    Close { code: u16, reason: String },
}

/// One upstream socket: `readyState` and the three calls the TS makes.
/// Dropping it leaves the socket alone (the TS holds it for the session's
/// lifetime and closes it explicitly).
#[derive(Clone, Debug)]
pub struct Upstream {
    state: Arc<AtomicU8>,
    cmd: mpsc::UnboundedSender<Cmd>,
}

impl Upstream {
    /// `ws.readyState`.
    pub fn ready_state(&self) -> u8 {
        self.state.load(Ordering::SeqCst)
    }

    /// `ws.send(text)`.
    pub fn send_text(&self, text: impl Into<String>) {
        let _ = self.cmd.send(Cmd::Text(text.into()));
    }

    /// `ws.send(bytes, { binary: true })`.
    pub fn send_binary(&self, bytes: Vec<u8>) {
        let _ = self.cmd.send(Cmd::Binary(bytes));
    }

    /// `ws.close(code, reason)`.
    pub fn close(&self, code: u16, reason: impl Into<String>) {
        let _ = self.cmd.send(Cmd::Close {
            code,
            reason: reason.into(),
        });
    }
}

/// `new WebSocket(url, { headers, perMessageDeflate: false, ca })`: the
/// socket and the events it will emit, or the message of the error the
/// constructor throws (a URL `ws` refuses, a header value Node refuses).
/// `trust` is `ca` ([`Trust::Ca`]) or, without it, Node's default store
/// ([`Trust::Default`]).
/// `greeting` is a text frame sent as the socket opens, before any frame
/// that came with the handshake is read: what the TS's `open` handler sends
/// synchronously (its first `KeepAlive`).
///
/// Needs a tokio runtime; the socket runs as a task until it closes.
pub fn open(
    url: &str,
    headers: &[(String, String)],
    trust: Trust,
    greeting: Option<String>,
) -> Result<(Upstream, mpsc::UnboundedReceiver<Event>), String> {
    let target = Target::parse(url)?;
    let key = handshake_key();
    let request = request_bytes(&target, headers, &key)?;
    let state = Arc::new(AtomicU8::new(CONNECTING));
    let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
    let (ev_tx, ev_rx) = mpsc::unbounded_channel();
    tokio::spawn(run(
        target,
        request,
        key,
        trust,
        greeting,
        Socket {
            state: Arc::clone(&state),
            events: ev_tx,
        },
        cmd_rx,
    ));
    Ok((Upstream { state, cmd: cmd_tx }, ev_rx))
}

// ───────────────────────────────── the URL ────────────────────────────────

/// What `initAsClient` keeps of the URL.
#[derive(Clone, Debug, PartialEq)]
struct Target {
    secure: bool,
    /// `parsedUrl.hostname`, without the brackets of an IPv6 literal.
    host: String,
    port: u16,
    /// `parsedUrl.pathname + parsedUrl.search`.
    path: String,
    /// Node's `Host` header.
    host_header: String,
}

impl Target {
    /// `new URL(address)` and `initAsClient`'s checks on it.
    fn parse(address: &str) -> Result<Target, String> {
        let url = url::Url::parse(address).map_err(|_| format!("Invalid URL: {address}"))?;
        let secure = match url.scheme() {
            "ws" | "http" => false,
            "wss" | "https" => true,
            _ => {
                return Err(
                    "The URL's protocol must be one of \"ws:\", \"wss:\", \"http:\", \"https:\", or \"ws+unix:\""
                        .to_owned(),
                );
            }
        };
        if url.fragment().is_some() {
            return Err("The URL contains a fragment identifier".to_owned());
        }
        let default_port = if secure { 443 } else { 80 };
        let port = url.port().unwrap_or(default_port);
        let host = url.host_str().unwrap_or_default();
        // `hostname` keeps an IPv6 literal's brackets, which `ws` strips for
        // the connection but Node keeps for the `Host` header.
        let bare = host
            .strip_prefix('[')
            .and_then(|h| h.strip_suffix(']'))
            .unwrap_or(host);
        let host_header = if port == default_port {
            host.to_owned()
        } else {
            format!("{host}:{port}")
        };
        let mut path = url.path().to_owned();
        if let Some(q) = url.query() {
            path.push('?');
            path.push_str(q);
        }
        Ok(Target {
            secure,
            host: bare.to_owned(),
            port,
            path,
            host_header,
        })
    }
}

/// `randomBytes(16).toString("base64")`.
fn handshake_key() -> String {
    let mut raw = [0u8; 16];
    if getrandom::fill(&mut raw).is_err() {
        raw.copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    }
    base64(&raw)
}

fn base64(bytes: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = u32::from(b[0]) << 16 | u32::from(b[1]) << 8 | u32::from(b[2]);
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(char::from(A[(n >> (18 - 6 * i) & 0x3f) as usize]));
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// Node's `checkInvalidHeaderChar`.
fn invalid_header_char(value: &str) -> bool {
    value
        .chars()
        .any(|c| !matches!(c, '\t' | ' '..='~' | '\u{80}'..='\u{ff}'))
}

/// The bytes `ws` writes for the opening handshake, or the message of the
/// `TypeError` Node throws for a header value it refuses.
fn request_bytes(
    target: &Target,
    headers: &[(String, String)],
    key: &str,
) -> Result<Vec<u8>, String> {
    let own = [
        ("Sec-WebSocket-Version", "13".to_owned()),
        ("Sec-WebSocket-Key", key.to_owned()),
        ("Connection", "Upgrade".to_owned()),
        ("Upgrade", "websocket".to_owned()),
        ("Host", target.host_header.clone()),
    ];
    let mut out = Vec::new();
    out.extend_from_slice(format!("GET {} HTTP/1.1\r\n", target.path).as_bytes());
    for (name, value) in headers
        .iter()
        .map(|(n, v)| (n.as_str(), v))
        .chain(own.iter().map(|(n, v)| (*n, v)))
    {
        if invalid_header_char(value) {
            return Err(format!("Invalid character in header content [\"{name}\"]"));
        }
        out.extend_from_slice(name.as_bytes());
        out.extend_from_slice(b": ");
        // Node writes a header value latin-1, so U+00E9 goes out as 0xE9.
        out.extend(value.chars().map(|c| c as u8));
        out.extend_from_slice(b"\r\n");
    }
    out.extend_from_slice(b"\r\n");
    Ok(out)
}

// ──────────────────────────────── the socket ──────────────────────────────

/// The event side of one socket, and the `readyState` the TS reads.
struct Socket {
    state: Arc<AtomicU8>,
    events: mpsc::UnboundedSender<Event>,
}

impl Socket {
    fn set(&self, state: u8) {
        self.state.store(state, Ordering::SeqCst);
    }

    fn emit(&self, ev: Event) {
        let _ = self.events.send(ev);
    }

    /// `emitErrorAndClose`: CLOSING, the error, then `close` with the
    /// default 1006 and no reason.
    fn error_and_close(&self, err: Value) {
        self.set(CLOSING);
        self.emit(Event::Error(err));
        self.set(CLOSED);
        self.emit(Event::Close {
            code: 1006,
            reason: String::new(),
        });
    }
}

/// A JS error object as the TS reads it.
fn err_with_code(message: impl Into<String>, code: &str) -> Value {
    json!({"message": message.into(), "code": code})
}

/// `abortHandshake`'s plain `Error` (no `code`).
fn plain_err(message: impl Into<String>) -> Value {
    json!({"message": message.into()})
}

trait Io: AsyncRead + AsyncWrite + Send + Unpin {}
impl<T: AsyncRead + AsyncWrite + Send + Unpin> Io for T {}

async fn run(
    target: Target,
    request: Vec<u8>,
    key: String,
    trust: Trust,
    greeting: Option<String>,
    sock: Socket,
    mut cmds: mpsc::UnboundedReceiver<Cmd>,
) {
    let tcp = match connect(&target).await {
        Ok(s) => s,
        Err(e) => return sock.error_and_close(e),
    };
    let mut io: Box<dyn Io> = if target.secure {
        match crate::voice_tls::wrap(tcp, &target.host, &trust).await {
            Ok(s) => Box::new(s),
            Err(e) => return sock.error_and_close(e),
        }
    } else {
        Box::new(tcp)
    };

    if let Err(e) = io.write_all(&request).await {
        return sock.error_and_close(socket_error(&e));
    }

    // The handshake response, and whatever of the first frames came with it.
    let mut buf = Vec::new();
    let head = loop {
        match read_response(&buf, &key) {
            Ok(Some(head)) => break head,
            Err(e) => return sock.error_and_close(e),
            Ok(None) => {}
        }
        if buf.len() > MAX_HEADER_SIZE {
            // Not probed: Node's parse error past `--max-http-header-size`.
            return sock.error_and_close(err_with_code(
                "Parse Error: Header overflow",
                "HPE_HEADER_OVERFLOW",
            ));
        }
        let mut chunk = [0u8; 8192];
        match io.read(&mut chunk).await {
            // The request got no answer: Node's `socket hang up`.
            Ok(0) => {
                return sock.error_and_close(err_with_code("socket hang up", "ECONNRESET"));
            }
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
            Err(e) => return sock.error_and_close(socket_error(&e)),
        }
    };
    match head {
        Head::Upgrade { rest } => {
            sock.set(OPEN);
            if let Some(text) = greeting {
                // A failed write shows up on the next read.
                let frame = Frame::message(text.into_bytes(), OpCode::Data(Data::Text), true);
                let _ = write_frame(&mut io, frame).await;
            }
            sock.emit(Event::Open);
            relay(io, rest, sock, cmds).await;
        }
        // `unexpected-response`: the TS's listener swallows it, so the
        // socket stays in CONNECTING until the session closes it.
        Head::Unexpected => {
            while let Some(cmd) = cmds.recv().await {
                if matches!(cmd, Cmd::Close { .. }) {
                    // `ws.close()` in CONNECTING aborts the handshake.
                    return sock.error_and_close(plain_err(
                        "WebSocket was closed before the connection was established",
                    ));
                }
            }
        }
        Head::Failed(e) => sock.error_and_close(e),
    }
}

/// Node's `net.connect`: every address the name resolves to, in order.
async fn connect(target: &Target) -> Result<TcpStream, Value> {
    let addrs: Vec<SocketAddr> =
        match tokio::net::lookup_host((target.host.as_str(), target.port)).await {
            Ok(a) => a.collect(),
            Err(_) => {
                return Err(err_with_code(
                    format!("getaddrinfo ENOTFOUND {}", target.host),
                    "ENOTFOUND",
                ));
            }
        };
    let mut last = None;
    for addr in &addrs {
        match TcpStream::connect(addr).await {
            Ok(s) => return Ok(s),
            Err(e) => last = Some((e, *addr)),
        }
    }
    let Some((e, addr)) = last else {
        return Err(err_with_code(
            format!("getaddrinfo ENOTFOUND {}", target.host),
            "ENOTFOUND",
        ));
    };
    let code = io_code(&e);
    if addrs.len() > 1 {
        // Node's happy-eyeballs `AggregateError`, whose own message is
        // empty and whose `errors` the TS never reads.
        return Err(err_with_code("", &code));
    }
    let host = match addr.ip() {
        IpAddr::V4(ip) => ip.to_string(),
        IpAddr::V6(ip) => ip.to_string(),
    };
    Err(err_with_code(
        format!("connect {code} {host}:{}", addr.port()),
        &code,
    ))
}

/// libuv's name for an `io::Error` (`ECONNREFUSED`).
fn io_code(e: &io::Error) -> String {
    node_err::uv_exception(e, "connect", None, None).code
}

/// A read or write failure on an open socket, in Node's words.
fn socket_error(e: &io::Error) -> Value {
    let ne = node_err::uv_exception(e, "read", None, None);
    if e.kind() == io::ErrorKind::UnexpectedEof {
        return err_with_code("socket hang up", "ECONNRESET");
    }
    err_with_code(format!("read {}", ne.code), &ne.code)
}

enum Head {
    /// A 101 upgrade `ws` accepted; `rest` is what followed the headers.
    Upgrade { rest: Vec<u8> },
    /// A response that isn't an upgrade (`unexpected-response`).
    Unexpected,
    /// A parse error, or one of `ws`'s four handshake checks.
    Failed(Value),
}

/// Classify the response in `buf`: `Ok(None)` while the headers are
/// incomplete.
fn read_response(buf: &[u8], key: &str) -> Result<Option<Head>, Value> {
    let mut headers = [httparse::EMPTY_HEADER; 64];
    let mut res = httparse::Response::new(&mut headers);
    let used = match res.parse(buf) {
        Ok(httparse::Status::Complete(n)) => n,
        Ok(httparse::Status::Partial) => return Ok(None),
        Err(e) => return Err(parse_error(e)),
    };
    let status = res.code.unwrap_or(0);
    // An informational response is not the answer (`100 Continue`).
    if (100..200).contains(&status) && status != 101 {
        return read_response(&buf[used..], key).map(|h| {
            h.map(|h| match h {
                Head::Upgrade { rest } => Head::Upgrade { rest },
                other => other,
            })
        });
    }
    let header = |name: &str| -> Option<String> {
        let mut values = res
            .headers
            .iter()
            .filter(|h| h.name.eq_ignore_ascii_case(name))
            .map(|h| String::from_utf8_lossy(h.value).into_owned())
            .peekable();
        values.peek().is_some().then(|| {
            // Node joins a repeated header's values with ", ".
            values.collect::<Vec<_>>().join(", ")
        })
    };
    // llhttp sets the upgrade flag when `Connection` holds the `upgrade`
    // token and `Upgrade` has a value; Node only emits `upgrade` then.
    let upgrade = header("upgrade").filter(|u| !u.is_empty());
    let connection_upgrade = header("connection").is_some_and(|c| {
        c.split(',')
            .any(|t| t.trim().eq_ignore_ascii_case("upgrade"))
    });
    if upgrade.is_none() || !connection_upgrade {
        return Ok(Some(Head::Unexpected));
    }
    if upgrade.as_deref().map(str::to_ascii_lowercase).as_deref() != Some("websocket") {
        return Ok(Some(Head::Failed(plain_err("Invalid Upgrade header"))));
    }
    if header("sec-websocket-accept").as_deref()
        != Some(&tungstenite::handshake::derive_accept_key(key.as_bytes()))
    {
        return Ok(Some(Head::Failed(plain_err(
            "Invalid Sec-WebSocket-Accept header",
        ))));
    }
    if header("sec-websocket-protocol").is_some() {
        return Ok(Some(Head::Failed(plain_err(
            "Server sent a subprotocol but none was requested",
        ))));
    }
    if header("sec-websocket-extensions").is_some() {
        return Ok(Some(Head::Failed(plain_err(
            "Server sent a Sec-WebSocket-Extensions header but no extension was requested",
        ))));
    }
    Ok(Some(Head::Upgrade {
        rest: buf[used..].to_vec(),
    }))
}

/// llhttp's message and code for a response it refuses.
fn parse_error(e: httparse::Error) -> Value {
    let (text, code) = match e {
        httparse::Error::Status => ("Invalid status code", "HPE_INVALID_STATUS"),
        httparse::Error::NewLine => ("Missing expected CR after response line", "HPE_CR_EXPECTED"),
        httparse::Error::HeaderName | httparse::Error::Token => {
            ("Invalid header token", "HPE_INVALID_HEADER_TOKEN")
        }
        httparse::Error::TooManyHeaders => ("Header overflow", "HPE_HEADER_OVERFLOW"),
        // `Version`, `HeaderValue` and the rest: llhttp fails the status
        // line first.
        _ => ("Expected HTTP/, RTSP/ or ICE/", "HPE_INVALID_CONSTANT"),
    };
    err_with_code(format!("Parse Error: {text}"), code)
}

// ──────────────────────────────── the frames ──────────────────────────────

/// After the upgrade: the TS's sends out, the peer's frames in.
async fn relay(
    mut io: Box<dyn Io>,
    head: Vec<u8>,
    sock: Socket,
    mut cmds: mpsc::UnboundedReceiver<Cmd>,
) {
    let mut rx = Receiver::new(head);
    // `ws` sets `_closeCode` to 1006 and `_closeMessage` to "" up front;
    // a close frame replaces them.
    let mut close_code = 1006u16;
    let mut close_reason = String::new();
    let mut close_sent = false;
    let mut close_received = false;
    let mut timer: Option<std::pin::Pin<Box<tokio::time::Sleep>>> = None;
    let mut chunk = [0u8; 65536];
    loop {
        // Everything already buffered, before another read.
        loop {
            match rx.next() {
                Ok(None) => break,
                Ok(Some(Decoded::Text(text))) => sock.emit(Event::Text(text)),
                // The TS's `message` handler drops a binary frame.
                Ok(Some(Decoded::Binary)) => {}
                Ok(Some(Decoded::Ping(payload))) => {
                    if sock.state.load(Ordering::SeqCst) == OPEN
                        && write_frame(&mut io, Frame::pong(payload)).await.is_err()
                    {
                        break;
                    }
                }
                Ok(Some(Decoded::Pong)) => {}
                Ok(Some(Decoded::Close { code, reason })) => {
                    close_received = true;
                    close_code = code;
                    close_reason = reason.clone();
                    if !close_sent {
                        sock.set(CLOSING);
                        let frame = if code == 1005 {
                            Frame::close(None)
                        } else {
                            close_frame(code, &reason)
                        };
                        let _ = write_frame(&mut io, frame).await;
                        close_sent = true;
                    }
                    // Both halves are done: `socket.end()`.
                    let _ = io.shutdown().await;
                }
                Err(e) => {
                    // `receiverOnError`: close with the error's status code,
                    // emit the error, and stop reading. (`ws` then waits for
                    // the peer to end the socket; nothing the TS does with
                    // the session depends on when.)
                    sock.set(CLOSING);
                    if !close_sent {
                        let _ = write_frame(&mut io, close_frame(e.status, "")).await;
                    }
                    sock.emit(Event::Error(err_with_code(e.message, e.code)));
                    sock.set(CLOSED);
                    return sock.emit(Event::Close {
                        code: close_code,
                        reason: close_reason,
                    });
                }
            }
        }
        let timeout = async {
            match timer.as_mut() {
                Some(t) => t.await,
                None => std::future::pending().await,
            }
        };
        tokio::select! {
            cmd = cmds.recv() => match cmd {
                Some(Cmd::Text(text)) => {
                    // `sendAfterClose` silently buffers a send past CLOSING.
                    if sock.state.load(Ordering::SeqCst) == OPEN {
                        let frame = Frame::message(text.into_bytes(), OpCode::Data(Data::Text), true);
                        if write_frame(&mut io, frame).await.is_err() { break; }
                    }
                }
                Some(Cmd::Binary(bytes)) => {
                    if sock.state.load(Ordering::SeqCst) == OPEN {
                        let frame = Frame::message(bytes, OpCode::Data(Data::Binary), true);
                        if write_frame(&mut io, frame).await.is_err() { break; }
                    }
                }
                Some(Cmd::Close { code, reason }) => {
                    if sock.state.load(Ordering::SeqCst) == OPEN {
                        sock.set(CLOSING);
                        let _ = write_frame(&mut io, close_frame(code, &reason)).await;
                        close_sent = true;
                        timer = Some(Box::pin(tokio::time::sleep(CLOSE_TIMEOUT)));
                    } else if close_sent && close_received {
                        let _ = io.shutdown().await;
                    }
                }
                // The session dropped the socket without closing it.
                None => break,
            },
            read = io.read(&mut chunk) => match read {
                Ok(0) => break,
                Ok(n) => rx.push(&chunk[..n]),
                Err(_) => break,
            },
            // The close frame's echo never came: destroy the socket.
            () = timeout => break,
        }
    }
    sock.set(CLOSED);
    sock.emit(Event::Close {
        code: close_code,
        reason: close_reason,
    });
}

/// A close frame with `ws`'s payload for a code and reason.
fn close_frame(code: u16, reason: &str) -> Frame {
    let mut payload = code.to_be_bytes().to_vec();
    payload.extend_from_slice(reason.as_bytes());
    Frame::from_payload(
        FrameHeader {
            opcode: OpCode::Control(Control::Close),
            ..FrameHeader::default()
        },
        payload.into(),
    )
}

/// Write one masked frame (a client masks every frame it sends).
async fn write_frame(io: &mut Box<dyn Io>, mut frame: Frame) -> io::Result<()> {
    let mut mask = [0u8; 4];
    if getrandom::fill(&mut mask).is_err() {
        mask.copy_from_slice(&uuid::Uuid::new_v4().as_bytes()[..4]);
    }
    frame.header_mut().mask = Some(mask);
    let mut out = Vec::with_capacity(frame.len());
    frame
        .format(&mut out)
        .map_err(|e| io::Error::other(e.to_string()))?;
    io.write_all(&out).await
}

/// One decoded message or control frame.
enum Decoded {
    Text(String),
    Binary,
    Ping(Vec<u8>),
    Pong,
    Close { code: u16, reason: String },
}

/// A receiver error, in `ws`'s words, with the close code it closes with.
struct RecvError {
    message: String,
    code: &'static str,
    status: u16,
}

/// `createError(…, prefix = true, …)`: `Invalid WebSocket frame: <message>`.
fn recv_err(message: impl Into<String>, code: &'static str, status: u16) -> RecvError {
    RecvError {
        message: format!("Invalid WebSocket frame: {}", message.into()),
        code,
        status,
    }
}

/// `createError(…, prefix = false, …)`: the message alone.
fn recv_err_plain(message: &str, code: &'static str, status: u16) -> RecvError {
    RecvError {
        message: message.to_owned(),
        code,
        status,
    }
}

/// `ws`'s `Receiver` for a client socket with no extensions: its checks, in
/// its order, with its messages.
struct Receiver {
    buf: Vec<u8>,
    /// `_fragmented`: the opcode of the message being fragmented, or 0.
    fragmented: u8,
    fragments: Vec<u8>,
}

impl Receiver {
    fn new(head: Vec<u8>) -> Receiver {
        Receiver {
            buf: head,
            fragmented: 0,
            fragments: Vec::new(),
        }
    }

    fn push(&mut self, bytes: &[u8]) {
        self.buf.extend_from_slice(bytes);
    }

    /// The next frame, or `None` while the buffer holds a partial one.
    fn next(&mut self) -> Result<Option<Decoded>, RecvError> {
        if self.buf.len() < 2 {
            return Ok(None);
        }
        let (b0, b1) = (self.buf[0], self.buf[1]);
        if b0 & 0x30 != 0 {
            return Err(recv_err(
                "RSV2 and RSV3 must be clear",
                "WS_ERR_UNEXPECTED_RSV_2_3",
                1002,
            ));
        }
        if b0 & 0x40 != 0 {
            return Err(recv_err(
                "RSV1 must be clear",
                "WS_ERR_UNEXPECTED_RSV_1",
                1002,
            ));
        }
        let fin = b0 & 0x80 != 0;
        let mut opcode = b0 & 0x0f;
        let short_len = usize::from(b1 & 0x7f);
        match opcode {
            0x00 => {
                if self.fragmented == 0 {
                    return Err(recv_err("invalid opcode 0", "WS_ERR_INVALID_OPCODE", 1002));
                }
                opcode = self.fragmented;
            }
            0x01 | 0x02 => {
                if self.fragmented != 0 {
                    return Err(recv_err(
                        format!("invalid opcode {opcode}"),
                        "WS_ERR_INVALID_OPCODE",
                        1002,
                    ));
                }
            }
            0x08..=0x0a => {
                if !fin {
                    return Err(recv_err("FIN must be set", "WS_ERR_EXPECTED_FIN", 1002));
                }
                if short_len > 0x7d || (opcode == 0x08 && short_len == 1) {
                    return Err(recv_err(
                        format!("invalid payload length {short_len}"),
                        "WS_ERR_INVALID_CONTROL_PAYLOAD_LENGTH",
                        1002,
                    ));
                }
            }
            _ => {
                return Err(recv_err(
                    format!("invalid opcode {opcode}"),
                    "WS_ERR_INVALID_OPCODE",
                    1002,
                ));
            }
        }
        if b1 & 0x80 != 0 {
            return Err(recv_err(
                "MASK must be clear",
                "WS_ERR_UNEXPECTED_MASK",
                1002,
            ));
        }
        // The payload length, then `maxPayload` on the message so far.
        let (len, header_len) = match short_len {
            126 => {
                if self.buf.len() < 4 {
                    return Ok(None);
                }
                (
                    usize::from(u16::from_be_bytes([self.buf[2], self.buf[3]])),
                    4,
                )
            }
            127 => {
                if self.buf.len() < 10 {
                    return Ok(None);
                }
                let n = u64::from_be_bytes(self.buf[2..10].try_into().unwrap_or_default());
                if n > (1u64 << 53) - 1 {
                    return Err(recv_err_plain(
                        "Unsupported WebSocket frame: payload length > 2^53 - 1",
                        "WS_ERR_UNSUPPORTED_DATA_PAYLOAD_LENGTH",
                        1009,
                    ));
                }
                (n as usize, 10)
            }
            n => (n, 2),
        };
        if opcode < 0x08 && self.fragments.len() + len > MAX_PAYLOAD {
            return Err(recv_err_plain(
                "Max payload size exceeded",
                "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH",
                1009,
            ));
        }
        if self.buf.len() < header_len + len {
            return Ok(None);
        }
        let payload = self.buf[header_len..header_len + len].to_vec();
        self.buf.drain(..header_len + len);
        if opcode >= 0x08 {
            return self.control(opcode, payload).map(Some);
        }
        if !fin {
            if self.fragmented == 0 {
                self.fragmented = opcode;
            }
            self.fragments.extend_from_slice(&payload);
            return Ok(None);
        }
        let data = if self.fragments.is_empty() {
            payload
        } else {
            let mut all = std::mem::take(&mut self.fragments);
            all.extend_from_slice(&payload);
            all
        };
        self.fragmented = 0;
        if opcode == 0x02 {
            return Ok(Some(Decoded::Binary));
        }
        match String::from_utf8(data) {
            Ok(text) => Ok(Some(Decoded::Text(text))),
            Err(_) => Err(recv_err(
                "invalid UTF-8 sequence",
                "WS_ERR_INVALID_UTF8",
                1007,
            )),
        }
    }

    fn control(&mut self, opcode: u8, payload: Vec<u8>) -> Result<Decoded, RecvError> {
        match opcode {
            0x09 => Ok(Decoded::Ping(payload)),
            0x0a => Ok(Decoded::Pong),
            _ => {
                if payload.is_empty() {
                    return Ok(Decoded::Close {
                        code: 1005,
                        reason: String::new(),
                    });
                }
                let code = u16::from_be_bytes([payload[0], payload[1]]);
                if !valid_status_code(code) {
                    return Err(recv_err(
                        format!("invalid status code {code}"),
                        "WS_ERR_INVALID_CLOSE_CODE",
                        1002,
                    ));
                }
                match String::from_utf8(payload[2..].to_vec()) {
                    Ok(reason) => Ok(Decoded::Close { code, reason }),
                    Err(_) => Err(recv_err(
                        "invalid UTF-8 sequence",
                        "WS_ERR_INVALID_UTF8",
                        1007,
                    )),
                }
            }
        }
    }
}

/// `isValidStatusCode`.
fn valid_status_code(code: u16) -> bool {
    (1000..=1014).contains(&code) && !matches!(code, 1004..=1006) || (3000..=4999).contains(&code)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_request_ws_writes() {
        let target = Target::parse("wss://api.anthropic.com/api/ws/x?a=1&b=2").unwrap();
        assert_eq!(target.port, 443);
        assert_eq!(target.host_header, "api.anthropic.com");
        // RFC 6455 §1.3's sample nonce (base64 of "the sample nonce"), not a
        // secret; gitleaks' generic-api-key rule would match it.
        let key = "dGhlIHNhbXBsZSBub25jZQ=="; // gitleaks:allow
        let bytes =
            request_bytes(&target, &[("Authorization".into(), "Bearer t".into())], key).unwrap();
        assert_eq!(
            String::from_utf8(bytes).unwrap(),
            format!(
                "GET /api/ws/x?a=1&b=2 HTTP/1.1\r\n\
                 Authorization: Bearer t\r\n\
                 Sec-WebSocket-Version: 13\r\n\
                 Sec-WebSocket-Key: {key}\r\n\
                 Connection: Upgrade\r\n\
                 Upgrade: websocket\r\n\
                 Host: api.anthropic.com\r\n\r\n"
            )
        );
    }

    #[test]
    fn header_values_node_refuses() {
        let target = Target::parse("ws://127.0.0.1:1234/x").unwrap();
        assert_eq!(target.host_header, "127.0.0.1:1234");
        for bad in ["a\nb", "euro\u{20ac}", "del\u{7f}", "nul\0"] {
            assert_eq!(
                request_bytes(&target, &[("Authorization".into(), bad.into())], "k"),
                Err("Invalid character in header content [\"Authorization\"]".to_owned())
            );
        }
        // Latin-1 and tabs are fine, and go out as single bytes.
        let bytes = request_bytes(
            &target,
            &[("Authorization".into(), "caf\u{e9}\tx".into())],
            "k",
        )
        .unwrap();
        assert!(bytes.windows(2).any(|w| w == [0xe9, b'\t']));
    }

    #[test]
    fn urls_ws_refuses() {
        assert_eq!(
            Target::parse("http://x/y#f"),
            Err("The URL contains a fragment identifier".to_owned())
        );
        assert_eq!(
            Target::parse("ftp://x/"),
            Err(
                "The URL's protocol must be one of \"ws:\", \"wss:\", \"http:\", \"https:\", or \"ws+unix:\""
                    .to_owned()
            )
        );
        assert_eq!(
            Target::parse("not a url"),
            Err("Invalid URL: not a url".to_owned())
        );
        // `http:` / `https:` are `ws:` / `wss:`, and the path is its own.
        let t = Target::parse("https://h/").unwrap();
        assert!(t.secure && t.path == "/");
    }

    #[test]
    fn base64_matches_the_key_shape() {
        assert_eq!(base64(b"the sample nonce"), "dGhlIHNhbXBsZSBub25jZQ==");
        assert_eq!(base64(b"a"), "YQ==");
        assert_eq!(base64(b"ab"), "YWI=");
        assert_eq!(handshake_key().len(), 24);
    }

    #[test]
    fn close_codes_the_receiver_accepts() {
        assert!(valid_status_code(1000) && valid_status_code(1014) && valid_status_code(3000));
        for bad in [999, 1004, 1005, 1006, 1015, 2999, 5000] {
            assert!(!valid_status_code(bad), "{bad}");
        }
    }
}
