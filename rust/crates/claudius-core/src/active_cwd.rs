//! The active context's cwd: port of `resolveActiveCwd`
//! (`lib/server/active-customization.ts`), with the parts of
//! `active-workspace.ts` (`resolveActiveWorkspace`) and `workspaces-store.ts`
//! (`ensureBootstrap`, `listWorkspaces`, `getActiveIdHint`) it runs on; the
//! customization side is [`crate::customizations`]. The cookie-scoped
//! routes (`sessions/open-tabs`, D21) start here.
//!
//! Priority: the `claudius.customization` cookie's customization (its
//! `src` mirror), else the active workspace (the `claudius.workspace`
//! cookie's, else the store's hint), else the process cwd. The callers
//! parse the cookies (Next's `RequestCookies`) and pass their values.
//!
//! Both stores are read as the JSON values TS works on (`fs.readFile` as
//! lossy UTF-8, then `JSON.parse`), and the lookups follow its callbacks:
//! `w.id === id` is strict equality (`1.0` equals `1`, objects never match),
//! an entry that is `null` throws, any other entry is passed over. A
//! workspace's `rootPath` is returned as whatever value it is, since TS
//! passes it on unchecked (a non-string one makes `openDb` throw).
//!
//! Self-contained for now: D01 ports the workspace store on raw values
//! (`workspaces::list_raw`, `resolve_active_raw`); once it lands,
//! [`list_workspaces_raw`] and [`resolve_active_workspace_raw`] become those.

use anyhow::anyhow;
use claudius_agent::js;
use serde_json::{Map, Value};

use crate::{customizations, paths};

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

/// `fs.readFile(path, "utf8")` then `JSON.parse`: `Ok(None)` for ENOENT,
/// `Err` for any other read error or a parse error.
fn read_json(path: &std::path::Path) -> anyhow::Result<Option<Value>> {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    js::json_parse(&String::from_utf8_lossy(&bytes))
        .map(Some)
        .map_err(|e| anyhow!(e))
}

fn null_read(key: &str) -> anyhow::Error {
    anyhow!("Cannot read properties of null (reading '{key}')")
}

/// `v.version === 1` (JS numbers: `1.0` is `1`).
fn is_version_1(m: &Map<String, Value>) -> bool {
    m.get("version").and_then(Value::as_f64) == Some(1.0)
}

/// `a === b` for JSON values (`a` may be `undefined`): objects and arrays
/// are references, never equal.
fn strict_eq(a: Option<&Value>, b: &Value) -> bool {
    match (a, b) {
        (Some(Value::Null), Value::Null) => true,
        (Some(Value::Bool(x)), Value::Bool(y)) => x == y,
        (Some(Value::Number(x)), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Some(Value::String(x)), Value::String(y)) => x == y,
        _ => false,
    }
}

/// `list.find((x) => x.id === target)`: a `null` entry throws.
fn find_by_id<'a>(list: &'a [Value], target: &Value) -> anyhow::Result<Option<&'a Value>> {
    for x in list {
        let id = match x {
            Value::Null => return Err(null_read("id")),
            Value::Object(m) => m.get("id"),
            _ => None,
        };
        if strict_eq(id, target) {
            return Ok(Some(x));
        }
    }
    Ok(None)
}

/// workspaces-store `ensureBootstrap()` (`readShape`): the store when it is
/// `{version: 1, workspaces: [..]}`, an empty one when the file is missing
/// or any other value; a parse error, a `null` file and other read errors
/// throw.
fn workspaces_shape() -> anyhow::Result<Map<String, Value>> {
    let parsed = read_json(&paths::claudius_root().join("workspaces.json"))?;
    match parsed {
        Some(Value::Null) => Err(null_read("version")),
        Some(Value::Object(m))
            if is_version_1(&m) && m.get("workspaces").is_some_and(Value::is_array) =>
        {
            Ok(m)
        }
        _ => {
            let mut m = Map::new();
            m.insert("version".into(), Value::from(1));
            m.insert("workspaces".into(), Value::Array(vec![]));
            Ok(m)
        }
    }
}

fn workspaces_of(shape: &Map<String, Value>) -> &[Value] {
    shape["workspaces"].as_array().map_or(&[], Vec::as_slice)
}

/// `listWorkspaces()`: the entries as stored.
pub fn list_workspaces_raw() -> anyhow::Result<Vec<Value>> {
    Ok(workspaces_of(&workspaces_shape()?).to_vec())
}

/// `getActiveIdHint()`: `activeId ?? workspaces[0]?.id ?? null`.
fn active_id_hint(shape: &Map<String, Value>) -> Option<Value> {
    if let Some(v) = shape.get("activeId").filter(|v| !v.is_null()) {
        return Some(v.clone());
    }
    match workspaces_of(shape).first() {
        Some(Value::Object(m)) => m.get("id").filter(|v| !v.is_null()).cloned(),
        _ => None,
    }
}

/// `resolveActiveWorkspace()` with the `claudius.workspace` cookie's value:
/// the entry whose `id` is the (non-empty) cookie, else the one whose `id`
/// is the (truthy) hint, which is read from the store a second time as TS
/// does.
pub fn resolve_active_workspace_raw(cookie_id: Option<&str>) -> anyhow::Result<Option<Value>> {
    let shape = workspaces_shape()?;
    let list = workspaces_of(&shape);
    if let Some(c) = cookie_id.filter(|c| !c.is_empty())
        && let Some(w) = find_by_id(list, &Value::from(c))?
    {
        return Ok(Some(w.clone()));
    }
    match active_id_hint(&workspaces_shape()?).filter(js::truthy) {
        Some(hint) => Ok(find_by_id(list, &hint)?.cloned()),
        None => Ok(None),
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
    if let Ok(Some(ws)) = resolve_active_workspace_raw(workspace_cookie) {
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn strict_equality_is_js() {
        assert!(strict_eq(Some(&json!(1)), &json!(1.0)));
        assert!(strict_eq(Some(&json!("a")), &json!("a")));
        assert!(!strict_eq(Some(&json!("1")), &json!(1)));
        assert!(!strict_eq(Some(&json!({})), &json!({})));
        assert!(!strict_eq(Some(&json!([])), &json!([])));
        assert!(!strict_eq(None, &json!(null)));
        assert!(strict_eq(Some(&json!(true)), &json!(true)));
        assert!(!strict_eq(Some(&json!(false)), &json!(true)));
        assert!(strict_eq(Some(&Value::Null), &Value::Null));
        assert!(!strict_eq(Some(&json!(0)), &json!(false)));
    }

    #[test]
    fn find_throws_on_a_null_entry_before_the_match_only() {
        let list = [json!(5), json!({"id": "a"}), Value::Null];
        assert_eq!(
            find_by_id(&list, &json!("a")).unwrap(),
            Some(&json!({"id": "a"}))
        );
        assert!(find_by_id(&list, &json!("b")).is_err());
        assert_eq!(find_by_id(&list[..2], &json!("b")).unwrap(), None);
    }
}
