//! The Files page's routes and the chat's out-of-workspace images: ports of
//! `app/api/assets/route.ts` (`GET`: list, after an optional transcript
//! backfill), `app/api/assets/[hash]/route.ts` (`GET`: the bytes,
//! `DELETE`: the file and its row), `app/api/assets/[hash]/uses/route.ts`
//! (`GET`) and `app/api/local-image/route.ts` (`GET`), over
//! [`claudius_core::asset_list`], [`asset_store`] and [`asset_ingest`].
//!
//! The asset routes only work in a trusted cwd (400 `unknown cwd`), like TS.
//! Bodies are `JSON.stringify` text; a throw in TS (a query on a database
//! without the tables, a fractional `limit`) is Next's empty 500.
//! `GET /api/assets/:hash` answers the row's media type as `Content-Type`
//! (normalized as `Headers` does: leading and trailing tabs, spaces, CR
//! and LF stripped; one with a NUL, CR, LF or a character past Latin-1
//! fails the handler) and its `size_bytes` as `Content-Length`, as given.
//!
//! `local-image` serves an image file from the OS temp roots only:
//! `os.tmpdir()` and `/tmp`, each as spelled and as its real path (taken
//! the way Node's `fs.realpathSync` walks it, once, at the first request).
//! The requested path is `path.resolve`d (so `..` collapses), must sit
//! under one of those roots, is rebased onto that root's real path, and is
//! checked again right above each fs call: before `realpath`, after it
//! (a symlink in tmp pointing out is refused), then `stat` (a file of at
//! most 10 MiB) and the read. The type comes from the extension alone.

use axum::Router;
use axum::extract::{Path, RawQuery};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use claudius_agent::js;
use claudius_core::asset_list;
use claudius_core::node_fs::FsError;
use claudius_core::node_path::{is_absolute, resolve};
use claudius_core::{asset_ingest, asset_store, log, trusted_cwd};
use serde_json::{Value, json};

use crate::AppState;
use crate::body::thrown;
use crate::session_transcript::search_param;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/assets", get(list))
        .route("/api/assets/{hash}", get(serve).delete(remove))
        .route("/api/assets/{hash}/uses", get(uses))
        .route("/api/local-image", get(local_image))
}

fn json_text(status: StatusCode, body: &Value) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "application/json")],
        js::stringify(body),
    )
        .into_response()
}

fn error(status: StatusCode, msg: &str) -> Response {
    json_text(status, &json!({ "error": msg }))
}

/// A throw in the TS handler: logged, then Next's empty 500.
fn failed(route: &str, e: &dyn std::fmt::Display) -> Response {
    tracing::error!(target: log::API, "[api/{route}] {e}");
    thrown()
}

/// Run a handler's blocking fs / SQLite work off the async runtime.
async fn blocking(f: impl FnOnce() -> Response + Send + 'static) -> Response {
    tokio::task::spawn_blocking(f)
        .await
        .unwrap_or_else(|_| thrown())
}

/// `resolveTrustedCwd(url.searchParams.get("cwd"))`.
fn trusted(query: Option<&str>) -> Option<String> {
    trusted_cwd::resolve_trusted_cwd(search_param(query, "cwd").as_deref())
}

async fn list(RawQuery(query): RawQuery) -> Response {
    blocking(move || list_in(query.as_deref())).await
}

/// `GET /api/assets?scope&type&q&limit&cursor&cwd&backfill`.
pub fn list_in(query: Option<&str>) -> Response {
    let scope = search_param(query, "scope").unwrap_or_else(|| "project".into());
    let kind = search_param(query, "type").unwrap_or_else(|| "all".into());
    let q = search_param(query, "q").unwrap_or_default();
    // `Number(get("limit") ?? "60") || 60`: NaN and ±0 are 60.
    let limit = js::to_number(search_param(query, "limit").as_deref().unwrap_or("60"));
    let limit = if limit.is_nan() || limit == 0.0 {
        60.0
    } else {
        limit
    };
    let cursor = search_param(query, "cursor");
    let Some(cwd) = trusted(query) else {
        return error(StatusCode::BAD_REQUEST, "unknown cwd");
    };
    let backfill = search_param(query, "backfill").as_deref() == Some("1");
    if backfill
        && scope == "project"
        && let Err(e) = asset_ingest::backfill_project(&cwd)
    {
        return failed("assets", &e);
    }
    // `cursor ? Number(cursor) : undefined`.
    let cursor = cursor.filter(|c| !c.is_empty()).map(|c| js::to_number(&c));
    match asset_list::list_assets(&scope, &cwd, &kind, &q, limit, cursor) {
        Ok(page) => json_text(StatusCode::OK, &page.to_json()),
        Err(e) => failed("assets", &e),
    }
}

