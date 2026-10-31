//! Finding and launching the `claude` binary the way the SDK does when
//! `pathToClaudeCodeExecutable` isn't set (`xZ`), plus how its
//! `ProcessTransport` launches a path (`wVe`) and words a failed launch
//! (`xVe`, Node's spawn errors).
//!
//! The SDK ships the binary as an optional dependency,
//! `@anthropic-ai/claude-agent-sdk-<platform>-<arch>[-musl|-android]/claude`
//! (`.exe` on Windows), and resolves it with Node's module resolution from
//! its own install. The port reuses that binary, so both backends drive the
//! same CLI. Rust has no SDK install to start from, so it searches
//! `node_modules` up from the session cwd, the process cwd and its own
//! executable's directory. Two port-only fallbacks: `$CLAUDIUS_CLAUDE_BIN`
//! first, and `claude` on `PATH` last.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use crate::redact::redact;

/// Env override, checked first.
pub const ENV_OVERRIDE: &str = "CLAUDIUS_CLAUDE_BIN";
/// The SDK's package name (`pc`); platform packages append `-<platform>-…`.
pub const SDK_PACKAGE: &str = "@anthropic-ai/claude-agent-sdk";

/// Node's `process.platform` for a Rust `std::env::consts::OS`.
pub fn node_platform(os: &str) -> &str {
    match os {
        "macos" => "darwin",
        "windows" => "win32",
        "solaris" | "illumos" => "sunos",
        other => other,
    }
}

/// Node's `process.arch` for a Rust `std::env::consts::ARCH`.
pub fn node_arch(arch: &str) -> &str {
    match arch {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        "x86" => "ia32",
        "powerpc64" => "ppc64",
        "powerpc" => "ppc",
        "loongarch64" => "loong64",
        other => other,
    }
}

/// `IVe()`: on Linux, prefer the musl package unless this process runs on
/// glibc. Node asks its own runtime (`glibcVersionRuntime`); for a Rust
/// binary that's the target it was built for.
pub fn prefers_musl() -> bool {
    cfg!(all(target_os = "linux", not(target_env = "gnu")))
}

/// The package-relative paths `xZ` tries, in order.
pub fn native_candidates(platform: &str, arch: &str, prefer_musl: bool) -> Vec<String> {
    let glibc = format!("{SDK_PACKAGE}-linux-{arch}");
    let musl = format!("{SDK_PACKAGE}-linux-{arch}-musl");
    let packages = match platform {
        "android" => vec![format!("{SDK_PACKAGE}-linux-{arch}-android")],
        "linux" if prefer_musl => vec![musl, glibc],
        "linux" => vec![glibc, musl],
        _ => vec![format!("{SDK_PACKAGE}-{platform}-{arch}")],
    };
    let ext = if platform == "win32" { ".exe" } else { "" };
    packages
        .into_iter()
        .map(|p| format!("{p}/claude{ext}"))
        .collect()
}

/// `xZ`'s loop: the first candidate `resolve` finds that also `exists`.
pub fn lookup(
    candidates: &[String],
    mut resolve: impl FnMut(&str) -> Option<PathBuf>,
    mut exists: impl FnMut(&Path) -> bool,
) -> Option<PathBuf> {
    candidates
        .iter()
        .filter_map(|c| resolve(c))
        .find(|p| exists(p))
}

/// `require.resolve(spec)` for a package file, from `start`: the first
/// `<dir>/node_modules/<spec>` that's a file, walking up from `start`. Like
/// Node, it doesn't look for `node_modules/node_modules`.
pub fn resolve_in_node_modules(start: &Path, spec: &str) -> Option<PathBuf> {
    start
        .ancestors()
        .filter(|d| d.file_name() != Some(OsStr::new("node_modules")))
        .map(|d| d.join("node_modules").join(spec))
        .find(|p| p.is_file())
}

/// This host's candidates.
pub fn host_candidates() -> Vec<String> {
    native_candidates(
        node_platform(std::env::consts::OS),
        node_arch(std::env::consts::ARCH),
        prefers_musl(),
    )
}

/// Candidate under `<root>/node_modules/` for this host's first package.
pub fn bundled_under(root: &Path) -> PathBuf {
    root.join("node_modules").join(&host_candidates()[0])
}

/// Resolve the binary: `$CLAUDIUS_CLAUDE_BIN`, then the SDK's lookup over
/// `node_modules` up from `search_from`, the cwd and this executable's
/// directory, then `claude` on `PATH`.
pub fn locate(search_from: Option<&Path>) -> Option<PathBuf> {
    if let Some(p) = std::env::var_os(ENV_OVERRIDE) {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Some(p);
        }
    }
    let mut starts: Vec<PathBuf> = Vec::new();
    if let Some(s) = search_from {
        starts.push(s.to_path_buf());
    }
    if let Ok(cwd) = std::env::current_dir() {
        starts.push(cwd);
    }
    if let Ok(exe) = std::env::current_exe()
        && let Some(dir) = exe.parent()
    {
        starts.push(dir.to_path_buf());
    }
    let found = lookup(
        &host_candidates(),
        |spec| starts.iter().find_map(|s| resolve_in_node_modules(s, spec)),
        Path::is_file,
    );
    if found.is_some() {
        return found;
    }
    let exe = if cfg!(windows) {
        "claude.exe"
    } else {
        "claude"
    };
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|d| d.join(exe))
        .find(|p| p.is_file())
}

