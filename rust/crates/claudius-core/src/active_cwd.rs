//! The active context's cwd: port of `resolveActiveCwd`
//! (`lib/server/active-customization.ts`) on the stores' raw readers:
//! [`crate::customizations`] (`getCustomization`, `customizationSrcDir`) and
//! [`crate::workspaces::resolve_active_raw`] (`resolveActiveWorkspace`). The
//! cookie-scoped routes (`sessions/open-tabs`, D21; `splash-examples`, D26b)
//! start here.
//!
//! Priority: the `claudius.customization` cookie's customization (its
//! `src` mirror), else the active workspace (the `claudius.workspace`
//! cookie's, else the store's hint), else the process cwd. The callers
//! parse the cookies (Next's `RequestCookies`) and pass their values.
//!
//! Both stores are read as the JSON values TS works on ([`js_string`]
//! strings, so a lone surrogate is its own code unit: a stored `"\ud800"`
//! matches neither `"\udc00"` nor U+FFFD), and the lookups follow its
//! callbacks: strict equality, a `null` entry throws. A workspace's
//! `rootPath` is returned as whatever value it is, since TS passes it on
//! unchecked (a non-string one makes `openDb` throw).
//!
//! [`js_string`]: crate::js_string

use serde_json::Value;

use crate::{customizations, workspaces};

/// What `resolveActiveCwd()` returns.
#[derive(Clone, Debug, PartialEq)]
pub struct ActiveCwd {
    /// The cwd as the JS value TS ends up with: a string, or (from a
    /// workspace whose `rootPath` isn't one) any other JSON value; `None`
    /// is `undefined` (a workspace without `rootPath`).
    pub cwd: Option<Value>,
    pub customization_id: Option<String>,
    /// The workspace entry it came from, as stored.
    pub workspace: Option<Value>,
}

impl ActiveCwd {
    /// The cwd when it is a string: the only kind `openDb` accepts.
    pub fn cwd_str(&self) -> Option<&str> {
        self.cwd.as_ref()?.as_str()
    }
}

/// `resolveActiveCwd()`, given the values of the `claudius.customization`
/// and `claudius.workspace` cookies (an empty value counts as none). Every
/// store error falls through to the next source, as TS's `.catch(() =>
/// null)`s do.
pub fn resolve_active_cwd(
    customization_cookie: Option<&str>,
    workspace_cookie: Option<&str>,
) -> ActiveCwd {
    if let Some(id) = customization_cookie.filter(|c| !c.is_empty())
        && let Ok(Some(_)) = customizations::get_customization(id)
    {
        return ActiveCwd {
            cwd: Some(Value::String(customizations::customization_src_dir(id))),
            customization_id: Some(id.to_owned()),
            workspace: None,
        };
    }
    if let Ok(Some(ws)) = workspaces::resolve_active_raw(workspace_cookie) {
        return ActiveCwd {
            cwd: ws.get("rootPath").cloned(),
            customization_id: None,
            workspace: Some(ws),
        };
    }
    ActiveCwd {
        cwd: std::env::current_dir()
            .ok()
            .map(|d| Value::String(d.display().to_string())),
        customization_id: None,
        workspace: None,
    }
}
