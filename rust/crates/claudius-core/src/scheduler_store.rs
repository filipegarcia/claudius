//! `lib/server/scheduler-store.ts`: Claudius's own scheduled jobs and their
//! run history, under `~/.claude/claudius/schedule`:
//! - `jobs.json`: `{"jobs": [...]}`, written as `JSON.stringify(…, null, 2)`
//!   plus a newline through a temp file and a rename, every
//!   read-modify-write behind one lock (`withJobsLock`);
//! - `jobs/<id>/runs.jsonl`: one run per line, the newest 200 kept and older
//!   ones moved to `runs.archive.jsonl`.
//!
//! Jobs and runs stay JSON values, as the TS keeps whatever `JSON.parse`
//! gave it: a foreign field, an odd type or a key order survives a rewrite,
//! re-serialized with [`js::stringify`]. Files are read as lossy UTF-8 and
//! parsed with [`js::json_parse`], like `readFile(…, "utf8")` and
//! `JSON.parse`. Where the TS throws from its own code (`JSON.parse`, a
//! property read off a `null` entry, `path.join` given a non-string id), the
//! error is [`StoreError::Js`] with V8's or Node's wording; fs failures are
//! [`StoreError::Fs`] with Node's `code` and message.
//!
//! Difference: a job id whose run files `path.join` would put outside the
//! schedule root (`../../x`) is refused ([`StoreError::Escape`]). The TS
//! reads and writes there.

use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};

use claudius_agent::js;
use serde_json::{Map, Value, json};

use crate::scheduler::Clock;

/// `MAX_RUNS_PER_JOB`.
pub const MAX_RUNS_PER_JOB: usize = 200;

/// A JS value read off an object (`job.id`): `None` is `undefined`.
pub type JsValue = Option<Value>;

/// A patch for [`SchedulerStore::patch_job`], in the order its keys are
/// spread: `None` sets the key to `undefined`, which drops it from the file
/// and from the job returned.
pub type JobPatch = Vec<(String, Option<Value>)>;

/// What a store call failed with.
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    /// An exception the TS throws from its own code: `SyntaxError` from
    /// `JSON.parse`, `TypeError` from a property read off `null` or from
    /// `path.join` given a non-string.
    #[error("{name}: {message}")]
    Js {
        name: &'static str,
        message: String,
        code: Option<&'static str>,
    },
    /// A Node fs error: `message` is Node's (`EISDIR: illegal operation on
    /// a directory, read`), `code` its errno name.
    #[error("Error: {message}")]
    Fs {
        code: Option<String>,
        message: String,
        #[source]
        source: std::io::Error,
    },
    /// A job id whose run files would land outside the schedule root.
    #[error("Error: job id escapes the schedule root: {0}")]
    Escape(String),
}

impl StoreError {
    /// V8's `Cannot read properties of null (reading 'key')`.
    pub fn reading_null(key: &str) -> StoreError {
        StoreError::Js {
            name: "TypeError",
            message: format!("Cannot read properties of null (reading '{key}')"),
            code: None,
        }
    }

    /// The JS error's `name`.
    pub fn name(&self) -> &str {
        match self {
            StoreError::Js { name, .. } => name,
            StoreError::Fs { .. } | StoreError::Escape(_) => "Error",
        }
    }

    /// The JS error's `message`.
    pub fn message(&self) -> String {
        match self {
            StoreError::Js { message, .. } | StoreError::Fs { message, .. } => message.clone(),
            StoreError::Escape(id) => format!("job id escapes the schedule root: {id}"),
        }
    }

    /// Node's `err.code`.
    pub fn code(&self) -> Option<&str> {
        match self {
            StoreError::Js { code, .. } => *code,
            StoreError::Fs { code, .. } => code.as_deref(),
            StoreError::Escape(_) => None,
        }
    }

    fn is_not_found(&self) -> bool {
        self.code() == Some("ENOENT")
    }
}

