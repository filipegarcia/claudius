//! [`InProcessTransport`]: the server's router called directly, no sockets.
//!
//! A request is built as a page's `fetch` builds it (see the crate docs),
//! handed to `claudius_server::app(state)` with `tower::ServiceExt::oneshot`,
//! and its response body read as a stream. So every route behaves exactly
//! as over HTTP, the SSE stream included (`/api/sessions/<id>/stream` sends
//! the same `data:` frames, pings and replay as to a browser), with no
//! per-route code.
//!
//! The request runs on its own tokio task, as hyper runs a connection's:
//! a panicking handler costs that request (a network error, as a dropped
//! connection is over HTTP), not the caller. Its body is pumped to the
//! caller through a small channel, and dropping the caller's body stream
//! drops the router's body at once, even while it waits for its next
//! chunk, as hyper drops it when a browser closes the connection (an SSE
//! route's subscription ends then).
//!
//! What differs from the wire: the response has no `date` and no
//! `transfer-encoding` (hyper's). `content-length` is there when the
//! body's size is known up front, as on the wire: axum's router sets it.
//!
//! Why the router and not `claudius_core` directly: the TODO's wording is
//! "`claudius-core` subscribe, no HTTP". The router *is* that, minus the
//! sockets: the stream route's handler is a `Session::subscribe_with` plus
//! the framing, and every other route's status codes, error strings and
//! JSON shapes come for free. Subscribing to core directly would duplicate
//! the stream route's resume / tail / `tabId` / trailing-`ready` logic in
//! the transport and still leave the 182 other routes to call through the
//! router. The `replay_done` marker the U00a spike missed is there too: the
//! stream route sends it after the replay window, as to a browser.

use std::sync::Arc;

use async_trait::async_trait;
use axum::Router;
use axum::body::Body;
use bytes::Bytes;
use futures::FutureExt;
use http_body_util::BodyExt;
use tokio::sync::{mpsc, oneshot};
use tower::ServiceExt;

use crate::{CookieJar, Origin, Request, StreamResponse, Target, Transport, TransportError, build};

/// The origin an in-process "page" is on: `Host` and `Origin` say this.
pub const IN_PROCESS_ORIGIN: &str = "http://localhost";

/// The server's router as a transport. Clones share the router and the
/// cookies.
#[derive(Clone)]
pub struct InProcessTransport {
    router: Router,
    origin: Arc<Origin>,
    jar: Arc<CookieJar>,
}

impl std::fmt::Debug for InProcessTransport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("InProcessTransport")
            .field("origin", &self.origin.serialized)
            .finish_non_exhaustive()
    }
}

impl InProcessTransport {
    /// Over the server's router for `state` (`claudius_server::app`).
    pub fn new(state: claudius_server::AppState) -> Self {
        Self::from_router(claudius_server::app(state))
    }

    /// Over any router (a test's, or the server's with extra layers).
    pub fn from_router(router: Router) -> Self {
        Self {
            router,
            origin: Arc::new(Origin::parse(IN_PROCESS_ORIGIN).expect("a valid origin")),
            jar: Arc::new(CookieJar::new()),
        }
    }

    /// Use `jar` for the page's cookies (shared with another transport,
    /// say).
    pub fn with_cookie_jar(mut self, jar: Arc<CookieJar>) -> Self {
        self.jar = jar;
        self
    }

    pub fn cookie_jar(&self) -> &Arc<CookieJar> {
        &self.jar
    }
}

#[async_trait]
impl Transport for InProcessTransport {
    async fn send(&self, req: Request) -> Result<StreamResponse, TransportError> {
        let req = build(&self.origin, &self.jar, req, Target::OriginForm)?.map(Body::from);
        let router = self.router.clone();
        let (head_tx, head_rx) = oneshot::channel();
        let (body_tx, mut body_rx) = mpsc::channel(16);
        tokio::spawn(async move {
            let Ok(res) = router.oneshot(req).await;
            let (parts, body) = res.into_parts();
            if head_tx.send(parts).is_err() {
                return;
            }
            pump(body, body_tx).await;
        });
        let parts = head_rx
            .await
            .map_err(|_| TransportError::Network("the handler panicked".into()))?;
        self.jar.store_from(&parts.headers);
        let body = futures::stream::poll_fn(move |cx| body_rx.poll_recv(cx));
        Ok(StreamResponse {
            status: parts.status.as_u16(),
            headers: parts.headers,
            body: Box::pin(body),
        })
    }

    fn shared(&self) -> Arc<dyn Transport> {
        Arc::new(self.clone())
    }
}

/// Move the router's body to the caller's stream, chunk by chunk, until it
/// ends, breaks (sent on as the stream's last item) or panics, or the
/// caller drops its end.
async fn pump(mut body: Body, tx: mpsc::Sender<Result<Bytes, TransportError>>) {
    loop {
        let frame = tokio::select! {
            () = tx.closed() => return,
            f = std::panic::AssertUnwindSafe(body.frame()).catch_unwind() => f,
        };
        let item = match frame {
            Ok(None) => return,
            Ok(Some(Ok(frame))) => match frame.into_data() {
                Ok(data) => Ok(data),
                Err(_) => continue, // trailers
            },
            Ok(Some(Err(e))) => Err(TransportError::Body(e.to_string())),
            Err(_) => Err(TransportError::Body("the body panicked".into())),
        };
        let last = item.is_err();
        if tx.send(item).await.is_err() || last {
            return;
        }
    }
}
