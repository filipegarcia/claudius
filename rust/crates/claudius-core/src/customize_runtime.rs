//! `app/api/customize/runtime/route.ts` (D16), and the one
//! `lib/server/customizations-startup.ts` export it calls,
//! [`is_running_inside_customization_mirror`] (the boot checks, D14 / G12,
//! and the updater scheduler, D27, call it too): which kind of Claudius
//! this process is, the main install or a preview served out of a
//! customization's mirror. The customization banner flips its copy on it.
//!
//! Both read the live source dir ([`runtime_dir::live_source_dir`]:
//! `$CLAUDIUS_LIVE_SOURCE`, JS-trimmed, else this process's cwd, read once)
//! and `customizationsRoot()`, and compare them as strings, as TS does: a
//! preview is the root itself or anything under `root + "/"`. The route
//! then names the customization after the live dir's parent (`basename(
//! dirname(live))`, so `<root>/<id>/src` is `<id>`) and looks its `name` up
//! in the store only when that parent starts with the root (a bare prefix
//! test); a store that can't be read counts as no customization. Replayed
//! against the TS through the route in `claudius-server/tests/customize.rs`
//! (`rust/scripts/customize-golden.mjs`).

use std::borrow::Cow;

use serde_json::{Value, json};

use crate::{customizations, node_path, runtime_dir};

/// `isRunningInsideCustomizationMirror()`: this process serves from inside
/// a customization mirror (an auto-spawned preview), not the main install.
pub fn is_running_inside_customization_mirror() -> bool {
    is_running_inside_customization_mirror_for(
        &runtime_dir::live_source_dir(),
        &customizations::customizations_root(),
    )
}

/// [`is_running_inside_customization_mirror`] for a live dir and a root:
/// `live === root || live.startsWith(root.endsWith("/") ? root : root + "/")`.
pub fn is_running_inside_customization_mirror_for(live: &str, root: &str) -> bool {
    let under: Cow<str> = if root.ends_with('/') {
        Cow::Borrowed(root)
    } else {
        Cow::Owned(format!("{root}/"))
    };
    live == root || live.starts_with(&*under)
}

/// The route's answer for this process: `{isPreview: false}`, or
/// `{isPreview: true, customizationId, name}`.
pub fn runtime_info() -> Value {
    runtime_info_for(
        &runtime_dir::live_source_dir(),
        &customizations::customizations_root(),
        customizations::get_customization,
    )
}

/// [`runtime_info`] for a live dir, a root and the store lookup
/// (`getCustomization`; its error is TS's `.catch(() => null)`). `name` is
/// the entry's `name` as stored (any JSON value), `null` when it has none.
pub fn runtime_info_for(
    live: &str,
    root: &str,
    get_customization: impl FnOnce(&str) -> anyhow::Result<Option<Value>>,
) -> Value {
    if !is_running_inside_customization_mirror_for(live, root) {
        return json!({"isPreview": false});
    }
    let id_dir = node_path::dirname(live);
    let customization_id = node_path::basename(&id_dir);
    let mut name = Value::Null;
    if id_dir.starts_with(root) {
        // `c?.name ?? null`.
        if let Ok(Some(c)) = get_customization(&customization_id) {
            name = c
                .get("name")
                .filter(|v| !v.is_null())
                .cloned()
                .unwrap_or(Value::Null);
        }
    }
    json!({"isPreview": true, "customizationId": customization_id, "name": name})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mirror_test_is_a_string_prefix() {
        let root = "/h/.claude/.claudius/customizations";
        let yes = |live: &str| is_running_inside_customization_mirror_for(live, root);
        assert!(yes(root));
        assert!(yes("/h/.claude/.claudius/customizations/"));
        assert!(yes("/h/.claude/.claudius/customizations/cust_1/src"));
        assert!(yes("/h/.claude/.claudius/customizations/../x"));
        assert!(!yes("/h/.claude/.claudius/customizationsx/a"));
        assert!(!yes("/h/.claude/.claudius"));
        assert!(!yes("h/.claude/.claudius/customizations/a"));
        // A root ending in `/` (never from `path.join`) is the prefix itself.
        assert!(is_running_inside_customization_mirror_for("/r/x", "/r/"));
        assert!(!is_running_inside_customization_mirror_for("/r", "/r/"));
    }

    #[test]
    fn names_the_live_dirs_parent() {
        let root = "/h/c";
        let none = |_: &str| -> anyhow::Result<Option<Value>> { Ok(None) };
        assert_eq!(
            runtime_info_for("/elsewhere", root, none),
            json!({"isPreview": false})
        );
        assert_eq!(
            runtime_info_for("/h/c", root, none),
            json!({"isPreview": true, "customizationId": "h", "name": null})
        );
        let named = |id: &str| -> anyhow::Result<Option<Value>> {
            assert_eq!(id, "cust_1");
            Ok(Some(json!({"id": "cust_1", "name": "Mine"})))
        };
        assert_eq!(
            runtime_info_for("/h/c/cust_1/src/", root, named),
            json!({"isPreview": true, "customizationId": "cust_1", "name": "Mine"})
        );
        let broken = |_: &str| -> anyhow::Result<Option<Value>> { anyhow::bail!("bad index") };
        assert_eq!(
            runtime_info_for("/h/c/cust_1/src", root, broken),
            json!({"isPreview": true, "customizationId": "cust_1", "name": null})
        );
    }
}
