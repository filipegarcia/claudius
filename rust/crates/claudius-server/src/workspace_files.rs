//! `GET/PUT/POST/DELETE/PATCH /api/workspaces/:id/files`: the port of
//! `app/api/workspaces/[id]/files/route.ts` (D03), the Files browser's and
//! the /git FileEditor's file API, over [`claudius_core::workspace_files`]
//! and [`claudius_core::text_encoding`].
//!
//! The id is a workspace (`workspaces.json`) or a customization (`cust_…`,
//! its `src` mirror); `?root=` picks one of the workspace's roots
//! (`primary`, the default, or `extra:<n>`, as `listWorkspaceRoots` numbers
//! them; a customization only has `primary`). An unknown one is 404 `unknown
//! root` (`workspace not found` without a `root`); a store that can't be
//! read throws (Next's empty 500). `?base=git` (GET and PUT) swaps the root
//! for its git work tree's top level. `?path=` is normalized, its leading
//! slashes dropped, and resolved under the root; one that isn't inside
//! (`..`, or a first segment starting with `..`) is 400.
//!
//! * GET: a file's text as `{rootId, rootPath, relPath, kind: "file",
//!   content, sizeBytes, modifiedMs, encoding, encodingLabel, editable,
//!   readOnlyReason?}` (413 over 2 MiB), or with `serve=1` its bytes for an
//!   image extension (415 otherwise, 413 over 10 MiB); a folder's listing
//!   `{…, entries, hiddenCount}` (403 when it can't be read), `search=`
//!   (the files whose path holds it, `{…, entries, truncated}`) or
//!   `contentSearch=` (`case=1` for case-sensitive; `{…, matches,
//!   truncated, scanned}`); a search whose own folder can't be read is
//!   403 / 500 `Search failed: …`, not an empty result (CC 2.1.301).
//!   404 `path not found`; 400 for anything else. A known binary
//!   extension ([`claudius_core::file_types`]), and anything that
//!   NUL-sniffs as binary, answers `{… content: "", binary: true …}` with
//!   no bytes read — the known extension before the 2 MiB cap.
//! * PUT (the body is the text, which must be UTF-8): writes the file in
//!   its existing encoding (415 for one that can't round-trip), creating
//!   the folders above it. POST `?kind=file|dir` creates (409 when
//!   something is there), DELETE removes (recursively; 404 `not found`),
//!   PATCH `?newPath=` renames (409 over an existing entry). Each answers
//!   `{ok: true}`, or 500 with Node's error message. The root itself is
//!   400.
//!
//! Every fs call has its containment check inline right above it (the TS
//! `relative`-based one, and `startsWith(root + "/")`). Symlinks are
//! followed wherever TS follows them (PORT_PLAN "Mirrored TS bugs", T08a).
//! Deliberate difference: a customization id whose `..` climbs out of the
//! customizations folder (`cust_x%2F..%2F..%2Fy`) resolves nowhere (TS
//! reads and writes under `~/.claude/.claudius/y/src`). Bodies are
//! `JSON.stringify` text (a content-search snippet cut through a surrogate
//! pair keeps the lone half as its escape). Replayed by
//! `tests/workspace_files.rs` against `rust/scripts/workspace-files-golden.mjs`.

use std::path::Path as FsPath;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use claudius_agent::js;
use claudius_core::text_encoding::{self, Detected, Editable};
use claudius_core::workspace_files::{
    image_mime, inside, list_dir, matches_json, rel_path, search_contents, search_files, under,
};
use claudius_core::{
    customizations, file_types, fs_list, git, js_string, log, node_fs, node_path, workspace_roots,
    workspaces,
};
use serde_json::{Value, json};

use crate::AppState;
use crate::body::thrown;
use crate::session_transcript::search_param;

pub fn router() -> Router<AppState> {
    Router::new().route(
        "/api/workspaces/{id}/files",
        get(get_files)
            .put(put_file)
            .post(post_file)
            .delete(delete_file)
            .patch(patch_file),
    )
}

