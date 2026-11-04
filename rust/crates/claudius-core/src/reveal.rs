//! `revealOnHost` from `app/api/workspaces/[id]/reveal/route.ts`: show a
//! path in the host's file manager. The route answers as soon as the
//! command is spawned; it doesn't wait for it.
//!
//! - macOS: `open -R <file>` selects a file in Finder, `open <dir>` opens a
//!   folder;
//! - Windows: `explorer /select,<file>` / `explorer <dir>`;
//! - elsewhere: `xdg-open` on the folder (a file's parent).
//!
//! The command is looked up on `PATH`, gets the path as one argument (no
//! shell), inherits the server's environment and cwd, runs detached
//! (`setsid`) with stdio on `/dev/null`, and is reaped in the background.
//! A spawn error Node reports as the child's `error` event (`ENOENT`,
//! `EACCES`, …) has no listener in TS: Next logs it as an uncaught
//! exception and the route still answers `{ok: true}`, so it is only logged
//! here; any other spawn error is what `spawn()` throws ([`Err`]).

use std::process::{Command, Stdio};

use crate::js_string::lossy;
use crate::shell::{SpawnFailure, spawn_failure};
use crate::{log, node_path};

/// The program and arguments `revealOnHost(absPath, isDir)` spawns here.
pub fn reveal_command(abs_path: &str, is_dir: bool) -> (&'static str, Vec<String>) {
    if cfg!(target_os = "macos") {
        let args = if is_dir {
            vec![abs_path.to_owned()]
        } else {
            vec!["-R".to_owned(), abs_path.to_owned()]
        };
        ("open", args)
    } else if cfg!(windows) {
        let arg = if is_dir {
            abs_path.to_owned()
        } else {
            format!("/select,{abs_path}")
        };
        ("explorer", vec![arg])
    } else {
        // No portable "select" verb: open the containing folder.
        let dir = if is_dir {
            abs_path.to_owned()
        } else {
            node_path::resolve(&[abs_path, ".."])
        };
        ("xdg-open", vec![dir])
    }
}

/// `revealOnHost(absPath, isDir)`: `Err` is the message `spawn()` threw.
pub fn reveal_on_host(abs_path: &str, is_dir: bool) -> Result<(), String> {
    let (file, args) = reveal_command(abs_path, is_dir);
    let mut cmd = Command::new(file);
    cmd.args(args.iter().map(|a| lossy(a).into_owned()))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // SAFETY: setsid, fcntl and close are async-signal-safe and touch
        // no Rust state.
        unsafe {
            cmd.pre_exec(|| {
                // `detached: true`.
                libc::setsid();
                claudius_agent::close_leaked_fds()
            });
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // `detached: true` (DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP),
        // and no console window for `windowsHide` (CREATE_NO_WINDOW).
        cmd.creation_flags(0x0000_0008 | 0x0000_0200 | 0x0800_0000);
    }
    match cmd.spawn() {
        Ok(mut child) => {
            // `.unref()`: nobody waits on it, but it is still reaped.
            std::thread::spawn(move || {
                let _ = child.wait();
            });
            Ok(())
        }
        Err(e) => match spawn_failure(file, &e) {
            SpawnFailure::Emitted(message) => {
                tracing::error!(target: log::API, "[api/workspaces/[id]/reveal] uncaughtException: Error: {message}");
                Ok(())
            }
            SpawnFailure::Thrown(message) => Err(message),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_command_follows_the_platform() {
        let (file, dir_args) = reveal_command("/a/b", true);
        let (_, file_args) = reveal_command("/a/b", false);
        if cfg!(target_os = "macos") {
            assert_eq!(file, "open");
            assert_eq!(dir_args, ["/a/b"]);
            assert_eq!(file_args, ["-R", "/a/b"]);
        } else if cfg!(windows) {
            assert_eq!(file, "explorer");
            assert_eq!(dir_args, ["/a/b"]);
            assert_eq!(file_args, ["/select,/a/b"]);
        } else {
            assert_eq!(file, "xdg-open");
            assert_eq!(dir_args, ["/a/b"]);
            assert_eq!(file_args, ["/a"]);
        }
    }
}