/// Node's fs error: `<CODE>: <libuv description>, <syscall> '<path>'`
/// (` -> '<dest>'` for a rename).
fn fs_error(
    source: std::io::Error,
    syscall: &str,
    path: Option<&Path>,
    dest: Option<&Path>,
) -> StoreError {
    let code = claudius_agent::binary::node_error_code(&source);
    let mut message = match &code {
        Some(c) => format!("{c}: {}, {syscall}", uv_description(c).unwrap_or(c)),
        None => format!("{source}, {syscall}"),
    };
    if let Some(p) = path {
        message.push_str(&format!(" '{}'", p.display()));
    }
    if let Some(d) = dest {
        message.push_str(&format!(" -> '{}'", d.display()));
    }
    StoreError::Fs {
        code,
        message,
        source,
    }
}

/// libuv's `uv_strerror` text for the codes a file store can hit.
fn uv_description(code: &str) -> Option<&'static str> {
    Some(match code {
        "EACCES" => "permission denied",
        "EAGAIN" => "resource temporarily unavailable",
        "EBADF" => "bad file descriptor",
        "EBUSY" => "resource busy or locked",
        "EEXIST" => "file already exists",
        "EFBIG" => "file too large",
        "EINTR" => "interrupted system call",
        "EINVAL" => "invalid argument",
        "EIO" => "i/o error",
        "EISDIR" => "illegal operation on a directory",
        "ELOOP" => "too many symbolic links encountered",
        "EMFILE" => "too many open files",
        "ENAMETOOLONG" => "name too long",
        "ENFILE" => "file table overflow",
        "ENOENT" => "no such file or directory",
        "ENOMEM" => "not enough memory",
        "ENOSPC" => "no space left on device",
        "ENOTDIR" => "not a directory",
        "ENOTEMPTY" => "directory not empty",
        "EPERM" => "operation not permitted",
        "EROFS" => "read-only file system",
        "ETXTBSY" => "text file is busy",
        "EXDEV" => "cross-device link not permitted",
        _ => return None,
    })
}

/// `fs.readFile(p, "utf8")`: open (an error names the path), then read
/// (an error doesn't: a directory opens and fails here), lossy UTF-8.
fn read_text(p: &Path) -> Result<String, StoreError> {
    let mut f = std::fs::File::open(p).map_err(|e| fs_error(e, "open", Some(p), None))?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf)
        .map_err(|e| fs_error(e, "read", None, None))?;
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

/// `fs.writeFile` (`append` false) or `fs.appendFile` (true).
fn write_text(p: &Path, text: &str, append: bool) -> Result<(), StoreError> {
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(append)
        .truncate(!append)
        .open(p)
        .map_err(|e| fs_error(e, "open", Some(p), None))?;
    f.write_all(text.as_bytes())
        .map_err(|e| fs_error(e, "write", None, None))
}

/// `fs.mkdir(p, {recursive: true})`.
fn mkdir_p(p: &Path) -> Result<(), StoreError> {
    std::fs::create_dir_all(p).map_err(|e| fs_error(e, "mkdir", Some(p), None))
}

/// `v.key` on a value `JSON.parse` made: an object's own property, or
/// `undefined` for anything else (an array's or a string's named property
/// is never a JSON key). The caller rules out `null`, where JS throws.
pub fn prop(v: &Value, key: &str) -> JsValue {
    v.as_object().and_then(|o| o.get(key)).cloned()
}

/// `a === b` for two JSON values: primitives by value (numbers as `f64`),
/// objects and arrays never, since two reads never share a reference.
pub fn strict_eq(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) | (Some(Value::Null), Some(Value::Null)) => true,
        (Some(Value::Bool(x)), Some(Value::Bool(y))) => x == y,
        (Some(Value::Number(x)), Some(Value::Number(y))) => x.as_f64() == y.as_f64(),
        (Some(Value::String(x)), Some(Value::String(y))) => x == y,
        _ => false,
    }
}

