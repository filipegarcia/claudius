//! `GET /api/workspaces/:id/files/preview/*path`: port of
//! `app/api/workspaces/[id]/files/preview/[...path]/route.ts` (D03c), the
//! file server behind the chat's HTML previews (`FilePreview`, the
//! Markdown file links), over [`claudius_core::files_preview`].
//!
//! The id is a workspace or a customization (`cust_…`, its `src` mirror),
//! looked up by [`workspace_roots::resolve_workspace_root`] with no root
//! selector (`primary`): unknown is 404 `workspace not found`, a store that
//! can't be read (or a root list that throws) is Next's empty 500. The
//! path's file is served with the content type of its extension and
//! `Cache-Control: private, no-store`; refusals are `text/plain` (403 for a
//! path outside the root, 404 `not found` / `not a file`, 413 over 128 MB).
//!
//! The params are the ones Next's route matcher hands the TS handler: the
//! raw path's id and catch-all segments, each `decodeURIComponent`d and
//! stripped of a leading `_NEXTSEP_` (`stripParameterSeparators`), the
//! segments joined with `/`. Where Next doesn't hand the handler the path as
//! it came, the request goes to Next unchanged: a `//` or `\` (its 308 to
//! the cleaned URL), a trailing `/` (its trailing-slash 308), a dot segment
//! (`..`, `.`, `%2e`: Next routes the WHATWG-resolved pathname, browsers
//! never send one) and an escape `decodeURIComponent` refuses (its 400
//! page). Replayed by
//! `tests/files_preview.rs` against `rust/scripts/files-preview-golden.mjs`.

use axum::Router;
use axum::extract::{Request, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use claudius_core::files_preview::{self, Preview};
use claudius_core::{js_string, log, workspace_roots};

use crate::AppState;
use crate::body::thrown;

pub fn router() -> Router<AppState> {
    Router::new().route("/api/workspaces/{id}/files/preview/{*path}", get(preview))
}

/// Next's separator for adjacent route params, which its matcher strips
/// off the front of every param value.
const PARAM_SEPARATOR: &str = "_NEXTSEP_";

/// A param as Next's matcher decodes it; `None` is its `DecodeError`.
fn param(raw: &str) -> Option<String> {
    let s = js_string::decode_uri_component(raw)?;
    Some(match s.strip_prefix(PARAM_SEPARATOR) {
        Some(rest) => rest.to_owned(),
        None => s,
    })
}

/// A segment the WHATWG URL parser resolves: `.` or `..`, a dot also
/// spelled `%2e` (either case).
fn is_dot_segment(seg: &str) -> bool {
    let s = seg.to_ascii_lowercase().replace("%2e", ".");
    s == "." || s == ".."
}

/// `(id, segments.join("/"))` for the raw path, or `None` where Next
/// doesn't hand the handler this path as it came: it redirects a `//`, a
/// `\` or a trailing `/`, routes the `parseUrl` pathname (dot segments
/// resolved), and answers 400 to a param it can't decode.
fn next_params(raw: &str) -> Option<(String, String)> {
    if raw.contains("//")
        || raw.contains('\\')
        || raw.ends_with('/')
        || raw.split('/').any(is_dot_segment)
    {
        return None;
    }
    let (id, rest) = raw.strip_prefix("/api/workspaces/")?.split_once('/')?;
    let rest = rest.strip_prefix("files/preview/")?;
    let id = param(id)?;
    let segments = rest.split('/').map(param).collect::<Option<Vec<_>>>()?;
    Some((id, segments.join("/")))
}

/// `new Response(msg, {status})`: a string body is `text/plain;charset=UTF-8`.
fn text(status: StatusCode, msg: &'static str) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "text/plain;charset=UTF-8")],
        msg,
    )
        .into_response()
}

async fn preview(State(app): State<AppState>, req: Request) -> Response {
    let Some((id, rel_path)) = next_params(req.uri().path()) else {
        return crate::proxy::handler(State(app), req).await;
    };
    tokio::task::spawn_blocking(move || answer(&id, &rel_path))
        .await
        .unwrap_or_else(|_| thrown())
}

fn answer(id: &str, rel_path: &str) -> Response {
    let resolved = match workspace_roots::resolve_workspace_root(id, None) {
        Ok(Some(r)) => r,
        Ok(None) => return text(StatusCode::NOT_FOUND, "workspace not found"),
        Err(e) => {
            tracing::error!(target: log::API, "[api/workspaces/files/preview] {e}");
            return thrown();
        }
    };
    match files_preview::read(&resolved.root.abs_path, rel_path) {
        Preview::Escapes => text(StatusCode::FORBIDDEN, "path escapes workspace root"),
        Preview::NotFound => text(StatusCode::NOT_FOUND, "not found"),
        Preview::NotAFile => text(StatusCode::NOT_FOUND, "not a file"),
        Preview::TooLarge => text(
            StatusCode::PAYLOAD_TOO_LARGE,
            "file too large to preview (>128 MB)",
        ),
        Preview::File(bytes) => (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, files_preview::content_type(rel_path)),
                (header::CACHE_CONTROL, "private, no-store"),
            ],
            bytes,
        )
            .into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::next_params;

    #[test]
    fn params_follow_nexts_matcher() {
        let p = |raw: &str| next_params(raw);
        let ok = |id: &str, path: &str| Some((id.to_owned(), path.to_owned()));
        assert_eq!(
            p("/api/workspaces/w/files/preview/a/b.html"),
            ok("w", "a/b.html")
        );
        assert_eq!(
            p("/api/workspaces/w%2Fx/files/preview/a%2Fb"),
            ok("w/x", "a/b")
        );
        assert_eq!(
            p("/api/workspaces/_NEXTSEP_w/files/preview/_NEXTSEP_a/b"),
            ok("w", "a/b")
        );
        assert_eq!(
            p("/api/workspaces/w/files/preview/%5FNEXTSEP%5F_NEXTSEP_a"),
            ok("w", "_NEXTSEP_a")
        );
        assert_eq!(
            p("/api/workspaces/w/files/preview/caf%C3%A9.html"),
            ok("w", "caf\u{e9}.html")
        );
        // Next answers these itself.
        assert_eq!(p("/api/workspaces/w/files/preview/a/"), None);
        assert_eq!(p("/api/workspaces/w/files/preview/a//b"), None);
        assert_eq!(p("/api/workspaces/w/files/preview/a\\b"), None);
        assert_eq!(p("/api/workspaces/w/files/preview/100%.html"), None);
        assert_eq!(p("/api/workspaces/w/files/preview/%E9"), None);
        assert_eq!(p("/api/workspaces/w/files/preview/%ED%A0%80"), None);
        assert_eq!(p("/api/workspaces/%zz/files/preview/a"), None);
        for dots in ["..", ".", "%2e", "%2E%2e", ".%2E", "%2e."] {
            assert_eq!(
                p(&format!("/api/workspaces/w/files/preview/a/{dots}/b")),
                None,
                "{dots}"
            );
        }
        // Encoded slashes aren't segments: the handler gets them decoded.
        assert_eq!(p("/api/workspaces/w/files/preview/..%2Fx"), ok("w", "../x"));
        assert_eq!(p("/api/workspaces/w/files/preview/.../x"), ok("w", ".../x"));
        assert_eq!(
            p("/api/workspaces/w/files/preview/%2e%2e%2e"),
            ok("w", "...")
        );
    }
}
