//! A request body the server answers without reading (I24), on the real
//! binary: axum's own 405 for a method a route doesn't export
//! (`POST /api/rust/health`) and a handler that never takes its body
//! (`heartbeat::other_method`: `POST /api/heartbeat`, `PATCH
//! /api/splash-examples`). Each answers before the body is sent. A
//! keep-alive connection, a browser's, must then serve the next request,
//! as Node's under Next does (it reads and drops what the handler left),
//! not end with the TCP reset hyper's early close gave once the body
//! reached a closed socket (`src/drain.rs`). A `Connection: close` one
//! waits for the body and ends with a FIN. Past [`MAX_BYTES`] or
//! [`MAX_TIME`] an unread body is cut off as before, and
//! `Expect: 100-continue` is left to hyper.
//!
//! Also the client side, `common::read_response`: a reset after a complete
//! response is its end, a reset before that is a failure.
#![cfg(unix)]

mod common;

use std::io::{ErrorKind, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use claudius_server::drain::{MAX_BYTES, MAX_TIME};
use common::{Payload, Server, World};

/// The method and route of each early answer, and a line its 405 has.
const ROUTES: [(&str, &str, &str); 3] = [
    ("POST", "/api/rust/health", "\r\nallow: GET,HEAD\r\n"),
    ("POST", "/api/heartbeat", "\r\nvary: rsc, "),
    ("PATCH", "/api/splash-examples", "\r\nvary: rsc, "),
];

/// A request head with `len` body bytes announced (none sent) and `extra`
/// header lines.
fn head(method: &str, path: &str, len: usize, extra: &str) -> String {
    format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {len}\r\n{extra}\r\n"
    )
}

const CLOSE: &str = "Connection: close\r\n";
const GET: &[u8] = b"GET /api/rust/health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n";

/// One response (head and `Content-Length` body) off `s`, as text.
fn read_one(s: &mut TcpStream) -> String {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        if let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&buf[..end]).to_ascii_lowercase();
            let len: usize = head
                .lines()
                .find_map(|l| l.strip_prefix("content-length:"))
                .map_or(0, |v| v.trim().parse().unwrap());
            if buf.len() >= end + 4 + len {
                return String::from_utf8_lossy(&buf[..end + 4 + len]).into_owned();
            }
        }
        let n = s.read(&mut chunk).expect("read a response");
        assert!(
            n > 0,
            "closed mid-response: {}",
            String::from_utf8_lossy(&buf)
        );
        buf.extend_from_slice(&chunk[..n]);
    }
}

/// Connected to `server`, reads bounded so a regression fails, not hangs.
fn connect(server: &Server, read_timeout: Duration) -> TcpStream {
    let s = TcpStream::connect(("127.0.0.1", server.port)).unwrap();
    s.set_read_timeout(Some(read_timeout)).unwrap();
    s
}

fn assert_405(resp: &str, line: &str) {
    assert!(resp.starts_with("HTTP/1.1 405 "), "{resp}");
    assert!(resp.contains(line), "{resp}");
}

/// The rest of the connection, which must end within the read timeout.
fn rest(s: &mut TcpStream) -> Result<String, std::io::Error> {
    let mut rest = Vec::new();
    s.read_to_end(&mut rest)?;
    Ok(String::from_utf8_lossy(&rest).into_owned())
}