/// `j.id === id` for a job entry; a `null` entry throws.
fn id_matches(j: &Value, id: &JsValue) -> Result<bool, StoreError> {
    if j.is_null() {
        return Err(StoreError::reading_null("id"));
    }
    Ok(strict_eq(
        j.as_object().and_then(|o| o.get("id")),
        id.as_ref(),
    ))
}

/// `jobs.findIndex((j) => j.id === id)`: stops at the first match, so a
/// `null` entry after it is never read.
fn find_index(all: &[Value], id: &JsValue) -> Result<Option<usize>, StoreError> {
    for (i, j) in all.iter().enumerate() {
        if id_matches(j, id)? {
            return Ok(Some(i));
        }
    }
    Ok(None)
}

/// Node's `ERR_INVALID_ARG_TYPE` for a `path` argument that isn't a string.
fn invalid_path_arg(v: &JsValue) -> StoreError {
    let received = match v {
        None => "undefined".to_owned(),
        Some(Value::Null) => "null".to_owned(),
        Some(Value::Bool(b)) => format!("type boolean ({b})"),
        Some(Value::Number(n)) => format!(
            "type number ({})",
            js::number_to_string(n.as_f64().unwrap_or(f64::NAN))
        ),
        Some(Value::Array(_)) => "an instance of Array".to_owned(),
        Some(Value::Object(_)) => "an instance of Object".to_owned(),
        Some(Value::String(s)) => format!("type string ('{s}')"),
    };
    StoreError::Js {
        name: "TypeError",
        message: format!("The \"path\" argument must be of type string. Received {received}"),
        code: Some("ERR_INVALID_ARG_TYPE"),
    }
}

/// `path.join(base, ...segments)` on POSIX: the segments appended with `/`
/// (an absolute one doesn't reset the path, unlike `PathBuf::join`), then
/// `.` and `..` resolved; `..` never climbs above `/`. `base` is absolute.
pub fn node_join(base: &Path, segments: &[&str]) -> PathBuf {
    // An empty segment adds a `/`, which `components()` skips.
    let joined = segments
        .iter()
        .fold(base.to_string_lossy().into_owned(), |acc, s| {
            format!("{acc}/{s}")
        });
    let mut out = PathBuf::from("/");
    for comp in Path::new(&joined).components() {
        match comp {
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(c) => out.push(c),
            Component::RootDir | Component::CurDir | Component::Prefix(_) => {}
        }
    }
    out
}

/// The run files of one job.
struct JobFiles {
    dir: PathBuf,
    runs: PathBuf,
    archive: PathBuf,
}

/// The schedule store at one root ([`SchedulerStore::default_root`] in the
/// app). One instance per root: its lock is what serializes the writes.
pub struct SchedulerStore {
    root: PathBuf,
    clock: Arc<dyn Clock>,
    /// `withJobsLock`.
    lock: Mutex<()>,
}

impl SchedulerStore {
    /// `SCHED_ROOT`: `homedir()/.claude/claudius/schedule`.
    pub fn default_root() -> PathBuf {
        crate::paths::claude_home()
            .join("claudius")
            .join("schedule")
    }

