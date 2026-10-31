//! `claudius_core::fetch::HttpsClient` against local raw servers: what it
//! sends (undici's default headers, unless the caller set them), how it
//! fails (`fetch failed` for a refused connection, a TLS handshake with a
//! plain-text server, a bad method and a server silent before the headers;
//! `terminated` for a body cut short or gone silent; undici's timeouts),
//! the dev/test base rewrite, and the `ProfileFetch` adapter. The parity of
//! answers with undici on recorded responses is in claudius-server's
//! `tests/accounts_oauth.rs`. Nothing here leaves 127.0.0.1.

use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use claudius_core::account_profile::ProfileFetch;
use claudius_core::fetch::{
    CONNECT_TIMEOUT, DEFAULT_HEADERS, FETCH_FAILED, Fetch, HttpsClient, READ_TIMEOUT, Request,
    TERMINATED, env_proxy_enabled,
};

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
    assert_eq!(refused.unwrap_err(), FETCH_FAILED);
    // TLS against a server that answers in plain text.
    let (port, _rx) =
        one_shot(b"HTTP/1.1 200 OK\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
    let tls = client
        .fetch(&req("GET", format!("https://127.0.0.1:{port}/"), &[], None))
        .await;
    assert_eq!(tls.unwrap_err(), FETCH_FAILED);
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
        assert_eq!(bad.unwrap_err(), want, "{method} {url}");
    }
    // A scheme fetch can't speak.
    let ftp = client
        .fetch(&req("GET", "ftp://127.0.0.1:9/".into(), &[], None))
        .await;
    assert_eq!(ftp.unwrap_err(), FETCH_FAILED);
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
    assert_eq!(client.get(&get(port), &auth).await.unwrap_err(), TERMINATED);
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
    assert_eq!(silent.unwrap_err(), FETCH_FAILED);
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
