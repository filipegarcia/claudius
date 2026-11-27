//! [`RemoteTransport`]: HTTP/1.1 to a `claudius` server's origin, with the
//! same requests as [`crate::InProcessTransport`] (see the crate docs).
//!
//! **What the server checks: nothing.** The Rust front door
//! (`claudius-server`) has no `Origin` / `Host` check, no CSRF token and no
//! authentication on any route; `proxy.ts` only does the workspace cookie
//! and page redirects, and its matcher skips `/api/`. Routes read only the
//! request's body, its query, `Cookie` (`claudius.workspace`, for the
//! active workspace) and, in two places, `Content-Type` and
//! `Content-Length`. So a remote client must send just what a page's
//! `fetch` sends, which this does, `Origin` included in case a guard is
//! added. The server binds `127.0.0.1` unless started with `--host` /
//! `CLAUDIUS_RS_HOST`: reach another machine's server through an SSH
//! tunnel, since anything that reaches the port can drive every session
//! (the `bash` route included).
//!
//! The client is hyper's pooled one (`hyper-util` legacy, as the server's
//! tests use), with `TCP_NODELAY`; `https://` isn't supported (the server
//! serves plain HTTP; TLS would come from a proxy in front of it).

use std::sync::Arc;

use async_trait::async_trait;
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::rt::TokioExecutor;

use crate::{CookieJar, Origin, Request, StreamResponse, Target, Transport, TransportError, build};

/// A `claudius` server at an `http://` origin. Clones share the connection
/// pool and the cookies.
#[derive(Clone)]
pub struct RemoteTransport {
    client: Client<HttpConnector, Full<Bytes>>,
    origin: Arc<Origin>,
    jar: Arc<CookieJar>,
}

impl std::fmt::Debug for RemoteTransport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RemoteTransport")
            .field("origin", &self.origin.serialized)
            .finish_non_exhaustive()
    }
}

impl RemoteTransport {
    /// The server at `base` (`http://127.0.0.1:3100`; a path in it is
    /// ignored: requests are origin-relative).
    pub fn new(base: &str) -> Result<Self, TransportError> {
        let origin = Origin::parse(base)?;
        let mut connector = HttpConnector::new();
        connector.set_nodelay(true);
        let client = Client::builder(TokioExecutor::new()).build(connector);
        Ok(Self {
            client,
            origin: Arc::new(origin),
            jar: Arc::new(CookieJar::new()),
        })
    }

    /// Use `jar` for the page's cookies.
    pub fn with_cookie_jar(mut self, jar: Arc<CookieJar>) -> Self {
        self.jar = jar;
        self
    }

    pub fn cookie_jar(&self) -> &Arc<CookieJar> {
        &self.jar
    }

    /// The server's origin (`http://127.0.0.1:3100`).
    pub fn origin(&self) -> &str {
        &self.origin.serialized
    }
}

#[async_trait]
impl Transport for RemoteTransport {
    async fn send(&self, req: Request) -> Result<StreamResponse, TransportError> {
        let req = build(&self.origin, &self.jar, req, Target::Absolute)?.map(Full::new);
        let res = self
            .client
            .request(req)
            .await
            .map_err(|e| TransportError::Network(error_chain(&e)))?;
        let (parts, body) = res.into_parts();
        self.jar.store_from(&parts.headers);
        Ok(StreamResponse {
            status: parts.status.as_u16(),
            headers: parts.headers,
            body: Box::pin(body_stream(body)),
        })
    }

    fn shared(&self) -> Arc<dyn Transport> {
        Arc::new(self.clone())
    }
}

/// hyper's body as data chunks; it ends after an error.
fn body_stream(
    body: Incoming,
) -> impl futures::Stream<Item = Result<Bytes, TransportError>> + Send {
    futures::stream::unfold(Some(body), |body| async move {
        let mut body = body?;
        loop {
            match body.frame().await {
                None => return None,
                Some(Ok(frame)) => {
                    if let Ok(data) = frame.into_data() {
                        return Some((Ok(data), Some(body)));
                    }
                }
                Some(Err(e)) => {
                    return Some((Err(TransportError::Body(error_chain(&e))), None));
                }
            }
        }
    })
}

/// An error and its sources, `a: b: c`.
fn error_chain(e: &dyn std::error::Error) -> String {
    let mut s = e.to_string();
    let mut cur = e.source();
    while let Some(c) = cur {
        s.push_str(": ");
        s.push_str(&c.to_string());
        cur = c.source();
    }
    s
}