#[test]
fn keep_alive_survives_a_body_sent_after_the_answer() {
    let world = World::new();
    let server = Server::spawn(&world, &[]);
    for (method, path, line) in ROUTES {
        let mut s = connect(&server, Duration::from_secs(30));
        let body = vec![b'x'; 64 * 1024];
        s.write_all(head(method, path, body.len(), "").as_bytes())
            .unwrap();
        assert_405(&read_one(&mut s), line);
        // The answer is out before any of the body: hyper had nothing to read.
        s.write_all(&body).unwrap();
        s.write_all(GET).unwrap();
        let next = read_one(&mut s);
        assert!(
            next.starts_with("HTTP/1.1 200 OK\r\n"),
            "{method} {path}: {next}"
        );
        assert!(next.contains(r#"{"ok":true,"backend":"rust","#), "{next}");
    }
}

#[test]
fn connection_close_waits_for_the_body_then_ends_cleanly() {
    let world = World::new();
    let server = Server::spawn(&world, &[]);
    for (method, path, line) in ROUTES {
        let mut s = connect(&server, Duration::from_secs(30));
        s.write_all(head(method, path, 100, CLOSE).as_bytes())
            .unwrap();
        assert_405(&read_one(&mut s), line);
        // Still open: closing now is what reset the body on its way.
        s.set_read_timeout(Some(Duration::from_millis(300)))
            .unwrap();
        let mut one = [0u8; 1];
        match s.read(&mut one) {
            Err(e) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
            other => panic!("{method} {path}: closed before the body came: {other:?}"),
        }
        s.set_read_timeout(Some(Duration::from_secs(30))).unwrap();
        s.write_all(&[b'x'; 100]).unwrap();
        let rest = rest(&mut s).expect("a FIN once the body is in, not a reset");
        assert_eq!(rest, "", "{method} {path}");
    }
}

#[test]
fn a_body_past_the_byte_bound_is_cut_off() {
    let world = World::new();
    let server = Server::spawn(&world, &[]);
    let mut s = connect(&server, Duration::from_secs(30));
    // Past the bound by more than hyper reads in its one last try (its read
    // buffer tops out near 400 KiB), or it would take the rest itself.
    let body = vec![b'x'; MAX_BYTES + 2 * 1024 * 1024];
    let (method, path, line) = ROUTES[0];
    s.write_all(head(method, path, body.len(), "").as_bytes())
        .unwrap();
    assert_405(&read_one(&mut s), line);
    // Writes past the bound may fail once the server has given up. A kept
    // connection would answer the GET and then close.
    let get = [&GET[..GET.len() - 2], CLOSE.as_bytes(), b"\r\n"].concat();
    let _ = s.write_all(&body).and_then(|()| s.write_all(&get));
    let mut rest = Vec::new();
    let _ = s.read_to_end(&mut rest);
    let rest = String::from_utf8_lossy(&rest);
    assert!(!rest.contains("HTTP/1.1"), "kept alive: {rest}");
}

#[test]
fn a_body_that_never_comes_is_given_up_on() {
    let world = World::new();
    let server = Server::spawn(&world, &[]);
    let mut s = connect(&server, MAX_TIME + Duration::from_secs(15));
    let (method, path, line) = ROUTES[0];
    s.write_all(head(method, path, 100, "").as_bytes()).unwrap();
    assert_405(&read_one(&mut s), line);
    let t0 = Instant::now();
    match rest(&mut s) {
        Ok(rest) => assert_eq!(rest, ""),
        Err(e) if e.kind() == ErrorKind::ConnectionReset => {}
        Err(e) => panic!("still open after {:?}: {e}", t0.elapsed()),
    }
}

#[test]
fn expect_100_continue_is_left_to_hyper() {
    // The early answer stands in for the `100 Continue`: the client sends
    // no body, and the connection ends at once, not after `MAX_TIME`.
    let world = World::new();
    let server = Server::spawn(&world, &[]);
    let mut s = connect(&server, MAX_TIME + Duration::from_secs(15));
    let (method, path, line) = ROUTES[0];
    s.write_all(head(method, path, 100, "Expect: 100-continue\r\n").as_bytes())
        .unwrap();
    assert_405(&read_one(&mut s), line);
    let t0 = Instant::now();
    let rest = match rest(&mut s) {
        Ok(rest) => rest,
        Err(e) if e.kind() == ErrorKind::ConnectionReset => String::new(),
        Err(e) => panic!("still open after {:?}: {e}", t0.elapsed()),
    };
    assert_eq!(rest, "");
    assert!(t0.elapsed() < MAX_TIME, "{:?}", t0.elapsed());
}

/// A Next stand-in: answers every request `200 ok` and keeps it as it came
/// (head and `Content-Length` body).
fn recording_next() -> (u16, Arc<Mutex<Vec<String>>>) {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let keep = seen.clone();
    std::thread::spawn(move || {
        for c in l.incoming() {
            let (mut c, seen) = (c.unwrap(), seen.clone());
            std::thread::spawn(move || {
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
                loop {
                    while let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        let head = String::from_utf8_lossy(&buf[..end]).to_ascii_lowercase();
                        let len: usize = head
                            .lines()
                            .find_map(|l| l.strip_prefix("content-length:"))
                            .map_or(0, |v| v.trim().parse().unwrap());
                        if buf.len() < end + 4 + len {
                            break;
                        }
                        let req: Vec<u8> = buf.drain(..end + 4 + len).collect();
                        seen.lock()
                            .unwrap()
                            .push(String::from_utf8_lossy(&req).into_owned());
                        let ok = b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok";
                        if c.write_all(ok).is_err() {
                            return;
                        }
                    }
                    match c.read(&mut chunk) {
                        Ok(n @ 1..) => buf.extend_from_slice(&chunk[..n]),
                        _ => return,
                    }
                }
            });
        }
    });
    (port, keep)
}

#[test]
fn proxied_requests_reach_next_as_they_came() {
    // Every request body is wrapped; Next must still see a GET without a
    // body as one (no `content-length: 0`) and a POST's body as sent.
    let (next, seen) = recording_next();
    let world = World::new();
    let url = format!("http://127.0.0.1:{next}");
    let missing = world.root.path().join("no-such-claude");
    let server = Server::spawn_args(&world, &missing, &["--next", &url], &[]);
    let get = common::send(server.port, "GET", "/api/i24-unported", Payload::None);
    let post = common::send(
        server.port,
        "POST",
        "/api/i24-unported",
        Payload::Json(br#"{"a":1}"#),
    );
    assert_eq!((get.status, get.text().as_str()), (200, "ok"));
    assert_eq!((post.status, post.text().as_str()), (200, "ok"));
    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 2, "{seen:?}");
    let (get, post) = (seen[0].to_ascii_lowercase(), seen[1].to_ascii_lowercase());
    assert!(
        get.starts_with("get /api/i24-unported http/1.1\r\n"),
        "{get}"
    );
    assert!(
        !get.contains("content-length") && !get.contains("transfer-encoding"),
        "{get}"
    );
    assert!(
        post.starts_with("post /api/i24-unported http/1.1\r\n"),
        "{post}"
    );
    assert!(post.contains("\r\ncontent-length: 7\r\n"), "{post}");
    assert!(!post.contains("transfer-encoding"), "{post}");
    assert!(post.ends_with("\r\n\r\n{\"a\":1}"), "{post}");
}

// ---- the client side ---------------------------------------------------------

/// A one-connection server that reads the request head only, answers
/// `response`, waits until the client's body is there (so the close must
/// reset it) and closes: what hyper did before `src/drain.rs`.
fn resets_after(response: &'static [u8]) -> u16 {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    std::thread::spawn(move || {
        let (mut c, _) = l.accept().unwrap();
        let mut head = Vec::new();
        let mut byte = [0u8; 1];
        while !head.ends_with(b"\r\n\r\n") {
            c.read_exact(&mut byte).unwrap();
            head.push(byte[0]);
        }
        c.write_all(response).unwrap();
        // Blocks until the body is in, which the close then leaves unread.
        assert!(c.peek(&mut byte).unwrap() > 0);
    });
    port
}

