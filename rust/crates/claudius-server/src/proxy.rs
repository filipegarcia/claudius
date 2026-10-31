//! Transparent reverse proxy to the Next.js server for every route the Rust
//! backend hasn't taken over yet. Streams bodies both ways and tunnels
//! WebSocket upgrades (Next dev HMR lives on `/_next/webpack-hmr`).

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{HeaderName, HeaderValue, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::rt::{TokioExecutor, TokioIo};

use crate::AppState;

pub struct Proxy {
    /// `scheme://authority`, no trailing slash.
    base: String,
    client: Client<HttpConnector, Body>,
}

impl Proxy {
    pub fn new(base: &str) -> anyhow::Result<Proxy> {
        let uri: Uri = base.parse()?;
        anyhow::ensure!(
            uri.scheme_str() == Some("http"),
            "only http:// upstreams are supported"
        );
        let authority = uri
            .authority()
            .ok_or_else(|| anyhow::anyhow!("upstream needs host:port"))?;
        let base = format!("http://{authority}");
        let client = Client::builder(TokioExecutor::new()).build(HttpConnector::new());
        Ok(Proxy { base, client })
    }

    pub fn base(&self) -> &str {
        &self.base
    }
}

const HOP_BY_HOP: [&str; 7] = [
    "connection",
    "keep-alive",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];

fn strip_hop_by_hop(h: &mut axum::http::HeaderMap) {
    for name in HOP_BY_HOP {
        h.remove(name);
    }
}

pub async fn handler(State(app): State<AppState>, req: Request) -> Response {
    match &app.proxy {
        Some(p) => forward(p, req).await,
        None => {
            // Read the request body before answering. A connection closed
            // with unread bytes in its receive buffer is reset (RST) by the
            // kernel, and the client can lose the 404 to ECONNRESET.
            // Bounded, so a huge upload is cut off instead of buffered.
            let _ = axum::body::to_bytes(req.into_body(), 1 << 20).await;
            (
                StatusCode::NOT_FOUND,
                "not found (no Next upstream configured)",
            )
                .into_response()
        }
    }
}

pub async fn forward(p: &Proxy, mut req: Request) -> Response {
    let pq = req
        .uri()
        .path_and_query()
        .map(|x| x.as_str().to_owned())
        .unwrap_or_else(|| "/".into());
    let target = format!("{}{}", p.base, pq);
    let Ok(uri) = target.parse::<Uri>() else {
        return (StatusCode::BAD_REQUEST, "bad uri").into_response();
    };
    let is_upgrade = req.headers().contains_key(header::UPGRADE);
    let client_upgrade = is_upgrade.then(|| hyper::upgrade::on(&mut req));
    let upgrade_hdr = req.headers().get(header::UPGRADE).cloned();

    let peer_host = req.headers().get(header::HOST).cloned();
    *req.uri_mut() = uri;
    let headers = req.headers_mut();
    strip_hop_by_hop(headers);
    if let Some(u) = upgrade_hdr {
        headers.insert(header::CONNECTION, HeaderValue::from_static("upgrade"));
        headers.insert(header::UPGRADE, u);
    }
    if let Some(h) = peer_host {
        headers.insert(HeaderName::from_static("x-forwarded-host"), h);
    }
    headers.insert(
        HeaderName::from_static("x-forwarded-proto"),
        HeaderValue::from_static("http"),
    );

    let mut resp = match p.client.request(req).await {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!("proxy → {target}: {e}");
            return (
                StatusCode::BAD_GATEWAY,
                format!("upstream unavailable: {e}"),
            )
                .into_response();
        }
    };
    if resp.status() == StatusCode::SWITCHING_PROTOCOLS {
        let upstream_upgrade = hyper::upgrade::on(&mut resp);
        if let Some(client_upgrade) = client_upgrade {
            tokio::spawn(async move {
                let (Ok(c), Ok(u)) = (client_upgrade.await, upstream_upgrade.await) else {
                    return;
                };
                let _ =
                    tokio::io::copy_bidirectional(&mut TokioIo::new(c), &mut TokioIo::new(u)).await;
            });
        }
        let (parts, _) = resp.into_parts();
        return Response::from_parts(parts, Body::empty());
    }
    let (mut parts, body) = resp.into_parts();
    strip_hop_by_hop(&mut parts.headers);
    Response::from_parts(parts, Body::new(body))
}
