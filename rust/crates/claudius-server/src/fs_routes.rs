//! `GET/POST /api/fs/dirs` and `GET /api/fs/list`: ports of
//! `app/api/fs/dirs/route.ts` (the workspace form's directory picker: list a
//! folder's subfolders, create one) and `app/api/fs/list/route.ts` (the
//! composer's `@`-mention candidates, [`claudius_core::fs_list`]).
//!
//! `fs/dirs` is confined to [`fs_root`] (`$CLAUDIUS_FS_ROOT`, else the home
//! dir). Like the TS, containment is lexical: the requested path is
//! `path.resolve`d (so `..` collapses) and must be the root or start with
//! `<root>/`, checked again right above every fs call. A symlink inside the
//! root is followed by `stat` / `readdir`, so it can list (and create in) a
//! folder outside the root, exactly as the TS does. On macOS a TCC folder
//! answers `needsAck` until the request carries `ack=1`, and `~/Library`'s
//! container folders are refused and never listed
//! ([`claudius_core::tcc_protected`], relative to the root).
//!
//! `fs/list` only walks a trusted cwd ([`trusted_cwd::resolve_trusted_cwd`]).
//! A cwd it can't read fails the search instead of answering an empty list
//! (CC 2.1.301): 403 for `EACCES` / `EPERM`, else 500, both worded
//! `Search failed: …` so the `@`-picker never shows it as "no matches"
//! ([`search_failed`]). An unreadable folder deeper in is still skipped.
//!
//! Errors keep the TS wording and statuses. Where the TS handler throws (a
//! non-string `parent` / `name`, a `null` body, a `readdir` error other than
//! `EACCES`, a `mkdir` error other than `EEXIST` / `EACCES` / `EPERM`) the
//! answer is Next's empty 500.

use axum::Router;
use axum::body::Bytes;
use axum::extract::RawQuery;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use claudius_agent::js;
use claudius_core::fs_list::{self, DirentKind, error_code};
use claudius_core::node_path::{dirname, is_absolute, join, relative, resolve};
use claudius_core::tcc_protected::{categorize_tcc_path, is_hidden_home_subpath, platform};
use claudius_core::{log, node_err, paths, trusted_cwd};
use serde_json::{Value, json};

use crate::AppState;
use crate::body::{JsonBody, js_member, thrown};
use crate::session_transcript::search_param;
use crate::tri;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/fs/dirs", get(dirs_get).post(dirs_post))
        .route("/api/fs/list", get(list_get))
}

/// `HIDDEN`: never offered by the picker (dot-names aren't either).
const HIDDEN: [&str; 9] = [
    "node_modules",
    ".git",
    ".next",
    "dist",
    "build",
    ".turbo",
    ".cache",
    "coverage",
    ".DS_Store",
];

/// `FS_ROOT`: `resolve(process.env.CLAUDIUS_FS_ROOT?.trim() || homedir())`,
/// taken once (at module load in TS, at the first request here).
pub fn fs_root() -> &'static str {
    static ROOT: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    ROOT.get_or_init(|| {
        let env = std::env::var_os("CLAUDIUS_FS_ROOT").map(|v| v.to_string_lossy().into_owned());
        let trimmed = env.as_deref().map(js::trim).unwrap_or_default();
        if trimmed.is_empty() {
            resolve(&[&paths::home_dir().to_string_lossy()])
        } else {
            resolve(&[trimmed])
        }
    })
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

/// Run a handler's blocking fs work off the async runtime.
async fn blocking(f: impl FnOnce() -> Response + Send + 'static) -> Response {
    tokio::task::spawn_blocking(f)
        .await
        .unwrap_or_else(|_| thrown())
}

async fn dirs_get(RawQuery(query): RawQuery) -> Response {
    blocking(move || dirs_get_in(fs_root(), platform(), query.as_deref())).await
}

async fn dirs_post(body: Bytes) -> Response {
    blocking(move || dirs_post_in(fs_root(), &body)).await
}

