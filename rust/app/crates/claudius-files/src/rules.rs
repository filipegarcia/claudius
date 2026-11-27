//! The Files page's pure rules, each where the TS has it: the URLs its
//! fetches build, the labels, sizes and tooltips it prints, the shortcut
//! matcher, find in file's matcher and find in folder's grouping, the
//! context menu's placement, and the grammar a path highlights with.
//! Replayed against the TS by `tests/rules_golden.rs`
//! (`rust/scripts/files-rules-golden.mjs`).

use claudius_agent::js;
use claudius_core::js_string;

// ---- URLs ------------------------------------------------------------------

/// `encodeURIComponent(s)`. A lone surrogate (which throws `URIError` in
/// JS) can't come from a typed path; it encodes as U+FFFD.
pub fn enc(s: &str) -> String {
    js_string::encode_uri_component(s).unwrap_or_else(|| {
        js_string::encode_uri_component(&js_string::lossy(s)).unwrap_or_default()
    })
}

/// page.tsx:58 `rootParam(root)`: `""` for the primary root, else
/// `&root=<enc>`.
pub fn root_param(root: &str) -> String {
    if root == "primary" {
        String::new()
    } else {
        format!("&root={}", enc(root))
    }
}

/// FileTree.tsx:87 / :128: the tree's own `root ? &root=… : ""` (a
/// multi-root group passes `primary` too, so it sends `&root=primary`).
pub fn tree_root_param(root: Option<&str>) -> String {
    match root {
        Some(r) if !r.is_empty() => format!("&root={}", enc(r)),
        _ => String::new(),
    }
}

/// `/api/workspaces/${wsId}/files` (the id goes in raw, as the template
/// literal puts it).
fn files_url(ws: &str) -> String {
    format!("/api/workspaces/{ws}/files")
}

/// page.tsx:108 `GET /api/workspaces/<id>/roots`.
pub fn roots_url(ws: &str) -> String {
    format!("/api/workspaces/{ws}/roots")
}

/// FileTree.tsx:129 `load(path)`: `?path=<enc>&depth=1<root>`.
pub fn list_url(ws: &str, root: Option<&str>, path: &str) -> String {
    format!(
        "{}?path={}&depth=1{}",
        files_url(ws),
        enc(path),
        tree_root_param(root)
    )
}

/// FileTree.tsx:88 the filename search: `?search=<enc q><root>`.
pub fn search_url(ws: &str, root: Option<&str>, q: &str) -> String {
    format!(
        "{}?search={}{}",
        files_url(ws),
        enc(q),
        tree_root_param(root)
    )
}

/// page.tsx:133 / :208 / :231: the file's own URL (GET, PUT, DELETE).
pub fn file_url(ws: &str, root: &str, rel: &str) -> String {
    format!("{}?path={}{}", files_url(ws), enc(rel), root_param(root))
}

/// page.tsx:259 the rename: `?path=<enc>&newPath=<enc><root>`.
pub fn rename_url(ws: &str, root: &str, rel: &str, next: &str) -> String {
    format!(
        "{}?path={}&newPath={}{}",
        files_url(ws),
        enc(rel),
        enc(next),
        root_param(root)
    )
}

/// A new entry's kind (page.tsx:277 `onCreate(kind)`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum NewKind {
    File,
    Dir,
}

impl NewKind {
    pub fn as_str(self) -> &'static str {
        match self {
            NewKind::File => "file",
            NewKind::Dir => "dir",
        }
    }
}

/// page.tsx:295 the create: `?path=<enc>&kind=<kind><root>`.
pub fn create_url(ws: &str, root: &str, next: &str, kind: NewKind) -> String {
    format!(
        "{}?path={}&kind={}{}",
        files_url(ws),
        enc(next),
        kind.as_str(),
        root_param(root)
    )
}

/// FindInFolder.tsx:91-95: `?contentSearch=<enc q><&path=><&root=><&case=1>`
/// (no `path` for the root folder, no `root` for the primary one).
pub fn content_search_url(ws: &str, root: &str, folder: &str, q: &str, case: bool) -> String {
    let path_q = if folder.is_empty() {
        String::new()
    } else {
        format!("&path={}", enc(folder))
    };
    let case_q = if case { "&case=1" } else { "" };
    format!(
        "{}?contentSearch={}{path_q}{}{case_q}",
        files_url(ws),
        enc(q),
        root_param(root)
    )
}

