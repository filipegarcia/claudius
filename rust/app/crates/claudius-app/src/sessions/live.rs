//! [`TransportSessionsData`]: the [`SessionsData`] of a running engine (U11b),
//! each [`SessionsRequest`] the `fetch` the React page or
//! `useSessionsHistory` makes, over a [`Transport`].
//!
//! **Requests.** [`fetch_request`]: the request's method and URL as
//! [`SessionsRequest::url`] writes them, and for rename and fork the
//! `JSON.stringify` body with `Content-Type: application/json`. No route
//! reads the workspace cookie, so one transport (its own jar) serves every
//! workspace.
//!
//! **Answers.** [`reply`]: the status, the body text (`res.text()`: UTF-8
//! with U+FFFD for a bad sequence, a leading BOM dropped) and the
//! `Content-Disposition` attachment's file name, the rest being the
//! models' (the fixture answers the same shape). A request that gets no
//! answer is the future's `Err` with `fetch`'s rejection as the page reads
//! it, `err.message`: `Failed to fetch`, or `network error` for a body that
//! broke off ([`rejection`]).
//!
//! **Change notifications** ([`SessionsData::subscribe`]), from what moves
//! the React page:
//! - [`SessionsChange::Unread`] when a workspace's unread counts move: the
//!   notifications stream's `state` events and the counts route
//!   ([`super::unread`]), which is what repaints the React rows' badges.
//! - [`SessionsChange::List`] with the request's `dir` after a rename, a
//!   fork or a delete that succeeded: `useSessionsHistory` re-reads the
//!   listing after its own rename and delete (`refresh()`), and a fork adds
//!   a row. The page's own model re-reads too (the list after a delete, the
//!   session after a rename), as the React page does; the screen on the
//!   page then re-reads once more, the newer answer winning.
//!
//! Nothing else the server pushes re-reads the React sessions pages: no
//! route streams the listing, and neither page re-reads on a turn, a
//! `visibilitychange` or a timer (the workspace list's `focus` re-read,
//! which can move the page's `dir`, is the shell's). So
//! [`SessionsChange::Session`] never comes from here; [`announce`] is for a
//! caller that knows more.
//!
//! [`announce`]: TransportSessionsData::announce

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use claudius_transport::{Request, Response, Transport, TransportError};
use futures::channel::mpsc::{UnboundedReceiver, UnboundedSender, unbounded};
use futures::future::FutureExt as _;

use super::data::{Reply, SessionsChange, SessionsData, SessionsRequest};
use super::unread::{self, UnreadStates};
use crate::data::DataFuture;

type Subscribers = Arc<Mutex<Vec<UnboundedSender<SessionsChange>>>>;

pub struct TransportSessionsData {
    transport: Arc<dyn Transport>,
    rt: tokio::runtime::Handle,
    unread: Arc<Mutex<UnreadStates>>,
    subscribers: Subscribers,
    /// The unread feed's task, stopped with this.
    feed: Option<tokio::task::AbortHandle>,
}

/// `fetch(url, init)` for `r`, as the TS sends it.
pub fn fetch_request(r: &SessionsRequest) -> Request {
    let req = Request::new(r.method(), r.url());
    match r.body() {
        Some(body) => req.json(claudius_agent::js::stringify(&body)),
        None => req,
    }
}

/// The page's reading of a rejected `fetch`: `err.message`.
pub fn rejection(e: &TransportError) -> String {
    let text = e.page_text();
    text.strip_prefix("TypeError: ").unwrap_or(text).to_owned()
}

/// A route's answer, as the models read it.
pub fn reply(res: &Response) -> Reply {
    let text = String::from_utf8_lossy(&res.body);
    Reply {
        status: res.status,
        body: text.strip_prefix('\u{feff}').unwrap_or(&text).to_owned(),
        filename: res
            .headers
            .get("content-disposition")
            .and_then(|v| attachment_filename(v.as_bytes())),
    }
}

