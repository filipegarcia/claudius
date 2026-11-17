//! The backup routes: ports of `app/api/settings/export/route.ts` (GET),
//! `settings/import` (POST), `settings/import/[id]` (GET, DELETE) and
//! `settings/import/[id]/resolve` (POST), over
//! [`claudius_core::settings_export`] and
//! [`claudius_core::settings_import`].
//!
//! * `GET /api/settings/export`: `JSON.stringify(bundle, null, 2)` as an
//!   attachment — `application/json; charset=utf-8`, a
//!   `claudius-backup-YYYY-MM-DD.json` filename from the bundle's
//!   `exportedAt`, and `Content-Length` in bytes. Anything the build throws
//!   (an unreadable settings file, a malformed one, a workspace whose
//!   `rootPath` is not a string) is Next's empty 500.
//! * `POST /api/settings/import`: the bundle as the JSON body, or as the
//!   `file` field of a `multipart/form-data` body (the content type only has
//!   to *contain* `multipart/form-data`, lower-cased, as the TS checks). A
//!   body `JSON.parse` refuses is 400 `invalid JSON: <V8's message>`; a
//!   multipart body `formData()` refuses is Next's empty 500; a missing or
//!   string-valued `file` field is 400 `missing file field`. A bundle
//!   without `version: 1` or a `workspaces` array of `{meta:{id,rootPath}}`
//!   strings is 400 `bundle failed validation (missing version or
//!   workspaces array)`. Otherwise the import starts and its first
//!   `ImportProgress` comes back (usually `paused`).
//! * `GET /api/settings/import/:id` re-runs the worker (side-effecting by
//!   design) and answers its progress, 404 `{error:"not found"}` when there
//!   is no session file. `DELETE` drops the session file, always
//!   `{"ok":true}`.
//! * `POST /api/settings/import/:id/resolve {wsIndex, decision}`: `wsIndex`
//!   must be a non-negative integer number and `decision.kind` one of
//!   `heal` / `skip` / `overwrite` / `rename`, else 400. A `null` body
//!   throws (`body.wsIndex`) and is the empty 500, as is a `rename`
//!   decision without `newName` (`.trim()` on `undefined`). The progress
//!   comes back with 404 only for `import session not found`.

use axum::Router;
use axum::body::Bytes;
use axum::extract::Path as AxumPath;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use claudius_agent::js;
use claudius_core::settings_import as import;
use claudius_core::skills::Thrown;
use claudius_core::{js_string, log, now_ms, settings_export};
use serde_json::{Value, json};

use crate::AppState;
use crate::body::{JsonBody, js_member, thrown};
use crate::tri;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/settings/export", get(export))
        .route("/api/settings/import", post(start))
        .route("/api/settings/import/{id}", get(progress).delete(discard))
        .route("/api/settings/import/{id}/resolve", post(resolve))
}

/// `NextResponse.json(body, {status})`.
fn json_text(status: StatusCode, body: &Value) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "application/json")],
        js::stringify(body),
    )
        .into_response()
}

fn ok(body: &Value) -> Response {
    json_text(StatusCode::OK, body)
}

fn bad_request(msg: &str) -> Response {
    json_text(StatusCode::BAD_REQUEST, &json!({ "error": msg }))
}

/// A throw the TS handler doesn't catch: Next's empty 500.
fn failed(route: &str, e: &Thrown) -> Response {
    tracing::error!(target: log::API, "[api/{route}] {}: {}", e.name, e.message);
    thrown()
}

// ── GET /api/settings/export ─────────────────────────────────────────────

async fn export() -> Response {
    let bundle = match settings_export::build_export_bundle(now_ms()) {
        Ok(b) => b,
        Err(e) => return failed("settings/export", &e),
    };
    let at = bundle["exportedAt"].as_f64().unwrap_or(f64::NAN);
    let body = js::stringify_pretty(&bundle);
    (
        StatusCode::OK,
        [
            (
                header::CONTENT_TYPE,
                "application/json; charset=utf-8".to_owned(),
            ),
            (
                header::CONTENT_DISPOSITION,
                format!(
                    "attachment; filename=\"{}\"",
                    settings_export::suggested_filename(at)
                ),
            ),
            (header::CONTENT_LENGTH, body.len().to_string()),
        ],
        body,
    )
        .into_response()
}

// ── POST /api/settings/import ────────────────────────────────────────────

