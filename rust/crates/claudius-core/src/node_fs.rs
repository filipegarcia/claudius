//! Node's `fs` for ported code: the calls, and the text of the errors they
//! reject with, so a route that hands `err.message` to the client says the
//! same thing. It is the one home for both (I14c folded D10a's `node_err`
//! and G05's copies in `agents` into it; I14d dropped the `node_err`
//! re-export); `path.posix` is [`crate::node_path`].
//!
//! A failed call in Node rejects with libuv's `uvException`: `CODE:
//! description, syscall 'path' -> 'dest'` (`EACCES: permission denied, open
//! '/x'`). Two shapes carry it:
//! - [`FsError`] (`err.code` and `err.message`), from the calls on path
//!   strings as the TS builds them ([`mkdir_recursive`], [`read_to_string`],
//!   [`write_file`], [`rename`], [`rm_recursive`], ...);
//! - [`NodeError`] (also `errno`, `syscall`, `path` and `dest`), from
//!   [`uv_exception`] and the [`sys`] calls on `Path`s.
//!
//! Both name and describe an errno with [`describe`] (libuv's
//! `UV_ERRNO_MAP`; the names are `claudius_agent::binary::errno_name`, which
//! the SDK host's spawn errors use too), recorded against node 22 by
//! `rust/scripts/settings-errors-golden.mjs` (`tests/settings_errors_golden.rs`),
//! and both walk `fs.mkdir(p, { recursive: true })` the one way
//! ([`mkdir_recursive`]).
//!
//! Paths are the strings the TS builds; they go to the OS as they are.

use std::fmt;
use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};

// ---- error text ----------------------------------------------------------------

/// A Node fs error (`SystemError`-shaped `Error`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NodeError {
    /// `err.code`: libuv's name (`ENOENT`), or `Unknown system error -N`
    /// for an errno libuv doesn't name.
    pub code: String,
    /// `err.errno`: libuv's (negative) error number, `-errno` on Unix.
    pub errno: i32,
    /// `err.syscall` (`open`, `read`, `mkdir`, `scandir`, ...).
    pub syscall: &'static str,
    pub path: Option<String>,
    pub dest: Option<String>,
    /// `err.message`.
    pub message: String,
}

impl fmt::Display for NodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for NodeError {}

/// libuv's `UV_UNKNOWN`, for an [`io::Error`] that carries no OS errno.
const UV_UNKNOWN: i32 = -4094;

/// `uvException({errno, syscall, path, dest})` for a failed call: the code
/// and description libuv gives the error's errno on this platform. An error
/// without an OS errno is `UNKNOWN: unknown error` (an [`FsError`] keeps
/// the Rust error's own text there instead).
pub fn uv_exception(
    err: &io::Error,
    syscall: &'static str,
    path: Option<&Path>,
    dest: Option<&Path>,
) -> NodeError {
    let (errno, code, description) = match err.raw_os_error() {
        Some(n) => match describe(n) {
            Some((code, description)) => (-n, code.to_owned(), description.to_owned()),
            None => {
                let unknown = format!("Unknown system error -{n}");
                (-n, unknown.clone(), unknown)
            }
        },
        None => (UV_UNKNOWN, "UNKNOWN".to_owned(), "unknown error".to_owned()),
    };
    let path = path.map(|p| p.to_string_lossy().into_owned());
    let dest = dest.map(|p| p.to_string_lossy().into_owned());
    let message = with_paths(
        format!("{code}: {description}"),
        syscall,
        path.as_deref(),
        dest.as_deref(),
    );
    NodeError {
        code,
        errno,
        syscall,
        path,
        dest,
        message,
    }
}

/// libuv's name and `uv_strerror` text for an OS errno (`UV_ERRNO_MAP`),
/// `None` where libuv has none on this platform.
#[cfg(unix)]
pub fn describe(errno: i32) -> Option<(&'static str, &'static str)> {
    claudius_agent::binary::errno_name(errno).map(|code| (code, strerror(code)))
}

/// libuv maps Win32 errors itself; only the two that matter for a missing
/// or unreadable file are mirrored.
#[cfg(not(unix))]
pub fn describe(errno: i32) -> Option<(&'static str, &'static str)> {
    match io::Error::from_raw_os_error(errno).kind() {
        ErrorKind::NotFound => Some(("ENOENT", "no such file or directory")),
        ErrorKind::PermissionDenied => Some(("EPERM", "operation not permitted")),
        _ => None,
    }
}