/// FilePathContextMenu.tsx:98 `POST /api/workspaces/<id>/reveal`.
pub fn reveal_url(ws: &str) -> String {
    format!("/api/workspaces/{ws}/reveal")
}

/// FilePathContextMenu.tsx:101 the body: `JSON.stringify({relPath,
/// ...(root ? {root} : {})})`.
pub fn reveal_body(rel: &str, root: Option<&str>) -> String {
    let mut m = serde_json::Map::new();
    m.insert("relPath".into(), rel.into());
    if let Some(r) = root.filter(|r| !r.is_empty()) {
        m.insert("root".into(), r.into());
    }
    js_string::stringify(&serde_json::Value::Object(m))
}

/// The image bytes for a preview (`?path=<enc>&serve=1<root>`), as the
/// chat's `FilePreview` asks the same route.
pub fn serve_url(ws: &str, root: &str, rel: &str) -> String {
    format!(
        "{}?path={}&serve=1{}",
        files_url(ws),
        enc(rel),
        root_param(root)
    )
}

/// page.tsx:163-164 / :267-268 the page's own URL after a pick or a rename:
/// `<pathname>?path=<enc>` plus `&root=<enc>` off the primary root.
pub fn page_url(pathname: &str, rel: &str, root: &str) -> String {
    let root_q = if root == "primary" {
        String::new()
    } else {
        format!("&root={}", enc(root))
    };
    format!("{pathname}?path={}{root_q}", enc(rel))
}

// ---- labels ----------------------------------------------------------------

/// `${n}` for a JSON number.
pub fn num(n: f64) -> String {
    js::number_to_string(n)
}

/// `Number.prototype.toFixed(1)`: the exact value to one place, a tie
/// going to the larger magnitude.
pub fn to_fixed1(x: f64) -> String {
    let (sign, a) = if x < 0.0 { ("-", -x) } else { ("", x + 0.0) };
    if a.is_nan() {
        return "NaN".into();
    }
    if a.is_infinite() {
        return format!("{sign}Infinity");
    }
    if a >= 1e21 {
        return format!("{sign}{}", js::number_to_string(a));
    }
    // A tie is `a = j / 4` with `j` odd (exact in binary).
    let scaled = a * 4.0;
    let body = if scaled.fract() == 0.0 && scaled % 2.0 == 1.0 {
        let n = ((scaled as u128) * 5).div_ceil(2);
        let s = format!("{n:0>2}");
        let (int, frac) = s.split_at(s.len() - 1);
        format!("{int}.{frac}")
    } else {
        format!("{a:.1}")
    };
    format!("{sign}{body}")
}

/// FileTree.tsx:479 `fmtSize(n)` and BinaryFilePlaceholder.tsx:5
/// `formatSize(bytes)` (the same rule): `512 B`, `1.5 KB`, `2.0 MB`.
pub fn fmt_size(n: f64) -> String {
    if n < 1024.0 {
        format!("{} B", num(n))
    } else if n < 1024.0 * 1024.0 {
        format!("{} KB", to_fixed1(n / 1024.0))
    } else {
        format!("{} MB", to_fixed1(n / 1024.0 / 1024.0))
    }
}

/// BinaryFilePlaceholder.tsx:12.
pub const BINARY_SAVE_TITLE: &str = "Binary file \u{2014} can't be edited here";
/// BinaryFilePlaceholder.tsx:15.
pub const ENCODING_READONLY_SAVE_TITLE: &str =
    "Read-only \u{2014} saving would convert this file's encoding";

/// BinaryFilePlaceholder.tsx:23 `saveButtonTitle`: binary first, then the
/// encoding's read-only reason, else none (the button keeps no tooltip).
pub fn save_button_title(binary: bool, read_only: bool) -> Option<&'static str> {
    if binary {
        Some(BINARY_SAVE_TITLE)
    } else if read_only {
        Some(ENCODING_READONLY_SAVE_TITLE)
    } else {
        None
    }
}

/// BinaryFilePlaceholder.tsx:44 `path.split("/").pop() || path`.
pub fn binary_name(path: &str) -> &str {
    match path.rsplit('/').next() {
        Some(n) if !n.is_empty() => n,
        _ => path,
    }
}

