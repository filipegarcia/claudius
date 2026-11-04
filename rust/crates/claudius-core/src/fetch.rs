//! The global `fetch` the TS server modules call, and the workspace's one
//! outbound HTTP(S) client behind it.
//!
//! Ported modules that call `fetch` take a [`Fetch`] (tests script one), and
//! production passes [`HttpsClient`]: reqwest on rustls (ring), HTTP/1.1 only,
//! set up to behave like Node 22's fetch (undici):
//!
//! - every network failure (refused, reset, DNS, TLS, a malformed response,
//!   more than 20 redirects, a scheme other than http / https, and undici's
//!   timeouts: 10 s to connect, 300 s of silence before the headers) is
//!   `fetch failed`, the message of undici's `TypeError`; a URL that doesn't
//!   parse or a bad method fails with undici's own words;
//! - a body that breaks off (or goes quiet for 300 s) after the headers is
//!   `terminated`, what `res.text()` / `res.json()` reject with;
//! - `statusText` is the reason phrase as sent (`""` when there is none);
//! - redirects are followed (at most 20; a 301 / 302 / 303 POST turns into a
//!   body-less GET) and send no `Referer`;
//! - a POST or PUT without a body sends `content-length: 0`;
//! - the defaults undici adds to a request that doesn't set them: `accept:
//!   */*`, `accept-language: *`, `sec-fetch-mode: cors`, `user-agent: node`.
//!   They go out after the request's own headers, as undici's. Differences:
//!   `accept-encoding` is `identity`, since nothing here decompresses
//!   (undici asks for `br, gzip, deflate` over HTTPS and `gzip, deflate`
//!   over HTTP, and decodes); every header name goes out in lower case
//!   (undici keeps the caller's `Content-Type`); no `connection: keep-alive`;
//! - proxies only with `NODE_USE_ENV_PROXY=1` (then `HTTP_PROXY`,
//!   `HTTPS_PROXY`, `NO_PROXY`), as Node 22, an https request tunnelling
//!   with `CONNECT host:port` as undici's; nothing retries.
//!
//! Not mirrored, as nothing here fetches such a URL (the callers' URLs are
//! fixed https ones on port 443): the fetch spec's bad-port list (undici
//! fails `http://h:9/` or `:6000` with `fetch failed`); a proxied plain-http
//! request (absolute form here; undici tunnels it too, and retries a
//! `CONNECT` the proxy drops); reqwest also reads `ALL_PROXY`.
//!
//! Certificates are checked against the OS trust store
//! (rustls-platform-verifier). Node checks its bundled Mozilla list (plus
//! `NODE_EXTRA_CA_CERTS`), so a chain only one of them trusts fails on the
//! other.
//!
//! Secrets: request bodies and header values never reach a log or a `Debug`
//! print from here.

use std::sync::OnceLock;
use std::time::Duration;

use claudius_agent::js;
use futures::future::BoxFuture;
use serde_json::Value;

use crate::account_profile::{FetchResponse, ProfileFetch};

/// undici's `TypeError` message for every failed `fetch`.
pub const FETCH_FAILED: &str = "fetch failed";
/// What reading a body rejects with when the connection breaks off.
pub const TERMINATED: &str = "terminated";
/// undici's `connectTimeout`.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// undici's `headersTimeout` and `bodyTimeout`: how long the server may stay
/// silent before the headers, and then between body chunks.
pub const READ_TIMEOUT: Duration = Duration::from_secs(300);

/// The headers [`HttpsClient`] adds unless the request sets them (any case),
/// after the request's own.
pub const DEFAULT_HEADERS: [(&str, &str); 5] = [
    ("accept", "*/*"),
    ("accept-language", "*"),
    ("sec-fetch-mode", "cors"),
    ("user-agent", "node"),
    ("accept-encoding", "identity"),
];

/// What `fetch(url, init)` was called with.
#[derive(Clone)]
pub struct Request {
    pub method: String,
    pub url: String,
    /// `init.headers` as given, in order.
    pub headers: Vec<(String, String)>,
    /// `init.body` (always text for the ported callers).
    pub body: Option<String>,
}

impl std::fmt::Debug for Request {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let names: Vec<&str> = self.headers.iter().map(|(k, _)| k.as_str()).collect();
        f.debug_struct("Request")
            .field("method", &self.method)
            .field("url", &self.url)
            .field("headers", &names)
            .field("body_len", &self.body.as_ref().map(String::len))
            .finish()
    }
}

/// A settled `fetch`: the status line, and the body as reading it ends.
#[derive(Clone)]
pub struct Response {
    pub status: u16,
    /// `res.statusText`.
    pub status_text: String,
    /// The body bytes, or the message reading them rejects with.
    pub body: Result<Vec<u8>, String>,
}

impl std::fmt::Debug for Response {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Response")
            .field("status", &self.status)
            .field("status_text", &self.status_text)
            .field("body_len", &self.body.as_ref().map(Vec::len))
            .finish()
    }
}

impl Response {
    /// `res.ok`.
    pub fn ok(&self) -> bool {
        (200..=299).contains(&self.status)
    }