/// libuv's `uv_strerror` for an error name; `Unknown system error -N` is
/// its own text, any other name libuv doesn't have `unknown error`.
fn strerror(code: &str) -> &str {
    match code {
        "E2BIG" => "argument list too long",
        "EACCES" => "permission denied",
        "EADDRINUSE" => "address already in use",
        "EADDRNOTAVAIL" => "address not available",
        "EAFNOSUPPORT" => "address family not supported",
        "EAGAIN" => "resource temporarily unavailable",
        "EALREADY" => "connection already in progress",
        "EBADF" => "bad file descriptor",
        "EBUSY" => "resource busy or locked",
        "ECANCELED" => "operation canceled",
        "ECONNABORTED" => "software caused connection abort",
        "ECONNREFUSED" => "connection refused",
        "ECONNRESET" => "connection reset by peer",
        "EDESTADDRREQ" => "destination address required",
        "EEXIST" => "file already exists",
        "EFAULT" => "bad address in system call argument",
        "EFBIG" => "file too large",
        "EHOSTDOWN" => "host is down",
        "EHOSTUNREACH" => "host is unreachable",
        "EILSEQ" => "illegal byte sequence",
        "EINTR" => "interrupted system call",
        "EINVAL" => "invalid argument",
        "EIO" => "i/o error",
        "EISCONN" => "socket is already connected",
        "EISDIR" => "illegal operation on a directory",
        "ELOOP" => "too many symbolic links encountered",
        "EMFILE" => "too many open files",
        "EMLINK" => "too many links",
        "EMSGSIZE" => "message too long",
        "ENAMETOOLONG" => "name too long",
        "ENETDOWN" => "network is down",
        "ENETUNREACH" => "network is unreachable",
        "ENFILE" => "file table overflow",
        "ENOBUFS" => "no buffer space available",
        "ENODATA" => "no data available",
        "ENODEV" => "no such device",
        "ENOENT" => "no such file or directory",
        "ENOEXEC" => "exec format error",
        "ENOMEM" => "not enough memory",
        "ENONET" => "machine is not on the network",
        "ENOPROTOOPT" => "protocol not available",
        "ENOSPC" => "no space left on device",
        "ENOSYS" => "function not implemented",
        "ENOTCONN" => "socket is not connected",
        "ENOTDIR" => "not a directory",
        "ENOTEMPTY" => "directory not empty",
        "ENOTSOCK" => "socket operation on non-socket",
        "ENOTSUP" => "operation not supported on socket",
        "ENOTTY" => "inappropriate ioctl for device",
        "ENXIO" => "no such device or address",
        "EOVERFLOW" => "value too large for defined data type",
        "EPERM" => "operation not permitted",
        "EPIPE" => "broken pipe",
        "EPROTO" => "protocol error",
        "EPROTONOSUPPORT" => "protocol not supported",
        "EPROTOTYPE" => "protocol wrong type for socket",
        "ERANGE" => "result too large",
        "EREMOTEIO" => "remote I/O error",
        "EROFS" => "read-only file system",
        "ESHUTDOWN" => "cannot send after transport endpoint shutdown",
        "ESOCKTNOSUPPORT" => "socket type not supported",
        "ESPIPE" => "invalid seek",
        "ESRCH" => "no such process",
        "ETIMEDOUT" => "connection timed out",
        "ETXTBSY" => "text file is busy",
        "EUNATCH" => "protocol driver not attached",
        "EXDEV" => "cross-device link not permitted",
        "EFTYPE" => "inappropriate file type or format",
        c if c.starts_with("Unknown system error") => c,
        _ => "unknown error",
    }
}

/// A failed `fs` call: Node's `err.code` and `err.message`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FsError {
    pub code: Option<String>,
    pub message: String,
}

impl FsError {
    /// The error `syscall` on `path` (and `dest`) rejects with for `error`.
    /// An error without an OS errno has no code, and its message is the
    /// Rust error's text (a [`NodeError`] says `UNKNOWN: unknown error`).
    pub fn new(
        error: &io::Error,
        syscall: &str,
        path: Option<&str>,
        dest: Option<&str>,
    ) -> FsError {
        let code = code(error);
        let head = match code.as_deref() {
            Some(c) => format!("{c}: {}", strerror(c)),
            None => error.to_string(),
        };
        FsError {
            message: with_paths(head, syscall, path, dest),
            code,
        }
    }

    /// An error Node makes up itself (`mkdir`'s walk reports `ENOTDIR` /
    /// `EEXIST` after a `stat`).
    fn coded(code: &str, syscall: &str, path: &str) -> FsError {
        FsError {
            message: with_paths(
                format!("{code}: {}", strerror(code)),
                syscall,
                Some(path),
                None,
            ),
            code: Some(code.to_owned()),
        }
    }

    /// `err.code === "ENOENT"`.
    pub fn is_not_found(&self) -> bool {
        self.code.as_deref() == Some("ENOENT")
    }
}

/// As node's C++ `UVException` builds it: `path` and `dest` follow, quoted,
/// whenever the call had them (even empty ones).
fn with_paths(head: String, syscall: &str, path: Option<&str>, dest: Option<&str>) -> String {
    let mut out = format!("{head}, {syscall}");
    if let Some(p) = path {
        out.push_str(&format!(" '{p}'"));
    }
    if let Some(d) = dest {
        out.push_str(&format!(" -> '{d}'"));
    }
    out
}

/// Node's `err.code` for an OS error (libuv's `uv_err_name`): an errno libuv
/// doesn't name is "Unknown system error -N"; an error without an OS code
/// has none. Off unix only the codes a file call usually meets are told
/// apart (libuv maps Win32 errors itself).
pub fn code(error: &io::Error) -> Option<String> {
    #[cfg(unix)]
    {
        claudius_agent::binary::node_error_code(error)
    }
    #[cfg(not(unix))]
    {
        error.raw_os_error()?;
        Some(
            match error.kind() {
                ErrorKind::NotFound => "ENOENT",
                ErrorKind::PermissionDenied => "EPERM",
                ErrorKind::AlreadyExists => "EEXIST",
                ErrorKind::NotADirectory => "ENOTDIR",
                ErrorKind::IsADirectory => "EISDIR",
                _ => "UNKNOWN",
            }
            .to_owned(),
        )
    }
}

// ---- mkdir -p ------------------------------------------------------------------