/// A header value as `new Response(…, {headers})` takes it: `None` where
/// the handler throws (a NUL, CR or LF after trimming, a character past
/// Latin-1) or the value can't go on the wire.
fn header_value(v: &str) -> Option<HeaderValue> {
    let http_ws = |c: char| matches!(c, '\t' | '\n' | '\r' | ' ');
    let v = v.trim_matches(http_ws);
    if v.contains(['\0', '\r', '\n']) {
        return None;
    }
    // ByteString: each character one Latin-1 byte, as Node writes it.
    let bytes: Option<Vec<u8>> = v.chars().map(|c| u8::try_from(u32::from(c)).ok()).collect();
    HeaderValue::from_bytes(&bytes?).ok()
}

async fn serve(Path(hash): Path<String>, RawQuery(query): RawQuery) -> Response {
    blocking(move || serve_in(&hash, query.as_deref())).await
}

/// `GET /api/assets/:hash?cwd`: the stored bytes.
pub fn serve_in(hash: &str, query: Option<&str>) -> Response {
    let Some(cwd) = trusted(query) else {
        return error(StatusCode::BAD_REQUEST, "unknown cwd");
    };
    let meta = match asset_list::get_asset_meta(&cwd, hash) {
        Ok(Some(m)) => m,
        Ok(None) => return error(StatusCode::NOT_FOUND, "not found"),
        Err(e) => return failed("assets/[hash]", &e),
    };
    // `readAsset` throws inside its `try` for a non-string media type.
    let buf = meta
        .media_type
        .as_str()
        .and_then(|m| asset_store::read_asset(&cwd, hash, m));
    let Some(buf) = buf else {
        return error(StatusCode::NOT_FOUND, "asset bytes missing on disk");
    };
    let content_type = meta.media_type.as_str().and_then(header_value);
    let length = header_value(&meta.size_bytes.to_js_string());
    let (Some(content_type), Some(length)) = (content_type, length) else {
        return failed("assets/[hash]", &"invalid header value");
    };
    let mut res = Response::new(axum::body::Body::from(buf));
    let h = res.headers_mut();
    h.insert(header::CONTENT_TYPE, content_type);
    h.insert(header::CONTENT_LENGTH, length);
    h.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=31536000, immutable"),
    );
    res
}

async fn remove(Path(hash): Path<String>, RawQuery(query): RawQuery) -> Response {
    blocking(move || remove_in(&hash, query.as_deref())).await
}

/// `DELETE /api/assets/:hash?cwd`: the file (any failure ignored), then the
/// row and its uses.
pub fn remove_in(hash: &str, query: Option<&str>) -> Response {
    let Some(cwd) = trusted(query) else {
        return error(StatusCode::BAD_REQUEST, "unknown cwd");
    };
    let meta = match asset_list::get_asset_meta(&cwd, hash) {
        Ok(Some(m)) => m,
        Ok(None) => return error(StatusCode::NOT_FOUND, "not found"),
        Err(e) => return failed("assets/[hash]", &e),
    };
    if let Some(m) = meta.media_type.as_str() {
        let _ = asset_store::delete_asset(&cwd, hash, m);
    }
    match asset_list::delete_asset_row(&cwd, hash) {
        Ok(_) => json_text(StatusCode::OK, &json!({"ok": true})),
        Err(e) => failed("assets/[hash]", &e),
    }
}

async fn uses(Path(hash): Path<String>, RawQuery(query): RawQuery) -> Response {
    blocking(move || uses_in(&hash, query.as_deref())).await
}

/// `GET /api/assets/:hash/uses?cwd`.
pub fn uses_in(hash: &str, query: Option<&str>) -> Response {
    let Some(cwd) = trusted(query) else {
        return error(StatusCode::BAD_REQUEST, "unknown cwd");
    };
    match asset_list::list_uses(&cwd, hash) {
        Ok(rows) => json_text(
            StatusCode::OK,
            &json!({"uses": rows.iter().map(asset_list::UseRow::to_json).collect::<Vec<_>>()}),
        ),
        Err(e) => failed("assets/[hash]/uses", &e),
    }
}