/// BinaryFilePlaceholder.tsx:53-56: `name` and ` · <size>` when there is
/// one.
pub fn binary_caption(path: &str, size: Option<f64>) -> String {
    match size {
        Some(n) => format!("{} \u{b7} {}", binary_name(path), fmt_size(n)),
        None => binary_name(path).to_owned(),
    }
}

/// BinaryFilePlaceholder.tsx:52 and :58-59.
pub const BINARY_HEADLINE: &str = "Binary file \u{2014} not shown as text";
pub const BINARY_BODY: &str = "This file isn't text (a spreadsheet, archive, database, media file or similar), so it can't be opened in the editor.";

/// page.tsx:556 the read-only notice when the server gives no reason.
pub const READ_ONLY_DEFAULT: &str =
    "Read-only: this file's encoding isn't UTF-8, and saving would convert it.";

/// page.tsx:188 / :306 an entry's name from a path: `p.split("/").pop() ?? p`.
pub fn last_segment(p: &str) -> &str {
    p.rsplit('/').next().unwrap_or(p)
}

/// page.tsx:285 `relPath.replace(/[^/]*$/, "")`: the folder part, its
/// trailing `/` kept (`""` for a top-level file).
pub fn base_hint(rel: &str) -> &str {
    match rel.rfind('/') {
        Some(at) => &rel[..=at],
        None => "",
    }
}

/// page.tsx:286-289 the create prompt's message and default.
pub fn create_prompt(kind: NewKind, open_rel: Option<&str>) -> (&'static str, String) {
    let hint = open_rel.map(base_hint).unwrap_or_default();
    match kind {
        NewKind::Dir => ("New folder path:", format!("{hint}newdir")),
        NewKind::File => ("New file path:", format!("{hint}untitled.md")),
    }
}

/// page.tsx:253 the rename prompt's message.
pub const RENAME_PROMPT: &str = "New path (relative to its root):";

/// page.tsx:226 the delete confirmation.
pub fn delete_question(rel: &str) -> String {
    format!("Delete {rel}? This cannot be undone.")
}

/// A root's `source` (page.tsx:50).
pub fn root_label<'a>(source: &str, abs_path: &'a str) -> &'a str {
    // page.tsx:422-425: `absPath.split("/").filter(Boolean).pop() ?? absPath`.
    if source == "primary" {
        return "Workspace root";
    }
    abs_path
        .split('/')
        .rfind(|s| !s.is_empty())
        .unwrap_or(abs_path)
}

/// page.tsx:426-427 the group's source badge.
pub fn source_badge(source: &str) -> Option<&'static str> {
    match source {
        "settings" => Some("settings.json"),
        "workspace" => Some("defaults"),
        _ => None,
    }
}

/// page.tsx:336 `+N root(s)`.
pub fn extra_roots_badge(n: usize) -> String {
    format!("+{n} root{}", if n == 1 { "" } else { "s" })
}

/// FileTree.tsx:443.
pub const HIDDEN_HINT: &str =
    "Dotfiles and folders like .git, node_modules, dist and build aren't shown in the tree.";

/// `N hidden item(s)`.
fn hidden_items(n: f64) -> String {
    format!("{} hidden item{}", num(n), if n == 1.0 { "" } else { "s" })
}

/// FileTree.tsx:305-310 an empty root listing.
pub fn empty_root_text(hidden: f64) -> String {
    if hidden > 0.0 {
        format!("No visible files \u{2014} {}.", hidden_items(hidden))
    } else {
        "This folder is empty.".into()
    }
}

/// FileTree.tsx:457-463 an open folder with nothing listed.
pub fn empty_dir_text(hidden: f64) -> String {
    if hidden > 0.0 {
        hidden_items(hidden)
    } else {
        "Empty".into()
    }
}

/// FileTree.tsx:278 the truncated search's footer.
pub fn search_truncated_text(n: usize) -> String {
    format!("Showing first {n} matches\u{2026}")
}

/// FileTree.tsx:140 the listing's key: a folder carries its trailing `/`
/// (`""` is the root).
pub fn load_key(path: &str) -> String {
    if path.is_empty() || path.ends_with('/') {
        path.to_owned()
    } else {
        format!("{path}/")
    }
}