/// Where the walk stopped: the OS error of the component's `mkdir` (or of
/// the `stat` after it), or a code Node reports itself after the `stat`.
enum MkdirFail {
    Os(io::Error, PathBuf),
    Coded(&'static str, PathBuf),
}

/// `path.substr(0, path.find_last_of('/'))` when it differs from `path`:
/// everything before the last `/` (`""` for `/x`); `None` without a `/`.
fn cut_last_slash(p: &Path) -> Option<PathBuf> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        let b = p.as_os_str().as_bytes();
        let i = b.iter().rposition(|c| *c == b'/')?;
        Some(PathBuf::from(std::ffi::OsStr::from_bytes(&b[..i])))
    }
    #[cfg(not(unix))]
    {
        let s = p.to_string_lossy();
        Some(PathBuf::from(&s[..s.rfind('/')?]))
    }
}

/// node 22's `MKDirpAsync` (`fs.mkdir(p, { recursive: true, mode })`): make
/// `path`, and on ENOENT its parents first. EACCES, ENOSPC, ENOTDIR and
/// EPERM fail at once; any other error is settled by a `stat` of that
/// component: a directory (followed through symlinks) is fine, another
/// entry is EEXIST, or ENOTDIR when it sits in the middle of the path (a
/// file or a dangling symlink), and a failed `stat` is its own error. The
/// error names the component, which can be a parent.
///
/// Where a component without a `/` left is ENOENT while a deeper one waits
/// (a relative path under a deleted cwd), node tries the deeper one again,
/// forever, and the promise never settles; this stops with that ENOENT.
fn mkdirp(path: &Path, mode: u32) -> Result<(), MkdirFail> {
    mkdirp_on(path, &mut |p| mkdir(p, mode), &|p| {
        std::fs::metadata(p).map(|m| m.is_dir())
    })
}

/// [`mkdirp`] over a given `mkdir` and `stat` (whether the entry, followed
/// through symlinks, is a directory).
fn mkdirp_on(
    path: &Path,
    mkdir: &mut dyn FnMut(&Path) -> io::Result<()>,
    stat: &dyn Fn(&Path) -> io::Result<bool>,
) -> Result<(), MkdirFail> {
    let mut pending: Vec<PathBuf> = Vec::new();
    let mut next = path.to_path_buf();
    loop {
        let result = mkdir(&next);
        let mut err = result.err().map(|e| (code(&e), e));
        loop {
            match err.as_ref().map(|(c, _)| c.as_deref()) {
                None => {
                    match pending.pop() {
                        Some(p) => next = p,
                        None => return Ok(()),
                    }
                    break;
                }
                Some(Some("EACCES" | "ENOSPC" | "ENOTDIR" | "EPERM")) => {
                    let (_, e) = err.expect("an error");
                    return Err(MkdirFail::Os(e, next));
                }
                Some(Some("ENOENT")) => {
                    if let Some(parent) = cut_last_slash(&next) {
                        pending.push(std::mem::replace(&mut next, parent));
                    } else if pending.is_empty() {
                        err = Some((Some("EEXIST".to_owned()), err.expect("an error").1));
                        continue;
                    } else {
                        let (_, e) = err.expect("an error");
                        return Err(MkdirFail::Os(e, next));
                    }
                    break;
                }
                was => {
                    let was_exists = was == Some(Some("EEXIST"));
                    let stat = stat(&next);
                    let is_dir = stat.as_ref().is_ok_and(|d| *d);
                    if was_exists && !pending.is_empty() {
                        if is_dir {
                            next = pending.pop().expect("not empty");
                            break;
                        }
                        return Err(MkdirFail::Coded("ENOTDIR", next));
                    }
                    return match stat {
                        Ok(_) if is_dir => Ok(()),
                        Ok(_) => Err(MkdirFail::Coded("EEXIST", next)),
                        Err(e) => Err(MkdirFail::Os(e, next)),
                    };
                }
            }
        }
    }
}

fn mkdir(path: &Path, mode: u32) -> io::Result<()> {
    let mut b = std::fs::DirBuilder::new();
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut b, mode);
    #[cfg(not(unix))]
    let _ = mode;
    b.create(path)
}

/// `fs.promises.mkdir(path, { recursive: true, mode })` ([`mkdirp`]'s
/// walk), the error always as syscall `mkdir` on the component it names.
pub fn mkdir_recursive(path: &str, mode: u32) -> Result<(), FsError> {
    mkdirp(Path::new(path), mode).map_err(MkdirFail::into_fs_error)
}

impl MkdirFail {
    fn into_fs_error(self) -> FsError {
        match self {
            MkdirFail::Os(e, at) => FsError::new(&e, "mkdir", Some(&at.to_string_lossy()), None),
            MkdirFail::Coded(code, at) => FsError::coded(code, "mkdir", &at.to_string_lossy()),
        }
    }
}

/// Node's `kIoMaxLength` (`2 ** 31 - 1`): `readFile` refuses a bigger
/// regular file (`ERR_FS_FILE_TOO_LARGE`) before reading it.
pub const IO_MAX_LENGTH: u64 = (1 << 31) - 1;

/// `fs.promises.readdir(path)`: the names (without `.` and `..`) sorted by
/// their raw bytes, as libuv's `scandir` sorts them (`strcmp`), each then
/// decoded as node decodes it (UTF-8, U+FFFD for invalid bytes). Nothing is
/// `stat`ed, so a listable folder without search permission still lists.
pub fn readdir(path: &str) -> io::Result<Vec<String>> {
    let mut raw = Vec::new();
    for entry in std::fs::read_dir(path)? {
        let name = entry?.file_name();
        #[cfg(unix)]
        raw.push(std::os::unix::ffi::OsStrExt::as_bytes(name.as_os_str()).to_vec());
        #[cfg(not(unix))]
        raw.push(name.to_string_lossy().into_owned().into_bytes());
    }
    raw.sort();
    Ok(raw
        .into_iter()
        .map(|name| String::from_utf8_lossy(&name).into_owned())
        .collect())
}

