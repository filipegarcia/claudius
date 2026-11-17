//! `lib/server/auto-memory.ts`: Claude Code's per-project auto-memory
//! directory, `homedir()/.claude/projects/<encodeProjectDir(cwd)>/memory`
//! (the home dir, not the CLI's config dir), and the `memory-update`
//! reminder (session.ts `MemoryUpdate` / `memoryUpdateReminderBody`) the
//! `/api/memory/auto` route fans out to the live sessions in that cwd.
//! Replayed against the TS in `tests/memory_golden.rs`.
//!
//! * Listing: `readdir` (raw-byte order), every `*.md` name `stat`ed
//!   (following symlinks; a failure skips the entry), stable-sorted by
//!   `mtimeMs` descending.
//! * Names: `^[\w.\-]+\.md$` (ASCII), checked before any disk access, so
//!   `..`, separators (also once a query's `%2F` is decoded), absolute
//!   paths and NUL never reach the disk. The directory comes from
//!   `encodeProjectDir`, which leaves only `[A-Za-z0-9-]`.
//! * Writes: a new file is created exclusively (`wx`: an existing name, a
//!   directory or any symlink, even a dangling one, is a 409), with the
//!   front matter `name` / `description` / `type` / `modified` and the
//!   `MEMORY.md` index line appended (refused, and the file removed again,
//!   past [`MEMORY_INDEX_READ_LIMIT_BYTES`] of loaded index text). A patch
//!   keeps `name` and rewrites the file and, when the description changes,
//!   the first index line naming the file.
//! * The values a patch takes are JSON values coerced as TS does: `??`
//!   keeps `0` / `false` / `""`, `String()` / `+` print them, and
//!   `yamlScalar` on a non-string either `JSON.stringify`s it (when its
//!   text has a risky character) or throws V8's `TypeError`.
//!
//! Like TS, symlinks inside the directory (and the directory itself being
//! one) are followed by reads, patches and listings. Every call that takes
//! a request-supplied name also checks, right before its fs call, that the
//! resolved target sits under the resolved directory (the CLAUDE.md
//! containment form); the name check already guarantees it.

use std::io;

use claudius_agent::js;
use serde_json::{Map, Value};

use crate::node_fs::{self, FsError};
use crate::{js_string, node_path, safe_path};

pub use crate::paths::encode_project_dir;

/// `MEMORY_INDEX_READ_LIMIT_BYTES`.
pub const MEMORY_INDEX_READ_LIMIT_BYTES: usize = 20_000;

/// The memory types `writeMemoryFile` / `patchMemoryFile` accept.
pub const MEMORY_TYPES: [&str; 4] = ["user", "feedback", "project", "reference"];

/// What a TS call threw instead of returning.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Thrown {
    /// A rejected `fs` call (an `Error` with Node's `code` and `message`).
    Fs(FsError),
    /// V8's `TypeError`, by message.
    Type(String),
    /// `PathInjectionError` (`lib/server/safe-path.ts`), by message.
    PathInjection(String),
}

impl Thrown {
    /// The error's `name`.
    pub fn name(&self) -> &'static str {
        match self {
            Thrown::Fs(_) => "Error",
            Thrown::Type(_) => "TypeError",
            Thrown::PathInjection(_) => "PathInjectionError",
        }
    }

    /// Node's `err.code`, for an fs error.
    pub fn code(&self) -> Option<&str> {
        match self {
            Thrown::Fs(e) => e.code.as_deref(),
            _ => None,
        }
    }

    /// The error's `message`.
    pub fn message(&self) -> &str {
        match self {
            Thrown::Fs(e) => &e.message,
            Thrown::Type(m) | Thrown::PathInjection(m) => m,
        }
    }
}

impl std::fmt::Display for Thrown {
    /// `${err.name}: ${err.message}`, as Node prints an uncaught error.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.name(), self.message())
    }
}

impl From<FsError> for Thrown {
    fn from(e: FsError) -> Thrown {
        Thrown::Fs(e)
    }
}

/// A `{ ok: false, status, error }` result.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refusal {
    pub status: u16,
    pub error: String,
}

impl Refusal {
    pub fn new(status: u16, error: impl Into<String>) -> Refusal {
        Refusal {
            status,
            error: error.into(),
        }
    }
}

/// A call that returns `{ ok: true, … }` or `{ ok: false, status, error }`,
/// or throws.
pub type Outcome<T> = Result<Result<T, Refusal>, Thrown>;