/// `GET /api/fs/dirs?path=…&ack=1` under `root` (`FS_ROOT`) as
/// `process.platform` would run it.
pub fn dirs_get_in(root: &str, platform: &str, query: Option<&str>) -> Response {
    let under = format!("{root}/");
    let requested = search_param(query, "path").unwrap_or_else(|| root.to_owned());
    let ack = search_param(query, "ack").as_deref() == Some("1");
    let path = if is_absolute(&requested) {
        resolve(&[&requested])
    } else {
        resolve(&[root, &requested])
    };

    if path != root && !path.starts_with(&under) {
        return error(StatusCode::FORBIDDEN, "path outside allowed root");
    }
    // `~/Library/Containers` and `~/Library/Group Containers` (relative to
    // the root): refused outright, whatever `ack` says.
    if path != root
        && path.starts_with(&under)
        && is_hidden_home_subpath(&relative(root, &path), platform)
    {
        return error(StatusCode::FORBIDDEN, "path is in a hidden system folder");
    }
    // The TCC gate: no stat until the picker has shown its own heads-up.
    if let Some(category) = categorize_tcc_path(&path, root, platform)
        && !ack
    {
        return json_text(
            StatusCode::OK,
            &json!({ "needsAck": true, "category": category, "path": path }),
        );
    }

    // Containment again, inline at the stat / readdir sinks.
    if path != root && !path.starts_with(&under) {
        return error(StatusCode::FORBIDDEN, "path outside allowed root");
    }
    let Ok(meta) = std::fs::metadata(&path) else {
        return error(StatusCode::NOT_FOUND, "path does not exist");
    };
    if !meta.is_dir() {
        return error(StatusCode::BAD_REQUEST, "path is not a directory");
    }
    let dirents = match fs_list::read_dir(&path) {
        Ok(d) => d,
        Err(e) if error_code(&e) == Some("EACCES") => {
            return error(StatusCode::FORBIDDEN, "permission denied");
        }
        Err(e) => {
            tracing::error!(target: log::API, "[api/fs/dirs] readdir {path}: {e}");
            return thrown();
        }
    };

    let mut entries: Vec<(String, String, bool)> = Vec::new();
    for ent in dirents {
        if HIDDEN.contains(&ent.name.as_str()) || ent.name.starts_with('.') {
            continue;
        }
        if ent.kind != DirentKind::Dir {
            continue;
        }
        let child = join(&[&path, &ent.name]);
        if is_hidden_home_subpath(&relative(root, &child), platform) {
            continue;
        }
        // Tagged, never stat'ed: listing the parent didn't touch it.
        let protected = categorize_tcc_path(&child, root, platform).is_some();
        entries.push((ent.name, child, protected));
    }
    // `a.name.localeCompare(b.name)`, stable (ties keep readdir order).
    entries.sort_by(|a, b| claudius_core::collate::locale_compare(&a.0, &b.0));
    let entries: Vec<Value> = entries
        .into_iter()
        .map(|(name, child, protected)| {
            let mut e = json!({ "name": name, "path": child });
            if protected {
                e["protected"] = json!(true);
            }
            e
        })
        .collect();

    let parent = dirname(&path);
    // No up-link at the filesystem root or at the allowed root.
    let parent = if parent == path || path == root {
        Value::Null
    } else {
        json!(parent)
    };
    json_text(
        StatusCode::OK,
        &json!({ "path": path, "parent": parent, "entries": entries, "home": root }),
    )
}