/// FileTree.tsx:180-191 the deep link's walk: the ancestor folders of
/// `selected`, as `(load path, key)` (`("a/b", "a/b/")`), none for a
/// top-level path.
pub fn ancestor_dirs(selected: &str) -> Vec<(String, String)> {
    let segs: Vec<&str> = selected.split('/').filter(|s| !s.is_empty()).collect();
    if segs.len() <= 1 {
        return Vec::new();
    }
    let mut prefix = String::new();
    let mut out = Vec::new();
    for seg in &segs[..segs.len() - 1] {
        prefix = if prefix.is_empty() {
            (*seg).to_owned()
        } else {
            format!("{prefix}/{seg}")
        };
        out.push((prefix.clone(), format!("{prefix}/")));
    }
    out
}

/// page.tsx:405-411 / :431-436 the path a root's tree highlights: the open
/// file's when it lives there, else (nothing open yet) the URL's when it
/// names this root, else none.
pub fn selected_path<'a>(
    open: Option<(&'a str, &'a str)>,
    url_root: Option<&'a str>,
    url_path: Option<&'a str>,
    root_id: &str,
) -> Option<&'a str> {
    match open {
        Some((root, rel)) if root == root_id => Some(rel),
        Some(_) => None,
        None if url_root.unwrap_or("primary") == root_id => url_path,
        None => None,
    }
}

/// page.tsx:421 a group is open while searching, else as toggled
/// (`primary` starts open).
pub fn group_open(query: &str, toggled: Option<bool>) -> bool {
    if !js::trim(query).is_empty() {
        true
    } else {
        toggled.unwrap_or(false)
    }
}

/// page.tsx:501 the encoding badge: off for a binary, and for UTF-8.
pub fn encoding_badge<'a>(
    binary: bool,
    encoding: Option<&str>,
    label: Option<&'a str>,
) -> Option<&'a str> {
    if binary {
        return None;
    }
    match encoding {
        Some(e) if !e.is_empty() && e != "utf-8" => label.filter(|l| !l.is_empty()),
        _ => None,
    }
}

// ---- keys ------------------------------------------------------------------

/// What a key handler reads from a `KeyboardEvent`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct KeyEvent {
    pub key: String,
    pub code: String,
    pub meta: bool,
    pub ctrl: bool,
    pub shift: bool,
    pub alt: bool,
}

/// key-match.ts:18 `isLetterKey(e, letter)`: a typed Latin letter decides;
/// otherwise (a non-Latin layout) the physical key does, unless Alt is
/// down or an IME is composing.
pub fn is_letter_key(key: &str, code: &str, alt: bool, letter: char) -> bool {
    let want = letter.to_ascii_lowercase();
    let units = js_string::units(key);
    let typed = if units.len() == 1 {
        js_string::to_lower(key)
    } else {
        String::new()
    };
    let mut chars = typed.chars();
    if let (Some(c), None) = (chars.next(), chars.next())
        && c.is_ascii_lowercase()
    {
        return c == want;
    }
    if alt || key == "Process" {
        return false;
    }
    code == format!("Key{}", want.to_ascii_uppercase())
}

/// page.tsx:572-577 ⌘S / Ctrl+S in the editor (no Shift, no Alt).
pub fn is_save_chord(e: &KeyEvent) -> bool {
    (e.meta || e.ctrl) && !e.shift && !e.alt && is_letter_key(&e.key, &e.code, e.alt, 's')
}

// ---- find in file ----------------------------------------------------------

/// FindInFile.tsx:61 the matcher's cap.
pub const FIND_CAP: usize = 5000;

/// One match, in UTF-16 units of the searched text (FindInFile.tsx:58).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Match16 {
    pub start: usize,
    pub end: usize,
}

/// FindInFile.tsx:48-64: every non-overlapping `indexOf` of the query in
/// the buffer, lower-cased on both sides unless case-sensitive (offsets
/// are the lowered text's, as the TS's are), at most [`FIND_CAP`].
pub fn find_matches(value: &str, query: &str, case_sensitive: bool) -> Vec<Match16> {
    if query.is_empty() {
        return Vec::new();
    }
    let (hay, needle) = if case_sensitive {
        (js_string::units(value), js_string::units(query))
    } else {
        (
            js_string::units(&js_string::to_lower(value)),
            js_string::units(&js_string::to_lower(query)),
        )
    };
    if needle.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut from = 0;
    while from + needle.len() <= hay.len() {
        let Some(i) = hay[from..]
            .windows(needle.len())
            .position(|w| w == needle.as_slice())
            .map(|p| p + from)
        else {
            break;
        };
        out.push(Match16 {
            start: i,
            end: i + needle.len(),
        });
        from = i + needle.len().max(1);
        if out.len() >= FIND_CAP {
            break;
        }
    }
    out
}

