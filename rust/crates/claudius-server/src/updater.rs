//! `/api/updater/{settings,status,log,check,changelog}`: port of the first
//! half of `app/api/updater/*` (D27a) over [`claudius_core::updater`].
//!
//! - `GET /api/updater/settings`: the four settings from
//!   `~/.claude/.claudius/updater.json` (defaults for a missing, unreadable
//!   or unparsable file). `PUT`: `mode` must be one of the four (else 400,
//!   nothing written); `remote` / `branch` strings and an `intervalHours`
//!   number are applied when `patchUpdaterSettings`' checks pass; the file is
//!   rewritten from what was read either way. A body that isn't JSON, or is
//!   `null`, is Next's empty 500.
//! - `GET /api/updater/status`: the settings, the state (with a `pending`
//!   the live HEAD already contains left out, the file untouched) and the
//!   install root's git facts and runtime mode.
//! - `GET /api/updater/log[?offset=n]`: the size of
//!   `<root>/.claudius/logs/updater.log`, or the bytes from `offset` (at most
//!   256 KiB, decoded as lossy UTF-8).
//! - `POST /api/updater/check`: one background check (single flight).
//! - `GET /api/updater/changelog?from=&to=`: the release changelog over
//!   GitHub's compare API (through `AppState::https`, so with the dev routes
//!   on `CLAUDIUS_DEV_FETCH_BASE` points it at a local fake); 400 for a bad
//!   or equal pair, 502 with the failure.
//!
//! `apply` (D27b) stays on Next.

use std::sync::LazyLock;

use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use claudius_agent::js;
use claudius_core::updater::release_changelog::{self, ChangelogCache};
use claudius_core::updater::settings::{self, SettingsPatch};
use claudius_core::updater::{detect, git, root};
use claudius_core::{js_num, js_string, log, node_path, now_ms};
use serde_json::{Map, Value, json};

use crate::AppState;
use crate::body::{JsonBody, js_member, thrown};
use crate::session_transcript::search_param;
use crate::tri;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/updater/settings", get(get_settings).put(put_settings))
        .route("/api/updater/status", get(status))
        .route("/api/updater/log", get(log_tail))
        .route("/api/updater/check", post(check))
        .route("/api/updater/changelog", get(changelog))
}

/// `NextResponse.json(body, {status})`: `JSON.stringify`, lone surrogates
/// as escapes.
fn json_text(status: StatusCode, body: &Value) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "application/json")],
        js_string::stringify(body),
    )
        .into_response()
}

fn ok(body: &Value) -> Response {
    json_text(StatusCode::OK, body)
}

/// A throw in the handler: logged, then Next's empty 500.
fn failed(route: &str, message: &str) -> Response {
    tracing::error!(target: log::API, "[api/updater/{route}] {message}");
    thrown()
}

/// `GET /api/updater/settings`.
async fn get_settings() -> Response {
    match tokio::task::spawn_blocking(settings::get_updater_settings).await {
        Ok(s) => ok(&s.to_json()),
        Err(e) => failed("settings", &e.to_string()),
    }
}

/// `PUT /api/updater/settings`.
async fn put_settings(body: Bytes) -> Response {
    // `await req.json()`, uncaught: a lone-surrogate escape stays one, a
    // number past f64 is `null` (both fail every check Infinity fails).
    let Ok(b) = js_string::parse(&JsonBody::text(&body)) else {
        return thrown();
    };
    let mut patch = SettingsPatch::default();
    // `body.mode` (no `?.`): a `null` body throws here.
    if let Some(mode) = tri!(js_member(&b, "mode")) {
        match mode {
            Value::String(m) if settings::is_mode(m) => patch.mode = Some(m.clone()),
            _ => {
                return json_text(
                    StatusCode::BAD_REQUEST,
                    &json!({"error": format!("mode must be one of {}", settings::MODES.join(", "))}),
                );
            }
        }
    }
    if let Some(Value::String(r)) = tri!(js_member(&b, "remote")) {
        patch.remote = Some(r.clone());
    }
    if let Some(Value::String(br)) = tri!(js_member(&b, "branch")) {
        patch.branch = Some(br.clone());
    }
    if let Some(Value::Number(n)) = tri!(js_member(&b, "intervalHours")) {
        patch.interval_hours = n.as_f64();
    }
    match tokio::task::spawn_blocking(move || settings::patch_updater_settings(&patch)).await {
        Ok(Ok(s)) => ok(&s.to_json()),
        Ok(Err(e)) => failed("settings", &e.message),
        Err(e) => failed("settings", &e.to_string()),
    }
}

/// `String(v)` for the `pending.remoteSha` handed to `git` (`undefined`
/// for a missing member). An object that shadows `toString` reaches the
/// spawn as an empty argument (what node 22's argv conversion makes of it).
fn arg_string(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(v) => js_string::to_js_string(v).unwrap_or_default(),
    }
}