/// `fs.promises.copyFile(src, dst)` (D14): the bytes and mode through
/// symlinks, a clone where the file system can (APFS), over an existing
/// `dst`. Errors name both paths (`ENOENT: …, copyfile 'src' -> 'dst'`).
pub fn copy_file(src: &str, dst: &str) -> Result<(), FsError> {
    std::fs::copy(src, dst)
        .map(|_| ())
        .map_err(|e| FsError::new(&e, "copyfile", Some(src), Some(dst)))
}

/// `fs.promises.readdir(path, { withFileTypes: true })`: [`readdir`]'s
/// names, each with the type of the entry itself (a symlink is a symlink,
/// never what it points at), as libuv reads it from the directory.
pub fn readdir_dirents(path: &str) -> io::Result<Vec<(String, std::fs::FileType)>> {
    let mut raw = Vec::new();
    for entry in std::fs::read_dir(path)? {
        let entry = entry?;
        let name = entry.file_name();
        #[cfg(unix)]
        let bytes = std::os::unix::ffi::OsStrExt::as_bytes(name.as_os_str()).to_vec();
        #[cfg(not(unix))]
        let bytes = name.to_string_lossy().into_owned().into_bytes();
        raw.push((bytes, entry.file_type()?));
    }
    raw.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(raw
        .into_iter()
        .map(|(name, kind)| (String::from_utf8_lossy(&name).into_owned(), kind))
        .collect())
}

/// `stat.mtimeMs`: the double `sec * 1e3 + nsec / 1e6` (`tv_sec` rounds
/// down and `tv_nsec` stays positive, before the epoch too), so two times
/// a few nanoseconds apart can be the same number.
pub fn mtime_ms(t: std::time::SystemTime) -> f64 {
    let nanos = match t.duration_since(std::time::UNIX_EPOCH) {
        Ok(d) => d.as_nanos() as i128,
        Err(e) => -(e.duration().as_nanos() as i128),
    };
    let (sec, nsec) = (
        nanos.div_euclid(1_000_000_000),
        nanos.rem_euclid(1_000_000_000),
    );
    sec as f64 * 1e3 + nsec as f64 / 1e6
}

/// `fs.promises.readFile(path, "utf8")`: the bytes decoded with U+FFFD for
/// invalid sequences (a BOM is kept). `open` errors name the path; `read`
/// errors (a directory) don't.
pub fn read_to_string(path: &str) -> Result<String, FsError> {
    use std::io::Read;
    let mut f =
        std::fs::File::open(path).map_err(|e| FsError::new(&e, "open", Some(path), None))?;
    let mut bytes = Vec::new();
    f.read_to_end(&mut bytes)
        .map_err(|e| FsError::new(&e, "read", None, None))?;
    Ok(match String::from_utf8(bytes) {
        Ok(s) => s,
        Err(e) => String::from_utf8_lossy(e.as_bytes()).into_owned(),
    })
}

/// `fs.promises.writeFile(path, text, { mode })`: created (with `mode`, less
/// the umask) or truncated.
pub fn write_file(path: &str, text: &str, mode: u32) -> Result<(), FsError> {
    use std::io::Write;
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut o, mode);
    #[cfg(not(unix))]
    let _ = mode;
    let mut f = o
        .open(path)
        .map_err(|e| FsError::new(&e, "open", Some(path), None))?;
    f.write_all(text.as_bytes())
        .map_err(|e| FsError::new(&e, "write", None, None))
}

/// `fs.promises.rename(from, to)`.
pub fn rename(from: &str, to: &str) -> Result<(), FsError> {
    std::fs::rename(from, to).map_err(|e| FsError::new(&e, "rename", Some(from), Some(to)))
}

/// `fs.promises.chmod(path, mode)` (a no-op off unix).
pub fn chmod(path: &str, mode: u32) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
    }
    #[cfg(not(unix))]
    {
        let _ = (path, mode);
        Ok(())
    }
}

/// `fs.promises.symlink(target, path)` (off unix, a directory link when the
/// target is a directory, as Node picks).
pub fn symlink(target: &str, path: &str) -> io::Result<()> {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, path)
    }
    #[cfg(windows)]
    {
        if std::fs::metadata(target).is_ok_and(|m| m.is_dir()) {
            std::os::windows::fs::symlink_dir(target, path)
        } else {
            std::os::windows::fs::symlink_file(target, path)
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (target, path);
        Err(io::Error::from(ErrorKind::Unsupported))
    }
}

/// `fs.constants.F_OK`.
pub const F_OK: i32 = 0;
/// `fs.constants.W_OK`.
pub const W_OK: i32 = 2;

