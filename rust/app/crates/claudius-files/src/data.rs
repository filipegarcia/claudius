//! What the Files page reads and does, as the [`FilesData`] trait: one
//! method per `fetch` the React page and its components make, answering
//! the parsed body or the text the TS shows for a failure (`err.message`).
//!
//! | Method | Request (TS) | Failure text |
//! |---|---|---|
//! | [`FilesData::roots`] | `GET /api/workspaces/<id>/roots` (page.tsx:108) | `HTTP <status>` (the page falls back to the primary root) |
//! | [`FilesData::list`] | `GET …/files?path=&depth=1[&root=]` (FileTree.tsx:129) | `{error}` or `HTTP <status>` |
//! | [`FilesData::search`] | `GET …/files?search=[&root=]` (FileTree.tsx:88) | `{error}` or `Search failed (HTTP <status>)` |
//! | [`FilesData::read`] | `GET …/files?path=[&root=]` (page.tsx:132) | `{error}` or `HTTP <status>` |
//! | [`FilesData::save`] | `PUT` the same, the text as the body (page.tsx:207) | the same |
//! | [`FilesData::delete`] | `DELETE` the same (page.tsx:230) | the same |
//! | [`FilesData::rename`] | `PATCH …&newPath=` (page.tsx:258) | the same |
//! | [`FilesData::create`] | `POST …&kind=file\|dir` (page.tsx:294) | the same |
//! | [`FilesData::content_search`] | `GET …/files?contentSearch=[&path=][&root=][&case=1]` (FindInFolder.tsx:94) | the same |
//! | [`FilesData::reveal`] | `POST /api/workspaces/<id>/reveal` `{relPath, root?}` (FilePathContextMenu.tsx:98) | the same |
//! | [`FilesData::image`] | `GET …/files?path=&serve=1` (the chat's `FilePreview`) | the same |
//!
//! A `fetch` that rejects (no answer) fails with its `TypeError`'s message
//! (`Failed to fetch`). The `parse_*` functions are the TS's reads of an
//! answer, shared by every source.

use std::sync::Arc;

use claudius_core::js_string;
use futures::future::BoxFuture;
use serde_json::Value;

pub use crate::rules::{ContentMatch, NewKind};

/// An answer, or the text the page shows.
pub type FilesResult<T> = Result<T, String>;
pub type FilesFuture<T> = BoxFuture<'static, FilesResult<T>>;

/// A root of the workspace (page.tsx:47 `WorkspaceRoot`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkspaceRoot {
    /// `primary` or `extra:<n>`.
    pub id: String,
    pub abs_path: String,
    /// `primary`, `workspace` (the workspace's defaults) or `settings`.
    pub source: String,
}

/// A tree row (FileTree.tsx:8 `Entry`).
#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub name: String,
    /// Root-relative; a folder's ends in `/`.
    pub rel_path: String,
    pub is_dir: bool,
    pub size_bytes: Option<f64>,
    pub modified_ms: Option<f64>,
}

/// A folder's listing (FileTree.tsx:136).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Listing {
    pub entries: Vec<Entry>,
    /// `hiddenCount` when it's a number, else 0.
    pub hidden: f64,
}

/// The filename search's answer (FileTree.tsx:94).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SearchResult {
    pub entries: Vec<Entry>,
    pub truncated: bool,
}

/// An opened file (page.tsx:27 `FileContent`, `root` the server's
/// `rootId` when it sent one).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct FileContent {
    pub root: String,
    pub rel_path: String,
    pub content: String,
    pub size_bytes: Option<f64>,
    pub modified_ms: Option<f64>,
    pub encoding: Option<String>,
    pub encoding_label: Option<String>,
    pub editable: Option<bool>,
    pub read_only_reason: Option<String>,
    /// `binary === true`.
    pub binary: bool,
}

impl FileContent {
    /// page.tsx:199 `open?.editable === false`.
    pub fn read_only(&self) -> bool {
        self.editable == Some(false)
    }
}