/// `wVe(path)`: a native binary unless it's a JS/TS entry point, which the
/// SDK runs through `executable` (`node`). By suffix only; `.cjs` counts as
/// native, as in the SDK.
pub fn is_native(path: &Path) -> bool {
    let s = path.to_string_lossy();
    ![".js", ".mjs", ".tsx", ".ts", ".jsx"]
        .iter()
        .any(|ext| s.ends_with(ext))
}

/// The SDK's message for a failed launch.
///
/// Node reports EACCES, EAGAIN, EMFILE, ENFILE and ENOENT asynchronously and
/// throws every other errno from `spawn()` itself ("spawn ENOTDIR"). Of the
/// async ones, ENOENT and EACCES get `xVe`'s wording, which depends on
/// whether `path` exists. The rest are "Failed to spawn Claude Code
/// process: spawn <command> <CODE>". Paths are redacted (`up()`).
pub fn launch_error_message(
    error: &std::io::Error,
    path: &Path,
    command: &OsStr,
    native: bool,
) -> String {
    let Some(code) = node_error_code(error) else {
        return format!(
            "Failed to spawn Claude Code process: {}",
            redact(&error.to_string())
        );
    };
    match code.as_str() {
        "ENOENT" | "EACCES" => {
            let shown = redact(&path.to_string_lossy());
            match (path.exists(), native) {
                (true, true) => format!(
                    "Claude Code native binary at {shown} exists but failed to launch. This usually means the binary does not match this system's libc — e.g. spawning a musl-linked binary on a glibc Linux host fails because the musl dynamic loader (/lib/ld-musl-*) is missing. Specify a matching binary with options.pathToClaudeCodeExecutable."
                ),
                (true, false) => {
                    format!("Claude Code executable at {shown} exists but failed to launch.")
                }
                (false, true) => format!(
                    "Claude Code native binary not found at {shown}. Please ensure Claude Code is installed via native installer or specify a valid path with options.pathToClaudeCodeExecutable."
                ),
                (false, false) => format!(
                    "Claude Code executable not found at {shown}. Is options.pathToClaudeCodeExecutable set?"
                ),
            }
        }
        "EAGAIN" | "EMFILE" | "ENFILE" => format!(
            "Failed to spawn Claude Code process: {}",
            redact(&format!("spawn {} {code}", command.to_string_lossy()))
        ),
        _ => format!("spawn {code}"),
    }
}

/// Node's code for a spawn error: `util.getSystemErrorName(-errno)`, so an
/// errno libuv doesn't name reads "Unknown system error -86". `None` for an
/// error without an OS code.
pub fn node_error_code(error: &std::io::Error) -> Option<String> {
    #[cfg(unix)]
    {
        let errno = error.raw_os_error()?;
        Some(match errno_name(errno) {
            Some(name) => name.to_owned(),
            None => format!("Unknown system error -{errno}"),
        })
    }
    // libuv maps Win32 errors itself; only the two that matter for a
    // missing or unreadable binary are mirrored.
    #[cfg(not(unix))]
    {
        error.raw_os_error()?;
        match error.kind() {
            std::io::ErrorKind::NotFound => Some("ENOENT".to_owned()),
            std::io::ErrorKind::PermissionDenied => Some("EPERM".to_owned()),
            _ => None,
        }
    }
}