/// `fs.promises.access(path, mode)`: libuv's `access(2)` with the process's
/// real ids, through symlinks (D22). Off unix, `W_OK` is the read-only bit.
pub fn access(path: &str, mode: i32) -> Result<(), FsError> {
    #[cfg(unix)]
    {
        let fail = |e: io::Error| FsError::new(&e, "access", Some(path), None);
        let c = std::ffi::CString::new(path)
            .map_err(|_| fail(io::Error::from(ErrorKind::InvalidInput)))?;
        // SAFETY: `c` is a NUL-terminated path that outlives the call.
        if unsafe { libc::access(c.as_ptr(), mode) } == 0 {
            Ok(())
        } else {
            Err(fail(io::Error::last_os_error()))
        }
    }
    #[cfg(not(unix))]
    {
        let md =
            std::fs::metadata(path).map_err(|e| FsError::new(&e, "access", Some(path), None))?;
        if mode & W_OK != 0 && md.permissions().readonly() {
            return Err(FsError::new(
                &io::Error::from(ErrorKind::PermissionDenied),
                "access",
                Some(path),
                None,
            ));
        }
        Ok(())
    }
}

/// `fs.promises.rm(path, { recursive: true, force: true })`: a directory
/// with everything in it, or the file or symlink itself; a missing path is
/// fine.
pub fn rm_recursive_force(path: &str) -> io::Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(m) if m.is_dir() => std::fs::remove_dir_all(path),
        Ok(_) => std::fs::remove_file(path),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

/// `fs.promises.rm(path, { force: true })`: [`rm_recursive`] without
/// `recursive`, so a directory is refused with Node's `ERR_FS_EISDIR`.
pub fn rm_force(path: &str) -> Result<(), FsError> {
    match std::fs::symlink_metadata(path) {
        Ok(m) if m.is_dir() => Err(FsError {
            code: Some("ERR_FS_EISDIR".into()),
            message: format!("Path is a directory: rm returned EISDIR (is a directory) {path}"),
        }),
        Ok(_) => rm_recursive(path, true),
        Err(e) if code(&e).as_deref() == Some("ENOENT") => Ok(()),
        Err(e) => Err(FsError::new(&e, "lstat", Some(path), None)),
    }
}

/// `fs.promises.rm(path, { recursive: true, force })`: `validateRmOptions`'
/// `lstat` (its ENOENT is fine with `force`, else the error), then node
/// 22's rimraf (no retries): an ENOENT anywhere below is success, and the
/// children of a directory are all removed before the first failure among
/// them is reported, as Node starts them all at once.
pub fn rm_recursive(path: &str, force: bool) -> Result<(), FsError> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => {}
        Err(e) if force && code(&e).as_deref() == Some("ENOENT") => return Ok(()),
        Err(e) => return Err(FsError::new(&e, "lstat", Some(path), None)),
    }
    rimraf::rimraf(std::path::Path::new(path))
}

mod rimraf {
    use std::io;
    use std::path::{Path, PathBuf};

    use super::{FsError, code};

    fn lossy(p: &Path) -> String {
        p.to_string_lossy().into_owned()
    }

    fn is_enoent(e: &io::Error) -> bool {
        code(e).as_deref() == Some("ENOENT")
    }

    /// `rimraf(path, options, cb)`: an `ENOENT` anywhere is success.
    pub(super) fn rimraf(path: &Path) -> Result<(), FsError> {
        match rimraf_inner(path) {
            Err(e) if e.is_not_found() => Ok(()),
            r => r,
        }
    }

    fn rimraf_inner(path: &Path) -> Result<(), FsError> {
        match std::fs::symlink_metadata(path) {
            Err(e) if is_enoent(&e) => return Ok(()),
            Ok(m) if m.is_dir() => return rmdir(path, None),
            _ => {}
        }
        match std::fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(e) => {
                let err = FsError::new(&e, "unlink", Some(&lossy(path)), None);
                match code(&e).as_deref() {
                    Some("ENOENT") => Ok(()),
                    Some("EISDIR" | "EPERM") => rmdir(path, Some(err)),
                    _ => Err(err),
                }
            }
        }
    }

    /// `_rmdir`: an empty directory goes at once, a full one after its
    /// children; `ENOTDIR` reports the error that led here, if any.
    fn rmdir(path: &Path, original: Option<FsError>) -> Result<(), FsError> {
        match std::fs::remove_dir(path) {
            Ok(()) => Ok(()),
            Err(e) => match code(&e).as_deref() {
                Some("ENOTEMPTY" | "EEXIST" | "EPERM") => rmchildren(path),
                Some("ENOTDIR") => original.map_or(Ok(()), Err),
                _ => Err(FsError::new(&e, "rmdir", Some(&lossy(path)), None)),
            },
        }
    }

    fn rmchildren(path: &Path) -> Result<(), FsError> {
        let mut names: Vec<std::ffi::OsString> = match std::fs::read_dir(path) {
            Ok(rd) => rd
                .map(|e| e.map(|e| e.file_name()))
                .collect::<io::Result<_>>()
                .map_err(|e| FsError::new(&e, "scandir", Some(&lossy(path)), None))?,
            Err(e) => return Err(FsError::new(&e, "scandir", Some(&lossy(path)), None)),
        };
        // libuv's `scandir` order.
        names.sort_by(|a, b| a.as_encoded_bytes().cmp(b.as_encoded_bytes()));
        let mut first = None;
        for name in names {
            let child: PathBuf = path.join(name);
            if let Err(e) = rimraf(&child) {
                first.get_or_insert(e);
            }
        }
        if let Some(e) = first {
            return Err(e);
        }
        std::fs::remove_dir(path).map_err(|e| FsError::new(&e, "rmdir", Some(&lossy(path)), None))
    }
}

/// `fs.promises` calls that reject with the whole `SystemError`
/// ([`NodeError`]), on `Path`s. Only the calls whose syscall or path isn't
/// the obvious one are here: `readFile` (a directory fails at `read`,
/// without a path) and recursive `mkdir` (the component that failed).
pub mod sys {
    use std::io::{Read, Write};
    use std::path::Path;

