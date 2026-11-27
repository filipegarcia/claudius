//! The native UI's I/O host for `claudius-client`, which never does I/O
//! itself (see `claudius_client::effect`): a [`Transport`] runs the
//! state machine's fetches and opens its event streams, either
//! in-process or against a `claudius` server elsewhere.
//!
//! - [`InProcessTransport`]: no sockets. Each request goes through the
//!   server's own axum router (`claudius_server::app`) with
//!   `tower::ServiceExt::oneshot`, so every API route answers exactly as it
//!   does over HTTP, with no per-route code. An SSE route's body is read as
//!   a stream, the same bytes a browser reads.
//! - [`RemoteTransport`]: HTTP/1.1 to a `claudius` server's origin (hyper,
//!   as the server's own tests use). Plain `http://` only; see its docs for
//!   what the server checks (nothing).
//!
//! On top of either: [`Transport::fetch`] (the response read to its end),
//! [`Transport::fetch_outcome`] (the machine's [`FetchOutcome`]), and
//! [`Transport::event_source`], an emulation of the browser's
//! `EventSource` (WHATWG HTML, "Server-sent events"; see
//! [`event_source`]). [`driver::Driver`] runs a `ChatState`'s effects over a
//! transport.
//!
//! **What a request carries.** What the React UI's `fetch` sends from its
//! page: the caller's headers (duplicates joined by `", "`, as `Headers`
//! joins them), `Accept: */*` unless given, `Content-Type:
//! text/plain;charset=UTF-8` for a body without one (a string body's
//! default), `Content-Length` (also `0` for a body-less `POST` / `PUT`),
//! `Origin` on anything but `GET` / `HEAD`, `Host`, and the page's cookies
//! ([`CookieJar`]: the routes read `claudius.workspace`, and
//! `/api/workspaces/<id>/select` sets it). The method is normalized as
//! `fetch` normalizes it (`delete`, `get`, `head`, `options`, `post`, `put`
//! uppercased; any other, `patch` included, sent as given). The URL is
//! resolved against the origin by the WHATWG URL parser (the `url` crate):
//! dot segments, percent-encoding and the dropped fragment are the
//! browser's. Redirects are not followed (no API route sends one).
//!
//! Everything runs on tokio (requests, the in-process handler tasks, the
//! event sources' connection loops, the driver's timers): call it from
//! inside a tokio runtime, as `claudius-core` needs one anyway.

pub mod cookies;
pub mod driver;
pub mod event_source;
pub mod in_process;
pub mod remote;
pub mod sse;

use std::pin::Pin;
use std::sync::Arc;

use async_trait::async_trait;
use bytes::Bytes;
use claudius_client::effect::{FetchOutcome, FetchRequest};
use futures::{Stream, StreamExt};
use http::header::{
    ACCEPT, CONTENT_LENGTH, CONTENT_TYPE, COOKIE, HOST, HeaderMap, HeaderName, HeaderValue, ORIGIN,
};
use http::{Method, Version};
use url::Url;

pub use cookies::CookieJar;
pub use event_source::{EventSource, EventSourceEvent, EventSourceOptions, ReadyState};
pub use in_process::InProcessTransport;
pub use remote::RemoteTransport;

/// What the page sees when `fetch` rejects: Chromium's text, whatever the
/// cause (refused, reset, a URL or header `fetch` refuses).
pub const FAILED_TO_FETCH: &str = "TypeError: Failed to fetch";

/// What the page sees when the body breaks off after the head arrived:
/// Chromium's rejection of `res.text()` / `res.json()`.
pub const BODY_NETWORK_ERROR: &str = "TypeError: network error";

/// Why a request got no (whole) response.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum TransportError {
    /// `fetch` would throw before sending: a URL that doesn't parse or
    /// leaves the origin, a method or header it refuses, a `GET` with a
    /// body.
    #[error("invalid request: {0}")]
    Invalid(String),
    /// No response: the connection failed, or (in-process) the handler
    /// panicked, which over HTTP drops the connection.
    #[error("network error: {0}")]
    Network(String),
    /// The body broke off after the head arrived.
    #[error("body error: {0}")]
    Body(String),
}

