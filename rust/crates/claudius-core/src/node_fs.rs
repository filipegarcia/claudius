//! What a ported store needs to touch the disk the way Node's `fs` does:
//! `path.posix.join` (the path strings end up in env vars and messages),
//! `fs.mkdir(p, { recursive: true })`'s walk, and the `message` of the error a
//! failed call rejects with (`CODE: description, syscall 'path' -> 'dest'`),
//! so a route that hands `err.message` to the client says the same thing.
//!
//! Paths are the strings the TS builds; they go to the OS as they are.

use std::io::{self, ErrorKind};

/// A failed `fs` call: Node's `err.code` and `err.message`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FsError {
    pub code: Option<String>,
    pub message: String,
}

impl FsError {
    /// The error `syscall` on `path` (and `dest`) rejects with for `error`.
    pub fn new(
        error: &io::Error,
        syscall: &str,
        path: Option<&str>,
        dest: Option<&str>,
    ) -> FsError {
        let code = code(error);
        let head = match code.as_deref() {
            Some(c) => format!("{c}: {}", describe(c)),
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
                format!("{code}: {}", describe(code)),
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
        let n = error.raw_os_error()?;
        Some(match claudius_agent::binary::errno_name(n) {
            Some(name) => name.to_owned(),
            None => format!("Unknown system error -{n}"),
        })
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

/// libuv's `uv_strerror` for a code.
fn describe(code: &str) -> &str {
    match code {
        "E2BIG" => "argument list too long",
        "EACCES" => "permission denied",
        "EAGAIN" => "resource temporarily unavailable",
        "EBADF" => "bad file descriptor",
        "EBUSY" => "resource busy or locked",
        "ECANCELED" => "operation canceled",
        "EEXIST" => "file already exists",
        "EFAULT" => "bad address in system call argument",
        "EFBIG" => "file too large",
        "EFTYPE" => "inappropriate file type or format",
        "EILSEQ" => "illegal byte sequence",
        "EINTR" => "interrupted system call",
        "EINVAL" => "invalid argument",
        "EIO" => "i/o error",
        "EISDIR" => "illegal operation on a directory",
        "ELOOP" => "too many symbolic links encountered",
        "EMFILE" => "too many open files",
        "EMLINK" => "too many links",
        "ENAMETOOLONG" => "name too long",
        "ENFILE" => "file table overflow",
        "ENODEV" => "no such device",
        "ENOENT" => "no such file or directory",
        "ENOMEM" => "not enough memory",
        "ENOSPC" => "no space left on device",
        "ENOSYS" => "function not implemented",
        "ENOTDIR" => "not a directory",
        "ENOTEMPTY" => "directory not empty",
        "ENOTSUP" => "operation not supported on socket",
        "ENXIO" => "no such device or address",
        "EOVERFLOW" => "value too large for defined data type",
        "EPERM" => "operation not permitted",
        "EROFS" => "read-only file system",
        "ESPIPE" => "invalid seek",
        "ETXTBSY" => "text file is busy",
        "EXDEV" => "cross-device link not permitted",
        c if c.starts_with("Unknown system error") => c,
        _ => "unknown error",
    }
}

/// `path.posix.normalize`: empty and `.` segments dropped, `..` resolved
/// lexically (kept at the front of a relative path, dropped at `/`), a
/// trailing `/` kept; `""` is `"."`.
pub fn normalize(path: &str) -> String {
    if path.is_empty() {
        return ".".into();
    }
    let absolute = path.starts_with('/');
    let trailing = path.ends_with('/');
    let mut segs: Vec<&str> = Vec::new();
    for seg in path.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                if segs.last().is_some_and(|s| *s != "..") {
                    segs.pop();
                } else if !absolute {
                    segs.push("..");
                }
            }
            s => segs.push(s),
        }
    }
    let mut out = segs.join("/");
    if out.is_empty() {
        return match (absolute, trailing) {
            (true, _) => "/".into(),
            (false, true) => "./".into(),
            (false, false) => ".".into(),
        };
    }
    if trailing {
        out.push('/');
    }
    if absolute { format!("/{out}") } else { out }
}