fn post_to(port: u16) -> common::Response {
    common::send(port, "POST", "/", Payload::Json(&[b'x'; 100]))
}

#[test]
fn a_reset_after_a_complete_response_is_its_end() {
    let r = post_to(resets_after(
        b"HTTP/1.1 405 Method Not Allowed\r\ncontent-length: 4\r\n\r\nnope",
    ));
    assert_eq!((r.status, r.text().as_str()), (405, "nope"));
    let r = post_to(resets_after(
        b"HTTP/1.1 405 Method Not Allowed\r\ntransfer-encoding: chunked\r\n\r\n4\r\nnope\r\n0\r\n\r\n",
    ));
    assert_eq!(
        (r.status, r.text().as_str()),
        (405, "4\r\nnope\r\n0\r\n\r\n")
    );
}

#[test]
#[should_panic(expected = "reset")]
fn a_reset_before_the_body_is_complete_fails() {
    post_to(resets_after(
        b"HTTP/1.1 405 Method Not Allowed\r\ncontent-length: 5\r\n\r\nnope",
    ));
}

#[test]
#[should_panic(expected = "reset")]
fn a_reset_before_the_last_chunk_fails() {
    post_to(resets_after(
        b"HTTP/1.1 405 Method Not Allowed\r\ntransfer-encoding: chunked\r\n\r\n4\r\nnope\r\n",
    ));
}

#[test]
#[should_panic(expected = "reset")]
fn a_reset_before_the_chunked_end_fails() {
    post_to(resets_after(
        b"HTTP/1.1 405 Method Not Allowed\r\ntransfer-encoding: chunked\r\n\r\n4\r\nnope\r\n0\r\n",
    ));
}

#[test]
#[should_panic(expected = "reset")]
fn a_reset_inside_the_head_fails() {
    post_to(resets_after(
        b"HTTP/1.1 405 Method Not Allowed\r\ncontent-length: 0\r\n",
    ));
}

#[test]
#[should_panic(expected = "reset")]
fn a_reset_before_the_status_line_fails() {
    post_to(resets_after(b""));
}