/// The `filename` parameter of a `Content-Disposition` header (its bytes
/// read as latin1, as the export route writes them): a quoted string (`\`
/// escapes the next character, an unclosed one runs to the end) or a token
/// up to the next `;`. `None` when there's none or it's empty. (The route
/// never sends RFC 5987's `filename*`, so it isn't read.)
pub fn attachment_filename(header: &[u8]) -> Option<String> {
    let text: String = header.iter().map(|&b| char::from(b)).collect();
    // The parameters after the disposition type.
    let mut s = text.split_once(';')?.1;
    loop {
        s = s.trim_start_matches([' ', '\t', ';']);
        if s.is_empty() {
            return None;
        }
        // A parameter without `=` is skipped.
        let at = s.find(['=', ';'])?;
        if s.as_bytes()[at] == b';' {
            s = &s[at..];
            continue;
        }
        let name = s[..at].trim();
        s = s[at + 1..].trim_start();
        let value = match s.strip_prefix('"') {
            Some(quoted) => {
                let mut out = String::new();
                let mut end = quoted.len();
                let mut chars = quoted.char_indices();
                while let Some((i, c)) = chars.next() {
                    match c {
                        '"' => {
                            end = i + 1;
                            break;
                        }
                        '\\' => out.extend(chars.next().map(|(_, c)| c)),
                        c => out.push(c),
                    }
                }
                s = &quoted[end..];
                out
            }
            None => {
                let end = s.find(';').unwrap_or(s.len());
                let token = s[..end].trim().to_owned();
                s = &s[end..];
                token
            }
        };
        if name.eq_ignore_ascii_case("filename") {
            return (!value.is_empty()).then_some(value);
        }
    }
}

/// What a successful request changed at the source, for the subscribers.
pub fn announced(r: &SessionsRequest) -> Option<SessionsChange> {
    match r {
        SessionsRequest::Rename { dir, .. }
        | SessionsRequest::Fork { dir, .. }
        | SessionsRequest::Delete { dir, .. } => Some(SessionsChange::List { dir: dir.clone() }),
        _ => None,
    }
}

fn notify(subscribers: &Subscribers, change: SessionsChange) {
    subscribers
        .lock()
        .expect("subscribers lock")
        .retain(|tx| tx.unbounded_send(change.clone()).is_ok());
}

impl TransportSessionsData {
    /// Requests through `transport`, run on `rt` (the engine's runtime:
    /// the routes do their disk work there); the unread counts follow the
    /// notifications stream from now on.
    pub fn new(transport: Arc<dyn Transport>, rt: tokio::runtime::Handle) -> Self {
        let mut data = Self::requests_only(transport, rt);
        let task = data.rt.spawn(unread::feed(
            data.transport.clone(),
            data.unread.clone(),
            data.unread_moved(),
        ));
        data.feed = Some(task.abort_handle());
        data
    }

    /// [`Self::new`] without the unread feed (the counts stay empty).
    pub fn requests_only(transport: Arc<dyn Transport>, rt: tokio::runtime::Handle) -> Self {
        TransportSessionsData {
            transport,
            rt,
            unread: Arc::default(),
            subscribers: Arc::default(),
            feed: None,
        }
    }

    /// Tells the subscribers `change` happened (a change this source
    /// doesn't see: see the module docs).
    pub fn announce(&self, change: SessionsChange) {
        notify(&self.subscribers, change);
    }

    /// The provider's `refreshCounts()`: fetch the counts again (its
    /// `visibilitychange` / `online` recovery), version-gated as the
    /// stream's.
    pub fn refresh_unread(&self) {
        self.rt.spawn(unread::fetch_counts(
            self.transport.clone(),
            self.unread.clone(),
            self.unread_moved(),
        ));
    }

    /// Tells the subscribers a workspace's counts moved.
    fn unread_moved(&self) -> unread::OnMoved {
        let subscribers = self.subscribers.clone();
        Arc::new(move |ws: &str| {
            notify(
                &subscribers,
                SessionsChange::Unread {
                    workspace_id: ws.to_owned(),
                },
            );
        })
    }
}

impl Drop for TransportSessionsData {
    fn drop(&mut self) {
        if let Some(feed) = self.feed.take() {
            feed.abort();
        }
    }
}