impl TransportError {
    /// The rejection's text as the page reads it ([`FAILED_TO_FETCH`] or
    /// [`BODY_NETWORK_ERROR`]).
    pub fn page_text(&self) -> &'static str {
        match self {
            Self::Body(_) => BODY_NETWORK_ERROR,
            Self::Invalid(_) | Self::Network(_) => FAILED_TO_FETCH,
        }
    }
}

/// `fetch(url, { method, headers, body })`.
#[derive(Debug, Clone, PartialEq)]
pub struct Request {
    /// As the caller wrote it (normalized when sent, see the crate docs).
    pub method: String,
    /// Origin-relative (`/api/sessions?workspaceId=…`), resolved against
    /// the transport's origin.
    pub url: String,
    /// The `headers` the caller passes, in order.
    pub headers: Vec<(String, String)>,
    /// The body as sent (a JSON request's `JSON.stringify` text).
    pub body: Option<Bytes>,
}

impl Request {
    pub fn new(method: impl Into<String>, url: impl Into<String>) -> Self {
        Self {
            method: method.into(),
            url: url.into(),
            headers: Vec::new(),
            body: None,
        }
    }

    pub fn get(url: impl Into<String>) -> Self {
        Self::new("GET", url)
    }

    pub fn post(url: impl Into<String>) -> Self {
        Self::new("POST", url)
    }

    pub fn header(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.headers.push((name.into(), value.into()));
        self
    }

    pub fn body(mut self, body: impl Into<Bytes>) -> Self {
        self.body = Some(body.into());
        self
    }

    /// A JSON body (`content-type: application/json`), as the UI posts.
    pub fn json(self, text: impl Into<String>) -> Self {
        self.header("content-type", "application/json")
            .body(text.into())
    }
}

impl From<&FetchRequest> for Request {
    fn from(r: &FetchRequest) -> Self {
        Self {
            method: r.method.to_owned(),
            url: r.url.clone(),
            headers: r
                .headers
                .iter()
                .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
                .collect(),
            body: r.body.clone().map(Bytes::from),
        }
    }
}

/// A response read to its end.
#[derive(Debug, Clone)]
pub struct Response {
    pub status: u16,
    pub headers: HeaderMap,
    pub body: Bytes,
}

impl Response {
    /// `res.ok`.
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }

    /// The body as UTF-8, a bad sequence as U+FFFD. A leading BOM stays:
    /// [`FetchOutcome`]'s `json()` drops it, as `res.json()` does.
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    /// The state machine's view: the status and the body text.
    pub fn outcome(&self) -> FetchOutcome {
        FetchOutcome::Response {
            status: self.status,
            body: self.text(),
        }
    }
}

/// A response body as it arrives.
pub type BodyStream = Pin<Box<dyn Stream<Item = Result<Bytes, TransportError>> + Send>>;

/// A response head, its body still to come. Dropping the body closes the
/// connection (in-process: the router's body is dropped, so an SSE route's
/// subscription ends, as when a browser tab goes away).
pub struct StreamResponse {
    pub status: u16,
    pub headers: HeaderMap,
    pub body: BodyStream,
}

impl std::fmt::Debug for StreamResponse {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StreamResponse")
            .field("status", &self.status)
            .field("headers", &self.headers)
            .finish_non_exhaustive()
    }
}

impl StreamResponse {
    /// Read the body to its end.
    pub async fn collect(mut self) -> Result<Response, TransportError> {
        let mut body = Vec::new();
        while let Some(chunk) = self.body.next().await {
            body.extend_from_slice(&chunk?);
        }
        Ok(Response {
            status: self.status,
            headers: self.headers,
            body: Bytes::from(body),
        })
    }
}

