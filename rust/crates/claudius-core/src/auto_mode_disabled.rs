//! `lib/shared/auto-mode-disabled.ts` (SDK 0.3.312): whether a settings
//! object turns Auto mode off.
//!
//! 0.3.312 added `permissions.disableAutoMode` (`"disable"`) alongside the
//! long-standing top-level `disableAutoMode`. Both are single-literal flags:
//! the string `"disable"` disables Auto mode, anything else (including a
//! mistyped `true`) leaves it available, because the CLI skips an invalid
//! auto-mode value rather than honouring it.
//!
//! `None` is TS's `null` / `undefined` settings value, which reports
//! `false` — so, unlike the pre-0.3.312 `gate.disableAutoMode` read, a
//! `null` user settings.json no longer throws out of `setPermissionMode`.

use serde_json::Value;

use claudius_agent::js;

/// `isAutoModeDisabled(settings)`. `settings` is the parsed file as TS sees
/// it (`None` for a `null` one).
pub fn is_auto_mode_disabled(settings: Option<&Value>) -> bool {
    let Some(s) = settings.filter(|s| !s.is_null()) else {
        return false;
    };
    let is_disable = |v: Option<&Value>| v.and_then(Value::as_str) == Some("disable");
    // `settings.disableAutoMode === "disable" ||
    //  settings.permissions?.disableAutoMode === "disable"`
    is_disable(js::prop(Some(s), "disableAutoMode"))
        || is_disable(js::prop(
            js::prop(Some(s), "permissions").filter(|p| !p.is_null()),
            "disableAutoMode",
        ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_top_level_flag_disables() {
        assert!(is_auto_mode_disabled(Some(
            &json!({"disableAutoMode": "disable"})
        )));
        assert!(!is_auto_mode_disabled(Some(
            &json!({"disableAutoMode": true})
        )));
        assert!(!is_auto_mode_disabled(Some(
            &json!({"disableAutoMode": "Disable"})
        )));
        assert!(!is_auto_mode_disabled(Some(&json!({}))));
    }

    #[test]
    fn the_nested_flag_disables() {
        assert!(is_auto_mode_disabled(Some(
            &json!({"permissions": {"disableAutoMode": "disable"}})
        )));
        assert!(!is_auto_mode_disabled(Some(
            &json!({"permissions": {"disableAutoMode": "off"}})
        )));
        // A non-object `permissions` has no such property; `null` short-circuits.
        assert!(!is_auto_mode_disabled(Some(
            &json!({"permissions": "disable"})
        )));
        assert!(!is_auto_mode_disabled(Some(&json!({"permissions": null}))));
    }

    #[test]
    fn a_missing_or_null_file_leaves_auto_available() {
        assert!(!is_auto_mode_disabled(None));
        assert!(!is_auto_mode_disabled(Some(&Value::Null)));
    }
}