/// The largest file GET returns as text, and as an image.
const MAX_EDIT_BYTES: u64 = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES: u64 = 10 * 1024 * 1024;

/// PUT's refusal for a file it can't write back losslessly.
const UNSUPPORTED_ENCODING_SAVE_ERROR: &str = "This file isn't UTF-8 or UTF-16LE text, so Claudius won't save it (that would convert it to UTF-8)";

const ESCAPES: &str = "path escapes workspace root";
const ESCAPES_OR_ROOT: &str = "path escapes workspace root or is root itself";

fn json_text(status: StatusCode, body: &Value) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "application/json")],
        js::stringify(body),
    )
        .into_response()
}

fn error(status: StatusCode, msg: &str) -> Response {
    json_text(status, &json!({"error": msg}))
}

/// `500 {error: err.message}`.
fn fs_error(message: &str) -> Response {
    error(StatusCode::INTERNAL_SERVER_ERROR, message)
}

fn ok() -> Response {
    json_text(StatusCode::OK, &json!({"ok": true}))
}

/// A store read that throws in TS: logged, then Next's empty 500.
fn threw(e: &anyhow::Error) -> Response {
    tracing::error!(target: log::API, "[api/workspaces/files] {e}");
    thrown()
}

async fn blocking(f: impl FnOnce() -> Response + Send + 'static) -> Response {
    tokio::task::spawn_blocking(f)
        .await
        .unwrap_or_else(|_| thrown())
}

/// Node's `ERR_INVALID_ARG_VALUE` for a path argument holding a NUL, which
/// the fs call throws before touching the disk.
fn nul_arg(arg: &str, path: &str) -> Option<Response> {
    path.contains('\0').then(|| {
        fs_error(&format!(
            "The argument '{arg}' must be a string, Uint8Array, or URL without null bytes. Received {}",
            git::node_inspect_string(path)
        ))
    })
}

/// A resolved `?root=`: its id and absolute path.
struct Root {
    id: String,
    abs: String,
}

/// `resolveWorkspaceRoot(id, rootSel)` (an empty selector is `primary`):
/// `Ok(None)` is its `null`, `Err` what it throws. A customization counts
/// when `getCustomization` finds it (a failed read is not found).
fn resolve_root(id: &str, selector: Option<&str>) -> anyhow::Result<Option<Root>> {
    let want = selector.filter(|s| !s.is_empty()).unwrap_or("primary");
    if id.starts_with("cust_") {
        if !matches!(customizations::get_customization(id), Ok(Some(_))) || want != "primary" {
            return Ok(None);
        }
        let abs = node_path::resolve(&[&customizations::customization_src_dir(id)]);
        // A deliberate difference: `path.join` lets a `..` in the id climb
        // out of the customizations folder; that mirror is nowhere here.
        let mirrors = node_path::resolve(&[&customizations::customizations_root()]);
        if !abs.starts_with(&format!("{mirrors}/")) {
            return Ok(None);
        }
        return Ok(Some(Root {
            id: "primary".into(),
            abs,
        }));
    }
    let Some(ws) = workspaces::get_raw(id)? else {
        return Ok(None);
    };
    Ok(workspace_roots::list_workspace_roots(&ws)?
        .into_iter()
        .find(|r| r.id == want)
        .map(|r| Root {
            id: want.to_owned(),
            abs: r.abs_path,
        }))
}

/// The 404 for an unresolved root: `rootSel ? "unknown root" : "workspace
/// not found"`.
fn not_resolved(selector: Option<&str>) -> Response {
    let msg = if selector.is_some_and(|s| !s.is_empty()) {
        "unknown root"
    } else {
        "workspace not found"
    };
    error(StatusCode::NOT_FOUND, msg)
}

/// `resolveBase(wsRoot, baseSel)`: with `git`, the work tree's top level
/// (`path.resolve`d) when there is one.
async fn resolve_base(ws_root: String, base: Option<&str>) -> String {
    if base != Some("git") {
        return ws_root;
    }
    match git::get_repo_root(&ws_root).await {
        Some(top) => node_path::resolve(&[&top]),
        None => ws_root,
    }
}