/// FindInFile.tsx:182 the counter: empty with no query, `No results`, or
/// `i / n`.
pub fn find_counter(query: &str, matches: usize, active: usize) -> String {
    if query.is_empty() {
        String::new()
    } else if matches == 0 {
        "No results".into()
    } else {
        format!("{} / {matches}", active + 1)
    }
}

/// FindInFile.tsx:125 / :129 next and previous, wrapping.
pub fn find_step(active: usize, matches: usize, forward: bool) -> usize {
    if matches == 0 {
        return active;
    }
    if forward {
        (active + 1) % matches
    } else {
        (active + matches - 1) % matches
    }
}

/// FindInFile.tsx:69-75 the active match after the count changed: back to
/// the first when there is none or it ran past the end.
pub fn find_clamp(active: usize, matches: usize) -> usize {
    if matches == 0 || active >= matches {
        0
    } else {
        active
    }
}

/// FindInFile.tsx:102 the match's line: `value.slice(0, start)
/// .split("\n").length - 1` (UTF-16 `start`).
pub fn line_of(value: &str, start16: usize) -> usize {
    let units = js_string::units(value);
    let end = start16.min(units.len());
    units[..end]
        .iter()
        .filter(|u| **u == u16::from(b'\n'))
        .count()
}

/// FindInFile.tsx:172 / FindInFolder.tsx:192 the case toggle's tooltip.
pub fn case_title(on: bool) -> &'static str {
    if on {
        "Case sensitive (on)"
    } else {
        "Case sensitive (off)"
    }
}

/// A UTF-16 offset into `s` as a byte offset, clamped to its end (a match
/// in the lowered text can sit past the original's end: `İ` lowers to two
/// units).
pub fn byte_offset(s: &str, units16: usize) -> usize {
    let mut seen = 0;
    for (i, c) in s.char_indices() {
        if seen >= units16 {
            return i;
        }
        seen += if js_string::lone_unit(c).is_some() {
            1
        } else {
            c.len_utf16()
        };
    }
    s.len()
}

// ---- find in folder --------------------------------------------------------

/// One `contentSearch` hit (FindInFolder.tsx:7).
#[derive(Clone, Debug, PartialEq)]
pub struct ContentMatch {
    pub rel_path: String,
    pub line: f64,
    pub col: f64,
    pub col_end: f64,
    pub text: String,
    pub truncated: bool,
}

/// FindInFolder.tsx:128-137 the hits bucketed by file, consecutive runs of
/// one path (the server sorts them), as indices into `matches`.
pub fn group_matches(matches: &[ContentMatch]) -> Vec<(String, Vec<usize>)> {
    let mut out: Vec<(String, Vec<usize>)> = Vec::new();
    for (i, m) in matches.iter().enumerate() {
        match out.last_mut() {
            Some((path, hits)) if *path == m.rel_path => hits.push(i),
            _ => out.push((m.rel_path.clone(), vec![i])),
        }
    }
    out
}

/// FindInFolder.tsx:140 `folderPath ? folderPath.replace(/\/$/, "") :
/// folderLabel`.
pub fn folder_display<'a>(folder: &'a str, label: &'a str) -> &'a str {
    if folder.is_empty() {
        label
    } else {
        folder.strip_suffix('/').unwrap_or(folder)
    }
}

/// FindInFolder.tsx:200-218 the status beside the case toggle.
pub fn folder_status(
    loading: bool,
    query: &str,
    error: bool,
    total: usize,
    files: usize,
) -> String {
    if loading {
        "searching\u{2026}".into()
    } else if js::trim(query).is_empty() || error {
        String::new()
    } else if total == 0 {
        "No matches".into()
    } else {
        format!(
            "{total} match{} \u{b7} {files} file{}",
            if total == 1 { "" } else { "es" },
            if files == 1 { "" } else { "s" }
        )
    }
}