    #[cfg(unix)]
    use super::{MkdirFail, mkdirp};
    use super::{NodeError, uv_exception};

    /// `fs.promises.readFile(path)`: `open` names the path, a failed `read`
    /// (a directory: EISDIR) doesn't.
    pub fn read_file(path: &Path) -> Result<Vec<u8>, NodeError> {
        let mut file =
            std::fs::File::open(path).map_err(|e| uv_exception(&e, "open", Some(path), None))?;
        let mut buf = Vec::new();
        file.read_to_end(&mut buf)
            .map_err(|e| uv_exception(&e, "read", None, None))?;
        Ok(buf)
    }

    /// `fs.promises.writeFile(path, bytes)`: open with `w` (create,
    /// truncate, mode 0o666 before the umask), then write.
    pub fn write_file(path: &Path, bytes: &[u8]) -> Result<(), NodeError> {
        let mut file =
            std::fs::File::create(path).map_err(|e| uv_exception(&e, "open", Some(path), None))?;
        file.write_all(bytes)
            .map_err(|e| uv_exception(&e, "write", None, None))
    }

    /// `fs.promises.lstat(path)`.
    pub fn lstat(path: &Path) -> Result<std::fs::Metadata, NodeError> {
        std::fs::symlink_metadata(path).map_err(|e| uv_exception(&e, "lstat", Some(path), None))
    }

    /// `fs.promises.chmod(path, mode)`.
    #[cfg(unix)]
    pub fn chmod(path: &Path, mode: u32) -> Result<(), NodeError> {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
            .map_err(|e| uv_exception(&e, "chmod", Some(path), None))
    }

    /// `fs.promises.rename(from, to)`.
    pub fn rename(from: &Path, to: &Path) -> Result<(), NodeError> {
        std::fs::rename(from, to).map_err(|e| uv_exception(&e, "rename", Some(from), Some(to)))
    }

    /// `fs.promises.unlink(path)` (a directory is EPERM on macOS, EISDIR
    /// on Linux, as unlink(2) says).
    pub fn unlink(path: &Path) -> Result<(), NodeError> {
        std::fs::remove_file(path).map_err(|e| uv_exception(&e, "unlink", Some(path), None))
    }

    /// `fs.promises.mkdir(path, { recursive: true })`: [`super::mkdirp`]'s
    /// walk with mode 0o777, the error always as syscall `mkdir` on the
    /// component it names (a missing component on a read-only file system
    /// reads ENOENT, from the `stat`).
    #[cfg(unix)]
    pub fn mkdir_recursive(path: &Path) -> Result<(), NodeError> {
        mkdirp(path, 0o777).map_err(|fail| match fail {
            MkdirFail::Os(e, at) => uv_exception(&e, "mkdir", Some(&at), None),
            MkdirFail::Coded(code, at) => {
                let errno = if code == "ENOTDIR" {
                    libc::ENOTDIR
                } else {
                    libc::EEXIST
                };
                let e = std::io::Error::from_raw_os_error(errno);
                uv_exception(&e, "mkdir", Some(&at), None)
            }
        })
    }