/// `resolveBoundedTarget(id, rootSel, rawPath, baseSel)`: `(root, target)`
/// for a path strictly under the root, or the refusal.
async fn bounded_target(
    id: &str,
    selector: Option<&str>,
    raw_path: &str,
    base: Option<&str>,
) -> Result<(String, String), Box<Response>> {
    let resolved = match resolve_root(id, selector) {
        Ok(Some(r)) => r,
        Ok(None) => return Err(Box::new(not_resolved(selector))),
        Err(e) => return Err(Box::new(threw(&e))),
    };
    if raw_path.is_empty() {
        return Err(Box::new(error(StatusCode::BAD_REQUEST, "path required")));
    }
    let root = resolve_base(resolved.abs, base).await;
    let rel = rel_path(raw_path);
    if rel == ".." || rel.starts_with("../") {
        return Err(Box::new(error(StatusCode::BAD_REQUEST, ESCAPES)));
    }
    let target = node_path::resolve(&[&root, &rel]);
    if !inside(&root, &target) || target == root {
        return Err(Box::new(error(StatusCode::BAD_REQUEST, ESCAPES_OR_ROOT)));
    }
    Ok((root, target))
}

// ---- GET ------------------------------------------------------------------------

/// GET's query, read as `searchParams.get` reads it.
struct GetQuery {
    raw_path: String,
    serve: bool,
    /// `search`, trimmed and lowercased.
    search: String,
    content_search: String,
    case_sensitive: bool,
}

async fn get_files(Path(id): Path<String>, RawQuery(query): RawQuery) -> Response {
    let q = query.as_deref();
    let selector = search_param(q, "root");
    let resolved = match resolve_root(&id, selector.as_deref()) {
        Ok(Some(r)) => r,
        Ok(None) => return not_resolved(selector.as_deref()),
        Err(e) => return threw(&e),
    };
    let root = resolve_base(resolved.abs, search_param(q, "base").as_deref()).await;
    let query = GetQuery {
        raw_path: search_param(q, "path").unwrap_or_default(),
        serve: search_param(q, "serve").as_deref() == Some("1"),
        search: js_string::to_lower(js::trim(&search_param(q, "search").unwrap_or_default())),
        content_search: search_param(q, "contentSearch").unwrap_or_default(),
        case_sensitive: search_param(q, "case").as_deref() == Some("1"),
    };
    let root_id = resolved.id;
    blocking(move || get_in(&root_id, &root, &query)).await
}

/// CC 2.1.301 — a binary file's answer: no content and `binary: true`, so
/// the viewers show a placeholder instead of a garbled lossy decode. Built
/// from `stat` alone, so no bytes are read.
fn binary_payload(root_id: &str, root: &str, rel: &str, meta: &std::fs::Metadata) -> Response {
    json_text(
        StatusCode::OK,
        &json!({
            "rootId": root_id,
            "rootPath": root,
            "relPath": rel,
            "kind": "file",
            "content": "",
            "binary": true,
            "sizeBytes": meta.len() as f64,
            "modifiedMs": meta.modified().map(node_fs::mtime_ms).unwrap_or(f64::NAN),
            "encoding": "unsupported",
            "encodingLabel": "binary",
            "editable": false,
            "readOnlyReason": "Binary file — not shown as text.",
        }),
    )
}

