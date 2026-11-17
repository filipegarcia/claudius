//! `lib/server/permission-symlink.ts` (CC 2.1.310): where a symlinked file
//! leads, for a Read / Edit / Write / NotebookEdit permission prompt. The
//! engine resolves the link for its own terminal card but never forwards it
//! through `canUseTool`, so Claudius resolves it itself and attaches the
//! result to the `permission_request` event.
//!
//! Only the final path component is checked (`lstat`), deliberately: on
//! macOS `/tmp` and `/var/folders` are themselves links into `/private`, so
//! a whole-path `realpath` comparison would warn on nearly every temp path.
//!
//! Replayed against the TS in `tests/session_callbacks_golden.rs`.

use std::path::MAIN_SEPARATOR;

use serde_json::{Value, json};

use crate::node_path;

/// `FILE_TOOLS`: which input field holds the path, and whether the tool
/// reads or modifies it.
fn file_tool(tool_name: &str) -> Option<(&'static str, &'static str)> {
    Some(match tool_name {
        "Read" => ("file_path", "read"),
        "Edit" => ("file_path", "modify"),
        "Write" => ("file_path", "modify"),
        "NotebookEdit" => ("notebook_path", "modify"),
        _ => return None,
    })
}

/// `PermissionSymlink`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PermissionSymlink {
    /// `realpath` of the link — the whole chain followed.
    pub target: String,
    /// The target lies outside the cwd and every additional directory.
    pub outside_working_dirs: bool,
    pub operation: &'static str,
}

impl PermissionSymlink {
    /// `{ target, outsideWorkingDirs, operation }`, the TS key order.
    pub fn to_json(&self) -> Value {
        json!({
            "target": self.target,
            "outsideWorkingDirs": self.outside_working_dirs,
            "operation": self.operation,
        })
    }
}

/// `permissionFilePath(toolName, input)`: the tool's path argument when
/// `toolName` is a file tool this check covers.
pub fn permission_file_path(tool_name: &str, input: &Value) -> Option<(String, &'static str)> {
    let (field, operation) = file_tool(tool_name)?;
    let p = input.get(field)?.as_str().filter(|s| !s.is_empty())?;
    Some((p.to_owned(), operation))
}

/// `realpath(dir)`, falling back to `resolve(dir)` when it fails.
fn real_or_resolved(dir: &str) -> String {
    match std::fs::canonicalize(dir) {
        Ok(p) => p.to_string_lossy().into_owned(),
        Err(_) => node_path::resolve(&[dir]),
    }
}

/// `resolvePermissionSymlink(toolName, input, cwd, additionalDirectories)`.
/// `None` for a regular file, a missing one (a Write creating it), a
/// dangling link, or any unreadable path — the card then renders as before.
///
/// Blocking: the caller runs it off the session lock.
pub fn resolve_permission_symlink(
    tool_name: &str,
    input: &Value,
    cwd: &str,
    additional_directories: &[String],
) -> Option<PermissionSymlink> {
    let (path, operation) = permission_file_path(tool_name, input)?;
    let link_path = node_path::resolve(&[cwd, &path]);
    let meta = std::fs::symlink_metadata(&link_path).ok()?;
    if !meta.file_type().is_symlink() {
        return None;
    }
    let target = std::fs::canonicalize(&link_path).ok()?;
    let target = target.to_string_lossy().into_owned();
    let inside = std::iter::once(cwd.to_owned())
        .chain(additional_directories.iter().cloned())
        .map(|d| real_or_resolved(&node_path::resolve(&[cwd, &d])))
        .any(|d| {
            // `target === d || target.startsWith(d.endsWith(sep) ? d : d + sep)`
            target == d
                || target.starts_with(&if d.ends_with(MAIN_SEPARATOR) {
                    d.clone()
                } else {
                    format!("{d}{MAIN_SEPARATOR}")
                })
        });
    Some(PermissionSymlink {
        target,
        outside_working_dirs: !inside,
        operation,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(p: &std::path::Path, text: &str) {
        std::fs::write(p, text).unwrap();
    }

    #[test]
    fn only_the_four_file_tools_have_a_path() {
        let input = json!({"file_path": "/a", "notebook_path": "/n"});
        assert_eq!(
            permission_file_path("Read", &input),
            Some(("/a".into(), "read"))
        );
        assert_eq!(
            permission_file_path("Edit", &input),
            Some(("/a".into(), "modify"))
        );
        assert_eq!(
            permission_file_path("Write", &input),
            Some(("/a".into(), "modify"))
        );
        assert_eq!(
            permission_file_path("NotebookEdit", &input),
            Some(("/n".into(), "modify"))
        );
        assert_eq!(permission_file_path("Bash", &input), None);
        assert_eq!(permission_file_path("MultiEdit", &input), None);
        // Non-string and empty paths are no path.
        assert_eq!(permission_file_path("Read", &json!({"file_path": 5})), None);
        assert_eq!(
            permission_file_path("Read", &json!({"file_path": ""})),
            None
        );
        assert_eq!(permission_file_path("Read", &json!({})), None);
    }

    #[test]
    fn a_link_inside_the_cwd_is_not_outside() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        write(&root.join("real.txt"), "x");
        std::os::unix::fs::symlink(root.join("real.txt"), root.join("link.txt")).unwrap();
        let cwd = root.display().to_string();
        let got = resolve_permission_symlink("Read", &json!({"file_path": "link.txt"}), &cwd, &[])
            .unwrap();
        assert_eq!(got.target, root.join("real.txt").display().to_string());
        assert!(!got.outside_working_dirs);
        assert_eq!(got.operation, "read");
    }

    #[test]
    fn a_link_out_of_the_cwd_is_flagged_unless_an_extra_dir_covers_it() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let (a, b) = (root.join("a"), root.join("b"));
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        write(&b.join("secret"), "s");
        std::os::unix::fs::symlink(b.join("secret"), a.join("notes")).unwrap();
        let cwd = a.display().to_string();
        let input = json!({"file_path": "notes"});
        let got = resolve_permission_symlink("Edit", &input, &cwd, &[]).unwrap();
        assert!(got.outside_working_dirs);
        assert_eq!(got.operation, "modify");
        let dirs = vec![b.display().to_string()];
        let got = resolve_permission_symlink("Edit", &input, &cwd, &dirs).unwrap();
        assert!(!got.outside_working_dirs);
    }

    #[test]
    fn a_regular_file_a_missing_one_and_a_dangling_link_report_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        write(&root.join("plain.txt"), "x");
        std::os::unix::fs::symlink(root.join("gone"), root.join("dangling")).unwrap();
        let cwd = root.display().to_string();
        for p in ["plain.txt", "missing.txt", "dangling"] {
            assert_eq!(
                resolve_permission_symlink("Read", &json!({"file_path": p}), &cwd, &[]),
                None,
                "{p}"
            );
        }
    }
}