/// `path.posix.join(...parts)`: the non-empty parts joined with `/`, then
/// [`normalize`]d; no parts at all is `"."`.
pub fn join(parts: &[&str]) -> String {
    let parts: Vec<&str> = parts.iter().copied().filter(|p| !p.is_empty()).collect();
    if parts.is_empty() {
        return ".".into();
    }
    normalize(&parts.join("/"))
}

/// `fs.promises.mkdir(path, { recursive: true, mode })`, walked the way
/// Node's `MKDirpAsync` walks it: a missing parent is made first; a path that
/// exists is fine if it's a directory (followed through symlinks); an error
/// names the directory it happened on, which can be a parent.
pub fn mkdir_recursive(path: &str, mode: u32) -> Result<(), FsError> {
    let mut pending: Vec<String> = Vec::new();
    let mut next = path.to_owned();
    loop {
        let result = mkdir(&next, mode);
        let mut err = result.as_ref().err().map(|e| (code(e), e));
        loop {
            match err.as_ref().map(|(c, _)| c.as_deref()) {
                None => {
                    match pending.pop() {
                        Some(p) => next = p,
                        None => return Ok(()),
                    }
                    break;
                }
                Some(Some("EACCES" | "ENOTDIR" | "EPERM")) => {
                    let (_, e) = err.expect("an error");
                    return Err(FsError::new(e, "mkdir", Some(&next), None));
                }
                Some(Some("ENOENT")) => {
                    let parent = next
                        .rfind('/')
                        .map_or(next.as_str(), |i| &next[..i])
                        .to_owned();
                    if parent != next {
                        pending.push(std::mem::replace(&mut next, parent));
                    } else if pending.is_empty() {
                        err = Some((Some("EEXIST".to_owned()), err.expect("an error").1));
                        continue;
                    } else {
                        // Node goes back to the path below and walks up to
                        // here again, forever (a relative path under a
                        // deleted cwd); stop with the error instead.
                        let (_, e) = err.expect("an error");
                        return Err(FsError::new(e, "mkdir", Some(&next), None));
                    }
                    break;
                }
                was => {
                    let was_exists = was == Some(Some("EEXIST"));
                    let stat = std::fs::metadata(&next);
                    let is_dir = stat.as_ref().is_ok_and(|m| m.is_dir());
                    if was_exists && !pending.is_empty() {
                        if is_dir {
                            next = pending.pop().expect("not empty");
                            break;
                        }
                        return Err(FsError::coded("ENOTDIR", "mkdir", &next));
                    }
                    return match stat {
                        Ok(_) if is_dir => Ok(()),
                        Ok(_) => Err(FsError::coded("EEXIST", "mkdir", &next)),
                        Err(e) => Err(FsError::new(&e, "mkdir", Some(&next), None)),
                    };
                }
            }
        }
    }
}

fn mkdir(path: &str, mode: u32) -> io::Result<()> {
    let mut b = std::fs::DirBuilder::new();
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut b, mode);
    #[cfg(not(unix))]
    let _ = mode;
    b.create(path)
}

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

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn join_matches_path_posix() {
        // Recorded from node 22's path.posix.join.
        let cases: &[(&[&str], &str)] = &[
            (&[], "."),
            (&[""], "."),
            (&["", ""], "."),
            (&["/a", "b"], "/a/b"),
            (&["/a/", "b/"], "/a/b/"),
            (&["/a//b", "./c", "../d"], "/a/b/d"),
            (&["/", ".."], "/"),
            (&["/a/..", ".."], "/"),
            (&["a", "..", ".."], ".."),
            (&["../a", "../../b"], "../../b"),
            (&["a/b", "../.."], "."),
            (&["a/b", "../../"], "./"),
            (&["./", "."], "."),
            (&["x", "", "y"], "x/y"),
            (&["/x/", "/", "/y"], "/x/y"),
            (&["...", "..a"], ".../..a"),
            (
                &["/home/u/", ".claude", ".claudius"],
                "/home/u/.claude/.claudius",
            ),
            (&["/acc", "profiles", ""], "/acc/profiles"),
            (&["/acc", "profiles", ".."], "/acc"),
        ];
        for (parts, want) in cases {
            assert_eq!(join(parts), *want, "{parts:?}");
        }
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