fn get_in(root_id: &str, root: &str, q: &GetQuery) -> Response {
    let target = node_path::resolve(&[root, &rel_path(&q.raw_path)]);
    if !inside(root, &target) {
        return error(StatusCode::BAD_REQUEST, ESCAPES);
    }
    // Inline at the stat / read / readdir sinks below.
    if target != root && !target.starts_with(&under(root)) {
        return error(StatusCode::BAD_REQUEST, ESCAPES);
    }
    let Ok(meta) = std::fs::metadata(&target) else {
        return error(StatusCode::NOT_FOUND, "path not found");
    };
    let rel = node_path::relative(root, &target);
    if meta.is_file() {
        if q.serve {
            return serve_image(&target, &meta);
        }
        // A known binary extension is answered before the size cap, so a
        // large .parquet / .zip gets the placeholder rather than "file too
        // large". (`?serve=1` images returned above; their extensions
        // aren't in `BINARY_EXTS` anyway.)
        if file_types::is_known_binary_path(&target) {
            return binary_payload(root_id, root, &rel, &meta);
        }
        if meta.len() > MAX_EDIT_BYTES {
            return error(
                StatusCode::PAYLOAD_TOO_LARGE,
                "file too large to edit (>2MB)",
            );
        }
        let bytes = match node_fs::sys::read_file(FsPath::new(&target)) {
            Ok(b) => b,
            Err(e) => return fs_error(&e.message),
        };
        let detected = text_encoding::detect(&bytes);
        // An unknown extension that NUL-sniffs as binary gets the same
        // placeholder as a known binary extension (above).
        if detected == Detected::Unsupported(text_encoding::Guess::Binary) {
            return binary_payload(root_id, root, &rel, &meta);
        }
        let mut out = json!({
            "rootId": root_id,
            "rootPath": root,
            "relPath": rel,
            "kind": "file",
            "content": text_encoding::content(&bytes, detected),
            "sizeBytes": meta.len() as f64,
            "modifiedMs": meta.modified().map(node_fs::mtime_ms).unwrap_or(f64::NAN),
            "encoding": detected.encoding(),
            "encodingLabel": detected.label(),
            "editable": matches!(detected, Detected::Editable(_)),
        });
        if let Detected::Unsupported(guess) = detected {
            out["readOnlyReason"] = json!(guess.reason());
        }
        return json_text(StatusCode::OK, &out);
    }
    if !meta.is_dir() {
        return error(StatusCode::BAD_REQUEST, "path is not a directory");
    }
    if !q.search.is_empty() {
        let (entries, truncated) = match search_files(root, &target, &q.search) {
            Ok(found) => found,
            Err(e) => return crate::fs_routes::search_failed(&e, &target),
        };
        return json_text(
            StatusCode::OK,
            &json!({
                "rootId": root_id,
                "rootPath": root,
                "relPath": rel,
                "entries": entries,
                "truncated": truncated,
            }),
        );
    }
    if !js::trim(&q.content_search).is_empty() {
        let (matches, truncated, scanned) =
            match search_contents(root, &target, &q.content_search, q.case_sensitive) {
                Ok(found) => found,
                Err(e) => return crate::fs_routes::search_failed(&e, &target),
            };
        // `{rootId, rootPath, relPath, matches, truncated, scanned}`, the
        // snippets written from their UTF-16 units.
        let head = js::stringify(&json!({"rootId": root_id, "rootPath": root, "relPath": rel}));
        let body = format!(
            "{},\"matches\":{},\"truncated\":{truncated},\"scanned\":{scanned}}}",
            &head[..head.len() - 1],
            matches_json(&matches),
        );
        return (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "application/json")],
            body,
        )
            .into_response();
    }
    match list_dir(root, &target) {
        Ok((entries, hidden_count)) => json_text(
            StatusCode::OK,
            &json!({
                "rootId": root_id,
                "rootPath": root,
                "relPath": rel,
                "entries": entries,
                "hiddenCount": hidden_count,
            }),
        ),
        Err(e) => match fs_list::error_code(&e) {
            Some(code @ ("EACCES" | "EPERM")) => error(
                StatusCode::FORBIDDEN,
                &format!("Permission denied — can't read this folder ({code})"),
            ),
            _ => fs_error(
                &node_fs::uv_exception(&e, "scandir", Some(FsPath::new(&target)), None).message,
            ),
        },
    }
}

