//! `GET /api/sessions/search` (`app/api/sessions/search/route.ts`): full-text
//! search across one workspace's raw `.jsonl` transcripts, the Sessions
//! page's "search inside the messages". The route lives in
//! `claudius-server`'s `session_search.rs`; everything it decides is here.
//!
//! What it scans: `projectRoot(dir)`, i.e. `homedir()/.claude/projects/` +
//! `encodeProjectDir(dir)` (every non-alphanumeric UTF-16 unit a `-`), under
//! `path.resolve`. That is `homedir()`, not `$CLAUDE_CONFIG_DIR`, and the
//! name is never hashed the way the SDK hashes cwds over 200 encoded chars,
//! as in TS. The encoded name is one `[A-Za-z0-9-]+` segment, so `dir` can't
//! climb out (`../..` is just `------`), and `assertWithin`'s refusal
//! ("invalid dir") is unreachable but kept.
//!
//! Which files: the folder's names (`readdir`: raw-byte order) that end in
//! `.jsonl`, each `stat`ed (following symlinks; any failure is mtime 0),
//! stable-sorted newest first by Node's `mtimeMs` double (ties keep name
//! order; 0 and pre-1970 times sort last), then cut to [`MAX_FILES`]. Names
//! that aren't a plain id (`^[A-Za-z0-9][A-Za-z0-9_-]*$` before `.jsonl`)
//! are dropped only after the cut, so they still take slots. Containment is
//! lexical (`resolve`, then `startsWith(base + "/")` right above each fs
//! call): a symlinked transcript is read wherever it points, as in TS. A
//! file that can't be read (unreadable, a directory, a dangling link) is
//! skipped, and so is one Node can't hold as a string (over 2 GiB, or over
//! V8's 2^29 − 24 units once decoded).
//!
//! The match: TS escapes the query (MDN's metacharacter escape) and runs
//! `new RegExp(escaped, "gi").exec(text)` on the lossily decoded text. Here
//! no regex is built: [`find`] is a linear scan for the query as a literal
//! under the `i` flag's rule *without* `u`, the ECMAScript `Canonicalize`
//! that V8 implements per UTF-16 unit ([`canonicalize`]): a unit's full
//! `toUpperCase` if that is one unit, unless it would map a non-ASCII unit
//! to ASCII. So `σ`/`ς`/`Σ`, `µ`/`μ`/`Μ` and `ǅ`/`ǆ`/`Ǆ` match each other;
//! `ß` (upper `SS`) matches only itself and not `ẞ`; `ı`, `ſ` and the
//! Kelvin sign don't match `i`/`s`/`k`; `İ` doesn't match `i`; `ΐ` and
//! `ﬁ` match only themselves; astral letters (`𐐀`/`𐐨`) are compared unit by
//! unit, so only exactly. That is not Unicode simple case folding (the `u`
//! flag), which would fold `ſ`, `K`, `ẞ`.
//!
//! The snippet ([`snippet`]): [`SNIPPET_RADIUS`] UTF-16 units each side of
//! the match, so the window can split a surrogate pair (the lone half is
//! kept and `JSON.stringify` prints it as `\udxxx`); the raw JSONL escapes
//! `\n` `\r` `\t` → space, `\"` → `"`, `\\` → `\` (three passes in that
//! order: `\\n` becomes `\ `), JS-whitespace runs → one space, trimmed, and
//! `…` on each side the window doesn't reach the end of.
//!
//! The order of the answer: TS reads [`CONCURRENCY`] files at a time and
//! pushes matches as reads complete, then keeps the first `limit`. Here the
//! answer is the first `limit` matches in scan order (newest first), which
//! is what TS answers whenever reads complete in the order they start (the
//! golden pins that with one libuv thread); under load TS can answer a big
//! file's match after a smaller, older one's.

use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use claudius_agent::js;

use crate::{node_fs, node_path, paths};