/// `autoMemoryDir(projectCwd)` under `home` (`homedir()`).
pub fn auto_memory_dir(home: &str, cwd: &str) -> String {
    node_path::join(&[
        home,
        ".claude",
        "projects",
        &encode_project_dir(cwd),
        "memory",
    ])
}

/// A `MemoryFile` (also the rules routes' `RuleFile`).
#[derive(Clone, Debug, PartialEq)]
pub struct MemoryFile {
    pub name: String,
    pub path: String,
    pub size: u64,
    /// Node's `stat.mtimeMs`.
    pub modified_ms: f64,
}

impl MemoryFile {
    /// `{ name, path, size, modifiedMs }`.
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("name".into(), Value::String(self.name.clone()));
        m.insert("path".into(), Value::String(self.path.clone()));
        m.insert("size".into(), Value::from(self.size));
        m.insert(
            "modifiedMs".into(),
            serde_json::Number::from_f64(self.modified_ms).map_or(Value::Null, Value::Number),
        );
        Value::Object(m)
    }
}

/// Node's `stat.mtimeMs`: the double `sec * 1e3 + nsec / 1e6`.
pub(crate) fn mtime_ms(meta: &std::fs::Metadata) -> f64 {
    use std::time::UNIX_EPOCH;
    let nanos = match meta.modified() {
        Ok(t) => match t.duration_since(UNIX_EPOCH) {
            Ok(d) => d.as_nanos() as i128,
            Err(e) => -(e.duration().as_nanos() as i128),
        },
        Err(_) => 0,
    };
    let (sec, nsec) = (
        nanos.div_euclid(1_000_000_000),
        nanos.rem_euclid(1_000_000_000),
    );
    sec as f64 * 1e3 + nsec as f64 / 1e6
}

/// `fs.readdir(dir)`: the names in raw-byte order (libuv's `scandir`
/// sorts with `strcmp`), decoded with U+FFFD for invalid UTF-8.
fn read_dir_names(dir: &str) -> Result<Vec<String>, FsError> {
    let fail = |e: &io::Error| FsError::new(e, "scandir", Some(dir), None);
    let mut raw: Vec<Vec<u8>> = Vec::new();
    for entry in std::fs::read_dir(dir).map_err(|e| fail(&e))? {
        let entry = entry.map_err(|e| fail(&e))?;
        raw.push(name_bytes(&entry.file_name()));
    }
    raw.sort();
    Ok(raw
        .into_iter()
        .map(|n| String::from_utf8_lossy(&n).into_owned())
        .collect())
}

#[cfg(unix)]
fn name_bytes(name: &std::ffi::OsStr) -> Vec<u8> {
    use std::os::unix::ffi::OsStrExt;
    name.as_bytes().to_vec()
}

#[cfg(not(unix))]
fn name_bytes(name: &std::ffi::OsStr) -> Vec<u8> {
    name.to_string_lossy().into_owned().into_bytes()
}

/// `listAutoMemory` / `listRules` over `dir`: a missing directory is empty.
pub(crate) fn list_md_files(dir: &str) -> Result<Vec<MemoryFile>, FsError> {
    let names = match read_dir_names(dir) {
        Ok(n) => n,
        Err(e) if e.is_not_found() => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    let mut out: Vec<MemoryFile> = Vec::new();
    for name in names {
        if !name.ends_with(".md") {
            continue;
        }
        let path = node_path::join(&[dir, &name]);
        if let Ok(meta) = std::fs::metadata(&path) {
            out.push(MemoryFile {
                size: meta.len(),
                modified_ms: mtime_ms(&meta),
                name,
                path,
            });
        }
    }
    // `out.sort((a, b) => b.modifiedMs - a.modifiedMs)`: stable.
    out.sort_by(|a, b| b.modified_ms.total_cmp(&a.modified_ms));
    Ok(out)
}

/// `listAutoMemory(projectCwd)`.
pub fn list_auto_memory(home: &str, cwd: &str) -> Result<Vec<MemoryFile>, FsError> {
    list_md_files(&auto_memory_dir(home, cwd))
}

/// `/^[\w.\-]+\.md$/` (also `isValidRuleFilename`).
pub fn is_valid_memory_filename(name: &str) -> bool {
    name.len() > 3
        && name.ends_with(".md")
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
}

/// `readMemoryFile(projectCwd, name)`: `None` for an invalid name or a
/// missing file.
pub fn read_memory_file(home: &str, cwd: &str, name: &str) -> Result<Option<String>, FsError> {
    if !is_valid_memory_filename(name) {
        return Ok(None);
    }
    let base = node_path::resolve(&[&auto_memory_dir(home, cwd)]);
    let target = node_path::resolve(&[&base, name]);
    if !target.starts_with(&format!("{base}/")) {
        return Ok(None);
    }
    match node_fs::read_to_string(&target) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.is_not_found() => Ok(None),
        Err(e) => Err(e),
    }
}