impl SessionsData for TransportSessionsData {
    fn send(&self, request: SessionsRequest) -> DataFuture<Reply> {
        let t = self.transport.clone();
        let subscribers = self.subscribers.clone();
        let task = self.rt.spawn(async move {
            let res = t.fetch(fetch_request(&request)).await;
            let reply = match res {
                Ok(res) => reply(&res),
                Err(e) => return Err(rejection(&e)),
            };
            if reply.ok()
                && let Some(change) = announced(&request)
            {
                notify(&subscribers, change);
            }
            Ok(reply)
        });
        async move {
            match task.await {
                Ok(Ok(reply)) => Ok(reply),
                Ok(Err(message)) => Err(anyhow::anyhow!(message)),
                Err(e) => Err(anyhow::anyhow!("{e}")),
            }
        }
        .boxed()
    }

    fn unread(&self, workspace_id: &str) -> BTreeMap<String, u32> {
        self.unread
            .lock()
            .expect("unread lock")
            .per_session(workspace_id)
    }

    fn subscribe(&self) -> UnboundedReceiver<SessionsChange> {
        let (tx, rx) = unbounded();
        self.subscribers.lock().expect("subscribers lock").push(tx);
        rx
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::time::Duration;

    use async_trait::async_trait;
    use bytes::Bytes;
    use claudius_transport::StreamResponse;
    use futures::StreamExt as _;
    use futures::executor::block_on;
    use http::HeaderMap;
    use serde_json::json;
    use tokio::time::Instant;

    use super::*;

    /// `/Users/demo/a b&c/é?#+%~*'()!`: every class `encodeURIComponent`
    /// and `URLSearchParams` treat differently.
    const DIR: &str = "/Users/demo/a b&c/\u{e9}?#+%~*'()!";

    /// A canned answer.
    #[derive(Clone)]
    enum Answer {
        Status(u16, &'static str, &'static str),
        /// SSE frames, then the body ends (`hold`: stays open instead).
        Sse(&'static str, bool),
        Down,
        BodyBreaks,
    }

    /// Answers each request with the first answer whose URL prefix matches
    /// (consumed; none: down), and logs it with the (paused) clock.
    #[derive(Clone, Default)]
    struct Scripted {
        answers: Arc<Mutex<VecDeque<(&'static str, Answer)>>>,
        log: Arc<Mutex<Vec<(Instant, Request)>>>,
        /// Held bodies still open (the client hasn't dropped them).
        open: Arc<std::sync::atomic::AtomicUsize>,
    }

    /// Counts a held body while it's alive.
    struct Held(Arc<std::sync::atomic::AtomicUsize>);

    impl Held {
        fn new(n: &Arc<std::sync::atomic::AtomicUsize>) -> Held {
            n.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Held(n.clone())
        }
    }

    impl Drop for Held {
        fn drop(&mut self) {
            self.0.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
        }
    }

    impl Scripted {
        fn answer(&self, prefix: &'static str, a: Answer) {
            self.answers.lock().unwrap().push_back((prefix, a));
        }

        fn requests(&self) -> Vec<Request> {
            self.log
                .lock()
                .unwrap()
                .iter()
                .map(|(_, r)| r.clone())
                .collect()
        }

        /// `<ms since the first request> <url>` for each request.
        fn timeline(&self) -> Vec<String> {
            let log = self.log.lock().unwrap();
            let t0 = log.first().map(|(t, _)| *t);
            log.iter()
                .map(|(t, r)| format!("{} {}", (*t - t0.unwrap()).as_millis(), r.url))
                .collect()
        }
    }

    #[async_trait]
    impl Transport for Scripted {
        async fn send(&self, req: Request) -> Result<StreamResponse, TransportError> {
            self.log.lock().unwrap().push((Instant::now(), req.clone()));
            let answer = {
                let mut answers = self.answers.lock().unwrap();
                let at = answers.iter().position(|(p, _)| req.url.starts_with(p));
                at.and_then(|i| answers.remove(i)).map(|(_, a)| a)
            };
            let (status, ct, body, hold) = match answer {
                Some(Answer::Status(s, ct, body)) => (s, ct, body, false),
                Some(Answer::Sse(frames, hold)) => (200, "text/event-stream", frames, hold),
                Some(Answer::BodyBreaks) => {
                    let broken: Result<Bytes, TransportError> =
                        Err(TransportError::Body("reset".into()));
                    return Ok(StreamResponse {
                        status: 200,
                        headers: HeaderMap::new(),
                        body: Box::pin(futures::stream::iter([broken])),
                    });
                }
                Some(Answer::Down) | None => return Err(TransportError::Network("down".into())),
            };
            let mut headers = HeaderMap::new();
            headers.insert("content-type", ct.parse().unwrap());
            if body.starts_with("Disposition:") {
                headers.insert(
                    "content-disposition",
                    "attachment; filename=\"claudius-session-s1.txt\""
                        .parse()
                        .unwrap(),
                );
            }
            let chunk: Result<Bytes, TransportError> = Ok(Bytes::from(body));
            let first = futures::stream::iter([chunk]);
            Ok(StreamResponse {
                status,
                headers,
                body: if hold {
                    let held = Held::new(&self.open);
                    Box::pin(first.chain(futures::stream::pending()).inspect(move |_| {
                        let _ = &held;
                    }))
                } else {
                    Box::pin(first)
                },
            })
        }

        fn shared(&self) -> Arc<dyn Transport> {
            Arc::new(self.clone())
        }
    }

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .unwrap()
    }

    fn header<'a>(r: &'a Request, name: &str) -> Option<&'a str> {
        r.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    fn body(r: &Request) -> Option<String> {
        r.body
            .as_ref()
            .map(|b| String::from_utf8(b.to_vec()).unwrap())
    }

    #[test]
    fn each_request_is_the_fetch_the_ts_makes() {
        let dir = Some(DIR.to_owned());
        // Each expected URL and body is what node@22 prints for the TS
        // expressions (`URLSearchParams`, `encodeURIComponent`,
        // `JSON.stringify`) on these inputs.
        let qs = "?dir=%2FUsers%2Fdemo%2Fa%20b%26c%2F%C3%A9%3F%23%2B%25~*'()!";
        let gets = [
            (
                SessionsRequest::List {
                    dir: dir.clone(),
                    limit: 400,
                },
                "/api/sessions/all?dir=%2FUsers%2Fdemo%2Fa+b%26c%2F%C3%A9%3F%23%2B%25%7E*%27%28%29%21&limit=400".to_owned(),
            ),
            (
                SessionsRequest::List {
                    dir: None,
                    limit: 200,
                },
                "/api/sessions/all?limit=200".to_owned(),
            ),
            (
                SessionsRequest::Info {
                    id: "s1".into(),
                    dir: dir.clone(),
                },
                format!("/api/sessions/info/s1{qs}"),
            ),
            (
                SessionsRequest::Transcript {
                    id: "s1".into(),
                    dir: dir.clone(),
                },
                format!("/api/sessions/transcript/s1{qs}"),
            ),
            (
                SessionsRequest::Search {
                    q: "n: a+b/(c)".into(),
                    dir: DIR.into(),
                },
                "/api/sessions/search?q=n%3A%20a%2Bb%2F(c)&dir=%2FUsers%2Fdemo%2Fa%20b%26c%2F%C3%A9%3F%23%2B%25~*'()!".to_owned(),
            ),
            (
                SessionsRequest::Export {
                    id: "s1".into(),
                    dir: None,
                },
                "/api/sessions/export/s1".to_owned(),
            ),
        ];
        for (r, url) in gets {
            let req = fetch_request(&r);
            assert_eq!(req.method, "GET", "{r:?}");
            assert_eq!(req.url, url, "{r:?}");
            assert!(req.headers.is_empty(), "{r:?}");
            assert_eq!(req.body, None, "{r:?}");
        }
        let delete = fetch_request(&SessionsRequest::Delete {
            id: "s1".into(),
            dir: dir.clone(),
        });
        assert_eq!(
            (delete.method.as_str(), delete.url.as_str()),
            ("DELETE", format!("/api/sessions/file/s1{qs}").as_str())
        );
        assert!(delete.headers.is_empty());
        assert_eq!(delete.body, None);

        // The JSON posts: `Content-Type: application/json` and the
        // `JSON.stringify` text (`dir: undefined` dropped; U+2028 raw).
        let posts = [
            (
                SessionsRequest::Rename {
                    session_id: "s1".into(),
                    title: "Say \"hi\"\t\u{2028}\u{1} \u{e9}\u{1f600}".into(),
                    dir: dir.clone(),
                },
                "/api/sessions/rename",
                "{\"sessionId\":\"s1\",\"title\":\"Say \\\"hi\\\"\\t\u{2028}\\u0001 \u{e9}\u{1f600}\",\"dir\":\"/Users/demo/a b&c/\u{e9}?#+%~*'()!\"}",
            ),
            (
                SessionsRequest::Rename {
                    session_id: "s1".into(),
                    title: "T".into(),
                    dir: None,
                },
                "/api/sessions/rename",
                r#"{"sessionId":"s1","title":"T"}"#,
            ),
            (
                SessionsRequest::Fork {
                    session_id: "s1".into(),
                    up_to_message_id: Some("m1".into()),
                    dir: None,
                },
                "/api/sessions/fork",
                r#"{"sessionId":"s1","upToMessageId":"m1"}"#,
            ),
            (
                SessionsRequest::Fork {
                    session_id: "s1".into(),
                    up_to_message_id: None,
                    dir: dir.clone(),
                },
                "/api/sessions/fork",
                "{\"sessionId\":\"s1\",\"dir\":\"/Users/demo/a b&c/\u{e9}?#+%~*'()!\"}",
            ),
        ];
        for (r, url, text) in posts {
            let req = fetch_request(&r);
            assert_eq!(req.method, "POST", "{r:?}");
            assert_eq!(req.url, url, "{r:?}");
            assert_eq!(header(&req, "content-type"), Some("application/json"));
            assert_eq!(req.headers.len(), 1);
            assert_eq!(body(&req).as_deref(), Some(text), "{r:?}");
        }
    }

    fn res(status: u16, headers: &[(&str, &[u8])], body: &[u8]) -> Response {
        let mut h = HeaderMap::new();
        for (k, v) in headers {
            h.insert(
                http::HeaderName::from_bytes(k.as_bytes()).unwrap(),
                http::HeaderValue::from_bytes(v).unwrap(),
            );
        }
        Response {
            status,
            headers: h,
            body: Bytes::copy_from_slice(body),
        }
    }

    #[test]
    fn the_reply_is_the_status_the_text_and_the_file_name() {
        let r = reply(&res(404, &[], br#"{"error":"session not found"}"#));
        assert_eq!(
            r,
            Reply {
                status: 404,
                body: r#"{"error":"session not found"}"#.into(),
                filename: None,
            }
        );
        // `res.text()`: a BOM dropped, a bad sequence as U+FFFD.
        let r = reply(&res(200, &[], b"\xef\xbb\xbf{\"ok\":true}"));
        assert_eq!(r.body, r#"{"ok":true}"#);
        assert_eq!(r.parse().unwrap(), json!({"ok": true}));
        assert_eq!(reply(&res(200, &[], b"a\xffb")).body, "a\u{fffd}b");
        // The export: its attachment's name.
        let r = reply(&res(
            200,
            &[(
                "content-disposition",
                b"attachment; filename=\"claudius-session-s1.txt\"",
            )],
            b"User: hi",
        ));
        assert_eq!(r.filename.as_deref(), Some("claudius-session-s1.txt"));
        assert_eq!(r.body, "User: hi");
        // Latin1 bytes, as the route writes a header.
        let r = reply(&res(
            200,
            &[(
                "content-disposition",
                b"attachment; filename=\"caf\xe9.txt\"",
            )],
            b"",
        ));
        assert_eq!(r.filename.as_deref(), Some("caf\u{e9}.txt"));
    }

    #[test]
    fn the_file_name_is_the_filename_parameter() {
        for (header, want) in [
            ("attachment; filename=\"a.txt\"", Some("a.txt")),
            ("attachment; filename=a.txt", Some("a.txt")),
            ("attachment;filename=a.txt; size=3", Some("a.txt")),
            ("attachment; filename = a.txt ; size=3", Some("a.txt")),
            ("attachment; size=3; FileName=\"b.txt\"", Some("b.txt")),
            (
                "attachment; filename=\"a;b \\\"q\\\".txt\"; x=1",
                Some("a;b \"q\".txt"),
            ),
            ("attachment; filename=\"unclosed", Some("unclosed")),
            // An unclosed quote holds the rest: no parameter inside it.
            ("attachment; x=\"; filename=inside.txt", None),
            ("attachment; junk; filename=c.txt", Some("c.txt")),
            ("attachment; name=\"x\"", None),
            ("attachment; filename=\"\"", None),
            ("attachment", None),
            ("", None),
        ] {
            assert_eq!(
                attachment_filename(header.as_bytes()).as_deref(),
                want,
                "{header:?}"
            );
        }
    }

    #[test]
    fn a_request_without_an_answer_fails_with_the_rejection() {
        let rt = rt();
        let t = Scripted::default();
        let data = TransportSessionsData::requests_only(Arc::new(t.clone()), rt.handle().clone());
        let list = || SessionsRequest::List {
            dir: None,
            limit: 200,
        };
        t.answer("/api/sessions/all", Answer::Down);
        let e = block_on(data.send(list())).unwrap_err();
        assert_eq!(e.to_string(), "Failed to fetch");
        t.answer("/api/sessions/all", Answer::BodyBreaks);
        let e = block_on(data.send(list())).unwrap_err();
        assert_eq!(e.to_string(), "network error");
        // An error answer is a reply.
        t.answer(
            "/api/sessions/all",
            Answer::Status(500, "application/json", r#"{"error":"boom"}"#),
        );
        let r = block_on(data.send(list())).unwrap();
        assert_eq!((r.status, r.body.as_str()), (500, r#"{"error":"boom"}"#));
        assert_eq!(t.requests().len(), 3);
        assert!(
            t.requests()
                .iter()
                .all(|r| r.url == "/api/sessions/all?limit=200")
        );
    }

    #[test]
    fn a_change_that_succeeded_is_announced() {
        let rt = rt();
        let t = Scripted::default();
        let data = TransportSessionsData::requests_only(Arc::new(t.clone()), rt.handle().clone());
        let mut changes = data.subscribe();
        let mut other = data.subscribe();
        let ok = Answer::Status(200, "application/json", r#"{"ok":true}"#);
        let dir = Some("/w".to_owned());
        let cases = [
            (
                SessionsRequest::Rename {
                    session_id: "s1".into(),
                    title: "T".into(),
                    dir: dir.clone(),
                },
                "/api/sessions/rename",
            ),
            (
                SessionsRequest::Fork {
                    session_id: "s1".into(),
                    up_to_message_id: None,
                    dir: None,
                },
                "/api/sessions/fork",
            ),
            (
                SessionsRequest::Delete {
                    id: "s1".into(),
                    dir: dir.clone(),
                },
                "/api/sessions/file/s1",
            ),
        ];
        for (r, prefix) in cases {
            // A failed one is not.
            t.answer(
                prefix,
                Answer::Status(500, "application/json", r#"{"error":"no"}"#),
            );
            assert_eq!(block_on(data.send(r.clone())).unwrap().status, 500);
            t.answer(prefix, Answer::Down);
            assert!(block_on(data.send(r.clone())).is_err());
            assert_eq!(changes.try_recv().ok(), None, "{r:?}");
            t.answer(prefix, ok.clone());
            assert!(block_on(data.send(r.clone())).unwrap().ok());
            let want = SessionsChange::List {
                dir: match &r {
                    SessionsRequest::Fork { .. } => None,
                    _ => dir.clone(),
                },
            };
            assert_eq!(changes.try_recv().ok(), Some(want.clone()), "{r:?}");
            assert_eq!(other.try_recv().ok(), Some(want));
        }
        // Reads announce nothing.
        for (r, prefix) in [
            (
                SessionsRequest::List {
                    dir: None,
                    limit: 200,
                },
                "/api/sessions/all",
            ),
            (
                SessionsRequest::Info {
                    id: "s1".into(),
                    dir: None,
                },
                "/api/sessions/info/",
            ),
            (
                SessionsRequest::Transcript {
                    id: "s1".into(),
                    dir: None,
                },
                "/api/sessions/transcript/",
            ),
            (
                SessionsRequest::Search {
                    q: "x".into(),
                    dir: "/w".into(),
                },
                "/api/sessions/search",
            ),
            (
                SessionsRequest::Export {
                    id: "s1".into(),
                    dir: None,
                },
                "/api/sessions/export/",
            ),
        ] {
            t.answer(prefix, ok.clone());
            assert!(block_on(data.send(r)).unwrap().ok());
        }
        assert_eq!(changes.try_recv().ok(), None);
        // A dropped subscriber is let go; `announce` reaches the others.
        drop(other);
        data.announce(SessionsChange::Session { id: "s9".into() });
        assert_eq!(
            changes.try_recv().ok(),
            Some(SessionsChange::Session { id: "s9".into() })
        );
        assert_eq!(data.subscribers.lock().unwrap().len(), 1);
        // No feed: no unread counts, no notifications requests.
        assert!(data.unread("w1").is_empty());
        assert!(
            t.requests()
                .iter()
                .all(|r| !r.url.starts_with("/api/notifications"))
        );
    }

    const STATE_W1: &str = "data: {\"type\":\"state\",\"workspaceId\":\"w1\",\"version\":3,\"totalUnread\":3,\"perSession\":{\"s1\":2,\"s2\":1}}\n\n";
    const NOTIFICATION_AND_STALE: &str = concat!(
        ": ping\n\n",
        "data: {\"type\":\"notification\",\"notification\":{\"id\":\"n1\"}}\n\n",
        "event: state\ndata: {\"type\":\"state\",\"workspaceId\":\"w1\",\"version\":9,\"perSession\":{}}\n\n",
        "data: {\"type\":\"state\",\"workspaceId\":\"w1\",\"version\":2,\"perSession\":{}}\n\n",
        "data: not json\n\n",
        "data: {\"type\":\"state\",\"workspaceId\":\"w2\",\"version\":1,\"perSession\":{\"s5\":4}}\n\n",
    );

    /// Waits on the paused clock until `f` holds (the runtime idles, so the
    /// clock jumps to the next timer).
    fn until(rt: &tokio::runtime::Runtime, what: &str, f: impl Fn() -> bool) {
        rt.block_on(async {
            for _ in 0..10_000 {
                if f() {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            panic!("never: {what}");
        });
    }

    fn paused_rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .start_paused(true)
            .build()
            .unwrap()
    }

    #[test]
    fn the_unread_counts_follow_the_notifications_stream() {
        let rt = paused_rt();
        let t = Scripted::default();
        t.answer(
            "/api/notifications/counts",
            Answer::Status(
                200,
                "application/json",
                r#"{"states":{"w1":{"workspaceId":"w1","version":1,"totalUnread":1,"perSession":{"s1":1}}}}"#,
            ),
        );
        t.answer("/api/notifications/stream", Answer::Sse(STATE_W1, true));
        let data = TransportSessionsData::new(Arc::new(t.clone()), rt.handle().clone());
        let mut changes = data.subscribe();
        until(&rt, "the stream's state", || {
            data.unread("w1").get("s1") == Some(&2)
        });
        assert_eq!(
            data.unread("w1"),
            BTreeMap::from([("s1".into(), 2), ("s2".into(), 1)])
        );
        // The counts moved twice (the boot fetch's, then the stream's
        // newer one), unless the stream's came first and gated the fetch's.
        let mut seen = Vec::new();
        while let Ok(c) = changes.try_recv() {
            seen.push(c);
        }
        assert!(!seen.is_empty() && seen.len() <= 2, "{seen:?}");
        assert!(seen.iter().all(|c| *c
            == SessionsChange::Unread {
                workspace_id: "w1".into()
            }));
        assert_eq!(
            t.requests()
                .iter()
                .map(|r| (r.method.as_str(), r.url.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("GET", "/api/notifications/counts"),
                ("GET", "/api/notifications/stream")
            ]
        );
        // The stream stays open: nothing more is asked.
        rt.block_on(async { tokio::time::sleep(Duration::from_secs(60)).await });
        assert_eq!(t.requests().len(), 2);
        assert_eq!(t.open.load(std::sync::atomic::Ordering::SeqCst), 1);
        // Dropping the data stops the feed: the stream's body is dropped.
        drop(data);
        rt.block_on(async { tokio::time::sleep(Duration::from_secs(60)).await });
        assert_eq!(t.requests().len(), 2);
        assert_eq!(t.open.load(std::sync::atomic::Ordering::SeqCst), 0);
    }

    #[test]
    fn only_newer_state_messages_move_the_counts() {
        let rt = paused_rt();
        let t = Scripted::default();
        t.answer(
            "/api/notifications/counts",
            Answer::Status(404, "application/json", "{}"),
        );
        let frames: &'static str =
            Box::leak(format!("{STATE_W1}{NOTIFICATION_AND_STALE}").into_boxed_str());
        t.answer("/api/notifications/stream", Answer::Sse(frames, true));
        let data = TransportSessionsData::new(Arc::new(t.clone()), rt.handle().clone());
        let mut changes = data.subscribe();
        until(&rt, "w2's state", || !data.unread("w2").is_empty());
        // The `event: state` message isn't `onmessage`'s; version 2 is
        // older than 3; the notification row and the junk are skipped.
        assert_eq!(
            data.unread("w1"),
            BTreeMap::from([("s1".into(), 2), ("s2".into(), 1)])
        );
        assert_eq!(data.unread("w2"), BTreeMap::from([("s5".into(), 4)]));
        let mut seen = Vec::new();
        while let Ok(c) = changes.try_recv() {
            seen.push(c);
        }
        assert_eq!(
            seen,
            vec![
                SessionsChange::Unread {
                    workspace_id: "w1".into()
                },
                SessionsChange::Unread {
                    workspace_id: "w2".into()
                },
            ]
        );
    }

    #[test]
    fn a_broken_stream_refetches_the_counts_and_reopens_with_backoff() {
        let rt = paused_rt();
        let t = Scripted::default();
        // Down twice, a stream that opens and ends, down five times (past
        // the cap), then one that holds.
        for _ in 0..2 {
            t.answer("/api/notifications/stream", Answer::Down);
        }
        t.answer("/api/notifications/stream", Answer::Sse(": hi\n\n", false));
        for _ in 0..5 {
            t.answer("/api/notifications/stream", Answer::Down);
        }
        t.answer("/api/notifications/stream", Answer::Sse(STATE_W1, true));
        for _ in 0..9 {
            t.answer(
                "/api/notifications/counts",
                Answer::Status(200, "application/json", r#"{"states":{}}"#),
            );
        }
        let data = TransportSessionsData::new(Arc::new(t.clone()), rt.handle().clone());
        until(&rt, "the last stream's state", || {
            !data.unread("w1").is_empty()
        });
        let streams: Vec<String> = t
            .timeline()
            .into_iter()
            .filter(|l| l.ends_with("stream"))
            .collect();
        // 1 s, 2 s, then the open resets it: 1, 2, 4, 8, then 15 (not 16),
        // 15.
        assert_eq!(
            streams,
            vec![
                "0 /api/notifications/stream",
                "1000 /api/notifications/stream",
                "3000 /api/notifications/stream",
                "4000 /api/notifications/stream",
                "6000 /api/notifications/stream",
                "10000 /api/notifications/stream",
                "18000 /api/notifications/stream",
                "33000 /api/notifications/stream",
                "48000 /api/notifications/stream",
            ]
        );
        // The counts on start and after each error.
        let counts = t
            .timeline()
            .into_iter()
            .filter(|l| l.ends_with("counts"))
            .count();
        assert_eq!(counts, 9);
    }

    #[test]
    fn refresh_unread_fetches_the_counts_again() {
        let rt = paused_rt();
        let t = Scripted::default();
        let data = TransportSessionsData::requests_only(Arc::new(t.clone()), rt.handle().clone());
        let mut changes = data.subscribe();
        t.answer(
            "/api/notifications/counts",
            Answer::Status(
                200,
                "application/json",
                "\u{feff}{\"states\":{\"w1\":{\"workspaceId\":\"w1\",\"version\":1,\"perSession\":{\"s1\":1}}}}",
            ),
        );
        data.refresh_unread();
        until(&rt, "the counts", || !data.unread("w1").is_empty());
        assert_eq!(
            changes.try_recv().ok(),
            Some(SessionsChange::Unread {
                workspace_id: "w1".into()
            })
        );
        // Not ok, or not JSON: nothing changes.
        t.answer(
            "/api/notifications/counts",
            Answer::Status(
                500,
                "application/json",
                r#"{"states":{"w1":{"workspaceId":"w1","version":5,"perSession":{}}}}"#,
            ),
        );
        data.refresh_unread();
        t.answer(
            "/api/notifications/counts",
            Answer::Status(200, "text/plain", "nope"),
        );
        data.refresh_unread();
        rt.block_on(async { tokio::time::sleep(Duration::from_secs(1)).await });
        assert_eq!(t.requests().len(), 3);
        assert_eq!(data.unread("w1"), BTreeMap::from([("s1".into(), 1)]));
        assert_eq!(changes.try_recv().ok(), None);
    }
}
