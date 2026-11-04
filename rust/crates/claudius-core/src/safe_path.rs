//! `assertWithin` from `lib/server/safe-path.ts`: the path-injection
//! barrier between request input and the disk, with `PathInjectionError`'s
//! messages.
//!
//! It computes and refuses paths exactly as TS does; it is not a
//! substitute for the containment check at each fs call (see the path
//! safety notes in `CLAUDE.md`), which the callers still write inline.
//! Older ports keep private copies (`agents`, `asset_store`,
//! `auto_memory`, `mcp_config`, `rules`; TODO I14).

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
}