async fn start(headers: HeaderMap, body: Bytes) -> Response {
    let raw_ct = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    // `req.headers.get("content-type")?.toLowerCase() ?? ""`.
    let ct = js_string::to_lower(raw_ct);
    let parsed = if ct.contains("multipart/form-data") {
        // `await req.formData()` — a body undici refuses throws, and so does
        // a content type whose essence is neither form encoding (the TS only
        // checks that the header *contains* `multipart/form-data`).
        let entries = match multipart::form_data(raw_ct, &body) {
            multipart::FormData::Entries(e) => e,
            multipart::FormData::WrongType => {
                return failed(
                    "settings/import",
                    &Thrown {
                        name: "TypeError",
                        message: "Content-Type was not one of \"multipart/form-data\" or \"application/x-www-form-urlencoded\".".into(),
                    },
                );
            }
            multipart::FormData::Failed => {
                return failed(
                    "settings/import",
                    &Thrown {
                        name: "TypeError",
                        message: "Failed to parse body as FormData.".into(),
                    },
                );
            }
        };
        // `form.get("file")`: the first entry with that name. A part without
        // a `filename` parameter is a string, not a File.
        let Some(entry) = entries.iter().find(|e| e.name == "file") else {
            return bad_request("missing file field");
        };
        if entry.filename.is_none() {
            return bad_request("missing file field");
        }
        match js::json_parse(&multipart::utf8_decode(&entry.body)) {
            Ok(v) => v,
            Err(message) => return bad_request(&format!("invalid JSON: {message}")),
        }
    } else {
        match JsonBody::parse_or_message(&body) {
            Ok(v) => v,
            Err(message) => return bad_request(&format!("invalid JSON: {message}")),
        }
    };
    if !import::validate_bundle(&parsed) {
        return bad_request("bundle failed validation (missing version or workspaces array)");
    }
    match import::start_import(&parsed) {
        Ok(progress) => ok(&progress),
        Err(e) => failed("settings/import", &e),
    }
}

// ── GET / DELETE /api/settings/import/:id ────────────────────────────────

async fn progress(AxumPath(id): AxumPath<String>) -> Response {
    match import::get_import_progress(&id) {
        Ok(Some(p)) => ok(&p),
        Ok(None) => json_text(StatusCode::NOT_FOUND, &json!({ "error": "not found" })),
        Err(e) => failed("settings/import/[id]", &e),
    }
}

async fn discard(AxumPath(id): AxumPath<String>) -> Response {
    import::cancel_import(&id);
    ok(&json!({ "ok": true }))
}

// ── POST /api/settings/import/:id/resolve ────────────────────────────────

async fn resolve(AxumPath(id): AxumPath<String>, body: Bytes) -> Response {
    let body = match JsonBody::parse_or_message(&body) {
        Ok(v) => v,
        Err(message) => return bad_request(&format!("invalid JSON: {message}")),
    };
    // `body.wsIndex` throws on a `null` body.
    if body.is_null() {
        return failed(
            "settings/import/[id]/resolve",
            &Thrown {
                name: "TypeError",
                message: "Cannot read properties of null (reading 'wsIndex')".into(),
            },
        );
    }
    let ws_index = tri!(js_member(&body, "wsIndex"));
    let valid = ws_index
        .and_then(Value::as_f64)
        .filter(|n| n.fract() == 0.0 && n.is_finite() && *n >= 0.0);
    let Some(ws_index) = valid else {
        return bad_request("wsIndex (non-negative integer) required");
    };
    let decision = tri!(js_member(&body, "decision"));
    if !matches!(decision, Some(Value::Object(_) | Value::Array(_))) {
        return bad_request("decision required");
    }
    let decision = decision.unwrap();
    let kind = decision.get("kind");
    if !matches!(
        kind.and_then(Value::as_str),
        Some("heal" | "skip" | "overwrite" | "rename")
    ) {
        return bad_request(&format!(
            "unknown decision.kind {}",
            kind.map_or("undefined".to_owned(), |v| js_string::to_js_string(v)
                .unwrap_or_else(|_| "[object Object]".into()))
        ));
    }
    let progress = match import::resolve(&id, ws_index, decision) {
        Ok(p) => p,
        Err(e) => return failed("settings/import/[id]/resolve", &e),
    };
    if progress.get("state").and_then(Value::as_str) == Some("error")
        && progress.get("error").and_then(Value::as_str) == Some("import session not found")
    {
        return json_text(StatusCode::NOT_FOUND, &progress);
    }
    ok(&progress)
}

// ── multipart/form-data ──────────────────────────────────────────────────

/// undici's `multipartFormDataParser` (`Request.formData()`), enough of it
/// for the one field the TS route reads. Every refusal is the same
/// `TypeError: Failed to parse body as FormData.`, so the route's behaviour
/// only depends on accept / reject and on the entry's name, filename and
/// bytes.
mod multipart {
    /// What `await req.formData()` did.
    pub enum FormData {
        Entries(Vec<Entry>),
        /// The content type's essence is neither form encoding: a different
        /// `TypeError`.
        WrongType,
        /// `TypeError: Failed to parse body as FormData.`
        Failed,
    }