/// FindInFolder.tsx:281-286 the footer under the hits.
pub fn folder_footer(truncated: bool, scanned: f64, total: usize) -> Option<String> {
    if truncated {
        Some(format!(
            "Showing first {total} matches across {} files \u{2014} refine the query for more.",
            num(scanned)
        ))
    } else if scanned > 0.0 && total == 0 {
        Some(format!("Scanned {} files.", num(scanned)))
    } else {
        None
    }
}

/// FindInFolder.tsx:301-313 `MatchedLine`: the snippet cut around the
/// match (1-based UTF-16 columns, clipped), or `None` to show it whole.
pub fn matched_line(text: &str, col: f64, col_end: f64) -> Option<(String, String, String)> {
    let units = js_string::units(text);
    let len = units.len() as f64;
    let start = 0f64.max(len.min(col - 1.0));
    let end = start.max(len.min(col_end - 1.0));
    if end.is_nan() || start.is_nan() || end <= start {
        return None;
    }
    // `slice` truncates fractional indices toward zero.
    let (s, e) = (start as usize, end as usize);
    if e <= s {
        // `slice(1.5, 1.9)` is empty: the mark is drawn, empty.
        return Some((
            js_string::from_units(&units[..s]),
            String::new(),
            js_string::from_units(&units[s..]),
        ));
    }
    Some((
        js_string::from_units(&units[..s]),
        js_string::from_units(&units[s..e]),
        js_string::from_units(&units[e..]),
    ))
}

/// How the hit row's `truncate` (`white-space: nowrap`) shows a line cut in
/// parts: each run of spaces / tabs collapses to one space, across the
/// parts, and none is left at the line's start (an indented line shows
/// flush).
pub fn collapse_spaces(parts: &[&str]) -> Vec<String> {
    let mut after_space = true;
    parts
        .iter()
        .map(|p| {
            let mut out = String::new();
            for ch in p.chars() {
                if matches!(ch, ' ' | '\t' | '\n' | '\r' | '\x0c') {
                    if !after_space {
                        out.push(' ');
                        after_space = true;
                    }
                } else {
                    out.push(ch);
                    after_space = false;
                }
            }
            out
        })
        .collect()
}

// ---- the context menu ------------------------------------------------------

/// FilePathContextMenu.tsx:12-13 the size it clamps with before measuring.
pub const MENU_EST_WIDTH: f64 = 200.0;
pub const MENU_EST_HEIGHT: f64 = 56.0;

/// `Math.round`: halves toward +∞.
pub fn js_round(x: f64) -> f64 {
    let f = x.floor();
    if x - f >= 0.5 { f + 1.0 } else { f }
}

/// FilePathContextMenu.tsx:164-170 `clamp`: the menu kept 8 px inside the
/// viewport, `(left, top)`.
pub fn clamp_menu(x: f64, y: f64, width: f64, height: f64, vw: f64, vh: f64) -> (f64, f64) {
    let left = 8f64.max(x.min(vw - width - 8.0));
    let top = 8f64.max(y.min(vh - height - 8.0));
    (js_round(left), js_round(top))
}

/// FilePathContextMenu.tsx:146 `revealLabel()` for the OS the app runs on.
pub fn reveal_label() -> &'static str {
    reveal_label_for(std::env::consts::OS)
}

/// The label for a Node `process.platform`-style name.
pub fn reveal_label_for(os: &str) -> &'static str {
    match os {
        "windows" | "win32" => "Show in Explorer",
        "linux" => "Open Containing Folder",
        "macos" | "darwin" => "Reveal in Finder",
        // Anything else falls through to the generic label.
        _ => "Open Containing Folder",
    }
}

// ---- previews --------------------------------------------------------------

/// lib/shared/file-types.ts `IMAGE_EXTS`.
pub const IMAGE_EXTS: [&str; 11] = [
    "png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "bmp", "avif", "tiff", "tif",
];

/// lib/shared/file-types.ts `getPreviewType`'s two kinds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PreviewType {
    Image,
    Html,
}