/// UTF-16 units of context on each side of the match.
pub const SNIPPET_RADIUS: usize = 60;
/// The newest this many `.jsonl` names are scanned.
pub const MAX_FILES: usize = 600;
/// Files read at once.
pub const CONCURRENCY: usize = 8;
/// Node's `kIoMaxLength`: `readFile` refuses a bigger regular file
/// (`ERR_FS_FILE_TOO_LARGE`) before reading it.
pub const IO_MAX_LENGTH: u64 = (1 << 31) - 1;
/// V8's `String::kMaxLength` (64-bit): a longer decoded text throws.
pub const MAX_STRING_LENGTH: usize = (1 << 29) - 24;

/// What node can read into a string: `readFile`'s size refusal and V8's
/// string length ([`Limits::NODE`]; tests shrink them).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    pub io_max: u64,
    pub max_units: usize,
}

impl Limits {
    pub const NODE: Limits = Limits {
        io_max: IO_MAX_LENGTH,
        max_units: MAX_STRING_LENGTH,
    };
}

const ELLIPSIS: u16 = 0x2026;
const BACKSLASH: u16 = b'\\' as u16;
const SPACE: u16 = b' ' as u16;

/// ECMAScript `Canonicalize(ch)` for a non-`u` `i` regex, as V8 runs it on
/// a UTF-16 unit: `toUpperCase` of the one-unit string, kept if it is one
/// unit and doesn't take a non-ASCII unit to ASCII; else the unit itself (a
/// lone surrogate is itself).
pub fn canonicalize(unit: u16) -> u16 {
    table()[usize::from(unit)]
}

fn canonicalize_slow(unit: u16) -> u16 {
    let Some(c) = char::from_u32(u32::from(unit)) else {
        return unit;
    };
    let mut upper = c.to_uppercase();
    let (Some(u), None) = (upper.next(), upper.next()) else {
        return unit;
    };
    match u16::try_from(u32::from(u)) {
        Ok(cu) if unit < 128 || cu >= 128 => cu,
        _ => unit,
    }
}

fn table() -> &'static [u16] {
    static TABLE: std::sync::OnceLock<Vec<u16>> = std::sync::OnceLock::new();
    TABLE.get_or_init(|| (0..=u16::MAX).map(canonicalize_slow).collect())
}

/// `new RegExp(escape(query), "gi").exec(text).index`: the first UTF-16
/// index where every unit of `query` matches under [`canonicalize`] (a
/// linear KMP scan, never a pattern). An empty query matches at 0.
pub fn find(text: &[u16], query: &[u16]) -> Option<usize> {
    find_units(text.iter().copied(), query)
}

fn find_units(text: impl Iterator<Item = u16>, query: &[u16]) -> Option<usize> {
    let needle: Vec<u16> = query.iter().map(|&u| canonicalize(u)).collect();
    if needle.is_empty() {
        return Some(0);
    }
    // KMP failure table over the canonical needle.
    let mut fail = vec![0usize; needle.len()];
    let mut k = 0;
    for i in 1..needle.len() {
        while k > 0 && needle[i] != needle[k] {
            k = fail[k - 1];
        }
        if needle[i] == needle[k] {
            k += 1;
        }
        fail[i] = k;
    }
    let mut k = 0;
    for (i, unit) in text.enumerate() {
        let unit = canonicalize(unit);
        while k > 0 && unit != needle[k] {
            k = fail[k - 1];
        }
        if unit == needle[k] {
            k += 1;
            if k == needle.len() {
                return Some(i + 1 - k);
            }
        }
    }
    None
}

/// The snippet window `[start, end)` around a match of `len` units at
/// `index` in a text of `total` units.
fn window(index: usize, len: usize, total: usize) -> (usize, usize) {
    (
        index.saturating_sub(SNIPPET_RADIUS),
        (index + len + SNIPPET_RADIUS).min(total),
    )
}

/// The TS snippet for a match of `len` units at `index` in `text`.
pub fn snippet(text: &[u16], index: usize, len: usize) -> Vec<u16> {
    let (start, end) = window(index, len, text.len());
    clean(&text[start..end], start > 0, end < text.len())
}

