//! `lib/server/safe-path.ts`: `assertWithin` and `assertAbsoluteUserPath`,
//! the path-injection barriers between request input and the disk, with
//! `PathInjectionError`'s messages.
//!
//! They compute and refuse paths exactly as TS does, quirks included: a
//! base that resolves to `/` refuses every child ("path escapes base
//! directory"), since the check is for `"/" + sep`. They are not a
//! substitute for the containment check at each fs call (see the path
//! safety notes in `CLAUDE.md`), which callers still write inline above
//! the sink (`agents`, `asset_store`, `auto_memory`, `rules`). I14d folded
//! the private copies in `asset_store`, `auto_memory`, `mcp_config`,
//! `rules`, `settings`, `settings_import` and the server's `workspaces`
//! onto these two; `agents::agent_path` keeps its own `assertWithin`.

use crate::node_path;

/// `assertWithin(base, child)`: `child` resolved against `base`, which must
/// be `base` itself or inside it. `Err` is the `PathInjectionError`'s
/// message: an empty `base` or `child`, a NUL in either, or an escape.
pub fn assert_within(base: &str, child: &str) -> Result<String, &'static str> {
    if base.is_empty() {
        return Err("invalid base path");
    }
    if child.is_empty() {
        return Err("invalid child path");
    }
    if base.contains('\0') || child.contains('\0') {
        return Err("null byte in path");
    }
    let resolved_base = node_path::resolve(&[base]);
    let resolved_child = node_path::resolve(&[&resolved_base, child]);
    if resolved_child != resolved_base && !resolved_child.starts_with(&format!("{resolved_base}/"))
    {
        return Err("path escapes base directory");
    }
    Ok(resolved_child)
}

/// `assertAbsoluteUserPath(input)`: a path the user chose (a workspace
/// root, a project cwd), normalized. `Err` is the `PathInjectionError`'s
/// message: an empty input, a NUL, or a relative path.
pub fn assert_absolute_user_path(input: &str) -> Result<String, &'static str> {
    if input.is_empty() {
        return Err("invalid path");
    }
    if input.contains('\0') {
        return Err("null byte in path");
    }
    if !node_path::is_absolute(input) {
        return Err("path must be absolute");
    }
    Ok(node_path::resolve(&[input]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refusals() {
        assert_eq!(assert_within("/a", "b/../c"), Ok("/a/c".into()));
        assert_eq!(assert_within("/a/", "."), Ok("/a".into()));
        assert_eq!(
            assert_within("/a", "../b"),
            Err("path escapes base directory")
        );
        assert_eq!(
            assert_within("/a", "/ab"),
            Err("path escapes base directory")
        );
        assert_eq!(assert_within("", "x"), Err("invalid base path"));
        assert_eq!(assert_within("/a", ""), Err("invalid child path"));
        assert_eq!(assert_within("/a\0", "x"), Err("null byte in path"));
    }

    #[test]
    fn absolute_user_paths() {
        assert_eq!(assert_absolute_user_path("/a//b/../c/"), Ok("/a/c".into()));
        assert_eq!(assert_absolute_user_path("/.."), Ok("/".into()));
        assert_eq!(assert_absolute_user_path(""), Err("invalid path"));
        assert_eq!(assert_absolute_user_path("/a\0"), Err("null byte in path"));
        assert_eq!(assert_absolute_user_path("a"), Err("path must be absolute"));
        assert_eq!(assert_absolute_user_path("\0a"), Err("null byte in path"));
    }
}