/// lib/shared/file-types.ts `getPreviewType(path)`: by what follows the
/// path's last `.` (the whole path is split, folders included), lowered.
pub fn preview_type(path: &str) -> Option<PreviewType> {
    let ext = js_string::to_lower(path.rsplit('.').next().unwrap_or_default());
    if IMAGE_EXTS.contains(&ext.as_str()) {
        Some(PreviewType::Image)
    } else if ext == "html" || ext == "htm" {
        Some(PreviewType::Html)
    } else {
        None
    }
}

/// shiki.ts `BASENAME_TO_LANG`.
const BASENAME_TO_LANG: &[(&str, &str)] = &[
    ("package.json", "json"),
    ("package-lock.json", "json"),
    ("tsconfig.json", "jsonc"),
    ("jsconfig.json", "jsonc"),
    ("deno.json", "jsonc"),
    ("deno.jsonc", "jsonc"),
    ("bun.lock", "json"),
    ("bunfig.toml", "toml"),
    ("cargo.toml", "toml"),
    ("cargo.lock", "toml"),
    ("pyproject.toml", "toml"),
    ("pipfile", "toml"),
    ("gemfile", "ruby"),
    ("rakefile", "ruby"),
    ("podfile", "ruby"),
    ("fastfile", "ruby"),
    ("appfile", "ruby"),
    ("matchfile", "ruby"),
    ("scanfile", "ruby"),
    ("guardfile", "ruby"),
    ("berksfile", "ruby"),
    ("vagrantfile", "ruby"),
    ("build.gradle", "groovy"),
    ("build.gradle.kts", "kotlin"),
    ("settings.gradle", "groovy"),
    ("settings.gradle.kts", "kotlin"),
    ("cmakelists.txt", "cmake"),
    ("dockerfile", "dockerfile"),
    ("containerfile", "dockerfile"),
    ("makefile", "make"),
    ("gnumakefile", "make"),
    ("justfile", "make"),
    ("procfile", "yaml"),
    (".gitignore", "text"),
    (".gitattributes", "text"),
    (".dockerignore", "text"),
    (".npmignore", "text"),
    (".prettierignore", "text"),
    (".eslintignore", "text"),
    (".editorconfig", "ini"),
    (".env", "bash"),
    (".babelrc", "json"),
    (".eslintrc", "json"),
    (".eslintrc.json", "json"),
    (".prettierrc", "json"),
    (".prettierrc.json", "json"),
    (".nvmrc", "text"),
    (".node-version", "text"),
    (".python-version", "text"),
    (".ruby-version", "text"),
    (".tool-versions", "text"),
    ("readme", "markdown"),
    ("license", "text"),
    ("changelog", "markdown"),
    ("notice", "text"),
    ("authors", "text"),
    ("claude.md", "markdown"),
    ("agents.md", "markdown"),
];