/// `.replace(/\\X/g, to)`: each `\` + `x` pair, left to right without
/// overlap, becomes `to`.
fn unescape(s: &[u16], x: &[u8], to: u16) -> Vec<u16> {
    let mut out = Vec::with_capacity(s.len());
    let mut i = 0;
    while i < s.len() {
        if s[i] == BACKSLASH
            && s.get(i + 1)
                .is_some_and(|&n| x.iter().any(|&b| u16::from(b) == n))
        {
            out.push(to);
            i += 2;
        } else {
            out.push(s[i]);
            i += 1;
        }
    }
    out
}

fn is_space(unit: u16) -> bool {
    // Every JS whitespace character is in the BMP; a surrogate never is one.
    char::from_u32(u32::from(unit)).is_some_and(js::is_whitespace)
}

/// The window's text as the TS cleans it, with the `…` marks.
fn clean(window: &[u16], before: bool, after: bool) -> Vec<u16> {
    let s = unescape(window, b"nrt", SPACE);
    let s = unescape(&s, b"\"", u16::from(b'"'));
    let s = unescape(&s, b"\\", BACKSLASH);
    // `.replace(/\s+/g, " ").trim()`
    let mut out = Vec::with_capacity(s.len() + 2);
    if before {
        out.push(ELLIPSIS);
    }
    let body = out.len();
    let mut gap = false;
    for u in s {
        if is_space(u) {
            gap = true;
            continue;
        }
        if gap && out.len() > body {
            out.push(SPACE);
        }
        gap = false;
        out.push(u);
    }
    if after {
        out.push(ELLIPSIS);
    }
    out
}

/// `Math.min(200, Math.max(1, Number(raw ?? "100") || 100))`, as the count
/// `matches.slice(0, limit)` keeps (a fraction truncates).
pub fn limit(raw: Option<&str>) -> usize {
    let n = js::to_number(raw.unwrap_or("100"));
    let n = if n.is_nan() || n == 0.0 { 100.0 } else { n };
    n.clamp(1.0, 200.0) as usize
}

/// `projectRoot(dir)`: `assertWithin(join(home, ".claude", "projects"),
/// encodeProjectDir(dir))`, or `None` where it throws `PathInjectionError`.
pub fn project_base(home: &str, dir: &str) -> Option<String> {
    let base = node_path::resolve(&[&node_path::join(&[home, ".claude", "projects"])]);
    let child = node_path::resolve(&[&base, &paths::encode_project_dir(dir)]);
    // The child is one non-empty `[A-Za-z0-9-]+` segment, so it is never the
    // base itself and always under it; TS's empty, NUL and equality tests
    // can't fire.
    child.starts_with(&format!("{base}/")).then_some(child)
}

/// The `.jsonl` names under `base` in scan order: newest `mtimeMs` first,
/// ties in `readdir` order, at most [`MAX_FILES`]. Empty when `base` can't
/// be listed.
pub fn list_files(base: &str) -> Vec<String> {
    let Ok(names) = node_fs::readdir(base) else {
        return Vec::new();
    };
    let under = format!("{base}/");
    let mut files: Vec<(String, f64)> = names
        .into_iter()
        .filter(|n| n.ends_with(".jsonl"))
        .map(|name| {
            let target = node_path::resolve(&[base, &name]);
            if !target.starts_with(&under) {
                return (name, 0.0);
            }
            let mtime = std::fs::metadata(&target)
                .and_then(|m| m.modified())
                .map_or(0.0, node_fs::mtime_ms);
            (name, mtime)
        })
        .collect();
    // `sort((a, b) => b.mtime - a.mtime)`: stable, and the times are finite.
    files.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    files.truncate(MAX_FILES);
    files.into_iter().map(|(name, _)| name).collect()
}

/// One `SessionContentMatch`; `snippet` is UTF-16 since it can hold a lone
/// surrogate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Match {
    pub session_id: String,
    pub snippet: Vec<u16>,
}

/// `^[A-Za-z0-9][A-Za-z0-9_-]*$`
fn is_session_id(id: &str) -> bool {
    let b = id.as_bytes();
    b.first().is_some_and(u8::is_ascii_alphanumeric)
        && b.iter()
            .all(|c| c.is_ascii_alphanumeric() || *c == b'_' || *c == b'-')
}

