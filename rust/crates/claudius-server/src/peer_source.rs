//! `GET /api/sessions/peer-source`: port of
//! `app/api/sessions/peer-source/route.ts`, which resolves a cross-session
//! peer message to the session that sent it
//! ([`claudius_core::peer_source`]) so the chat's peer-message row can link
//! there.
//!
//! Params are `searchParams.get` values (first pair wins, form-decoded):
//! `from` (`|| undefined`), `pid` (`^\d{1,10}$`, else none), `msgId`
//! (`|| undefined`), `snippet` (its first 200 UTF-16 units, `|| undefined`)
//! and `at` (`^\d{1,16}$`). With no pid, msgId, from or snippet it is 400
//! `from, pid, msgId or snippet required`. A sender that can't be found is
//! 200 `{source: null}`. Otherwise `{source: {sessionId, cwd, name, live,
//! hostedHere, workspaceId}}`: `hostedHere` when this process's session
//! manager has the session, `workspaceId` the `id ?? null` of the deepest
//! workspace whose root holds the sender's cwd. A workspaces.json entry
//! that is `null` or has a non-string `rootPath` makes that lookup throw:
//! Next's empty 500. The lookup runs on the blocking pool.

use axum::Router;
use axum::extract::{RawQuery, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use claudius_agent::js;
use claudius_core::peer_source::{
    self as ps, PEER_SNIPPET_MAX, PeerSource, PeerSourceQuery, Resolver,
};
use claudius_core::{js_string, log, workspaces};
use serde_json::json;

use crate::AppState;
use crate::body::thrown;
use crate::session_transcript::search_param;

const ROUTE: &str = "api/sessions/peer-source";

pub fn router() -> Router<AppState> {
    Router::new().route("/api/sessions/peer-source", get(peer_source))
}

fn json_text(status: StatusCode, body: String) -> Response {
    (status, [(header::CONTENT_TYPE, "application/json")], body).into_response()
}

/// `^\d{1,max}$` (ASCII digits), as `Number(raw)`.
fn digits(raw: Option<String>, max: usize) -> Option<f64> {
    let raw = raw?;
    if raw.is_empty() || raw.len() > max || !raw.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    raw.parse().ok()
}

/// The query as the route reads it; `None` is the 400.
fn query(raw: Option<&str>) -> Option<PeerSourceQuery> {
    let param = |k: &str| search_param(raw, k);
    let q = PeerSourceQuery {
        from: param("from").filter(|s| !s.is_empty()),
        pid: digits(param("pid"), 10),
        msg_id: param("msgId").filter(|s| !s.is_empty()),
        snippet: param("snippet")
            .map(|s| {
                s.encode_utf16()
                    .take(PEER_SNIPPET_MAX)
                    .collect::<Vec<u16>>()
            })
            .filter(|s| !s.is_empty()),
        at: digits(param("at"), 16),
    };
    (q.pid.is_some() || q.msg_id.is_some() || q.from.is_some() || q.snippet.is_some()).then_some(q)
}

async fn peer_source(State(app): State<AppState>, RawQuery(raw): RawQuery) -> Response {
    let Some(q) = query(raw.as_deref()) else {
        return json_text(
            StatusCode::BAD_REQUEST,
            js::stringify(&json!({"error": "from, pid, msgId or snippet required"})),
        );
    };
    let looked_up = tokio::task::spawn_blocking(move || {
        let found = Resolver::global().resolve(&q, &ps::default_roots())?;
        // `listWorkspaces().catch(() => [])`, only for a sender with a cwd.
        let workspace = found.cwd.as_deref().map(|cwd| {
            let list = workspaces::list_raw().unwrap_or_default();
            ps::workspace_for_cwd(cwd, &list)
        });
        Some((found, workspace))
    })
    .await;
    let found = match looked_up {
        Ok(Some(found)) => found,
        Ok(None) => return json_text(StatusCode::OK, "{\"source\":null}".to_owned()),
        Err(_) => return thrown(),
    };
    let (found, workspace): (PeerSource, _) = found;
    let workspace_id = match workspace {
        None => "null".to_owned(),
        Some(Ok(id)) => js_string::stringify(&id),
        Some(Err(e)) => {
            tracing::error!(target: log::API, "[{ROUTE}] {e}");
            return thrown();
        }
    };
    let hosted_here = app.mgr.get(&found.session_id).is_some();
    let mut body = String::from("{\"source\":{\"sessionId\":");
    js::stringify_utf16(
        &found.session_id.encode_utf16().collect::<Vec<_>>(),
        &mut body,
    );
    body.push_str(",\"cwd\":");
    ps::push_str_or_null(&mut body, found.cwd.as_deref());
    body.push_str(",\"name\":");
    ps::push_str_or_null(&mut body, found.name.as_deref());
    body.push_str(&format!(
        ",\"live\":{},\"hostedHere\":{hosted_here},\"workspaceId\":{workspace_id}}}}}",
        found.live
    ));
    json_text(StatusCode::OK, body)
}