/// `yamlScalar(value)`: `value` as it is when it's a plain safe scalar,
/// else `JSON.stringify(value)`.
pub fn yaml_scalar(value: &str) -> String {
    let risky = value.is_empty()
        || value.contains(RISKY)
        || js::trim(value) != value
        || value.starts_with(RISKY_FIRST);
    if risky {
        js::stringify(&Value::String(value.to_owned()))
    } else {
        value.to_owned()
    }
}

/// `/[:#\n\r"'\\]/`
const RISKY: [char; 7] = [':', '#', '\n', '\r', '"', '\'', '\\'];
/// `/^[-?&*!|>%@`[\]{},]/`
const RISKY_FIRST: [char; 15] = [
    '-', '?', '&', '*', '!', '|', '>', '%', '@', '`', '[', ']', '{', '}', ',',
];

/// `String(v)` (and `"…" + v`) for a JSON value ([`js_string::to_js_string`]):
/// an object with an own `toString` key throws V8's `TypeError`, also as an
/// array item.
fn string_of(v: &Value) -> Result<String, Thrown> {
    js_string::to_js_string(v)
        .map_err(|_| Thrown::Type("Cannot convert object to primitive value".into()))
}

/// `yamlScalar(value)` for any JSON value: a string as [`yaml_scalar`]; any
/// other value is `JSON.stringify`ed when its `String()` holds a character
/// of `/[:#\n\r"'\\]/`, and otherwise reaches `value.trim()`, which it
/// doesn't have.
fn yaml_scalar_value(value: &Value) -> Result<String, Thrown> {
    match value {
        Value::String(s) => Ok(yaml_scalar(s)),
        v if string_of(v)?.contains(RISKY) => Ok(js::stringify(v)),
        _ => Err(Thrown::Type("value.trim is not a function".into())),
    }
}

/// `new Date(ms).toISOString()`.
fn iso_string(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .unwrap_or_default()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

/// `fs.writeFile(path, text, { flag: "wx" })`: created (mode 0666, less the
/// umask), never through an existing entry; `EEXIST` when there is one.
pub(crate) fn write_new(path: &str, text: &str) -> Result<(), FsError> {
    use std::io::Write;
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut o, 0o666);
    let mut f = o
        .open(path)
        .map_err(|e| FsError::new(&e, "open", Some(path), None))?;
    f.write_all(text.as_bytes())
        .map_err(|e| FsError::new(&e, "write", None, None))
}

/// `fs.writeFile(path, text, "utf8")`.
pub(crate) fn write_text(path: &str, text: &str) -> Result<(), FsError> {
    node_fs::write_file(path, text, 0o666)
}

/// `fs.unlink(path)`.
pub(crate) fn unlink(path: &str) -> Result<(), FsError> {
    std::fs::remove_file(path).map_err(|e| FsError::new(&e, "unlink", Some(path), None))
}

/// `WriteMemoryInput`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WriteMemoryInput {
    pub filename: String,
    pub type_: String,
    pub name: String,
    pub description: String,
    pub body: String,
}

/// `{ ok: true, name, path }`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Written {
    pub name: String,
    pub path: String,
}