/// `?serve=1`: an image's bytes with its type, cached for a minute.
fn serve_image(target: &str, meta: &std::fs::Metadata) -> Response {
    let Some(mime) = image_mime(target) else {
        return error(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "not a supported image type",
        );
    };
    if meta.len() > MAX_IMAGE_BYTES {
        return error(StatusCode::PAYLOAD_TOO_LARGE, "image too large (>10MB)");
    }
    match node_fs::sys::read_file(FsPath::new(target)) {
        Ok(bytes) => (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, mime),
                (header::CACHE_CONTROL, "private, max-age=60"),
            ],
            bytes,
        )
            .into_response(),
        Err(e) => fs_error(&e.message),
    }
}

// ---- PUT / POST / DELETE / PATCH -----------------------------------------------------

async fn put_file(Path(id): Path<String>, RawQuery(query): RawQuery, body: Bytes) -> Response {
    let q = query.as_deref();
    let (root, target) = match bounded_target(
        &id,
        search_param(q, "root").as_deref(),
        &search_param(q, "path").unwrap_or_default(),
        search_param(q, "base").as_deref(),
    )
    .await
    {
        Ok(t) => t,
        Err(r) => return *r,
    };
    // A fatal decode that keeps a leading U+FEFF (`ignoreBOM: true`).
    let Ok(text) = String::from_utf8(body.to_vec()) else {
        return error(StatusCode::BAD_REQUEST, "request body isn't valid UTF-8");
    };
    blocking(move || put_in(&root, &target, &text)).await
}

fn put_in(root: &str, target: &str, text: &str) -> Response {
    let exists = match std::fs::metadata(target) {
        Ok(m) if m.is_dir() => {
            return error(StatusCode::BAD_REQUEST, "target is a directory");
        }
        Ok(_) => true,
        Err(_) => false,
    };
    // The TS guard, inline above the read / mkdir / write sinks (a `/` root
    // fails it: nothing starts with `//`).
    let base = node_path::resolve(&[root]);
    let dest = node_path::resolve(&[&base, target]);
    if !dest.starts_with(&format!("{base}/")) {
        return error(StatusCode::FORBIDDEN, ESCAPES);
    }
    let mut encoding = Editable::Utf8;
    if exists {
        match node_fs::sys::read_file(FsPath::new(&dest)) {
            Ok(existing) => match text_encoding::detect(&existing) {
                Detected::Editable(e) => encoding = e,
                Detected::Unsupported(_) => {
                    return error(
                        StatusCode::UNSUPPORTED_MEDIA_TYPE,
                        UNSUPPORTED_ENCODING_SAVE_ERROR,
                    );
                }
            },
            // Raced with a delete: a new file.
            Err(e) if e.code == "ENOENT" => {}
            Err(e) => return fs_error(&e.message),
        }
    }
    let parent = node_path::resolve(&[&dest, ".."]);
    if let Some(r) = nul_arg("path", &parent) {
        return r;
    }
    if parent != base && !parent.starts_with(&format!("{base}/")) {
        return error(StatusCode::FORBIDDEN, ESCAPES);
    }
    if let Err(e) = node_fs::sys::mkdir_recursive(FsPath::new(&parent)) {
        return fs_error(&e.message);
    }
    if let Some(r) = nul_arg("path", &dest) {
        return r;
    }
    match node_fs::sys::write_file(
        FsPath::new(&dest),
        &text_encoding::encode_text(&text.encode_utf16().collect::<Vec<u16>>(), encoding),
    ) {
        Ok(()) => ok(),
        Err(e) => fs_error(&e.message),
    }
}

async fn post_file(Path(id): Path<String>, RawQuery(query): RawQuery) -> Response {
    let q = query.as_deref();
    let dir = match search_param(q, "kind").as_deref() {
        Some("file") => false,
        Some("dir") => true,
        _ => return error(StatusCode::BAD_REQUEST, "kind must be file or dir"),
    };
    let (root, target) = match bounded_target(
        &id,
        search_param(q, "root").as_deref(),
        &search_param(q, "path").unwrap_or_default(),
        None,
    )
    .await
    {
        Ok(t) => t,
        Err(r) => return *r,
    };
    blocking(move || post_in(&root, &target, dir)).await
}