/// How the UI reaches the engine: the two operations the client state
/// machine needs, `fetch` and `EventSource`, over one origin.
#[async_trait]
pub trait Transport: Send + Sync + 'static {
    /// Send `req`; the response head, its body as a stream.
    async fn send(&self, req: Request) -> Result<StreamResponse, TransportError>;

    /// This transport as a shared handle (a cheap clone: the same router or
    /// connection pool and the same cookies), for the task an
    /// [`EventSource`] runs.
    fn shared(&self) -> Arc<dyn Transport>;

    /// `await fetch(...)` with the body read to its end.
    async fn fetch(&self, req: Request) -> Result<Response, TransportError> {
        self.send(req).await?.collect().await
    }

    /// A [`FetchRequest`] the state machine made, as the outcome it takes
    /// back (`fetch_settled`): the status and body text, or the page's
    /// rejection text.
    async fn fetch_outcome(&self, req: &FetchRequest) -> FetchOutcome {
        match self.fetch(Request::from(req)).await {
            Ok(res) => res.outcome(),
            Err(e) => FetchOutcome::Failed(e.page_text().to_owned()),
        }
    }

    /// `new EventSource(url)`, with Chromium's 3 s default reconnection
    /// time.
    fn event_source(&self, url: &str) -> EventSource {
        EventSource::open(self.shared(), url, EventSourceOptions::default())
    }
}

/// The origin a transport talks to, and how a request URL resolves
/// against it.
#[derive(Debug, Clone)]
pub(crate) struct Origin {
    base: Url,
    /// `http://host:port` (the default port left out), the `Origin` header.
    serialized: String,
    /// `host[:port]`, the `Host` header.
    authority: String,
}

impl Origin {
    pub(crate) fn parse(base: &str) -> Result<Origin, TransportError> {
        let url = Url::parse(base).map_err(|e| TransportError::Invalid(format!("{base}: {e}")))?;
        if url.scheme() != "http" {
            return Err(TransportError::Invalid(format!(
                "{base}: only http:// is supported"
            )));
        }
        let Some(host) = url.host_str() else {
            return Err(TransportError::Invalid(format!("{base}: no host")));
        };
        let authority = match url.port() {
            Some(port) => format!("{host}:{port}"),
            None => host.to_owned(),
        };
        let serialized = url.origin().ascii_serialization();
        let mut base = url;
        base.set_path("/");
        base.set_query(None);
        base.set_fragment(None);
        Ok(Origin {
            base,
            serialized,
            authority,
        })
    }

    /// `url` resolved as `fetch` resolves it against a page at the origin's
    /// root: the request target (path and query). A URL on another origin
    /// is refused: a transport talks to one server.
    pub(crate) fn resolve(&self, url: &str) -> Result<String, TransportError> {
        let joined = self
            .base
            .join(url)
            .map_err(|e| TransportError::Invalid(format!("{url}: {e}")))?;
        if joined.origin() != self.base.origin() {
            return Err(TransportError::Invalid(format!(
                "{url}: not on {}",
                self.serialized
            )));
        }
        let mut target = joined.path().to_owned();
        if let Some(q) = joined.query() {
            target.push('?');
            target.push_str(q);
        }
        Ok(target)
    }
}

/// How the request line names the target.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Target {
    /// `/path?query`, as a server receives it (in-process).
    OriginForm,
    /// `http://host:port/path?query`, as hyper's client takes it.
    Absolute,
}

/// `fetch`'s method normalization: the six standard methods uppercased in
/// any case, any other token sent as given.
fn normalize_method(m: &str) -> Result<Method, TransportError> {
    const UPPER: [&str; 6] = ["DELETE", "GET", "HEAD", "OPTIONS", "POST", "PUT"];
    let m = UPPER
        .iter()
        .find(|u| u.eq_ignore_ascii_case(m))
        .map_or(m, |u| *u);
    Method::from_bytes(m.as_bytes())
        .map_err(|_| TransportError::Invalid(format!("'{m}' is not a valid HTTP method")))
}

/// A header value as `Headers` takes it: HTTP whitespace trimmed, each
/// char a byte (latin1). `HeaderValue` refuses NUL / CR / LF, as `Headers`
/// does, and the other controls but tab too, which `Headers` would send.
fn header_value(name: &str, value: &str) -> Result<HeaderValue, TransportError> {
    let v = value.trim_matches(['\t', '\n', '\r', ' ']);
    let bytes: Option<Vec<u8>> = v.chars().map(|c| u8::try_from(u32::from(c)).ok()).collect();
    bytes
        .and_then(|b| HeaderValue::from_bytes(&b).ok())
        .ok_or_else(|| TransportError::Invalid(format!("invalid value for header {name}")))
}