/// libuv's errno names (`UV_ERRNO_MAP`) on this platform.
#[cfg(unix)]
pub fn errno_name(errno: i32) -> Option<&'static str> {
    use libc::*;
    Some(match errno {
        E2BIG => "E2BIG",
        EACCES => "EACCES",
        EADDRINUSE => "EADDRINUSE",
        EADDRNOTAVAIL => "EADDRNOTAVAIL",
        EAFNOSUPPORT => "EAFNOSUPPORT",
        EAGAIN => "EAGAIN",
        EALREADY => "EALREADY",
        EBADF => "EBADF",
        EBUSY => "EBUSY",
        ECANCELED => "ECANCELED",
        ECONNABORTED => "ECONNABORTED",
        ECONNREFUSED => "ECONNREFUSED",
        ECONNRESET => "ECONNRESET",
        EDESTADDRREQ => "EDESTADDRREQ",
        EEXIST => "EEXIST",
        EFAULT => "EFAULT",
        EFBIG => "EFBIG",
        EHOSTDOWN => "EHOSTDOWN",
        EHOSTUNREACH => "EHOSTUNREACH",
        EILSEQ => "EILSEQ",
        EINTR => "EINTR",
        EINVAL => "EINVAL",
        EIO => "EIO",
        EISCONN => "EISCONN",
        EISDIR => "EISDIR",
        ELOOP => "ELOOP",
        EMFILE => "EMFILE",
        EMLINK => "EMLINK",
        EMSGSIZE => "EMSGSIZE",
        ENAMETOOLONG => "ENAMETOOLONG",
        ENETDOWN => "ENETDOWN",
        ENETUNREACH => "ENETUNREACH",
        ENFILE => "ENFILE",
        ENOBUFS => "ENOBUFS",
        ENODATA => "ENODATA",
        ENODEV => "ENODEV",
        ENOENT => "ENOENT",
        ENOEXEC => "ENOEXEC",
        ENOMEM => "ENOMEM",
        #[cfg(any(target_os = "linux", target_os = "android"))]
        ENONET => "ENONET",
        ENOPROTOOPT => "ENOPROTOOPT",
        ENOSPC => "ENOSPC",
        ENOSYS => "ENOSYS",
        ENOTCONN => "ENOTCONN",
        ENOTDIR => "ENOTDIR",
        ENOTEMPTY => "ENOTEMPTY",
        ENOTSOCK => "ENOTSOCK",
        ENOTSUP => "ENOTSUP",
        ENOTTY => "ENOTTY",
        ENXIO => "ENXIO",
        EOVERFLOW => "EOVERFLOW",
        EPERM => "EPERM",
        EPIPE => "EPIPE",
        EPROTO => "EPROTO",
        EPROTONOSUPPORT => "EPROTONOSUPPORT",
        EPROTOTYPE => "EPROTOTYPE",
        ERANGE => "ERANGE",
        #[cfg(any(target_os = "linux", target_os = "android"))]
        EREMOTEIO => "EREMOTEIO",
        EROFS => "EROFS",
        ESHUTDOWN => "ESHUTDOWN",
        ESOCKTNOSUPPORT => "ESOCKTNOSUPPORT",
        ESPIPE => "ESPIPE",
        ESRCH => "ESRCH",
        ETIMEDOUT => "ETIMEDOUT",
        ETXTBSY => "ETXTBSY",
        #[cfg(any(target_os = "linux", target_os = "android"))]
        EUNATCH => "EUNATCH",
        EXDEV => "EXDEV",
        #[cfg(any(
            target_os = "macos",
            target_os = "ios",
            target_os = "freebsd",
            target_os = "netbsd",
            target_os = "openbsd",
            target_os = "dragonfly"
        ))]
        EFTYPE => "EFTYPE",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_names() {
        assert_eq!(node_platform("macos"), "darwin");
        assert_eq!(node_platform("windows"), "win32");
        assert_eq!(node_platform("linux"), "linux");
        assert_eq!(node_platform("illumos"), "sunos");
        assert_eq!(node_arch("aarch64"), "arm64");
        assert_eq!(node_arch("x86_64"), "x64");
        assert_eq!(node_arch("x86"), "ia32");
        assert_eq!(node_arch("riscv64"), "riscv64");
    }

    #[test]
    fn js_entries_are_not_native() {
        for p in ["/a/cli.js", "/a/cli.mjs", "x.ts", "x.tsx", "x.jsx"] {
            assert!(!is_native(Path::new(p)), "{p}");
        }
        for p in ["/a/claude", "/a/claude.exe", "/a/cli.cjs", "/a/js"] {
            assert!(is_native(Path::new(p)), "{p}");
        }
    }

    #[test]
    fn lookup_skips_resolved_paths_that_dont_exist() {
        let c = native_candidates("linux", "x64", false);
        let picked = lookup(
            &c,
            |spec| Some(PathBuf::from(format!("/nm/{spec}"))),
            |p| p.to_string_lossy().ends_with("-musl/claude"),
        );
        assert_eq!(
            picked,
            Some(PathBuf::from(
                "/nm/@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude"
            ))
        );
        assert_eq!(lookup(&c, |_| None, |_| true), None);
    }

    #[test]
    fn resolves_up_the_tree_but_not_inside_node_modules() {
        let tmp = tempfile::tempdir().unwrap();
        let spec = "@anthropic-ai/claude-agent-sdk-test/claude";
        let bin = tmp.path().join("node_modules").join(spec);
        std::fs::create_dir_all(bin.parent().unwrap()).unwrap();
        std::fs::write(&bin, "").unwrap();
        let deep = tmp.path().join("a/b/c");
        std::fs::create_dir_all(&deep).unwrap();
        assert_eq!(resolve_in_node_modules(&deep, spec), Some(bin.clone()));
        // From inside `node_modules`, the walk skips `node_modules/node_modules`.
        let inner = tmp.path().join("node_modules/pkg");
        std::fs::create_dir_all(&inner).unwrap();
        let decoy = tmp.path().join("node_modules/node_modules").join(spec);
        std::fs::create_dir_all(decoy.parent().unwrap()).unwrap();
        std::fs::write(&decoy, "").unwrap();
        assert_eq!(resolve_in_node_modules(&inner, spec), Some(bin));
        assert_eq!(resolve_in_node_modules(&deep, "@x/missing"), None);
    }
}