    /// `res.text()`: undici drops a leading UTF-8 BOM and its `TextDecoder`
    /// another; invalid bytes become U+FFFD.
    pub fn text(&self) -> Result<String, String> {
        let body = self.body.as_deref().map_err(Clone::clone)?;
        let once = body.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(body);
        let twice = once.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(once);
        Ok(String::from_utf8_lossy(twice).into_owned())
    }

    /// `res.json()`: [`text`](Self::text), then `JSON.parse` (V8's message
    /// on a parse failure).
    pub fn json(&self) -> Result<Value, String> {
        js::json_parse(&self.text()?)
    }
}

/// The global `fetch`: the settled response, or the rejection's message.
pub trait Fetch: Send + Sync {
    fn fetch<'a>(&'a self, req: &'a Request) -> BoxFuture<'a, Result<Response, String>>;
}

/// The production [`Fetch`] (see the module docs). The reqwest client is
/// built on first use; if that fails, every fetch fails.
pub struct HttpsClient {
    client: OnceLock<Option<reqwest::Client>>,
    base: Option<String>,
    timeouts: (Duration, Duration),
}

impl Default for HttpsClient {
    fn default() -> Self {
        HttpsClient::new()
    }
}

impl HttpsClient {
    pub fn new() -> HttpsClient {
        HttpsClient {
            client: OnceLock::new(),
            base: None,
            timeouts: (CONNECT_TIMEOUT, READ_TIMEOUT),
        }
    }

    /// For tests only: other connect / read timeouts than undici's
    /// [`CONNECT_TIMEOUT`] / [`READ_TIMEOUT`].
    pub fn with_timeouts(mut self, connect: Duration, read: Duration) -> HttpsClient {
        self.timeouts = (connect, read);
        self
    }

    /// The `(connect, read)` timeouts.
    pub fn timeouts(&self) -> (Duration, Duration) {
        self.timeouts
    }

    /// For dev and test servers only: send `scheme://host[:port]/path?query`
    /// to `<base>/host[:port]/path?query` instead (e.g. a local fake of the
    /// Anthropic endpoints).
    pub fn with_base(mut self, base: impl Into<String>) -> HttpsClient {
        self.base = Some(base.into());
        self
    }

    fn client(&self) -> Option<&reqwest::Client> {
        self.client
            .get_or_init(|| build_client(self.timeouts))
            .as_ref()
    }

    /// Where a request for `url` goes.
    pub fn target(&self, url: &str) -> String {
        let (Some(base), Ok(u)) = (&self.base, url::Url::parse(url)) else {
            return url.to_owned();
        };
        let Some(host) = u.host_str() else {
            return url.to_owned();
        };
        let mut out = format!("{}/{host}", base.trim_end_matches('/'));
        if let Some(port) = u.port() {
            out.push_str(&format!(":{port}"));
        }
        out.push_str(u.path());
        if let Some(q) = u.query() {
            out.push('?');
            out.push_str(q);
        }
        out
    }

    /// `fetch(url, init)`, with the response's header fields as well
    /// (`res.headers`): in order, names lower-cased, values as sent (undici
    /// reads each byte as one latin1 character).
    pub async fn fetch_with_headers(
        &self,
        req: &Request,
    ) -> Result<(Response, ResponseHeaders), String> {
        self.send_full(req).await
    }

    async fn send(&self, req: &Request) -> Result<Response, String> {
        self.send_full(req).await.map(|(res, _)| res)
    }

    async fn send_full(&self, req: &Request) -> Result<(Response, ResponseHeaders), String> {
        let failed = || FETCH_FAILED.to_owned();
        if url::Url::parse(&req.url).is_err() {
            return Err(format!("Failed to parse URL from {}", req.url));
        }
        let method = fetch_method(&req.method)?;
        let client = self.client().ok_or_else(failed)?;
        // The fetch spec's network fetch: a POST or PUT without a body still
        // says `content-length: 0` (hyper would send none).
        let empty_upload = req.body.is_none()
            && (method == reqwest::Method::POST || method == reqwest::Method::PUT);
        let mut rb = client.request(method, self.target(&req.url));
        for (k, v) in &req.headers {
            rb = rb.header(k.as_str(), v.as_str());
        }
        for (k, v) in DEFAULT_HEADERS {
            if !req.headers.iter().any(|(h, _)| h.eq_ignore_ascii_case(k)) {
                rb = rb.header(k, v);
            }
        }
        if let Some(body) = &req.body {
            rb = rb.body(body.clone());
        } else if empty_upload {
            rb = rb.header("content-length", "0");
        }
        let res = rb.send().await.map_err(|_| failed())?;
        let status = res.status();
        let status_text = match res.extensions().get::<hyper::ext::ReasonPhrase>() {
            Some(reason) => String::from_utf8_lossy(reason.as_bytes()).into_owned(),
            None => status.canonical_reason().unwrap_or_default().to_owned(),
        };
        let headers = ResponseHeaders(
            res.headers()
                .iter()
                .map(|(k, v)| (k.as_str().to_owned(), v.as_bytes().to_vec()))
                .collect(),
        );
        let body = match res.bytes().await {
            Ok(b) => Ok(b.to_vec()),
            Err(_) => Err(TERMINATED.to_owned()),
        };
        let res = Response {
            status: status.as_u16(),
            status_text,
            body,
        };
        Ok((res, headers))
    }
}