/// The request a page's `fetch` sends for `req` (see the crate docs),
/// with the jar's cookies.
pub(crate) fn build(
    origin: &Origin,
    jar: &CookieJar,
    req: Request,
    target: Target,
) -> Result<http::Request<Bytes>, TransportError> {
    let method = normalize_method(&req.method)?;
    if req.body.is_some() && (method == Method::GET || method == Method::HEAD) {
        return Err(TransportError::Invalid(
            "Request with GET/HEAD method cannot have body".into(),
        ));
    }
    let path = origin.resolve(&req.url)?;
    let uri = match target {
        Target::OriginForm => path,
        Target::Absolute => format!("{}{path}", origin.serialized),
    };
    let mut headers = HeaderMap::new();
    for (name, value) in &req.headers {
        let key = HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| TransportError::Invalid(format!("invalid header name {name:?}")))?;
        let value = header_value(name, value)?;
        // `Headers.append` on a name already there joins the values.
        let joined = match headers.get(&key) {
            Some(prev) => {
                let mut v = prev.as_bytes().to_vec();
                v.extend_from_slice(b", ");
                v.extend_from_slice(value.as_bytes());
                HeaderValue::from_bytes(&v)
                    .map_err(|_| TransportError::Invalid(format!("invalid header {name}")))?
            }
            None => value,
        };
        headers.insert(key, joined);
    }
    if !headers.contains_key(ACCEPT) {
        headers.insert(ACCEPT, HeaderValue::from_static("*/*"));
    }
    // A string body (even `""`) is `text/plain;charset=UTF-8` unless the
    // caller says otherwise, and has a length; a body-less `POST` / `PUT`
    // sends `Content-Length: 0`.
    let given = req.body.is_some();
    let body = req.body.unwrap_or_default();
    if given && !headers.contains_key(CONTENT_TYPE) {
        headers.insert(
            CONTENT_TYPE,
            HeaderValue::from_static("text/plain;charset=UTF-8"),
        );
    }
    if given || method == Method::POST || method == Method::PUT {
        headers.insert(CONTENT_LENGTH, HeaderValue::from(body.len()));
    }
    if method != Method::GET && method != Method::HEAD {
        headers.insert(
            ORIGIN,
            HeaderValue::from_str(&origin.serialized).expect("an ASCII origin"),
        );
    }
    if let Some(cookie) = jar.header() {
        if let Ok(v) = HeaderValue::from_str(&cookie) {
            headers.insert(COOKIE, v);
        }
    }
    headers.insert(
        HOST,
        HeaderValue::from_str(&origin.authority).expect("an ASCII host"),
    );
    let mut out = http::Request::builder()
        .method(method)
        .uri(uri)
        .version(Version::HTTP_11)
        .body(body)
        .map_err(|e| TransportError::Invalid(e.to_string()))?;
    *out.headers_mut() = headers;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn origin() -> Origin {
        Origin::parse("http://127.0.0.1:3100").unwrap()
    }

    fn built(req: Request) -> http::Request<Bytes> {
        build(&origin(), &CookieJar::new(), req, Target::Absolute).unwrap()
    }

    fn headers(r: &http::Request<Bytes>) -> Vec<(String, String)> {
        let mut v: Vec<(String, String)> = r
            .headers()
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_str().unwrap().to_owned()))
            .collect();
        v.sort();
        v
    }

    fn pairs(p: &[(&str, &str)]) -> Vec<(String, String)> {
        let mut v: Vec<(String, String)> =
            p.iter().map(|(k, v)| ((*k).into(), (*v).into())).collect();
        v.sort();
        v
    }

    #[test]
    fn a_get_is_what_a_page_sends() {
        let r = built(Request::get("/api/sessions?workspaceId=w"));
        assert_eq!(r.method(), Method::GET);
        assert_eq!(r.uri(), "http://127.0.0.1:3100/api/sessions?workspaceId=w");
        assert_eq!(r.version(), Version::HTTP_11);
        assert_eq!(
            headers(&r),
            pairs(&[("accept", "*/*"), ("host", "127.0.0.1:3100")])
        );
        assert!(r.body().is_empty());
    }

    #[test]
    fn a_json_post() {
        let r = built(Request::post("/api/sessions").json(r#"{"cwd":"/p"}"#));
        assert_eq!(
            headers(&r),
            pairs(&[
                ("accept", "*/*"),
                ("content-type", "application/json"),
                ("content-length", "12"),
                ("origin", "http://127.0.0.1:3100"),
                ("host", "127.0.0.1:3100"),
            ])
        );
        assert_eq!(r.body().as_ref(), br#"{"cwd":"/p"}"#);
        // Origin-form for the in-process router.
        let r = build(
            &origin(),
            &CookieJar::new(),
            Request::post("/api/x"),
            Target::OriginForm,
        )
        .unwrap();
        assert_eq!(r.uri(), "/api/x");
    }

    #[test]
    fn body_defaults() {
        // A string body without a type is text/plain; `""` too.
        for body in ["x", ""] {
            let r = built(Request::new("PATCH", "/a").body(body));
            let h = headers(&r);
            assert!(h.contains(&("content-type".into(), "text/plain;charset=UTF-8".into())));
            assert!(h.contains(&("content-length".into(), body.len().to_string())));
        }
        // A body-less POST / PUT says `Content-Length: 0`; DELETE, PATCH don't.
        for (m, len) in [
            ("POST", true),
            ("PUT", true),
            ("DELETE", false),
            ("PATCH", false),
        ] {
            let r = built(Request::new(m, "/a"));
            let h = headers(&r);
            assert_eq!(
                h.contains(&("content-length".into(), "0".into())),
                len,
                "{m}"
            );
            assert!(!h.iter().any(|(k, _)| k == "content-type"), "{m}");
            assert!(
                h.contains(&("origin".into(), "http://127.0.0.1:3100".into())),
                "{m}"
            );
        }
        // The caller's own type and accept win.
        let r = built(
            Request::post("/a")
                .header("Accept", "application/json")
                .header("Content-Type", "application/x-ndjson")
                .body("{}"),
        );
        let h = headers(&r);
        assert!(h.contains(&("accept".into(), "application/json".into())));
        assert!(h.contains(&("content-type".into(), "application/x-ndjson".into())));
        assert_eq!(h.iter().filter(|(k, _)| k == "content-type").count(), 1);
    }

    #[test]
    fn methods_normalize_as_fetch_does() {
        for (given, sent) in [
            ("get", "GET"),
            ("Post", "POST"),
            ("delete", "DELETE"),
            ("head", "HEAD"),
            ("options", "OPTIONS"),
            ("put", "PUT"),
            ("patch", "patch"),
            ("PATCH", "PATCH"),
            ("PROPFIND", "PROPFIND"),
        ] {
            let r = built(Request::new(given, "/a"));
            assert_eq!(r.method().as_str(), sent, "{given}");
        }
        assert!(matches!(
            build(
                &origin(),
                &CookieJar::new(),
                Request::new("BAD METHOD", "/a"),
                Target::Absolute
            ),
            Err(TransportError::Invalid(_))
        ));
        for m in ["GET", "HEAD", "get"] {
            assert!(
                matches!(
                    build(
                        &origin(),
                        &CookieJar::new(),
                        Request::new(m, "/a").body("x"),
                        Target::Absolute
                    ),
                    Err(TransportError::Invalid(_))
                ),
                "{m} with a body"
            );
        }
    }

    #[test]
    fn headers_join_trim_and_refuse() {
        let r = built(
            Request::get("/a")
                .header("X-A", " 1 ")
                .header("x-a", "2")
                .header("X-L", "caf\u{e9}"),
        );
        assert_eq!(r.headers()["x-a"], "1, 2");
        assert_eq!(r.headers()["x-l"].as_bytes(), b"caf\xe9", "latin1");
        for bad in [
            Request::get("/a").header("X Y", "1"),
            Request::get("/a").header("", "1"),
            Request::get("/a").header("x", "a\nb"),
            Request::get("/a").header("x", "a\0b"),
            Request::get("/a").header("x", "\u{1f600}"),
            // Past latin1, even where the low byte is a fine one (`a`).
            Request::get("/a").header("x", "\u{161}"),
        ] {
            assert!(
                matches!(
                    build(&origin(), &CookieJar::new(), bad.clone(), Target::Absolute),
                    Err(TransportError::Invalid(_))
                ),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn urls_resolve_as_the_browser_resolves_them() {
        let o = origin();
        for (given, target) in [
            ("/api/x", "/api/x"),
            ("api/x", "/api/x"),
            ("/api/a/../b/./c", "/api/b/c"),
            ("/api/x?q=a b&r=\u{e9}", "/api/x?q=a%20b&r=%C3%A9"),
            ("/api/caf\u{e9} x", "/api/caf%C3%A9%20x"),
            ("/api/x#frag", "/api/x"),
            ("/api/x?", "/api/x?"),
            ("http://127.0.0.1:3100/api/y", "/api/y"),
            ("", "/"),
        ] {
            assert_eq!(o.resolve(given).unwrap(), target, "{given:?}");
        }
        for other in [
            "http://127.0.0.1:3101/api/x",
            "//evil.example/x",
            "https://127.0.0.1:3100/x",
        ] {
            assert!(
                matches!(o.resolve(other), Err(TransportError::Invalid(_))),
                "{other}"
            );
        }
        // Default port, no port in Host.
        let o = Origin::parse("http://example.test/").unwrap();
        assert_eq!(
            (o.serialized.as_str(), o.authority.as_str()),
            ("http://example.test", "example.test")
        );
        let o = Origin::parse("http://example.test:80/some/path?q#f").unwrap();
        assert_eq!(o.authority, "example.test");
        assert_eq!(o.resolve("x").unwrap(), "/x", "the base path is dropped");
        for bad in ["https://example.test", "nope", "file:///tmp", "http://"] {
            assert!(Origin::parse(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn the_jars_cookies_go_out() {
        let jar = CookieJar::new();
        jar.set("a=1");
        jar.set("b=2");
        let r = build(&origin(), &jar, Request::get("/a"), Target::Absolute).unwrap();
        assert_eq!(r.headers()["cookie"], "a=1; b=2");
    }

    #[test]
    fn a_fetch_request_converts() {
        let fr = FetchRequest {
            id: claudius_client::effect::FetchId(3),
            method: "POST",
            url: "/api/sessions/s/recap".into(),
            headers: vec![("Content-Type", "application/json")],
            body: Some("{}".into()),
        };
        assert_eq!(
            Request::from(&fr),
            Request::post("/api/sessions/s/recap")
                .header("Content-Type", "application/json")
                .body("{}")
        );
    }

    #[test]
    fn outcomes() {
        let res = Response {
            status: 404,
            headers: HeaderMap::new(),
            body: Bytes::from_static(b"\xEF\xBB\xBF{\"error\":\"x\xFF\"}"),
        };
        assert!(!res.ok());
        assert_eq!(res.text(), "\u{feff}{\"error\":\"x\u{fffd}\"}");
        assert_eq!(
            res.outcome(),
            FetchOutcome::Response {
                status: 404,
                body: "\u{feff}{\"error\":\"x\u{fffd}\"}".into()
            }
        );
        for (code, ok) in [
            (199, false),
            (200, true),
            (204, true),
            (299, true),
            (300, false),
        ] {
            let r = Response {
                status: code,
                headers: HeaderMap::new(),
                body: Bytes::new(),
            };
            assert_eq!(r.ok(), ok, "{code}");
        }
        assert_eq!(
            TransportError::Network("x".into()).page_text(),
            FAILED_TO_FETCH
        );
        assert_eq!(
            TransportError::Invalid("x".into()).page_text(),
            FAILED_TO_FETCH
        );
        assert_eq!(
            TransportError::Body("x".into()).page_text(),
            BODY_NETWORK_ERROR
        );
    }
}