// ─────────────────────────────────── local-image ─────────────────────────────

/// `MAX_BYTES`.
const MAX_BYTES: u64 = 10 * 1024 * 1024;

/// `IMAGE_MIME[ext]` (a plain object: `constructor` and `__proto__` find
/// `Object.prototype`'s members, which `Headers` prints with `String()`).
fn image_mime(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        "tiff" | "tif" => "image/tiff",
        "constructor" => "function Object() { [native code] }",
        "__proto__" => "[object Object]",
        _ => return None,
    })
}

/// `os.tmpdir()` on posix: `TMPDIR`, `TMP`, then `TEMP` (the first that
/// isn't empty) with one trailing `/` dropped, else `/tmp`.
pub fn os_tmpdir(env: impl Fn(&str) -> Option<String>) -> String {
    let dir = ["TMPDIR", "TMP", "TEMP"]
        .iter()
        .find_map(|k| env(k).filter(|v| !v.is_empty()));
    match dir {
        Some(d) if d.len() > 1 && d.ends_with('/') => d[..d.len() - 1].to_owned(),
        Some(d) => d,
        None => "/tmp".into(),
    }
}

/// Node's JS `fs.realpathSync(p)`: walk the resolved path, `lstat` every
/// component and replace each symlink by its target (checked with `stat`
/// first, so a dangling or looping link fails). Unlike `realpath(3)` it
/// keeps the spelling of the components that aren't links.
pub fn realpath_sync(p: &str) -> Option<String> {
    use std::collections::{HashMap, HashSet};
    #[cfg(unix)]
    use std::os::unix::fs::MetadataExt;
    let mut p = resolve(&[p]);
    let mut known_hard: HashSet<String> = HashSet::new();
    let mut seen: HashMap<(u64, u64), String> = HashMap::new();
    let (mut current, mut pos) = ("/".to_owned(), 1usize);
    while pos < p.len() {
        let previous = current.clone();
        let base = match p[pos..].find('/') {
            None => {
                current.push_str(&p[pos..]);
                let base = format!("{previous}{}", &p[pos..]);
                pos = p.len();
                base
            }
            Some(rel) => {
                let r = pos + rel;
                current.push_str(&p[pos..=r]);
                let base = format!("{previous}{}", &p[pos..r]);
                pos = r + 1;
                base
            }
        };
        if known_hard.contains(&base) {
            continue;
        }
        let meta = std::fs::symlink_metadata(&base).ok()?;
        if !meta.file_type().is_symlink() {
            known_hard.insert(base.clone());
            continue;
        }
        #[cfg(unix)]
        let id = (meta.dev(), meta.ino());
        #[cfg(not(unix))]
        let id = (0, 0);
        let target = match seen.get(&id) {
            Some(t) => t.clone(),
            None => {
                std::fs::metadata(&base).ok()?;
                std::fs::read_link(&base)
                    .ok()?
                    .to_string_lossy()
                    .into_owned()
            }
        };
        let resolved = resolve(&[&previous, &target]);
        seen.insert(id, target);
        p = resolve(&[&resolved, &p[pos..]]);
        current = "/".into();
        pos = 1;
    }
    Some(p)
}

/// `TEMP_ROOTS`: each accepted prefix (as spelled and as its real path)
/// with the real path it is rebased onto, in the `Map`'s insertion order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TempRoots(pub Vec<(String, String)>);

impl TempRoots {
    /// For `[tmpdir, "/tmp"]`.
    pub fn new(tmpdir: &str) -> TempRoots {
        let mut m: Vec<(String, String)> = Vec::new();
        let mut set = |k: String, v: String| match m.iter_mut().find(|(key, _)| *key == k) {
            Some(slot) => slot.1 = v,
            None => m.push((k, v)),
        };
        for raw in [tmpdir, "/tmp"] {
            let spelled = resolve(&[raw]);
            // `realOrSelf`.
            let real = realpath_sync(&spelled).unwrap_or_else(|| resolve(&[&spelled]));
            set(spelled, real.clone());
            set(real.clone(), real);
        }
        TempRoots(m)
    }