/// Find in folder's answer (FindInFolder.tsx:104).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ContentSearch {
    pub matches: Vec<ContentMatch>,
    pub truncated: bool,
    pub scanned: f64,
}

/// What the Files page reads and does (see the module docs).
pub trait FilesData: Send + Sync + 'static {
    fn roots(&self, ws: &str) -> FilesFuture<Vec<WorkspaceRoot>>;
    /// `root`: the tree's own selector (`None` on a single-root page).
    fn list(&self, ws: &str, root: Option<&str>, path: &str) -> FilesFuture<Listing>;
    fn search(&self, ws: &str, root: Option<&str>, q: &str) -> FilesFuture<SearchResult>;
    /// `root`: `primary` or `extra:<n>`; the answer's `root` is the
    /// server's.
    fn read(&self, ws: &str, root: &str, rel: &str) -> FilesFuture<FileContent>;
    fn save(&self, ws: &str, root: &str, rel: &str, text: &str) -> FilesFuture<()>;
    fn delete(&self, ws: &str, root: &str, rel: &str) -> FilesFuture<()>;
    fn rename(&self, ws: &str, root: &str, rel: &str, next: &str) -> FilesFuture<()>;
    fn create(&self, ws: &str, root: &str, path: &str, kind: NewKind) -> FilesFuture<()>;
    fn content_search(
        &self,
        ws: &str,
        root: &str,
        folder: &str,
        q: &str,
        case_sensitive: bool,
    ) -> FilesFuture<ContentSearch>;
    fn reveal(&self, ws: &str, root: Option<&str>, rel: &str) -> FilesFuture<()>;
    /// An image's bytes and content type.
    fn image(&self, ws: &str, root: &str, rel: &str) -> FilesFuture<(Vec<u8>, String)>;
}

/// A shared source.
pub type SharedFilesData = Arc<dyn FilesData>;

// ---- the TS's reads of an answer -----------------------------------------

/// `JSON.parse` of a body (`res.json()`: a leading BOM dropped).
fn json(body: &str) -> Result<Value, String> {
    let text = body.strip_prefix('\u{feff}').unwrap_or(body);
    js_string::parse(text).map_err(|e| format!("SyntaxError: {e}"))
}

/// `new Error(j.error ?? fallback).message` after
/// `res.json().catch(() => ({}))`: a body that isn't JSON reads as `{}`;
/// a `null` body throws reading `.error`.
pub fn error_text(body: &str, fallback: impl FnOnce() -> String) -> String {
    let j = json(body).unwrap_or_else(|_| Value::Object(Default::default()));
    match &j {
        Value::Null => "Cannot read properties of null (reading 'error')".into(),
        Value::Object(m) => match m.get("error") {
            None | Some(Value::Null) => fallback(),
            Some(v) => js_string::to_js_string(v).unwrap_or_else(|_| fallback()),
        },
        // A primitive or an array has no `error` property.
        _ => fallback(),
    }
}

/// `HTTP <status>`.
pub fn http_status(status: u16) -> String {
    format!("HTTP {status}")
}

/// An answer that isn't `ok`: its `{error}`, else `fallback(status)`.
pub fn check(status: u16, body: &str, fallback: impl FnOnce(u16) -> String) -> Result<(), String> {
    if (200..300).contains(&status) {
        Ok(())
    } else {
        Err(error_text(body, || fallback(status)))
    }
}

fn opt_str(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(Value::as_str).map(str::to_owned)
}

fn opt_num(v: &Value, k: &str) -> Option<f64> {
    v.get(k).and_then(Value::as_f64)
}

/// JS truthiness (`Boolean(v)`).
fn truthy(v: Option<&Value>) -> bool {
    v.is_some_and(claudius_agent::js::truthy)
}

fn entry(v: &Value) -> Option<Entry> {
    let rel = opt_str(v, "relPath")?;
    Some(Entry {
        name: opt_str(v, "name").unwrap_or_else(|| crate::rules::last_segment(&rel).to_owned()),
        is_dir: v.get("kind").and_then(Value::as_str) == Some("dir"),
        rel_path: rel,
        size_bytes: opt_num(v, "sizeBytes"),
        modified_ms: opt_num(v, "modifiedMs"),
    })
}