/// `POST /api/fs/dirs` `{ parent, name }` under `root` (`FS_ROOT`).
pub fn dirs_post_in(root: &str, bytes: &[u8]) -> Response {
    let under = format!("{root}/");
    // `try { await req.json() } catch { 400 }`. A number past f64 (`1e400`,
    // Infinity in JS) reads as the stand-in `0`: like Infinity, a number,
    // which only matters as a non-string `parent` / `name` (both throw).
    let Ok(parsed) = JsonBody::parse_or_message(bytes) else {
        return error(StatusCode::BAD_REQUEST, "invalid JSON");
    };
    let b = JsonBody::lenient_overflow(bytes, parsed, &json!(0));

    // `body.parent ?? FS_ROOT`, then `isAbsolute`, which throws on a
    // non-string (and `body.parent` itself on a `null` body).
    let raw_parent = match tri!(js_member(&b, "parent")) {
        None | Some(Value::Null) => root.to_owned(),
        Some(Value::String(s)) => s.clone(),
        Some(_) => return thrown(),
    };
    let parent = if is_absolute(&raw_parent) {
        resolve(&[&raw_parent])
    } else {
        resolve(&[root, &raw_parent])
    };
    if parent != root && !parent.starts_with(&under) {
        return error(StatusCode::FORBIDDEN, "parent outside allowed root");
    }
    // `(body.name ?? "").trim()`: a non-string has no `trim`.
    let name = match tri!(js_member(&b, "name")) {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => js::trim(s).to_owned(),
        Some(_) => return thrown(),
    };
    if name.is_empty() {
        return error(StatusCode::BAD_REQUEST, "name is required");
    }
    if name.contains('/')
        || name.contains('\\')
        || name.contains('\0')
        || name == "."
        || name == ".."
    {
        return error(StatusCode::BAD_REQUEST, "invalid folder name");
    }

    // Inline at the stat sink: the TS `relative` form. Inside the root it
    // only fires for a parent whose first segment starts with `..`
    // (`<root>/..foo`), which TS refuses too.
    let rel = relative(root, &parent);
    if rel.starts_with("..") || rel == ".." {
        return error(StatusCode::FORBIDDEN, "parent outside allowed root");
    }
    match std::fs::metadata(&parent) {
        Ok(m) if !m.is_dir() => {
            return error(StatusCode::BAD_REQUEST, "parent is not a directory");
        }
        Ok(_) => {}
        Err(_) => return error(StatusCode::NOT_FOUND, "parent does not exist"),
    }

    // Inline at the mkdir sink. With `name` a plain basename this only
    // fires when the root is `/` (nothing starts with `//`).
    let target = resolve(&[&parent, &name]);
    if !target.starts_with(&under) {
        return error(StatusCode::FORBIDDEN, "path outside allowed root");
    }
    match std::fs::create_dir(&target) {
        Ok(()) => json_text(StatusCode::OK, &json!({ "path": target })),
        Err(e) => match error_code(&e) {
            Some("EEXIST") => error(StatusCode::CONFLICT, "folder already exists"),
            Some("EACCES" | "EPERM") => error(StatusCode::FORBIDDEN, "permission denied"),
            _ => {
                tracing::error!(target: log::API, "[api/fs/dirs] mkdir {target}: {e}");
                thrown()
            }
        },
    }
}

async fn list_get(RawQuery(query): RawQuery) -> Response {
    blocking(move || {
        let query = query.as_deref();
        let Some(cwd) = trusted_cwd::resolve_trusted_cwd(search_param(query, "cwd").as_deref())
        else {
            return error(StatusCode::BAD_REQUEST, "unknown cwd");
        };
        let q = search_param(query, "q").unwrap_or_default();
        // `Number(get("limit") ?? "200") || 200`: NaN and ±0 are 200.
        let limit = js::to_number(search_param(query, "limit").as_deref().unwrap_or("200"));
        let limit = if limit.is_nan() || limit == 0.0 {
            200.0
        } else {
            limit
        };
        let entries: Vec<Value> = match fs_list::list_fs(&cwd, &q, limit) {
            Ok(entries) => entries.iter().map(fs_list::FsEntry::to_json).collect(),
            // The walk only fails on the root it was handed, so the path the
            // error names is the resolved cwd.
            Err(e) => return search_failed(&e, &resolve(&[&cwd])),
        };
        json_text(StatusCode::OK, &json!({ "cwd": cwd, "entries": entries }))
    })
    .await
}

/// CC 2.1.301 — the folder the search starts from couldn't be read: 403
/// `Search failed: permission denied — can't read this folder (<code>)`
/// for `EACCES` / `EPERM`, else 500 with Node's `readdir` message. Shared
/// with the files route's own `searchFailed` ([`crate::workspace_files`]).
pub fn search_failed(e: &std::io::Error, path: &str) -> Response {
    match error_code(e) {
        Some(code @ ("EACCES" | "EPERM")) => error(
            StatusCode::FORBIDDEN,
            &format!("Search failed: permission denied — can't read this folder ({code})"),
        ),
        _ => error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!(
                "Search failed: {}",
                node_err::uv_exception(e, "scandir", Some(std::path::Path::new(path)), None)
                    .message
            ),
        ),
    }
}