    /// The process's roots, taken once.
    pub fn process() -> &'static TempRoots {
        static ROOTS: std::sync::OnceLock<TempRoots> = std::sync::OnceLock::new();
        ROOTS.get_or_init(|| {
            TempRoots::new(&os_tmpdir(|k| {
                std::env::var_os(k).map(|v| v.to_string_lossy().into_owned())
            }))
        })
    }
}

async fn local_image(RawQuery(query): RawQuery) -> Response {
    blocking(move || local_image_in(TempRoots::process(), query.as_deref())).await
}

/// `GET /api/local-image?path=/abs/path.png` against `roots`.
pub fn local_image_in(roots: &TempRoots, query: Option<&str>) -> Response {
    let raw = search_param(query, "path").unwrap_or_default();
    if raw.is_empty() || !is_absolute(&raw) {
        return error(StatusCode::BAD_REQUEST, "absolute path required");
    }
    // `raw.split(".").pop().toLowerCase()`.
    let ext = raw.rsplit('.').next().unwrap_or("").to_lowercase();
    let Some(content_type) = image_mime(&ext) else {
        return error(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "not a supported image type",
        );
    };

    let abs = resolve(&[&raw]);
    let Some((spelled, base)) = roots
        .0
        .iter()
        .find(|(root, _)| abs.starts_with(&format!("{root}/")))
    else {
        return error(StatusCode::FORBIDDEN, "path is outside the temp directory");
    };
    let rel = &abs[spelled.len() + 1..];
    let under = format!("{base}/");

    // Rebased onto the real root; checked right above the fs calls.
    let target = resolve(&[base, rel]);
    if !target.starts_with(&under) {
        return error(StatusCode::FORBIDDEN, "path escapes the temp directory");
    }
    let Ok(real) = std::fs::canonicalize(&target) else {
        return error(StatusCode::NOT_FOUND, "image not found");
    };
    let real = real.to_string_lossy().into_owned();
    if !real.starts_with(&under) {
        return error(StatusCode::FORBIDDEN, "path escapes the temp directory");
    }
    let Ok(stat) = std::fs::metadata(&real) else {
        return error(StatusCode::NOT_FOUND, "image not found");
    };
    if !stat.is_file() {
        return error(StatusCode::NOT_FOUND, "not a file");
    }
    if stat.len() > MAX_BYTES {
        return error(StatusCode::PAYLOAD_TOO_LARGE, "image too large (>10MB)");
    }
    if !real.starts_with(&under) {
        return error(StatusCode::FORBIDDEN, "path escapes the temp directory");
    }
    let buf = match std::fs::read(&real) {
        Ok(b) => b,
        Err(e) => {
            let e = FsError::new(&e, "open", Some(&real), None);
            return json_text(
                StatusCode::INTERNAL_SERVER_ERROR,
                &json!({ "error": e.message }),
            );
        }
    };
    let mut res = Response::new(axum::body::Body::from(buf));
    let h = res.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    h.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=10"),
    );
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tmpdir_like_node() {
        let env = |pairs: &'static [(&'static str, &'static str)]| {
            move |k: &str| {
                pairs
                    .iter()
                    .find(|(n, _)| *n == k)
                    .map(|(_, v)| (*v).to_owned())
            }
        };
        assert_eq!(os_tmpdir(env(&[("TMPDIR", "/a/b/")])), "/a/b");
        assert_eq!(os_tmpdir(env(&[("TMPDIR", "/a/b//")])), "/a/b/");
        assert_eq!(os_tmpdir(env(&[("TMPDIR", ""), ("TMP", "/x/")])), "/x");
        assert_eq!(os_tmpdir(env(&[("TEMP", "/z"), ("TMP", "/w")])), "/w");
        assert_eq!(os_tmpdir(env(&[("TMPDIR", "//")])), "/");
        assert_eq!(os_tmpdir(env(&[])), "/tmp");
    }

    #[test]
    fn header_values_like_headers() {
        assert_eq!(header_value(" image/png\t\n").unwrap(), "image/png");
        assert!(header_value("a\nb").is_none());
        assert!(header_value("\u{0100}").is_none());
        assert_eq!(header_value("\u{e9}").unwrap().as_bytes(), [0xe9]);
    }
}