/// shiki.ts `EXT_TO_LANG`.
const EXT_TO_LANG: &[(&str, &str)] = &[
    (".ts", "typescript"),
    (".d.ts", "typescript"),
    (".mts", "typescript"),
    (".cts", "typescript"),
    (".tsx", "tsx"),
    (".js", "javascript"),
    (".mjs", "javascript"),
    (".cjs", "javascript"),
    (".jsx", "jsx"),
    (".html", "html"),
    (".htm", "html"),
    (".xhtml", "html"),
    (".css", "css"),
    (".scss", "scss"),
    (".sass", "sass"),
    (".less", "less"),
    (".vue", "vue"),
    (".svelte", "svelte"),
    (".astro", "astro"),
    (".graphql", "graphql"),
    (".gql", "graphql"),
    (".json", "json"),
    (".jsonc", "jsonc"),
    (".json5", "json5"),
    (".yaml", "yaml"),
    (".yml", "yaml"),
    (".toml", "toml"),
    (".ini", "ini"),
    (".cfg", "ini"),
    (".conf", "ini"),
    (".properties", "properties"),
    (".xml", "xml"),
    (".svg", "xml"),
    (".plist", "xml"),
    (".csv", "csv"),
    (".tsv", "csv"),
    (".md", "markdown"),
    (".markdown", "markdown"),
    (".mdx", "mdx"),
    (".tex", "tex"),
    (".bib", "bibtex"),
    (".sh", "bash"),
    (".bash", "bash"),
    (".zsh", "bash"),
    (".ksh", "bash"),
    (".fish", "fish"),
    (".ps1", "powershell"),
    (".psm1", "powershell"),
    (".bat", "bat"),
    (".cmd", "bat"),
    (".awk", "awk"),
    (".c", "c"),
    (".h", "c"),
    (".cc", "cpp"),
    (".cpp", "cpp"),
    (".cxx", "cpp"),
    (".hpp", "cpp"),
    (".hxx", "cpp"),
    (".hh", "cpp"),
    (".cs", "csharp"),
    (".rs", "rust"),
    (".go", "go"),
    (".zig", "zig"),
    (".swift", "swift"),
    (".kt", "kotlin"),
    (".kts", "kotlin"),
    (".java", "java"),
    (".scala", "scala"),
    (".sc", "scala"),
    (".m", "objective-c"),
    (".mm", "objective-c"),
    (".py", "python"),
    (".pyi", "python"),
    (".pyw", "python"),
    (".rb", "ruby"),
    (".rake", "ruby"),
    (".gemspec", "ruby"),
    (".php", "php"),
    (".phtml", "php"),
    (".pl", "perl"),
    (".pm", "perl"),
    (".lua", "lua"),
    (".r", "r"),
    (".jl", "julia"),
    (".dart", "dart"),
    (".ex", "elixir"),
    (".exs", "elixir"),
    (".erl", "erlang"),
    (".hrl", "erlang"),
    (".hs", "haskell"),
    (".lhs", "haskell"),
    (".clj", "clojure"),
    (".cljs", "clojure"),
    (".cljc", "clojure"),
    (".edn", "clojure"),
    (".ml", "ocaml"),
    (".mli", "ocaml"),
    (".fs", "fsharp"),
    (".fsx", "fsharp"),
    (".fsi", "fsharp"),
    (".sql", "sql"),
    (".pls", "plsql"),
    (".pks", "plsql"),
    (".pkb", "plsql"),
    (".prisma", "prisma"),
    (".tf", "terraform"),
    (".tfvars", "terraform"),
    (".hcl", "hcl"),
    (".nginx", "nginx"),
    (".diff", "diff"),
    (".patch", "diff"),
    (".groovy", "groovy"),
    (".gvy", "groovy"),
    (".vim", "vim"),
    (".vimrc", "vim"),
    (".log", "text"),
    (".txt", "text"),
];

fn lookup(table: &[(&str, &'static str)], key: &str) -> Option<&'static str> {
    if key.is_empty() {
        return None;
    }
    table.iter().find(|(k, _)| *k == key).map(|(_, v)| *v)
}

/// shiki.ts:199 `languageForPath(path)`: the grammar a path highlights
/// with, `None` for none. Exact basename first, then the `Dockerfile*` /
/// `Makefile*` / `.env*` prefixes, then the longest dotted tail, then the
/// last extension. (A basename that names an `Object.prototype` member,
/// `constructor` say, makes the TS return a function, which it then
/// treats as no grammar: `None` here.)
pub fn language_for_path(path: &str) -> Option<&'static str> {
    if path.is_empty() {
        return None;
    }
    let base = path.rsplit('/').next().unwrap_or(path);
    let lower = js_string::to_lower(base);
    if let Some(l) = lookup(BASENAME_TO_LANG, &lower) {
        return Some(l);
    }
    if lower.starts_with("dockerfile") {
        return Some("dockerfile");
    }
    if lower.starts_with("makefile") || lower.starts_with("gnumakefile") {
        return Some("make");
    }
    if lower.starts_with(".env") {
        return Some("bash");
    }
    if let Some(dot) = lower.find('.') {
        if let Some(l) = lookup(EXT_TO_LANG, &lower[dot..]) {
            return Some(l);
        }
        if let Some(last) = lower.rfind('.')
            && last > 0
            && let Some(l) = lookup(EXT_TO_LANG, &lower[last..])
        {
            return Some(l);
        }
    }
    None
}

/// The editor's grammar: [`language_for_path`], `text` (no highlighting)
/// when there is none, as `HighlightedEditor`'s `data-lang`.
pub fn editor_language(path: &str) -> &'static str {
    language_for_path(path).unwrap_or("text")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_tables_hold_the_ts_entries() {
        assert_eq!(BASENAME_TO_LANG.len(), 58);
        assert_eq!(EXT_TO_LANG.len(), 117);
    }
}