fn entries(v: Option<&Value>) -> Vec<Entry> {
    v.and_then(Value::as_array)
        .map(|a| a.iter().filter_map(entry).collect())
        .unwrap_or_default()
}

/// page.tsx:109-111: `r.ok ? r.json() : reject(HTTP n)`, then `d.roots`
/// when it's an array, else none.
pub fn parse_roots(status: u16, body: &str) -> FilesResult<Vec<WorkspaceRoot>> {
    if !(200..300).contains(&status) {
        return Err(http_status(status));
    }
    let d = json(body)?;
    let Some(list) = d.get("roots").and_then(Value::as_array) else {
        return Ok(Vec::new());
    };
    Ok(list
        .iter()
        .filter_map(|r| {
            Some(WorkspaceRoot {
                id: opt_str(r, "id")?,
                abs_path: opt_str(r, "absPath").unwrap_or_default(),
                source: opt_str(r, "source").unwrap_or_default(),
            })
        })
        .collect())
}

/// FileTree.tsx:132-142 a folder's listing.
pub fn parse_listing(status: u16, body: &str) -> FilesResult<Listing> {
    check(status, body, http_status)?;
    let d = json(body)?;
    Ok(Listing {
        entries: entries(d.get("entries")),
        hidden: opt_num(&d, "hiddenCount").unwrap_or(0.0),
    })
}

/// FileTree.tsx:89-97 the filename search.
pub fn parse_search(status: u16, body: &str) -> FilesResult<SearchResult> {
    check(status, body, |s| format!("Search failed (HTTP {s})"))?;
    let d = json(body)?;
    Ok(SearchResult {
        entries: entries(d.get("entries")),
        truncated: truthy(d.get("truncated")),
    })
}

/// page.tsx:135-154 an opened file; `root` the selector asked for (used
/// when the server sends no `rootId`).
pub fn parse_file(status: u16, body: &str, root: &str) -> FilesResult<FileContent> {
    check(status, body, http_status)?;
    let d = json(body)?;
    Ok(FileContent {
        root: opt_str(&d, "rootId").unwrap_or_else(|| root.to_owned()),
        rel_path: opt_str(&d, "relPath").unwrap_or_default(),
        content: opt_str(&d, "content").unwrap_or_default(),
        size_bytes: opt_num(&d, "sizeBytes"),
        modified_ms: opt_num(&d, "modifiedMs"),
        encoding: opt_str(&d, "encoding"),
        encoding_label: opt_str(&d, "encodingLabel"),
        editable: d.get("editable").and_then(Value::as_bool),
        read_only_reason: opt_str(&d, "readOnlyReason"),
        binary: d.get("binary") == Some(&Value::Bool(true)),
    })
}

/// page.tsx:211-214 (and the delete, rename and create): `ok` or the
/// failure.
pub fn parse_ok(status: u16, body: &str) -> FilesResult<()> {
    check(status, body, http_status)
}

fn content_match(v: &Value) -> Option<ContentMatch> {
    Some(ContentMatch {
        rel_path: opt_str(v, "relPath")?,
        line: opt_num(v, "line").unwrap_or(0.0),
        col: opt_num(v, "col").unwrap_or(0.0),
        col_end: opt_num(v, "colEnd").unwrap_or(0.0),
        text: opt_str(v, "text").unwrap_or_default(),
        truncated: truthy(v.get("truncated")),
    })
}

/// FindInFolder.tsx:97-109 the content search.
pub fn parse_content_search(status: u16, body: &str) -> FilesResult<ContentSearch> {
    check(status, body, http_status)?;
    let d = json(body)?;
    Ok(ContentSearch {
        matches: d
            .get("matches")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(content_match).collect())
            .unwrap_or_default(),
        truncated: truthy(d.get("truncated")),
        scanned: opt_num(&d, "scanned").unwrap_or(0.0),
    })
}
