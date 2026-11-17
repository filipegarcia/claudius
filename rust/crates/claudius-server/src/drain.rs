//! Read what a handler left of its request body, so the connection ends
//! cleanly (I24).
//!
//! hyper reads a request body only as fast as the handler polls it. When
//! a handler answers without reading it (axum's 405 for a method the route
//! doesn't export, a route that never looks at its body, an early 4xx),
//! hyper tries one read and, if the body isn't all there yet, stops reading,
//! turns keep-alive off and closes the connection after the response. The
//! body bytes still on their way then reach a closed socket, and the kernel
//! answers them with a TCP RST: the client has the whole response but reads
//! `ECONNRESET` instead of its end (some stacks drop the unread response
//! too), and a keep-alive client such as a browser loses the connection.
//! Node's HTTP server under Next reads and discards an unread body instead
//! (`req._dump()` once the response is done), so there the connection stays
//! open for the next request.
//!
//! [`unread_bodies`] wraps every request body. One the handler drops
//! before its end is read to its end in the background and discarded, at
//! most [`MAX_BYTES`] of it within [`MAX_TIME`]: hyper sees the body
//! consumed, so it keeps the connection (or, for `Connection: close`, closes
//! it once the request is in). Past either bound the body is dropped as
//! before, so a huge or stalled upload is cut off rather than read forever.
//! A request with `Expect: 100-continue` is left as it is: reading its body
//! would make hyper send the `100 Continue` the early answer stands in for.

use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::extract::Request;
use axum::http::header::EXPECT;
use http_body_util::BodyExt;
use hyper::body::{Body as HttpBody, Frame, SizeHint};

/// How much of an unread body is read and thrown away (the same bound as
/// the no-upstream 404 in [`crate::proxy`]).
pub const MAX_BYTES: usize = 1 << 20;

/// How long an unread body may take to arrive.
pub const MAX_TIME: Duration = Duration::from_secs(5);

/// `axum::middleware::map_request` function: the request, its body wrapped
/// so that what the handler doesn't read is drained (see the module doc).
pub async fn unread_bodies(req: Request) -> Request {
    if req.headers().contains_key(EXPECT) {
        return req;
    }
    req.map(|body| Body::new(Drained { inner: Some(body) }))
}

/// A request body that drains itself when dropped unread.
struct Drained {
    inner: Option<Body>,
}

impl HttpBody for Drained {
    type Data = Bytes;
    type Error = axum::Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, axum::Error>>> {
        match self.inner.as_mut() {
            Some(body) => Pin::new(body).poll_frame(cx),
            None => Poll::Ready(None),
        }
    }

    fn is_end_stream(&self) -> bool {
        self.inner.as_ref().is_none_or(HttpBody::is_end_stream)
    }

    fn size_hint(&self) -> SizeHint {
        self.inner
            .as_ref()
            .map_or_else(|| SizeHint::with_exact(0), HttpBody::size_hint)
    }
}

impl Drop for Drained {
    fn drop(&mut self) {
        let Some(body) = self.inner.take() else {
            return;
        };
        if body.is_end_stream() {
            return;
        }
        if let Ok(rt) = tokio::runtime::Handle::try_current() {
            rt.spawn(drain(body));
        }
    }
}

/// Read and discard `body` to its end, within [`MAX_BYTES`] and
/// [`MAX_TIME`]; past either it is dropped where it stands.
async fn drain(mut body: Body) {
    let read = async move {
        let mut left = MAX_BYTES;
        while let Some(Ok(frame)) = body.frame().await {
            let n = frame.data_ref().map_or(0, Bytes::len);
            let Some(rest) = left.checked_sub(n) else {
                return;
            };
            left = rest;
        }
    };
    let _ = tokio::time::timeout(MAX_TIME, read).await;
}