/// One worker step: `name`'s match, if it is a plain id that reads and
/// holds `query`.
fn scan_file(base: &str, name: &str, query: &[u16], limits: Limits) -> Option<Match> {
    let session_id = name.strip_suffix(".jsonl")?;
    if !is_session_id(session_id) {
        return None;
    }
    // Inline path-injection barrier at the sinks: resolve under the base and
    // confirm containment.
    let target = node_path::resolve(&[base, name]);
    if !target.starts_with(&format!("{base}/")) {
        return None;
    }
    // `readFile(target, "utf8")`: open, fstat (a regular file over 2 GiB is
    // refused unread), read, decode lossily (a BOM is kept).
    let file = std::fs::File::open(&target).ok()?;
    let meta = file.metadata().ok()?;
    if meta.is_file() && meta.len() > limits.io_max {
        return None;
    }
    // Every 3 bytes decode to at least one unit, so a text cut at this many
    // bytes is already too long for V8, as the whole one would be; the cap
    // keeps an endless file (a link to a device) from being read forever,
    // where node reads until the string overflows.
    let cap = 3 * (limits.max_units as u64 + 1);
    let mut bytes = Vec::new();
    std::io::Read::read_to_end(&mut std::io::Read::take(file, cap), &mut bytes).ok()?;
    let text = String::from_utf8_lossy(&bytes);
    let total: usize = text.chars().map(char::len_utf16).sum();
    if total > limits.max_units {
        return None;
    }
    let index = find_units(text.encode_utf16(), query)?;
    let (start, end) = window(index, query.len(), total);
    let units: Vec<u16> = text.encode_utf16().skip(start).take(end - start).collect();
    Some(Match {
        session_id: session_id.to_owned(),
        snippet: clean(&units, start > 0, end < total),
    })
}

/// The route's search over `base`: the first `limit` matching files in
/// scan order, read [`CONCURRENCY`] at a time. Workers stop taking files
/// once `limit` matches are in, and every file before the cursor has been
/// read by then, so the first `limit` by index are the answer.
pub fn search_in(base: &str, query: &str, limit: usize) -> Vec<Match> {
    search_with(base, query, limit, Limits::NODE)
}

fn search_with(base: &str, query: &str, limit: usize, limits: Limits) -> Vec<Match> {
    let files = list_files(base);
    let query: Vec<u16> = query.encode_utf16().collect();
    let cursor = AtomicUsize::new(0);
    let found = AtomicUsize::new(0);
    let hits = Mutex::new(Vec::new());
    std::thread::scope(|s| {
        for _ in 0..CONCURRENCY.min(files.len()) {
            s.spawn(|| {
                while found.load(Ordering::SeqCst) < limit {
                    let i = cursor.fetch_add(1, Ordering::SeqCst);
                    let Some(name) = files.get(i) else { break };
                    if let Some(m) = scan_file(base, name, &query, limits) {
                        hits.lock().unwrap().push((i, m));
                        found.fetch_add(1, Ordering::SeqCst);
                    }
                }
            });
        }
    });
    let mut hits = hits.into_inner().unwrap();
    hits.sort_by_key(|(i, _)| *i);
    hits.into_iter().take(limit).map(|(_, m)| m).collect()
}