fn post_in(root: &str, target: &str, dir: bool) -> Response {
    // Inline at the stat / mkdir / open sinks.
    if !target.starts_with(&under(root)) {
        return error(StatusCode::BAD_REQUEST, ESCAPES_OR_ROOT);
    }
    if std::fs::metadata(target).is_ok() {
        return error(StatusCode::CONFLICT, "already exists");
    }
    if dir {
        if let Some(r) = nul_arg("path", target) {
            return r;
        }
        return match std::fs::create_dir(target) {
            Ok(()) => ok(),
            Err(e) => fs_error(
                &node_fs::uv_exception(&e, "mkdir", Some(FsPath::new(target)), None).message,
            ),
        };
    }
    let parent = node_path::resolve(&[target, ".."]);
    if let Some(r) = nul_arg("path", &parent) {
        return r;
    }
    if let Err(e) = node_fs::sys::mkdir_recursive(FsPath::new(&parent)) {
        return fs_error(&e.message);
    }
    if let Some(r) = nul_arg("path", target) {
        return r;
    }
    // `writeFile(target, "", {flag: "wx"})`.
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target)
    {
        Ok(_) => ok(),
        Err(e) => {
            fs_error(&node_fs::uv_exception(&e, "open", Some(FsPath::new(target)), None).message)
        }
    }
}

async fn delete_file(Path(id): Path<String>, RawQuery(query): RawQuery) -> Response {
    let q = query.as_deref();
    let (root, target) = match bounded_target(
        &id,
        search_param(q, "root").as_deref(),
        &search_param(q, "path").unwrap_or_default(),
        None,
    )
    .await
    {
        Ok(t) => t,
        Err(r) => return *r,
    };
    blocking(move || delete_in(&root, &target)).await
}

fn delete_in(root: &str, target: &str) -> Response {
    if let Some(r) = nul_arg("path", target) {
        return r;
    }
    // Inline at the rm sink.
    if !target.starts_with(&under(root)) {
        return error(StatusCode::BAD_REQUEST, ESCAPES_OR_ROOT);
    }
    match node_fs::rm_recursive(target, false) {
        Ok(()) => ok(),
        Err(e) if e.is_not_found() => error(StatusCode::NOT_FOUND, "not found"),
        Err(e) => fs_error(&e.message),
    }
}

async fn patch_file(Path(id): Path<String>, RawQuery(query): RawQuery) -> Response {
    let q = query.as_deref();
    let selector = search_param(q, "root");
    let src = match bounded_target(
        &id,
        selector.as_deref(),
        &search_param(q, "path").unwrap_or_default(),
        None,
    )
    .await
    {
        Ok(t) => t,
        Err(r) => return *r,
    };
    let dst = match bounded_target(
        &id,
        selector.as_deref(),
        &search_param(q, "newPath").unwrap_or_default(),
        None,
    )
    .await
    {
        Ok(t) => t,
        Err(r) => return *r,
    };
    blocking(move || patch_in(&src, &dst)).await
}

fn patch_in((src_root, src): &(String, String), (dst_root, dst): &(String, String)) -> Response {
    // Inline at the stat / mkdir / rename sinks.
    if !src.starts_with(&under(src_root)) || !dst.starts_with(&under(dst_root)) {
        return error(StatusCode::BAD_REQUEST, ESCAPES_OR_ROOT);
    }
    if std::fs::metadata(dst).is_ok() {
        return error(StatusCode::CONFLICT, "destination already exists");
    }
    let parent = node_path::resolve(&[dst, ".."]);
    if let Some(r) = nul_arg("path", &parent) {
        return r;
    }
    if let Err(e) = node_fs::sys::mkdir_recursive(FsPath::new(&parent)) {
        return fs_error(&e.message);
    }
    if let Some(r) = nul_arg("oldPath", src).or_else(|| nul_arg("newPath", dst)) {
        return r;
    }
    match node_fs::sys::rename(FsPath::new(src), FsPath::new(dst)) {
        Ok(()) => ok(),
        Err(e) => fs_error(&e.message),
    }
}