    /// `Request.formData()`: the entry list for a `multipart/form-data`
    /// body. An `application/x-www-form-urlencoded` one parses too, but its
    /// entries are all strings, so none of them is ever the `File` the route
    /// wants — an empty list says the same thing.
    pub fn form_data(ct: &str, input: &[u8]) -> FormData {
        let essence = ct
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        match essence.as_str() {
            "multipart/form-data" => match parse(ct, input) {
                Some(entries) => FormData::Entries(entries),
                None => FormData::Failed,
            },
            "application/x-www-form-urlencoded" => FormData::Entries(Vec::new()),
            _ => FormData::WrongType,
        }
    }

    /// One `FormData` entry.
    pub struct Entry {
        pub name: String,
        /// `None` for a part without a `filename` parameter, which undici
        /// turns into a string value rather than a `File`.
        pub filename: Option<String>,
        pub body: Vec<u8>,
    }

    /// The `boundary` parameter of the content type. undici
    /// parses the MIME type properly; this follows the same grammar for the
    /// one parameter that matters: `;`-separated, optionally quoted.
    fn boundary_of(ct: &str) -> Option<String> {
        for part in ct.split(';').skip(1) {
            let (k, v) = part.split_once('=')?;
            if !k.trim().eq_ignore_ascii_case("boundary") {
                continue;
            }
            let v = v.trim();
            let v = match v.strip_prefix('"') {
                Some(rest) => rest.split('"').next().unwrap_or("").to_owned(),
                None => v.split(';').next().unwrap_or("").trim().to_owned(),
            };
            return (!v.is_empty() && v.len() <= 70).then_some(v);
        }
        None
    }

    fn starts_with(input: &[u8], at: usize, want: &[u8]) -> bool {
        input.len() >= at + want.len() && &input[at..at + want.len()] == want
    }

    fn crlf_at(input: &[u8], at: usize) -> bool {
        starts_with(input, at, b"\r\n")
    }

    /// `multipartFormDataParser(input, mimeType)`: the entry list, or
    /// `None` for anything it refuses.
    pub fn parse(ct: &str, input: &[u8]) -> Option<Vec<Entry>> {
        let boundary = format!("--{}", boundary_of(ct)?).into_bytes();
        let mut entries = Vec::new();
        let mut pos = 0usize;
        // undici skips CRLFs before the first boundary.
        while crlf_at(input, pos) {
            pos += 2;
        }
        loop {
            if !starts_with(input, pos, &boundary) {
                return None;
            }
            let after = pos + boundary.len();
            if starts_with(input, after, b"--") {
                return Some(entries);
            }
            if !crlf_at(input, after) {
                return None;
            }
            pos = after + 2;
            let header = headers(input, &mut pos)?;
            // The blank line that ends the headers.
            if !crlf_at(input, pos) {
                return None;
            }
            pos += 2;
            // The body runs to the next `\r\n--boundary`.
            let mut end = None;
            let needle: Vec<u8> = [b"\r\n".as_slice(), &boundary].concat();
            let mut i = pos;
            while i + needle.len() <= input.len() {
                if &input[i..i + needle.len()] == needle.as_slice() {
                    end = Some(i);
                    break;
                }
                i += 1;
            }
            let end = end?;
            let body = input[pos..end].to_vec();
            pos = end;
            if !crlf_at(input, pos) {
                return None;
            }
            pos += 2;
            entries.push(Entry {
                name: header.0,
                filename: header.1,
                body,
            });
        }
    }