    /// `fs.promises.mkdir(path, { recursive: true })`.
    #[cfg(not(unix))]
    pub fn mkdir_recursive(path: &Path) -> Result<(), NodeError> {
        std::fs::create_dir_all(path).map_err(|e| uv_exception(&e, "mkdir", Some(path), None))
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn formats_like_uv_exception() {
        let e = io::Error::from_raw_os_error(libc::EACCES);
        let n = uv_exception(&e, "open", Some(Path::new("/a b/'c'")), None);
        assert_eq!(n.message, "EACCES: permission denied, open '/a b/'c''");
        assert_eq!((n.code.as_str(), n.errno), ("EACCES", -libc::EACCES));
        let n = uv_exception(
            &io::Error::from_raw_os_error(libc::EISDIR),
            "rename",
            Some(Path::new("/a")),
            Some(Path::new("/b")),
        );
        assert_eq!(
            n.to_string(),
            "EISDIR: illegal operation on a directory, rename '/a' -> '/b'"
        );
        let n = uv_exception(
            &io::Error::from_raw_os_error(libc::EISDIR),
            "read",
            None,
            None,
        );
        assert_eq!(n.message, "EISDIR: illegal operation on a directory, read");
        assert_eq!((n.path, n.dest), (None, None));
    }

    #[test]
    fn unnamed_and_synthetic_errors() {
        let n = uv_exception(&io::Error::from_raw_os_error(9999), "open", None, None);
        assert_eq!(
            n.message,
            "Unknown system error -9999: Unknown system error -9999, open"
        );
        assert_eq!(n.errno, -9999);
        let n = uv_exception(&io::Error::other("boom"), "write", None, None);
        assert_eq!(
            (n.code.as_str(), n.errno, n.message.as_str()),
            ("UNKNOWN", -4094, "UNKNOWN: unknown error, write")
        );
    }

    /// Every name libuv has here has its text (the table is keyed by name,
    /// the names come from the SDK host's spawn table).
    #[test]
    fn every_name_has_its_text() {
        for n in 1..512 {
            if let Some(code) = claudius_agent::binary::errno_name(n) {
                assert_ne!(strerror(code), "unknown error", "{code}");
                assert_eq!(describe(n).map(|d| d.0), Some(code));
            } else {
                assert_eq!(describe(n), None, "errno {n}");
            }
        }
    }

    /// The two shapes say the same for every errno (G02a's `FsError` once
    /// said `unknown error` for the names its own table missed, and G05's
    /// table named EDQUOT, which libuv doesn't), and walk `mkdir -p` the
    /// same way.
    #[test]
    fn both_shapes_agree() {
        for n in 1..512 {
            let e = io::Error::from_raw_os_error(n);
            let fs = FsError::new(&e, "rename", Some("/x"), Some("/y"));
            let node = uv_exception(&e, "rename", Some(Path::new("/x")), Some(Path::new("/y")));
            assert_eq!(fs.message, node.message, "errno {n}");
            assert_eq!(fs.code.as_deref(), Some(node.code.as_str()), "errno {n}");
        }
        assert_eq!(
            FsError::new(
                &io::Error::from_raw_os_error(libc::ENOTTY),
                "open",
                Some("/x"),
                None
            )
            .message,
            "ENOTTY: inappropriate ioctl for device, open '/x'"
        );
        assert_eq!(
            FsError::new(
                &io::Error::from_raw_os_error(libc::EDQUOT),
                "open",
                Some("/x"),
                None
            )
            .message,
            format!(
                "Unknown system error -{0}: Unknown system error -{0}, open '/x'",
                libc::EDQUOT
            )
        );
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::write(root.join("file"), "x").unwrap();
        std::fs::create_dir(root.join("ro")).unwrap();
        std::os::unix::fs::symlink(root.join("nowhere/x"), root.join("dangling")).unwrap();
        std::os::unix::fs::symlink(root.join("loop"), root.join("loop")).unwrap();
        let mode =
            |m| std::fs::set_permissions(root.join("ro"), std::fs::Permissions::from_mode(m));
        mode(0o555).unwrap();
        for rel in [
            "file",
            "file/a/b",
            "dangling",
            "dangling/a",
            "loop/a",
            "ro/a/b",
            "ro",
            "new/a/b",
        ] {
            let p = root.join(rel);
            let node = sys::mkdir_recursive(&p).err().map(|e| e.message);
            let fs = mkdir_recursive(p.to_str().unwrap(), 0o777)
                .err()
                .map(|e| e.message);
            assert_eq!(node, fs, "{rel}");
        }
        mode(0o755).unwrap();
    }

    #[test]
    fn messages_match_node() {
        // Recorded from node 22's fs.promises.
        let e = |n| io::Error::from_raw_os_error(n);
        let msg = |n, syscall, path, dest| FsError::new(&e(n), syscall, path, dest).message;
        assert_eq!(
            msg(libc::ENOENT, "open", Some("/x"), None),
            "ENOENT: no such file or directory, open '/x'"
        );
        assert_eq!(
            msg(libc::EISDIR, "read", None, None),
            "EISDIR: illegal operation on a directory, read"
        );
        assert_eq!(
            msg(libc::EISDIR, "rename", Some("src"), Some("adir")),
            "EISDIR: illegal operation on a directory, rename 'src' -> 'adir'"
        );
        assert_eq!(
            msg(libc::EPERM, "unlink", Some("adir"), None),
            "EPERM: operation not permitted, unlink 'adir'"
        );
        assert_eq!(
            msg(libc::EINVAL, "readlink", Some("adir"), None),
            "EINVAL: invalid argument, readlink 'adir'"
        );
        assert_eq!(
            msg(libc::ENOENT, "rename", Some(""), Some("")),
            "ENOENT: no such file or directory, rename '' -> ''"
        );
        assert_eq!(
            mkdir_recursive("", 0o777).unwrap_err().message,
            "ENOENT: no such file or directory, mkdir ''"
        );
        assert_eq!(
            read_to_string("").unwrap_err().message,
            "ENOENT: no such file or directory, open ''"
        );
        assert_eq!(
            FsError::new(&io::Error::other("boom"), "open", Some("p"), None).message,
            "boom, open 'p'"
        );
        assert_eq!(
            code(&e(9999)).as_deref(),
            Some("Unknown system error -9999")
        );
    }

    #[test]
    fn mkdir_walk_on_injected_errors() {
        // node 22's MKDirpAsync over a fake disk holding `dirs` (and `/`),
        // where `special` paths fail their `mkdir` with an errno. ENOSPC
        // fails at once (G02a's walk went on to the `stat`, which said
        // ENOENT); any other error is settled by the `stat`; an ENOENT with
        // no `/` left while a deeper component waits stops there (node
        // retries forever).
        use std::cell::RefCell;
        let errno = |n| io::Error::from_raw_os_error(n);
        let walk = |path: &str, special: &[(&str, i32)], dirs: &[&str]| {
            let dirs: RefCell<Vec<String>> =
                RefCell::new(dirs.iter().map(|d| (*d).to_owned()).collect());
            let exists = |p: &str| p.is_empty() || dirs.borrow().iter().any(|d| d == p);
            let mut made: Vec<String> = Vec::new();
            let r = mkdirp_on(
                Path::new(path),
                &mut |p| {
                    let s = p.to_str().unwrap();
                    if let Some((_, n)) = special.iter().find(|(at, _)| *at == s) {
                        return Err(errno(*n));
                    }
                    if exists(s) {
                        return Err(errno(libc::EEXIST));
                    }
                    match s.rfind('/') {
                        Some(i) if exists(&s[..i]) => {
                            dirs.borrow_mut().push(s.to_owned());
                            made.push(s.to_owned());
                            Ok(())
                        }
                        _ => Err(errno(libc::ENOENT)),
                    }
                },
                &|p| {
                    if exists(p.to_str().unwrap()) {
                        Ok(true)
                    } else {
                        Err(errno(libc::ENOENT))
                    }
                },
            );
            (r.map_err(|f| f.into_fs_error().message), made)
        };
        let r = &["/r"];
        assert_eq!(
            walk("/r/a/b", &[], r),
            (Ok(()), vec!["/r/a".to_owned(), "/r/a/b".to_owned()])
        );
        assert_eq!(
            walk("/r/a/b", &[("/r/a", libc::ENOSPC)], r),
            (
                Err("ENOSPC: no space left on device, mkdir '/r/a'".into()),
                vec![]
            )
        );
        assert_eq!(
            walk("/r/a/b", &[("/r/a", libc::EROFS)], r),
            (
                Err("ENOENT: no such file or directory, mkdir '/r/a'".into()),
                vec![]
            )
        );
        // A component that is a directory after all settles the whole
        // call as done, its children not made (node's `Done(0)`).
        assert_eq!(
            walk(
                "/r/a/b",
                &[("/r/a/b", libc::ENOENT), ("/r/a", libc::EROFS)],
                &["/r", "/r/a"]
            ),
            (Ok(()), vec![])
        );
        assert_eq!(
            walk("a/b/c", &[], &[]),
            (
                Err("ENOENT: no such file or directory, mkdir 'a'".into()),
                vec![]
            )
        );
        for n in [libc::EACCES, libc::ENOTDIR, libc::EPERM] {
            let (r, made) = walk("/r/a/b", &[("/r/a/b", libc::ENOENT), ("/r/a", n)], &["/r"]);
            assert!(r.unwrap_err().ends_with(", mkdir '/r/a'"), "{n}");
            assert!(made.is_empty());
        }
    }

    #[test]
    fn mkdir_walk_matches_node() {
        // Recorded from node 22's fs.promises.mkdir(p, { recursive: true }).
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap().display().to_string();
        let p = |rel: &str| format!("{root}/{rel}");
        std::fs::write(p("file"), "x").unwrap();
        std::os::unix::fs::symlink(p("nowhere"), p("dangling")).unwrap();
        std::os::unix::fs::symlink(p("file"), p("tofile")).unwrap();
        std::fs::create_dir(p("d")).unwrap();
        std::os::unix::fs::symlink(p("d"), p("todir")).unwrap();
        let err = |rel: &str| {
            mkdir_recursive(&p(rel), 0o777)
                .unwrap_err()
                .message
                .replace(&root, "$R")
        };
        mkdir_recursive(&p("a/b/c"), 0o700).unwrap();
        use std::os::unix::fs::PermissionsExt;
        for rel in ["a", "a/b", "a/b/c"] {
            let mode = std::fs::metadata(p(rel)).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o700, "{rel}");
        }
        mkdir_recursive(&p("a/b/c"), 0o777).unwrap();
        mkdir_recursive(&p("todir"), 0o777).unwrap();
        mkdir_recursive(&p("todir/new/deeper/"), 0o777).unwrap();
        assert!(std::fs::metadata(p("d/new/deeper")).unwrap().is_dir());
        // `ff//g/` already exists by the time its turn comes (made as
        // `ff//g`), which is fine as it's a directory.
        mkdir_recursive(&p("ff//g//"), 0o777).unwrap();
        assert!(std::fs::metadata(p("ff/g")).unwrap().is_dir());
        assert_eq!(err("file"), "EEXIST: file already exists, mkdir '$R/file'");
        assert_eq!(
            err("tofile"),
            "EEXIST: file already exists, mkdir '$R/tofile'"
        );
        assert_eq!(
            err("file/x/y"),
            "ENOTDIR: not a directory, mkdir '$R/file/x/y'"
        );
        assert_eq!(
            err("dangling"),
            "ENOENT: no such file or directory, mkdir '$R/dangling'"
        );
        assert_eq!(
            err("dangling/x"),
            "ENOTDIR: not a directory, mkdir '$R/dangling'"
        );
    }