/// `writeMemoryFile(projectCwd, input)` at `now_ms` (`new Date()`).
pub fn write_memory_file(
    home: &str,
    cwd: &str,
    input: &WriteMemoryInput,
    now_ms: i64,
) -> Outcome<Written> {
    if !is_valid_memory_filename(&input.filename) {
        return Ok(Err(Refusal::new(400, "invalid filename")));
    }
    if js::trim(&input.name).is_empty() || js::trim(&input.description).is_empty() {
        return Ok(Err(Refusal::new(400, "name and description required")));
    }
    if !MEMORY_TYPES.contains(&input.type_.as_str()) {
        return Ok(Err(Refusal::new(400, "invalid type")));
    }
    let dir = auto_memory_dir(home, cwd);
    node_fs::mkdir_recursive(&dir, 0o777)?;
    let target = safe_path::assert_within(&dir, &input.filename)
        .map_err(|m| Thrown::PathInjection(m.into()))?;
    // The barrier again, inline above the sink (CodeQL doesn't carry it
    // out of the call). The name passed `isValidMemoryFilename`, so it
    // never resolves to `dir` itself, which `assertWithin` would allow.
    let base = node_path::resolve(&[&dir]);
    if !target.starts_with(&format!("{base}/")) {
        return Err(Thrown::PathInjection("path escapes base directory".into()));
    }
    let content = format!(
        "---\nname: {}\ndescription: {}\ntype: {}\nmodified: {}\n---\n\n{}",
        yaml_scalar(&input.name),
        yaml_scalar(&input.description),
        yaml_scalar(&input.type_),
        iso_string(now_ms),
        input.body
    );
    if let Err(e) = write_new(&target, &content) {
        return Ok(Err(if e.code.as_deref() == Some("EEXIST") {
            Refusal::new(409, "file already exists")
        } else {
            Refusal::new(500, e.message)
        }));
    }
    if let Err(refused) =
        append_memory_index(home, cwd, &input.filename, &input.name, &input.description)?
    {
        // Roll the file back, so a refused index entry leaves nothing behind.
        let rollback = node_path::resolve(&[&base, &input.filename]);
        if rollback.starts_with(&format!("{base}/")) {
            let _ = unlink(&rollback);
        }
        return Ok(Err(refused));
    }
    Ok(Ok(Written {
        name: input.filename.clone(),
        path: target,
    }))
}

/// A `ParsedMemory`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedMemory {
    pub name: String,
    pub description: String,
    pub type_: String,
    pub body: String,
    pub modified: Option<String>,
}

impl ParsedMemory {
    /// `{ name, description, type, body, modified? }`.
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("name".into(), Value::String(self.name.clone()));
        m.insert(
            "description".into(),
            Value::String(self.description.clone()),
        );
        m.insert("type".into(), Value::String(self.type_.clone()));
        m.insert("body".into(), Value::String(self.body.clone()));
        if let Some(modified) = &self.modified {
            m.insert("modified".into(), Value::String(modified.clone()));
        }
        Value::Object(m)
    }
}

/// A JS line terminator (what `.` doesn't match and `^` / `$` sit next to
/// in a multiline regex).
fn is_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// `fm.match(new RegExp(`^${key}:\\s*(.*)$`, "m"))?.[1]`: on the first line
/// starting with `key:`, the text after the whitespace that follows (which
/// can run over line ends) up to the next line terminator.
fn front_matter_value<'a>(fm: &'a str, key: &str) -> Option<&'a str> {
    let starts = std::iter::once(0).chain(
        fm.char_indices()
            .filter(|(_, c)| is_line_terminator(*c))
            .map(|(i, c)| i + c.len_utf8()),
    );
    for start in starts {
        let Some(rest) = fm[start..]
            .strip_prefix(key)
            .and_then(|r| r.strip_prefix(':'))
        else {
            continue;
        };
        let rest = rest.trim_start_matches(js::is_whitespace);
        let end = rest.find(is_line_terminator).unwrap_or(rest.len());
        return Some(&rest[..end]);
    }
    None
}

/// `parseMemoryFrontmatter(raw)`: `None` without a `---` block opening the
/// text or without a `name`.
pub fn parse_memory_frontmatter(raw: &str) -> Option<ParsedMemory> {
    // `/^---\n([\s\S]*?)\n---\n?\n?([\s\S]*)$/`
    let rest = raw.strip_prefix("---\n")?;
    let close = rest.find("\n---")?;
    let fm = &rest[..close];
    let mut body = &rest[close + 4..];
    for _ in 0..2 {
        body = body.strip_prefix('\n').unwrap_or(body);
    }
    let get = |key: &str| -> Option<String> {
        let v = js::trim(front_matter_value(fm, key)?);
        // Reverse the writer's double-quoting.
        if v.len() >= 2
            && v.starts_with('"')
            && v.ends_with('"')
            && let Ok(Value::String(s)) = js::json_parse(v)
        {
            return Some(s);
        }
        Some(v.to_owned())
    };
    let name = get("name").unwrap_or_default();
    if name.is_empty() {
        return None;
    }
    Some(ParsedMemory {
        name,
        description: get("description").unwrap_or_default(),
        type_: get("type").unwrap_or_else(|| "user".into()),
        body: body.to_owned(),
        modified: get("modified"),
    })
}