    /// `parseMultipartFormDataHeaders` — `(name, filename)`. `None` is a
    /// parsing error, including a part with no `content-disposition`.
    #[allow(clippy::type_complexity)]
    fn headers(input: &[u8], pos: &mut usize) -> Option<(String, Option<String>)> {
        let mut name: Option<String> = None;
        let mut filename: Option<String> = None;
        loop {
            if crlf_at(input, *pos) {
                return name.map(|n| (n, filename));
            }
            let start = *pos;
            while *pos < input.len() && !matches!(input[*pos], b'\n' | b'\r' | b':') {
                *pos += 1;
            }
            let raw = &input[start..*pos];
            let header_name: Vec<u8> = raw
                .iter()
                .copied()
                .skip_while(|c| matches!(c, b'\t' | b' '))
                .collect();
            let header_name: Vec<u8> = header_name
                .into_iter()
                .rev()
                .skip_while(|c| matches!(c, b'\t' | b' '))
                .collect::<Vec<u8>>()
                .into_iter()
                .rev()
                .collect();
            if input.get(*pos) != Some(&b':') {
                return None;
            }
            *pos += 1;
            while matches!(input.get(*pos), Some(b' ' | b'\t')) {
                *pos += 1;
            }
            let lower: Vec<u8> = header_name.iter().map(u8::to_ascii_lowercase).collect();
            if lower == b"content-disposition" {
                // undici clears both before re-reading them.
                filename = None;
                if !starts_with(input, *pos, b"form-data; name=\"") {
                    return None;
                }
                *pos += 17;
                name = Some(quoted_name(input, pos)?);
                if starts_with(input, *pos, b"; ") {
                    if !starts_with(input, *pos + 2, b"filename") {
                        return None;
                    }
                    *pos += 10; // `; filename`
                    if input.get(*pos) == Some(&b'*') {
                        *pos += 1;
                    }
                    if !starts_with(input, *pos, b"=\"") {
                        return None;
                    }
                    *pos += 2;
                    filename = Some(quoted_name(input, pos)?);
                }
            } else {
                // Any other header: read its value and move on.
                while *pos < input.len() && !matches!(input[*pos], b'\r' | b'\n') {
                    *pos += 1;
                }
            }
            if !crlf_at(input, *pos) {
                return None;
            }
            *pos += 2;
        }
    }

    /// `parseMultipartFormDataName`: bytes up to the closing quote, with
    /// undici's three percent-escapes undone.
    fn quoted_name(input: &[u8], pos: &mut usize) -> Option<String> {
        let start = *pos;
        while *pos < input.len() && !matches!(input[*pos], b'\n' | b'\r' | b'"') {
            *pos += 1;
        }
        if input.get(*pos) != Some(&b'"') {
            return None;
        }
        let raw = &input[start..*pos];
        *pos += 1;
        let text = String::from_utf8_lossy(raw);
        let mut out = String::with_capacity(text.len());
        let bytes = text.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i] == b'%' && i + 2 < bytes.len() {
                let esc = &text[i..i + 3];
                let replacement = match esc.to_ascii_uppercase().as_str() {
                    "%0A" => Some('\n'),
                    "%0D" => Some('\r'),
                    _ if esc == "%22" => Some('"'),
                    _ => None,
                };
                if let Some(c) = replacement {
                    out.push(c);
                    i += 3;
                    continue;
                }
            }
            let ch = text[i..].chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
        }
        Some(out)
    }

    /// `Blob.prototype.text()` — UTF-8 decode, which drops one leading BOM.
    pub fn utf8_decode(bytes: &[u8]) -> String {
        let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
        String::from_utf8_lossy(bytes).into_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::multipart;

    fn body(parts: &[&str]) -> Vec<u8> {
        parts.join("\r\n").into_bytes()
    }

    #[test]
    fn a_file_part_parses() {
        let raw = body(&[
            "--X",
            "Content-Disposition: form-data; name=\"file\"; filename=\"b.json\"",
            "Content-Type: application/json",
            "",
            "{\"a\":1}",
            "--X--",
            "",
        ]);
        let entries = multipart::parse("multipart/form-data; boundary=X", &raw).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "file");
        assert_eq!(entries[0].filename.as_deref(), Some("b.json"));
        assert_eq!(multipart::utf8_decode(&entries[0].body), "{\"a\":1}");
    }

    #[test]
    fn a_field_without_a_filename_is_a_string() {
        let raw = body(&[
            "--X",
            "Content-Disposition: form-data; name=\"file\"",
            "",
            "{}",
            "--X--",
            "",
        ]);
        let entries = multipart::parse("multipart/form-data; boundary=X", &raw).unwrap();
        assert!(entries[0].filename.is_none());
    }

    #[test]
    fn refusals() {
        for (ct, raw) in [
            ("multipart/form-data", &body(&["--X--", ""])[..]),
            ("multipart/form-data; boundary=X", b""),
            ("multipart/form-data; boundary=X", b"--Y--\r\n"),
            (
                "multipart/form-data; boundary=X",
                &body(&[
                    "--X",
                    "Content-Disposition: form-data; name=file",
                    "",
                    "{}",
                    "--X--",
                    "",
                ])[..],
            ),
            (
                "multipart/form-data; boundary=X",
                &body(&["--X", "X-Other: 1", "", "{}", "--X--", ""])[..],
            ),
        ] {
            assert!(multipart::parse(ct, raw).is_none(), "{ct} {raw:?}");
        }
    }
}