    #[test]
    fn dirents_sort_by_bytes_and_do_not_follow_links() {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path();
        let mut names: Vec<String> = (0..40).map(|i| format!("{:x}", (i * 7919) % 997)).collect();
        names.extend(["B".into(), "a".into(), "\u{e9}".into(), "\u{1f600}".into()]);
        for n in &names {
            std::fs::write(d.join(n), "").unwrap();
        }
        std::fs::create_dir(d.join("zdir")).unwrap();
        symlink(
            d.join("zdir").to_str().unwrap(),
            d.join("zlink").to_str().unwrap(),
        )
        .unwrap();
        let got = readdir_dirents(d.to_str().unwrap()).unwrap();
        let mut want = names.clone();
        want.extend(["zdir".into(), "zlink".into()]);
        want.sort();
        assert_eq!(got.iter().map(|(n, _)| n.clone()).collect::<Vec<_>>(), want);
        let kind = |n: &str| got.iter().find(|(x, _)| x == n).unwrap().1;
        assert!(kind("zdir").is_dir());
        assert!(kind("zlink").is_symlink() && !kind("zlink").is_dir());
        assert!(kind("a").is_file());
        assert_eq!(
            readdir_dirents(d.join("a").to_str().unwrap())
                .unwrap_err()
                .raw_os_error(),
            Some(libc::ENOTDIR)
        );
    }
}