    /// A store at `root` (absolute); `clock` stands in for `Date.now()` in
    /// the temp file's name.
    pub fn new(root: PathBuf, clock: Arc<dyn Clock>) -> SchedulerStore {
        SchedulerStore {
            root,
            clock,
            lock: Mutex::new(()),
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn jobs_file(&self) -> PathBuf {
        self.root.join("jobs.json")
    }

    /// `jobDir` / `runsFile` / `archiveFile`: `path.join(SCHED_ROOT, "jobs",
    /// id)`, which throws for a non-string id; refused when it leaves the
    /// root.
    fn job_files(&self, id: &JsValue) -> Result<JobFiles, StoreError> {
        let Some(Value::String(id)) = id else {
            return Err(invalid_path_arg(id));
        };
        let dir = node_join(&self.root, &["jobs", id]);
        // `..` is the root itself, as in TS (its runs file sits beside
        // `jobs.json`); only above it is refused.
        if !dir.starts_with(&self.root) {
            return Err(StoreError::Escape(id.clone()));
        }
        Ok(JobFiles {
            runs: dir.join("runs.jsonl"),
            archive: dir.join("runs.archive.jsonl"),
            dir,
        })
    }

    /// `listJobs()`: a missing file is `[]`; anything else that fails to
    /// read or parse throws, and a parse that isn't `{jobs: [...]}` is `[]`
    /// (`null` throws reading `jobs`).
    pub fn list_jobs(&self) -> Result<Vec<Value>, StoreError> {
        let text = match read_text(&self.jobs_file()) {
            Ok(t) => t,
            Err(e) if e.is_not_found() => return Ok(Vec::new()),
            Err(e) => return Err(e),
        };
        let parsed = js::json_parse(&text).map_err(|message| StoreError::Js {
            name: "SyntaxError",
            message,
            code: None,
        })?;
        if parsed.is_null() {
            return Err(StoreError::reading_null("jobs"));
        }
        Ok(match prop(&parsed, "jobs") {
            Some(Value::Array(jobs)) => jobs,
            _ => Vec::new(),
        })
    }

    /// `writeJobs`: `{jobs}` pretty-printed to `jobs.json.<pid>.<now>.tmp`,
    /// then renamed over `jobs.json`.
    fn write_jobs(&self, jobs: Vec<Value>) -> Result<(), StoreError> {
        mkdir_p(&self.root)?;
        let file = self.jobs_file();
        let tmp = self.root.join(format!(
            "jobs.json.{}.{}.tmp",
            std::process::id(),
            js::number_to_string(self.clock.now_ms())
        ));
        write_text(
            &tmp,
            &(js::stringify_pretty(&json!({ "jobs": jobs })) + "\n"),
            false,
        )?;
        std::fs::rename(&tmp, &file).map_err(|e| fs_error(e, "rename", Some(&tmp), Some(&file)))
    }

    fn locked(&self) -> std::sync::MutexGuard<'_, ()> {
        self.lock.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// `getJob(id)`: the first job whose `id` is `=== id`.
    pub fn get_job(&self, id: &JsValue) -> Result<Option<Value>, StoreError> {
        let mut all = self.list_jobs()?;
        Ok(find_index(&all, id)?.map(|i| all.swap_remove(i)))
    }

    /// `saveJob(job)`: replace the first job with its id, else append.
    pub fn save_job(&self, job: Value) -> Result<(), StoreError> {
        let _g = self.locked();
        let mut all = self.list_jobs()?;
        // `job.id` is only read inside the `findIndex` callback.
        if job.is_null() && !all.is_empty() {
            return Err(StoreError::reading_null("id"));
        }
        match find_index(&all, &prop(&job, "id"))? {
            Some(i) => all[i] = job,
            None => all.push(job),
        }
        self.write_jobs(all)
    }

    /// `patchJob(id, patch)`: `{...stored, ...patch, id}` written back and
    /// returned; `None`, writing nothing, when no job has the id.
    pub fn patch_job(&self, id: &JsValue, patch: &JobPatch) -> Result<Option<Value>, StoreError> {
        let _g = self.locked();
        let mut all = self.list_jobs()?;
        let Some(i) = find_index(&all, id)? else {
            return Ok(None);
        };
        // A spread copies own enumerable properties: an object's members, a
        // string's characters, nothing of a number or boolean (an
        // `undefined` id matches those).
        let mut next: Map<String, Value> = js::entries(&all[i]).into_iter().collect();
        let id_entry = ("id".to_owned(), id.clone());
        for (k, v) in patch.iter().cloned().chain([id_entry]) {
            match v {
                Some(v) => {
                    next.insert(k, v);
                }
                None => {
                    next.shift_remove(&k);
                }
            }
        }
        let next = Value::Object(next);
        all[i] = next.clone();
        self.write_jobs(all)?;
        Ok(Some(next))
    }

    /// `deleteJob(id)`: drop every job with the id; then, best effort, its
    /// runs file, its archive and its (now empty) directory. `false` when no
    /// job had the id.
    pub fn delete_job(&self, id: &JsValue) -> Result<bool, StoreError> {
        {
            let _g = self.locked();
            let all = self.list_jobs()?;
            let before = all.len();
            let mut kept = Vec::with_capacity(before);
            for j in all {
                if !id_matches(&j, id)? {
                    kept.push(j);
                }
            }
            if kept.len() == before {
                return Ok(false);
            }
            self.write_jobs(kept)?;
        }
        // `runsFile(id)` throws inside each `try` for a non-string id.
        if let Ok(files) = self.job_files(id) {
            // Neither `fs.rm` nor `remove_file` removes a directory, and
            // `fs.rmdir` / `remove_dir` leave one that isn't empty.
            let _ = std::fs::remove_file(&files.runs);
            let _ = std::fs::remove_file(&files.archive);
            let _ = std::fs::remove_dir(&files.dir);
        }
        Ok(true)
    }

    /// `appendRun(run)`: one line onto the job's runs file (made with its
    /// directory), then the rotation.
    pub fn append_run(&self, run: &Value) -> Result<(), StoreError> {
        let files = self.job_files(&prop(run, "jobId"))?;
        if let Some(parent) = files.runs.parent() {
            mkdir_p(parent)?;
        }
        write_text(&files.runs, &(js::stringify(run) + "\n"), true)?;
        self.rotate_if_needed(&files)
    }

    /// `updateRun(run)`: rewrite every line whose run has `run.id`; an
    /// unreadable file is left alone. Empty lines are dropped and every
    /// other line (unparseable, not an object) is kept as it reads.
    pub fn update_run(&self, run: &Value) -> Result<(), StoreError> {
        let files = match self.job_files(&prop(run, "jobId")) {
            Ok(f) => f,
            Err(StoreError::Escape(_)) => return Ok(()),
            Err(e) => return Err(e),
        };
        let Ok(text) = read_text(&files.runs) else {
            return Ok(());
        };
        let id = prop(run, "id");
        let line = js::stringify(run);
        let next: Vec<&str> = text
            .split('\n')
            .filter(|l| !l.is_empty())
            .map(|l| match js::json_parse(l) {
                // `r.id` off a `null` line throws inside the `try`: kept.
                Ok(r) if !r.is_null() && strict_eq(prop(&r, "id").as_ref(), id.as_ref()) => {
                    line.as_str()
                }
                _ => l,
            })
            .collect();
        write_text(&files.runs, &(next.join("\n") + "\n"), false)
    }

    /// `listRuns(jobId, limit)`: every line that parses, `.slice(-limit)`,
    /// newest first. A missing file is `[]`.
    pub fn list_runs(&self, job_id: &JsValue, limit: f64) -> Result<Vec<Value>, StoreError> {
        let files = match self.job_files(job_id) {
            Ok(f) => f,
            Err(StoreError::Escape(_)) => return Ok(Vec::new()),
            Err(e) => return Err(e),
        };
        let text = match read_text(&files.runs) {
            Ok(t) => t,
            Err(e) if e.is_not_found() => return Ok(Vec::new()),
            Err(e) => return Err(e),
        };
        // A blank line (which TS skips first) doesn't parse either.
        let all: Vec<Value> = text
            .split('\n')
            .filter_map(|l| js::json_parse(l).ok())
            .collect();
        let start = slice_start(all.len(), -limit);
        Ok(all.into_iter().skip(start).rev().collect())
    }

    /// `rotateIfNeeded`: past 200 lines, the oldest move to the archive.
    fn rotate_if_needed(&self, files: &JobFiles) -> Result<(), StoreError> {
        let Ok(text) = read_text(&files.runs) else {
            return Ok(());
        };
        let lines: Vec<&str> = text.split('\n').filter(|l| !l.is_empty()).collect();
        if lines.len() <= MAX_RUNS_PER_JOB {
            return Ok(());
        }
        let overflow = lines.len() - MAX_RUNS_PER_JOB;
        write_text(&files.archive, &(lines[..overflow].join("\n") + "\n"), true)?;
        write_text(&files.runs, &(lines[overflow..].join("\n") + "\n"), false)
    }
}

/// `Array.prototype.slice(start)`'s start index: `ToIntegerOrInfinity`
/// (NaN is 0), counted from the end when negative, clamped to the length.
fn slice_start(len: usize, start: f64) -> usize {
    let rel = if start.is_nan() { 0.0 } else { start.trunc() };
    if rel < 0.0 {
        (len as f64 + rel).max(0.0) as usize
    } else {
        rel.min(len as f64) as usize
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_join_matches_path_join() {
        let base = Path::new("/r/s");
        for (seg, want) in [
            ("a", "/r/s/jobs/a"),
            ("a/b", "/r/s/jobs/a/b"),
            ("", "/r/s/jobs"),
            (".", "/r/s/jobs"),
            ("..", "/r/s"),
            ("/abs", "/r/s/jobs/abs"),
            ("x/../../y", "/r/s/y"),
            ("../../../../../..", "/"),
            ("a//b/", "/r/s/jobs/a/b"),
        ] {
            assert_eq!(
                node_join(base, &["jobs", seg]),
                PathBuf::from(want),
                "{seg:?}"
            );
        }
    }

    #[test]
    fn slice_start_is_js() {
        for (start, want) in [
            (-2.0, 3),
            (-0.0, 0),
            (-9.0, 0),
            (2.0, 2),
            (9.0, 5),
            (-2.5, 3),
            (2.5, 2),
            (f64::NAN, 0),
            (f64::INFINITY, 5),
            (f64::NEG_INFINITY, 0),
        ] {
            assert_eq!(slice_start(5, start), want, "{start}");
        }
    }

    #[test]
    fn non_string_ids_throw_like_path_join() {
        for (id, want) in [
            (None, "undefined"),
            (Some(json!(null)), "null"),
            (Some(json!(5)), "type number (5)"),
            (Some(json!(1.5)), "type number (1.5)"),
            (Some(json!(true)), "type boolean (true)"),
            (Some(json!([])), "an instance of Array"),
            (Some(json!({})), "an instance of Object"),
        ] {
            let e = invalid_path_arg(&id);
            assert_eq!(e.name(), "TypeError");
            assert_eq!(e.code(), Some("ERR_INVALID_ARG_TYPE"));
            assert_eq!(
                e.message(),
                format!("The \"path\" argument must be of type string. Received {want}")
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn fs_errors_read_like_node() {
        let enoent = std::io::Error::from_raw_os_error(libc::ENOENT);
        let e = fs_error(enoent, "open", Some(Path::new("/x/y")), None);
        assert_eq!(e.code(), Some("ENOENT"));
        assert_eq!(
            e.message(),
            "ENOENT: no such file or directory, open '/x/y'"
        );
        assert_eq!(e.name(), "Error");
        let exdev = std::io::Error::from_raw_os_error(libc::EXDEV);
        let e = fs_error(
            exdev,
            "rename",
            Some(Path::new("/a")),
            Some(Path::new("/b")),
        );
        assert_eq!(
            e.message(),
            "EXDEV: cross-device link not permitted, rename '/a' -> '/b'"
        );
        let eisdir = std::io::Error::from_raw_os_error(libc::EISDIR);
        assert_eq!(
            fs_error(eisdir, "read", None, None).message(),
            "EISDIR: illegal operation on a directory, read"
        );
    }

    fn store() -> (tempfile::TempDir, SchedulerStore) {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("schedule");
        let store = SchedulerStore::new(root, Arc::new(crate::scheduler::SystemClock));
        (tmp, store)
    }

    fn jobs_text(store: &SchedulerStore) -> String {
        std::fs::read_to_string(store.root().join("jobs.json")).unwrap()
    }

    #[test]
    fn a_null_job_is_saved_into_an_empty_list_only() {
        // `job.id` is only read by the `findIndex` callback.
        let (_tmp, store) = store();
        store.save_job(Value::Null).unwrap();
        assert_eq!(jobs_text(&store), "{\n  \"jobs\": [\n    null\n  ]\n}\n");
        let e = store.save_job(Value::Null).unwrap_err();
        assert_eq!(e.message(), "Cannot read properties of null (reading 'id')");
    }

    #[test]
    fn patching_a_string_job_spreads_its_characters() {
        // `undefined === ("ab").id`, and `{..."ab"}` is `{0: "a", 1: "b"}`.
        let (_tmp, store) = store();
        std::fs::create_dir_all(store.root()).unwrap();
        std::fs::write(store.root().join("jobs.json"), r#"{"jobs":["ab"]}"#).unwrap();
        let got = store
            .patch_job(&None, &vec![("k".to_owned(), Some(json!(1)))])
            .unwrap();
        assert_eq!(got, Some(json!({"0": "a", "1": "b", "k": 1})));
        assert_eq!(
            jobs_text(&store),
            "{\n  \"jobs\": [\n    {\n      \"0\": \"a\",\n      \"1\": \"b\",\n      \"k\": 1\n    }\n  ]\n}\n"
        );
    }

    #[test]
    fn an_undefined_patch_value_drops_the_key_in_place() {
        // `{...stored, b: undefined, id}`: `b` keeps its slot as
        // `undefined`, so `JSON.stringify` skips it and the rest keep their
        // order.
        let (_tmp, store) = store();
        std::fs::create_dir_all(store.root()).unwrap();
        std::fs::write(
            store.root().join("jobs.json"),
            r#"{"jobs":[{"id":"j","a":1,"b":2,"c":3,"d":4}]}"#,
        )
        .unwrap();
        let got = store
            .patch_job(
                &Some(json!("j")),
                &vec![("b".to_owned(), None), ("e".to_owned(), Some(json!(5)))],
            )
            .unwrap()
            .unwrap();
        assert_eq!(js::stringify(&got), r#"{"id":"j","a":1,"c":3,"d":4,"e":5}"#);
        assert_eq!(
            jobs_text(&store),
            "{\n  \"jobs\": [\n    {\n      \"id\": \"j\",\n      \"a\": 1,\n      \"c\": 3,\n      \"d\": 4,\n      \"e\": 5\n    }\n  ]\n}\n"
        );
    }

    #[test]
    fn a_run_without_an_id_replaces_the_lines_without_one() {
        // `r.id === undefined`: true for `5` and an id-less object; `null`
        // throws reading it, and stays.
        let (_tmp, store) = store();
        let dir = store.root().join("jobs/j");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("runs.jsonl"),
            "null\n5\n{\"x\":1}\n{\"id\":\"a\"}\n",
        )
        .unwrap();
        store.update_run(&json!({"jobId": "j", "v": 2})).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join("runs.jsonl")).unwrap(),
            "null\n{\"jobId\":\"j\",\"v\":2}\n{\"jobId\":\"j\",\"v\":2}\n{\"id\":\"a\"}\n"
        );
    }

    #[test]
    fn strict_eq_is_js() {
        assert!(strict_eq(None, None));
        assert!(strict_eq(Some(&json!(null)), Some(&json!(null))));
        assert!(!strict_eq(None, Some(&json!(null))));
        assert!(strict_eq(Some(&json!(5)), Some(&json!(5.0))));
        assert!(!strict_eq(Some(&json!(5)), Some(&json!("5"))));
        assert!(strict_eq(Some(&json!("a")), Some(&json!("a"))));
        assert!(!strict_eq(Some(&json!(true)), Some(&json!(false))));
        assert!(!strict_eq(Some(&json!({})), Some(&json!({}))));
        assert!(!strict_eq(Some(&json!([])), Some(&json!([]))));
    }
}
