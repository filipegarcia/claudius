//! Node's fs error text, for ported code whose errors reach a user or a
//! response body.
//!
//! A failed `fs` call in Node rejects with libuv's `uvException`:
//! `CODE: description, syscall 'path' -> 'dest'` (`EACCES: permission
//! denied, open '/x'`), with `code`, `errno`, `syscall`, `path` and `dest`
//! on the error. [`uv_exception`] builds that from an [`std::io::Error`]
//! and the syscall Node would name, and [`fs`] has the `fs.promises` calls
//! whose syscall or path isn't the obvious one: `readFile` (a directory
//! fails at `read`, without a path) and recursive `mkdir` (the component
//! that failed). Recorded against node 22 by
//! `rust/scripts/settings-errors-golden.mjs` (`tests/settings_errors_golden.rs`).

use std::fmt;
use std::io;
use std::path::Path;

/// A Node fs error (`SystemError`-shaped `Error`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NodeError {
    /// `err.code`: libuv's name (`ENOENT`), or `Unknown system error -N`
    /// for an errno libuv doesn't name.
    pub code: String,
    /// `err.errno`: libuv's (negative) error number, `-errno` on Unix.
    pub errno: i32,
    /// `err.syscall` (`open`, `read`, `mkdir`, `scandir`, …).
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
/// and description libuv gives the error's errno on this platform.
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
    let mut message = format!("{code}: {description}, {syscall}");
    if let Some(p) = &path {
        message.push_str(&format!(" '{p}'"));
    }
    if let Some(d) = &dest {
        message.push_str(&format!(" -> '{d}'"));
    }
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
    use libc::*;
    Some(match errno {
        E2BIG => ("E2BIG", "argument list too long"),
        EACCES => ("EACCES", "permission denied"),
        EADDRINUSE => ("EADDRINUSE", "address already in use"),
        EADDRNOTAVAIL => ("EADDRNOTAVAIL", "address not available"),
        EAFNOSUPPORT => ("EAFNOSUPPORT", "address family not supported"),
        EAGAIN => ("EAGAIN", "resource temporarily unavailable"),
        EALREADY => ("EALREADY", "connection already in progress"),
        EBADF => ("EBADF", "bad file descriptor"),
        EBUSY => ("EBUSY", "resource busy or locked"),
        ECANCELED => ("ECANCELED", "operation canceled"),
        ECONNABORTED => ("ECONNABORTED", "software caused connection abort"),
        ECONNREFUSED => ("ECONNREFUSED", "connection refused"),
        ECONNRESET => ("ECONNRESET", "connection reset by peer"),
        EDESTADDRREQ => ("EDESTADDRREQ", "destination address required"),
        EEXIST => ("EEXIST", "file already exists"),
        EFAULT => ("EFAULT", "bad address in system call argument"),
        EFBIG => ("EFBIG", "file too large"),
        EHOSTDOWN => ("EHOSTDOWN", "host is down"),
        EHOSTUNREACH => ("EHOSTUNREACH", "host is unreachable"),
        EILSEQ => ("EILSEQ", "illegal byte sequence"),
        EINTR => ("EINTR", "interrupted system call"),
        EINVAL => ("EINVAL", "invalid argument"),
        EIO => ("EIO", "i/o error"),
        EISCONN => ("EISCONN", "socket is already connected"),
        EISDIR => ("EISDIR", "illegal operation on a directory"),
        ELOOP => ("ELOOP", "too many symbolic links encountered"),
        EMFILE => ("EMFILE", "too many open files"),
        EMLINK => ("EMLINK", "too many links"),
        EMSGSIZE => ("EMSGSIZE", "message too long"),
        ENAMETOOLONG => ("ENAMETOOLONG", "name too long"),
        ENETDOWN => ("ENETDOWN", "network is down"),
        ENETUNREACH => ("ENETUNREACH", "network is unreachable"),
        ENFILE => ("ENFILE", "file table overflow"),
        ENOBUFS => ("ENOBUFS", "no buffer space available"),
        ENODATA => ("ENODATA", "no data available"),
        ENODEV => ("ENODEV", "no such device"),
        ENOENT => ("ENOENT", "no such file or directory"),
        ENOEXEC => ("ENOEXEC", "exec format error"),
        ENOMEM => ("ENOMEM", "not enough memory"),
        #[cfg(any(target_os = "linux", target_os = "android"))]
        ENONET => ("ENONET", "machine is not on the network"),
        ENOPROTOOPT => ("ENOPROTOOPT", "protocol not available"),
        ENOSPC => ("ENOSPC", "no space left on device"),
        ENOSYS => ("ENOSYS", "function not implemented"),
        ENOTCONN => ("ENOTCONN", "socket is not connected"),
        ENOTDIR => ("ENOTDIR", "not a directory"),
        ENOTEMPTY => ("ENOTEMPTY", "directory not empty"),
        ENOTSOCK => ("ENOTSOCK", "socket operation on non-socket"),
        ENOTSUP => ("ENOTSUP", "operation not supported on socket"),
        ENOTTY => ("ENOTTY", "inappropriate ioctl for device"),
        ENXIO => ("ENXIO", "no such device or address"),
        EOVERFLOW => ("EOVERFLOW", "value too large for defined data type"),
        EPERM => ("EPERM", "operation not permitted"),
        EPIPE => ("EPIPE", "broken pipe"),
        EPROTO => ("EPROTO", "protocol error"),
        EPROTONOSUPPORT => ("EPROTONOSUPPORT", "protocol not supported"),
        EPROTOTYPE => ("EPROTOTYPE", "protocol wrong type for socket"),
        ERANGE => ("ERANGE", "result too large"),
        #[cfg(any(target_os = "linux", target_os = "android"))]
        EREMOTEIO => ("EREMOTEIO", "remote I/O error"),
        EROFS => ("EROFS", "read-only file system"),
        ESHUTDOWN => ("ESHUTDOWN", "cannot send after transport endpoint shutdown"),
        ESOCKTNOSUPPORT => ("ESOCKTNOSUPPORT", "socket type not supported"),
        ESPIPE => ("ESPIPE", "invalid seek"),
        ESRCH => ("ESRCH", "no such process"),
        ETIMEDOUT => ("ETIMEDOUT", "connection timed out"),
        ETXTBSY => ("ETXTBSY", "text file is busy"),
        #[cfg(any(target_os = "linux", target_os = "android"))]
        EUNATCH => ("EUNATCH", "protocol driver not attached"),
        EXDEV => ("EXDEV", "cross-device link not permitted"),
        #[cfg(any(
            target_os = "macos",
            target_os = "ios",
            target_os = "freebsd",
            target_os = "netbsd",
            target_os = "openbsd",
            target_os = "dragonfly"
        ))]
        EFTYPE => ("EFTYPE", "inappropriate file type or format"),
        _ => return None,
    })
}