/// `GET /api/updater/status`.
async fn status() -> Response {
    let root = root::install_root();
    let file = match tokio::task::spawn_blocking(settings::read_updater_file).await {
        Ok(f) => f,
        Err(e) => return failed("status", &e.to_string()),
    };
    let is_repo = git::is_git_checkout(&root).await;
    let head = if is_repo {
        git::head_sha(&root).await.ok()
    } else {
        None
    };
    let branch = if is_repo {
        git::current_branch(&root).await.unwrap_or(None)
    } else {
        None
    };
    // A `pending` the live HEAD already contains (an outside `git pull`) is
    // left off the answer; the file keeps it until the next check.
    let mut state = file.state;
    if let (Some(pending), true, Some(head)) = (&state.pending, is_repo, &head)
        && !head.is_empty()
    {
        let sha = match pending {
            Value::Object(m) => arg_string(m.get("remoteSha")),
            _ => arg_string(None),
        };
        if git::is_ancestor(&root, &sha, head).await {
            state.pending = None;
        }
    }
    let mut install = Map::new();
    install.insert("root".into(), Value::String(root.clone()));
    install.insert("isGitCheckout".into(), Value::Bool(is_repo));
    if let Some(h) = head {
        install.insert("currentSha".into(), Value::String(h));
    }
    install.insert(
        "currentBranch".into(),
        branch.map_or(Value::Null, Value::String),
    );
    install.insert(
        "runtimeMode".into(),
        Value::String(root::runtime_mode().into()),
    );
    let mut out = Map::new();
    out.insert("settings".into(), file.settings.to_json());
    out.insert("state".into(), state.to_json());
    out.insert("install".into(), Value::Object(install));
    ok(&Value::Object(out))
}

/// `MAX_CHUNK`: the most one poll reads.
const MAX_CHUNK: f64 = 256.0 * 1024.0;

/// `GET /api/updater/log`.
async fn log_tail(uri: Uri) -> Response {
    let root = root::install_root();
    // A fixed path, still resolved and checked right above the fs calls.
    let base = node_path::resolve(&[&root]);
    let target = node_path::resolve(&[&base, ".claudius/logs/updater.log"]);
    if !target.starts_with(&format!("{base}/")) {
        return json_text(StatusCode::BAD_REQUEST, &json!({"error": "invalid path"}));
    }
    // `fs.stat` follows links; a missing log is an empty stream.
    let size = match std::fs::metadata(&target) {
        Ok(m) => m.len() as f64,
        Err(_) => return ok(&json!({"size": 0, "content": ""})),
    };
    let Some(param) = search_param(uri.query(), "offset") else {
        return ok(&json!({"size": js_num(size)}));
    };
    let mut offset = js::to_number(&param);
    if !offset.is_finite() || offset < 0.0 {
        offset = 0.0;
    }
    if offset >= size {
        return ok(&json!({"size": js_num(size), "content": ""}));
    }
    // A fractional offset makes `fh.read` throw: a `length` past the
    // buffer `Buffer.alloc` floored, an empty buffer, or a non-integer
    // `position`.
    if offset.fract() != 0.0 {
        return failed(
            "log",
            &format!("offset {} is not an integer", js::number_to_string(offset)),
        );
    }
    let len = (size - offset).min(MAX_CHUNK);
    let read =
        tokio::task::spawn_blocking(move || read_at(&target, offset as u64, len as usize)).await;
    match read {
        Ok(Ok(buf)) => ok(&json!({
            "size": js_num(offset + len),
            "content": String::from_utf8_lossy(&buf),
        })),
        Ok(Err(e)) => failed("log", &e),
        Err(e) => failed("log", &e.to_string()),
    }
}

/// `fh.read(Buffer.alloc(len), 0, len, offset)` on a fresh `open(…, "r")`:
/// the buffer whole, zeros past what the file still had.
fn read_at(path: &str, offset: u64, len: usize) -> Result<Vec<u8>, String> {
    use std::os::unix::fs::FileExt;
    let f = std::fs::File::open(path)
        .map_err(|e| claudius_core::node_fs::FsError::new(&e, "open", Some(path), None).message)?;
    let mut buf = vec![0u8; len];
    let mut done = 0;
    while done < len {
        match f.read_at(&mut buf[done..], offset + done as u64) {
            Ok(0) => break,
            Ok(n) => done += n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) => {
                return Err(claudius_core::node_fs::FsError::new(&e, "read", None, None).message);
            }
        }
    }
    Ok(buf)
}

/// `POST /api/updater/check`.
async fn check() -> Response {
    match detect::check_for_updates().await {
        Ok(result) => ok(&result.to_json()),
        Err(message) => failed("check", &message),
    }
}

/// The process's `getReleaseChangelog` cache.
static CHANGELOG: LazyLock<ChangelogCache> = LazyLock::new(ChangelogCache::new);

/// `GET /api/updater/changelog`.
async fn changelog(State(app): State<AppState>, uri: Uri) -> Response {
    let q = uri.query();
    let from = release_changelog::to_release_tag(&search_param(q, "from").unwrap_or_default());
    let to = release_changelog::to_release_tag(&search_param(q, "to").unwrap_or_default());
    let (Some(from), Some(to)) = (from, to) else {
        return json_text(
            StatusCode::BAD_REQUEST,
            &json!({"error": "from and to must be release versions"}),
        );
    };
    if from == to {
        return json_text(StatusCode::BAD_REQUEST, &json!({"error": "same version"}));
    }
    let clock = || now_ms() as f64;
    match CHANGELOG.get(app.https.as_ref(), &from, &to, &clock).await {
        Ok(changelog) => ok(&changelog),
        Err(error) => json_text(StatusCode::BAD_GATEWAY, &json!({"error": error})),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_sha_args_are_js_strings() {
        assert_eq!(arg_string(None), "undefined");
        assert_eq!(arg_string(Some(&json!(null))), "null");
        assert_eq!(arg_string(Some(&json!([["a", null], []]))), "a,,");
        assert_eq!(arg_string(Some(&json!({}))), "[object Object]");
        assert_eq!(arg_string(Some(&json!({"toString": 1}))), "");
        assert_eq!(arg_string(Some(&json!(123))), "123");
    }
}