/// `PatchMemoryInput`: each field a JSON value, `None` for `undefined`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PatchMemoryInput {
    pub filename: String,
    pub description: Option<Value>,
    pub type_: Option<Value>,
    pub body: Option<Value>,
}

/// `{ ok: true, path, parsed }`: `parsed` is the patched `ParsedMemory` as
/// `JSON.stringify` sees it (the patch's raw values where it set them).
#[derive(Clone, Debug, PartialEq)]
pub struct Patched {
    pub path: String,
    pub parsed: Value,
}

/// `a ?? b` for a patch field.
fn or_existing(v: &Option<Value>, existing: &str) -> Value {
    match v {
        None | Some(Value::Null) => Value::String(existing.to_owned()),
        Some(v) => v.clone(),
    }
}

/// `patchMemoryFile(projectCwd, input)` at `now_ms`.
pub fn patch_memory_file(
    home: &str,
    cwd: &str,
    input: &PatchMemoryInput,
    now_ms: i64,
) -> Outcome<Patched> {
    if !is_valid_memory_filename(&input.filename) {
        return Ok(Err(Refusal::new(400, "invalid filename")));
    }
    // `input.type && !TYPES.includes(input.type)`
    if let Some(t) = &input.type_
        && js::truthy(t)
        && !t.as_str().is_some_and(|s| MEMORY_TYPES.contains(&s))
    {
        return Ok(Err(Refusal::new(400, "invalid type")));
    }
    let base = node_path::resolve(&[&auto_memory_dir(home, cwd)]);
    let target = node_path::resolve(&[&base, &input.filename]);
    if !target.starts_with(&format!("{base}/")) {
        return Ok(Err(Refusal::new(400, "invalid path")));
    }
    let raw = match node_fs::read_to_string(&target) {
        Ok(raw) => raw,
        Err(e) if e.is_not_found() => return Ok(Err(Refusal::new(404, "not found"))),
        Err(e) => return Ok(Err(Refusal::new(500, e.message))),
    };
    let Some(parsed) = parse_memory_frontmatter(&raw) else {
        return Ok(Err(Refusal::new(400, "unparseable frontmatter")));
    };
    let modified = iso_string(now_ms);
    let description = or_existing(&input.description, &parsed.description);
    let type_ = or_existing(&input.type_, &parsed.type_);
    let body = or_existing(&input.body, &parsed.body);
    let content = format!(
        "---\nname: {}\ndescription: {}\ntype: {}\nmodified: {modified}\n---\n\n{}",
        yaml_scalar(&parsed.name),
        yaml_scalar_value(&description)?,
        yaml_scalar(&string_of(&type_)?),
        string_of(&body)?
    );
    if let Err(e) = write_text(&target, &content) {
        return Ok(Err(Refusal::new(500, e.message)));
    }
    // `input.description !== undefined && input.description !== parsed.description`
    if input
        .description
        .as_ref()
        .is_some_and(|d| d.as_str() != Some(parsed.description.as_str()))
    {
        replace_memory_index_line(
            home,
            cwd,
            &input.filename,
            &parsed.name,
            &string_of(&description)?,
        )?;
    }
    let mut next = Map::new();
    next.insert("name".into(), Value::String(parsed.name));
    next.insert("description".into(), description);
    next.insert("type".into(), type_);
    next.insert("body".into(), body);
    next.insert("modified".into(), Value::String(modified));
    Ok(Ok(Patched {
        path: target,
        parsed: Value::Object(next),
    }))
}

/// `deleteMemoryFile(projectCwd, filename)`.
pub fn delete_memory_file(home: &str, cwd: &str, filename: &str) -> Outcome<()> {
    if !is_valid_memory_filename(filename) {
        return Ok(Err(Refusal::new(400, "invalid filename")));
    }
    let base = node_path::resolve(&[&auto_memory_dir(home, cwd)]);
    let target = node_path::resolve(&[&base, filename]);
    if !target.starts_with(&format!("{base}/")) {
        return Ok(Err(Refusal::new(400, "invalid path")));
    }
    if let Err(e) = unlink(&target) {
        return Ok(Err(if e.is_not_found() {
            Refusal::new(404, "not found")
        } else {
            Refusal::new(500, e.message)
        }));
    }
    remove_memory_index_line(home, cwd, filename)?;
    Ok(Ok(()))
}