/// libuv maps Win32 errors itself; only the two that matter for a missing
/// or unreadable file are mirrored.
#[cfg(not(unix))]
pub fn describe(errno: i32) -> Option<(&'static str, &'static str)> {
    match io::Error::from_raw_os_error(errno).kind() {
        io::ErrorKind::NotFound => Some(("ENOENT", "no such file or directory")),
        io::ErrorKind::PermissionDenied => Some(("EPERM", "operation not permitted")),
        _ => None,
    }
}

/// `fs.promises` calls with Node's errors.
pub mod fs {
    use std::io::{Read, Write};
    use std::path::{Path, PathBuf};

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

    /// `fs.promises.mkdir(path, { recursive: true })`, node's `MKDirpAsync`:
    /// create `path`, and on ENOENT its parents first. The error names the
    /// component whose `mkdir` (or the `stat` after it) failed, always as
    /// syscall `mkdir`. An existing directory is success; any other
    /// existing entry is EEXIST; one in the middle of the path that isn't a
    /// directory, including a dangling symlink, is ENOTDIR. EACCES, ENOSPC,
    /// ENOTDIR and EPERM fail at once; any other error is resolved with a
    /// `stat` of that component: a directory is success, an error is the
    /// `stat`'s (a missing component on a read-only file system reads
    /// ENOENT).
    #[cfg(unix)]
    pub fn mkdir_recursive(path: &Path) -> Result<(), NodeError> {
        use std::os::unix::ffi::OsStrExt;

        let fail = |e: &std::io::Error, p: &Path| uv_exception(e, "mkdir", Some(p), None);
        let raw = |n: i32| std::io::Error::from_raw_os_error(n);
        let mut stack: Vec<PathBuf> = vec![path.to_path_buf()];
        while let Some(next) = stack.pop() {
            let mut result = std::fs::create_dir(&next).map_err(|e| e.raw_os_error());
            loop {
                match result {
                    Ok(()) => break,
                    Err(Some(n @ (libc::EACCES | libc::ENOSPC | libc::ENOTDIR | libc::EPERM))) => {
                        return Err(fail(&raw(n), &next));
                    }
                    Err(Some(libc::ENOENT)) => {
                        let bytes = next.as_os_str().as_bytes();
                        let cut = bytes.iter().rposition(|b| *b == b'/');
                        let dirname =
                            cut.map(|i| Path::new(std::ffi::OsStr::from_bytes(&bytes[..i])));
                        match dirname {
                            // `/x`: the parent is `/` (libuv loops on ""; `/` always exists).
                            Some(d) if d.as_os_str().is_empty() => {
                                return Err(fail(&raw(libc::ENOENT), &next));
                            }
                            Some(d) => {
                                let d = d.to_path_buf();
                                stack.push(next.clone());
                                stack.push(d);
                            }
                            None if stack.is_empty() => {
                                result = Err(Some(libc::EEXIST));
                                continue;
                            }
                            None => {}
                        }
                        break;
                    }
                    Err(code) => {
                        let stat = std::fs::metadata(&next);
                        if code == Some(libc::EEXIST) && !stack.is_empty() {
                            if stat.as_ref().is_ok_and(std::fs::Metadata::is_dir) {
                                break;
                            }
                            return Err(fail(&raw(libc::ENOTDIR), &next));
                        }
                        return match stat {
                            Ok(m) if m.is_dir() => Ok(()),
                            Ok(_) => Err(fail(&raw(libc::EEXIST), &next)),
                            Err(e) => Err(fail(&e, &next)),
                        };
                    }
                }
            }
        }
        Ok(())
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

    /// G02a's `crate::node_fs` builds the same messages: every errno its
    /// table names, and the recursive `mkdir` walk.
    #[test]
    fn agrees_with_node_fs() {
        for n in 1..200 {
            let e = io::Error::from_raw_os_error(n);
            let theirs = crate::node_fs::FsError::new(&e, "rename", Some("/x"), Some("/y"));
            if theirs.message.contains("unknown error") {
                continue;
            }
            let ours = uv_exception(&e, "rename", Some(Path::new("/x")), Some(Path::new("/y")));
            assert_eq!(theirs.message, ours.message, "errno {n}");
            assert_eq!(
                theirs.code.as_deref(),
                Some(ours.code.as_str()),
                "errno {n}"
            );
        }
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
            let ours = fs::mkdir_recursive(&p).err().map(|e| e.message);
            let theirs = crate::node_fs::mkdir_recursive(p.to_str().unwrap(), 0o777)
                .err()
                .map(|e| e.message);
            assert_eq!(ours, theirs, "{rel}");
        }
        mode(0o755).unwrap();
    }

    /// Every name agrees with the SDK host's spawn-error table.
    #[test]
    fn names_agree_with_the_spawn_table() {
        for n in 1..200 {
            assert_eq!(
                describe(n).map(|(code, _)| code),
                claudius_agent::binary::errno_name(n),
                "errno {n}"
            );
        }
    }
}