/// A response's header fields: `(lower-cased name, value bytes)`, in order.
#[derive(Clone, Debug, Default)]
pub struct ResponseHeaders(pub Vec<(String, Vec<u8>)>);

impl ResponseHeaders {
    /// `headers.get(name)`: every value of the field joined with `", "`, or
    /// `None` when there is none.
    pub fn get(&self, name: &str) -> Option<Vec<u8>> {
        let mut values = self
            .0
            .iter()
            .filter(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_slice());
        let first = values.next()?;
        Some(values.fold(first.to_vec(), |mut all, v| {
            all.extend_from_slice(b", ");
            all.extend_from_slice(v);
            all
        }))
    }
}

/// `new Request(…, { method })`'s checks: not `CONNECT` / `TRACE` /
/// `TRACK`, the six standard names in any case uppercased, and an HTTP token
/// (`Method::from_bytes` takes exactly the RFC 9110 token characters, so a
/// name that isn't one fails there with undici's words, after the forbidden
/// check as in undici, which no non-token can match).
fn fetch_method(m: &str) -> Result<reqwest::Method, String> {
    if ["CONNECT", "TRACE", "TRACK"]
        .iter()
        .any(|f| f.eq_ignore_ascii_case(m))
    {
        return Err(format!("'{m}' HTTP method is unsupported."));
    }
    let m = match ["DELETE", "GET", "HEAD", "OPTIONS", "POST", "PUT"]
        .iter()
        .find(|n| n.eq_ignore_ascii_case(m))
    {
        Some(n) => n,
        None => m,
    };
    reqwest::Method::from_bytes(m.as_bytes())
        .map_err(|_| format!("'{m}' is not a valid HTTP method."))
}

/// Node 22 uses `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` for fetch only
/// when `NODE_USE_ENV_PROXY` is exactly `1`.
pub fn env_proxy_enabled(node_use_env_proxy: Option<&str>) -> bool {
    node_use_env_proxy == Some("1")
}

/// The client's settings (see the module docs). `http1_only` and
/// `retry(never)` are what reqwest already does without its `http2` feature
/// (the workspace doesn't enable it); they keep it so if it ever does.
fn client_builder((connect, read): (Duration, Duration), proxy: bool) -> reqwest::ClientBuilder {
    let b = reqwest::Client::builder()
        .http1_only()
        .redirect(reqwest::redirect::Policy::limited(20))
        .referer(false)
        .retry(reqwest::retry::never())
        .connect_timeout(connect)
        .read_timeout(read);
    if proxy { b } else { b.no_proxy() }
}

fn build_client(timeouts: (Duration, Duration)) -> Option<reqwest::Client> {
    // reqwest is built without a default crypto provider; another one
    // installed first is fine too.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let proxy = env_proxy_enabled(std::env::var("NODE_USE_ENV_PROXY").ok().as_deref());
    match client_builder(timeouts, proxy).build() {
        Ok(c) => Some(c),
        Err(e) => {
            tracing::error!(target: crate::log::API, "[fetch] client setup failed: {e}");
            None
        }
    }
}

impl Fetch for HttpsClient {
    fn fetch<'a>(&'a self, req: &'a Request) -> BoxFuture<'a, Result<Response, String>> {
        Box::pin(self.send(req))
    }
}

/// `account-profile.ts`'s lookup over this client: it reads the body only
/// on a 2xx, inside the `try` that also catches a failed fetch.
impl ProfileFetch for HttpsClient {
    fn get<'a>(
        &'a self,
        url: &'a str,
        headers: &'a [(String, String)],
    ) -> BoxFuture<'a, Result<FetchResponse, String>> {
        Box::pin(async move {
            let req = Request {
                method: "GET".into(),
                url: url.into(),
                headers: headers.to_vec(),
                body: None,
            };
            let res = self.send(&req).await?;
            let ok = res.ok();
            match res.body {
                Ok(body) => Ok(FetchResponse {
                    status: res.status,
                    body,
                }),
                Err(e) if ok => Err(e),
                Err(_) => Ok(FetchResponse {
                    status: res.status,
                    body: Vec::new(),
                }),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The settings reqwest's `Debug` shows (the read timeout and the
    /// redirects are checked by behaviour, in `tests/fetch_client.rs` and
    /// the binary replay; the proxy switch in the binary replay).
    #[test]
    fn the_builder_settings() {
        let t = (Duration::from_millis(1234), Duration::from_millis(5678));
        let b = format!("{:?}", client_builder(t, false));
        assert!(b.contains("http1_only: true"), "{b}");
        assert!(b.contains("connect_timeout: 1.234s"), "{b}");
    }
}