/// `JSON.stringify({ matches })`.
pub fn matches_json(matches: &[Match]) -> String {
    let mut out = String::from(r#"{"matches":["#);
    for (i, m) in matches.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str(r#"{"sessionId":"#);
        out.push_str(&js::stringify(&serde_json::Value::from(
            m.session_id.as_str(),
        )));
        out.push_str(r#","snippet":"#);
        js::stringify_utf16(&m.snippet, &mut out);
        out.push('}');
    }
    out.push_str("]}");
    out
}

/// The whole handler on the `searchParams.get` values: status and JSON body.
/// `home` is `os.homedir()`.
pub fn respond(
    home: &str,
    q: Option<&str>,
    dir: Option<&str>,
    raw_limit: Option<&str>,
) -> (u16, String) {
    let q = q.unwrap_or_default();
    let dir = dir.unwrap_or_default();
    let limit = limit(raw_limit);
    if js::trim(q).is_empty() {
        return (200, r#"{"matches":[]}"#.into());
    }
    if dir.is_empty() {
        return (400, r#"{"error":"dir is required"}"#.into());
    }
    let Some(base) = project_base(home, dir) else {
        return (400, r#"{"error":"invalid dir"}"#.into());
    };
    (200, matches_json(&search_in(&base, q, limit)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> Vec<u16> {
        s.encode_utf16().collect()
    }

    #[test]
    fn canonicalize_follows_to_upper_case_with_the_two_refusals() {
        for (c, want) in [
            ('a', 'A'),
            ('A', 'A'),
            ('σ', 'Σ'),
            ('ς', 'Σ'),
            ('µ', 'Μ'),
            ('ǅ', 'Ǆ'),
            ('ß', 'ß'),
            ('ẞ', 'ẞ'),
            ('ı', 'ı'),
            ('ſ', 'ſ'),
            ('\u{212a}', '\u{212a}'),
            ('İ', 'İ'),
            ('ΐ', 'ΐ'),
            ('ﬁ', 'ﬁ'),
            ('ꭰ', 'Ꭰ'),
            ('ა', 'Ა'),
        ] {
            assert_eq!(canonicalize(c as u16), want as u16, "{c}");
        }
        assert_eq!(canonicalize(0xd801), 0xd801, "a surrogate is itself");
    }

    #[test]
    fn find_is_literal_and_linear() {
        assert_eq!(find(&u("Hello WORLD"), &u("world")), Some(6));
        assert_eq!(find(&u("a.b"), &u(".")), Some(1));
        assert_eq!(find(&u("axb"), &u("a.b")), None);
        assert_eq!(find(&u("ΟΔΟΣ"), &u("οδος")), Some(0));
        assert_eq!(find(&u("straße"), &u("STRASSE")), None);
        assert_eq!(find(&u("x𐐀"), &u("𐐨")), None);
        assert_eq!(find(&u("x𐐀"), &u("𐐀")), Some(1));
        assert_eq!(find(&u("abc"), &u("")), Some(0));
        // KMP restarts inside a partial match.
        assert_eq!(find(&u("aabaabaaab"), &u("AABAAAB")), Some(3));
        assert_eq!(find(&u("aabaabaab"), &u("aabaaab")), None);
        assert_eq!(find(&u("aabaabaaabaaab"), &u("aaab")), Some(6));
        assert_eq!(find(&u("abababc"), &u("ababc")), Some(2));
        // The failure table falls back through a non-zero prefix.
        assert_eq!(find(&u("aabaaabaaaa"), &u("aabaaaa")), Some(4));
        let long = "a".repeat(200_000);
        assert_eq!(find(&u(&long), &u(&format!("{}b", "a".repeat(5000)))), None);
    }

    #[test]
    fn snippets_unescape_in_pass_order_and_mark_cuts() {
        let s = |t: &str, q: &str| {
            let t = u(t);
            let i = find(&t, &u(q)).unwrap();
            String::from_utf16_lossy(&snippet(&t, i, q.encode_utf16().count()))
        };
        assert_eq!(s(r#"a\nb\"c\\d\\ne"#, "c"), r#"a b"c\d\ e"#);
        assert_eq!(s(" \t x  y\u{85}z\u{feff} ", "x"), "x y\u{85}z");
        let long = format!("{}Mid{}", "a".repeat(70), "b".repeat(70));
        assert_eq!(
            s(&long, "mid"),
            format!("…{}Mid{}…", "a".repeat(60), "b".repeat(60))
        );
        assert_eq!(
            s(&format!("{}x", "a".repeat(60)), "x"),
            format!("{}x", "a".repeat(60))
        );
        assert_eq!(
            s(&format!("{}x", "a".repeat(61)), "x"),
            format!("…{}x", "a".repeat(60))
        );
    }

    #[test]
    fn limit_coerces_like_the_route() {
        for (raw, want) in [
            (None, 100),
            (Some(""), 100),
            (Some("0"), 100),
            (Some("abc"), 100),
            (Some("-3"), 1),
            (Some("0.5"), 1),
            (Some("2.9"), 2),
            (Some("1e3"), 200),
            (Some("Infinity"), 200),
            (Some("0x10"), 16),
        ] {
            assert_eq!(limit(raw), want, "{raw:?}");
        }
    }

    #[test]
    fn the_base_is_the_resolved_encoded_project_dir() {
        assert_eq!(
            project_base("/h", "/w/x.y").as_deref(),
            Some("/h/.claude/projects/-w-x-y")
        );
        assert_eq!(
            project_base("/h/../h2/", "../..").as_deref(),
            Some("/h2/.claude/projects/-----")
        );
        assert_eq!(
            project_base("/h", "😀").as_deref(),
            Some("/h/.claude/projects/--")
        );
    }

    fn ids(matches: Vec<Match>) -> Vec<String> {
        matches.into_iter().map(|m| m.session_id).collect()
    }

    #[cfg(unix)]
    #[test]
    fn reads_stop_where_node_cannot_hold_the_text() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().to_str().unwrap().to_owned();
        std::fs::write(dir.path().join("ten.jsonl"), "needle1234").unwrap();
        std::fs::write(dir.path().join("wide.jsonl"), "n€€€").unwrap();
        std::fs::write(dir.path().join("long.jsonl"), "€€€€x").unwrap();
        std::os::unix::fs::symlink("/dev/zero", dir.path().join("zero.jsonl")).unwrap();
        let find = |io_max, max_units, q: &str| {
            ids(search_with(&base, q, 100, Limits { io_max, max_units }))
        };
        assert_eq!(find(10, 10, "needle"), ["ten"]);
        assert!(find(9, 10, "needle").is_empty(), "10 bytes: refused unread");
        assert!(find(10, 9, "needle").is_empty(), "10 units: too long");
        // 10 bytes, 4 units: under the 15-byte cap, so read whole.
        assert_eq!(find(100, 4, "€€€"), ["wide"]);
        assert!(find(100, 3, "€€€").is_empty());
        // 13 bytes, 5 units: too long, even though its first 12 bytes aren't.
        assert!(find(100, 4, "€€€€").is_empty());
        assert_eq!(find(100, 5, "€€€€"), ["long"]);
        // An endless file is cut at the cap, and that is too long.
        assert!(find(100, 4, "\0").is_empty());
        assert_eq!(Limits::NODE.max_units, 536_870_888);
        assert_eq!(Limits::NODE.io_max, 2_147_483_647);
    }

    #[test]
    fn the_answer_is_the_first_matches_in_scan_order() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().to_str().unwrap().to_owned();
        let mut want = Vec::new();
        for i in 0..40u64 {
            let p = dir.path().join(format!("f{i:02}.jsonl"));
            std::fs::write(&p, if i % 3 == 0 { "miss" } else { "a hit" }).unwrap();
            let t = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000 + i);
            std::fs::File::open(&p)
                .unwrap()
                .set_times(std::fs::FileTimes::new().set_modified(t))
                .unwrap();
            if i % 3 != 0 {
                want.insert(0, format!("f{i:02}"));
            }
        }
        std::fs::write(dir.path().join("f99.txt"), "a hit").unwrap();
        for _ in 0..20 {
            assert_eq!(ids(search_in(&base, "HIT", 5)), want[..5]);
            assert_eq!(ids(search_in(&base, "hit", 200)), want);
            assert_eq!(ids(search_in(&base, "hit", 1)), want[..1]);
        }
        assert_eq!(list_files(&base).len(), 40);
        assert!(search_in(&format!("{base}/nope"), "hit", 5).is_empty());
    }

    #[test]
    fn session_ids_are_plain_tokens() {
        for ok in ["a", "A9", "a_b-c", "0-"] {
            assert!(is_session_id(ok), "{ok}");
        }
        for bad in ["", "-a", "_a", "a.b", "a b", "é", "a\n"] {
            assert!(!is_session_id(bad), "{bad:?}");
        }
    }
}