/// `MEMORY.md`'s text, `None` when it's missing.
fn read_index(index_path: &str) -> Result<Option<String>, FsError> {
    match node_fs::read_to_string(index_path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.is_not_found() => Ok(None),
        Err(e) => Err(e),
    }
}

/// `replaceMemoryIndexLine`: the first index line holding `(<filename>)`
/// rewritten; nothing written when there's none.
fn replace_memory_index_line(
    home: &str,
    cwd: &str,
    filename: &str,
    name: &str,
    description: &str,
) -> Result<(), FsError> {
    let index_path = node_path::join(&[&auto_memory_dir(home, cwd), "MEMORY.md"]);
    let Some(existing) = read_index(&index_path)? else {
        return Ok(());
    };
    let marker = format!("({filename})");
    let mut lines: Vec<String> = existing.split('\n').map(str::to_owned).collect();
    let Some(line) = lines.iter_mut().find(|l| l.contains(&marker)) else {
        return Ok(());
    };
    *line = format!("- [{name}]({filename}) \u{2014} {description}");
    write_text(&index_path, &lines.join("\n"))
}

/// `removeMemoryIndexLine`: every index line holding `(<filename>)` dropped;
/// nothing written when there's none.
fn remove_memory_index_line(home: &str, cwd: &str, filename: &str) -> Result<(), FsError> {
    let index_path = node_path::join(&[&auto_memory_dir(home, cwd), "MEMORY.md"]);
    let Some(existing) = read_index(&index_path)? else {
        return Ok(());
    };
    let marker = format!("({filename})");
    let lines: Vec<&str> = existing.split('\n').collect();
    let kept: Vec<&str> = lines
        .iter()
        .copied()
        .filter(|l| !l.contains(&marker))
        .collect();
    if kept.len() == lines.len() {
        return Ok(());
    }
    write_text(&index_path, &kept.join("\n"))
}

/// `measureMemoryIndexLoadedBytes(text)`: the UTF-8 length once a leading
/// `--- … ---` block and every terminated `<!-- … -->` are gone.
pub fn measure_memory_index_loaded_bytes(text: &str) -> usize {
    // `text.replace(/^---\n[\s\S]*?\n---\n?/, "")`
    let without_front_matter = text
        .strip_prefix("---\n")
        .and_then(|rest| {
            let close = rest.find("\n---")?;
            let after = &rest[close + 4..];
            Some(after.strip_prefix('\n').unwrap_or(after))
        })
        .unwrap_or(text);
    strip_html_comments(without_front_matter).len()
}

/// `stripHtmlComments`: each `<!--` up to the first `-->` after it removed;
/// an unterminated one (and all after it) kept.
fn strip_html_comments(text: &str) -> String {
    let mut result = String::new();
    let mut cursor = 0;
    loop {
        let Some(start) = text[cursor..].find("<!--").map(|i| cursor + i) else {
            result.push_str(&text[cursor..]);
            return result;
        };
        let Some(end) = text[start + 4..].find("-->").map(|i| start + 4 + i) else {
            result.push_str(&text[cursor..]);
            return result;
        };
        result.push_str(&text[cursor..start]);
        cursor = end + 3;
    }
}

/// `appendMemoryIndex(projectCwd, filename, name, description)`: nothing
/// when a line already names `(<filename>)`; a 413 when the index would
/// pass the read limit.
pub fn append_memory_index(
    home: &str,
    cwd: &str,
    filename: &str,
    name: &str,
    description: &str,
) -> Outcome<()> {
    let index_path = node_path::join(&[&auto_memory_dir(home, cwd), "MEMORY.md"]);
    let existing = read_index(&index_path)?.unwrap_or_default();
    if existing.contains(&format!("({filename})")) {
        return Ok(Ok(()));
    }
    let line = format!("- [{name}]({filename}) \u{2014} {description}\n");
    let sep = if !existing.is_empty() && !existing.ends_with('\n') {
        "\n"
    } else {
        ""
    };
    let next = format!("{existing}{sep}{line}");
    if measure_memory_index_loaded_bytes(&next) > MEMORY_INDEX_READ_LIMIT_BYTES {
        return Ok(Err(Refusal::new(
            413,
            format!(
                "MEMORY.md index would exceed its {MEMORY_INDEX_READ_LIMIT_BYTES}-byte read limit \u{2014} trim older entries before adding more"
            ),
        )));
    }
    write_text(&index_path, &next)?;
    Ok(Ok(()))
}

// ───────────────────────────── memory-update ─────────────────────────────

/// `MemoryUpdate["op"]`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MemoryOp {
    Created,
    Updated,
    Deleted,
}

impl MemoryOp {
    pub fn as_str(self) -> &'static str {
        match self {
            MemoryOp::Created => "created",
            MemoryOp::Updated => "updated",
            MemoryOp::Deleted => "deleted",
        }
    }

    pub fn parse(s: &str) -> Option<MemoryOp> {
        match s {
            "created" => Some(MemoryOp::Created),
            "updated" => Some(MemoryOp::Updated),
            "deleted" => Some(MemoryOp::Deleted),
            _ => None,
        }
    }
}

/// session.ts `MemoryUpdate`: one write to the memory directory.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MemoryUpdate {
    pub op: MemoryOp,
    pub path: String,
}

/// session.ts `memoryUpdateReminderBody(updates, inContextPaths)`: `None`
/// when no update has a path.
pub fn memory_update_reminder_body(
    updates: &[MemoryUpdate],
    in_context: &[&str],
) -> Option<String> {
    let valid: Vec<&MemoryUpdate> = updates.iter().filter(|u| !u.path.is_empty()).collect();
    if valid.is_empty() {
        return None;
    }
    let summary: Vec<String> = valid
        .iter()
        .map(|u| {
            let base = u.path.rsplit('/').next().unwrap_or(&u.path);
            format!("{} {base}", u.op.as_str())
        })
        .collect();
    let paths: Vec<&str> = valid.iter().map(|u| u.path.as_str()).collect();
    let mut lines = vec![
        format!(
            "The user updated your memory directory: {}.",
            summary.join(", ")
        ),
        format!("Files changed: {}.", paths.join(", ")),
    ];
    let stale: Vec<&str> = in_context
        .iter()
        .copied()
        .filter(|p| !p.is_empty())
        .collect();
    if !stale.is_empty() {
        lines.push(format!(
            "Your loaded copy of {} is now stale relative to disk \u{2014} Read it again if you need current contents.",
            stale.join(", ")
        ));
    }
    Some(lines.join("\n"))
}

/// The body `Session.notifyMemoryUpdate(updates)` queues for a session that
/// has Read `read_paths` (in order): the changed paths it has in context
/// are the stale ones. `None` (nothing queued) for no updates.
pub fn memory_update_reminder<'a>(
    updates: &[MemoryUpdate],
    read_paths: impl IntoIterator<Item = &'a String>,
) -> Option<String> {
    let in_context: Vec<&str> = read_paths
        .into_iter()
        .map(String::as_str)
        .filter(|p| updates.iter().any(|u| u.path == *p))
        .collect();
    memory_update_reminder_body(updates, &in_context)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_follow_the_regex() {
        for ok in ["a.md", "..md", "-rf.md", "A_1.b-c.md", "MEMORY.md"] {
            assert!(is_valid_memory_filename(ok), "{ok}");
        }
        for bad in [
            "",
            ".md",
            "md",
            "a.MD",
            "a/b.md",
            "../a.md",
            "a b.md",
            "a.md\n",
            "\u{e9}.md",
            "a\0.md",
        ] {
            assert!(!is_valid_memory_filename(bad), "{bad:?}");
        }
    }

    #[test]
    fn non_string_scalars_coerce_as_v8() {
        let t = |v: Value| yaml_scalar_value(&v);
        assert_eq!(t(serde_json::json!([":", 2])), Ok(r#"[":",2]"#.into()));
        assert_eq!(
            t(serde_json::json!(3)),
            Err(Thrown::Type("value.trim is not a function".into()))
        );
        assert_eq!(
            t(serde_json::json!({"toString": 1})),
            Err(Thrown::Type(
                "Cannot convert object to primitive value".into()
            ))
        );
        assert_eq!(
            string_of(&serde_json::json!([1, null, [2, [3]]])),
            Ok("1,,2,3".into())
        );
    }
}
