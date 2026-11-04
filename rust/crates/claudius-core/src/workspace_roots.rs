//! `lib/server/workspace-roots.ts`: the root directories the Files browser
//! shows for a workspace (`listWorkspaceRoots`) and the `?root=` selector
//! lookup (`resolveWorkspaceRoot`) behind `GET /api/workspaces/:id/roots`
//! and `POST …/reveal` (and the files routes, D03).
//!
//! A workspace is the store entry as JSON ([`crate::workspaces::get_raw`]),
//! so its fields have whatever type the file holds. The roots are
//! `primary` (`resolve(ws.rootPath)`), then each non-blank string of the
//! workspace's `defaults.additionalDirectories`, then of the project
//! `settings.json`'s `permissions.additionalDirectories`, each
//! `path.resolve`d against the process cwd and deduped (the first source
//! wins), with ids `extra:<n>` by position. Replayed against the TS
//! through the routes: `claudius-server/tests/workspace_roots.rs` (`roots`
//! and `reveal`, D02) and `workspaces.rs` (D01's `roots` requests).

use anyhow::bail;
use serde_json::{Value, json};

use crate::js_string::{self, lossy};
use crate::{customizations, node_path, workspaces};

/// Where a root came from (`WorkspaceRoot.source`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RootSource {
    /// `ws.rootPath` (or a customization's mirror).
    Primary,
    /// The workspace's `defaults.additionalDirectories`.
    Workspace,
    /// The project-scope `settings.json`'s `permissions.additionalDirectories`.
    Settings,
}

impl RootSource {
    pub fn as_str(self) -> &'static str {
        match self {
            RootSource::Primary => "primary",
            RootSource::Workspace => "workspace",
            RootSource::Settings => "settings",
        }
    }
}

/// One `WorkspaceRoot`: `id` is `primary` or `extra:<n>`, `abs_path` the
/// resolved path (lone surrogates as [`js_string`] stand-ins).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkspaceRoot {
    pub id: String,
    pub abs_path: String,
    pub source: RootSource,
}

impl WorkspaceRoot {
    /// `{id, absPath, source}`, the TS object in its key order.
    pub fn to_json(&self) -> Value {
        json!({"id": self.id, "absPath": self.abs_path, "source": self.source.as_str()})
    }
}

/// `listWorkspaceRoots(ws)`. A `rootPath` that isn't a string throws
/// (`path.resolve`'s TypeError), and so does a workspace list that isn't
/// iterable: `defaults.additionalDirectories` is walked when it is an
/// array, or a string's code points, and anything else but `null` throws.
/// The settings list counts only as an array, and any failure reading it
/// (no file is `{}`; a directory, bad JSON, a `null` file, a primary `"/"`
/// or one with a NUL that `assertWithin` rejects) just skips it.
pub fn list_workspace_roots(ws: &Value) -> anyhow::Result<Vec<WorkspaceRoot>> {
    let Some(root_path) = ws.get("rootPath").and_then(Value::as_str) else {
        bail!("The \"paths[0]\" argument must be of type string");
    };
    let primary = node_path::resolve(&[root_path]);
    let mut out = vec![WorkspaceRoot {
        id: "primary".into(),
        abs_path: primary.clone(),
        source: RootSource::Primary,
    }];
    let mut seen = vec![primary.clone()];
    let mut add = |raw: &Value, source: RootSource, out: &mut Vec<WorkspaceRoot>| {
        // `typeof raw !== "string" || !raw.trim()`.
        let Some(raw) = raw
            .as_str()
            .filter(|s| !claudius_agent::js::trim(s).is_empty())
        else {
            return;
        };
        let abs = node_path::resolve(&[raw]);
        if seen.contains(&abs) {
            return;
        }
        seen.push(abs.clone());
        out.push(WorkspaceRoot {
            id: format!("extra:{}", out.len() - 1),
            abs_path: abs,
            source,
        });
    };
    // `ws.defaults?.additionalDirectories ?? []`: only an object has the
    // key (a string, array or number default reads `undefined`).
    let from_workspace = match ws.get("defaults") {
        Some(Value::Object(d)) => d.get("additionalDirectories").filter(|v| !v.is_null()),
        _ => None,
    };
    match from_workspace {
        None => {}
        Some(Value::Array(items)) => {
            for raw in items {
                add(raw, RootSource::Workspace, &mut out);
            }
        }
        Some(Value::String(s)) => {
            for raw in js_string::code_points(s) {
                add(&Value::String(raw), RootSource::Workspace, &mut out);
            }
        }
        Some(_) => bail!("fromWorkspace is not iterable"),
    }
    for raw in &project_additional_dirs(&primary) {
        add(raw, RootSource::Settings, &mut out);
    }
    Ok(out)
}

/// `(await readSettings("project", primary)).permissions?.additionalDirectories`
/// when it is an array; none where it isn't or the TS `try` catches. The
/// file is parsed with [`js_string::parse`], so a lone-surrogate escape in
/// an entry stays the lone surrogate TS resolves (`settings::read_settings`
/// would make it U+FFFD).
fn project_additional_dirs(primary: &str) -> Vec<Value> {
    // `pathFor` → `assertWithin(primary, ".claude/settings.json")`.
    if primary.contains('\0') {
        return Vec::new();
    }
    let target = node_path::resolve(&[primary, ".claude/settings.json"]);
    if !target.starts_with(&format!("{primary}/")) {
        return Vec::new();
    }
    let Ok(bytes) = std::fs::read(lossy(&target).as_ref()) else {
        return Vec::new();
    };
    let Ok(settings) = js_string::parse(&String::from_utf8_lossy(&bytes)) else {
        return Vec::new();
    };
    match settings
        .get("permissions")
        .and_then(|p| p.get("additionalDirectories"))
    {
        Some(Value::Array(a)) => a.clone(),
        _ => Vec::new(),
    }
}

/// What `resolveWorkspaceRoot` resolves to: the workspace entry (`None` for
/// a customization) and the root the selector names.
#[derive(Clone, Debug, PartialEq)]
pub struct ResolvedRoot {
    pub ws: Option<Value>,
    pub root: WorkspaceRoot,
}

/// `resolveWorkspaceRoot(workspaceId, selector)`. A missing or empty
/// selector is `primary`. A `cust_…` id is a customization: when
/// `getCustomization` finds it (any failure reading the index counts as
/// not found) only `primary` resolves, to `resolve(customizationSrcDir(id))`
/// (a `path.join`, so `..` in the id climbs). Otherwise the workspace's
/// roots are listed and the one with that id is picked. `Ok(None)` is TS's
/// `null` (the routes' 404); `Err` is what TS lets throw (the store's
/// errors, [`list_workspace_roots`]'s TypeErrors).
pub fn resolve_workspace_root(
    workspace_id: &str,
    selector: Option<&str>,
) -> anyhow::Result<Option<ResolvedRoot>> {
    let id = selector.filter(|s| !s.is_empty()).unwrap_or("primary");
    if workspace_id.starts_with("cust_") {
        if !matches!(customizations::get_customization(workspace_id), Ok(Some(_))) {
            return Ok(None);
        }
        if id != "primary" {
            return Ok(None);
        }
        let src = customizations::customization_src_dir(workspace_id);
        return Ok(Some(ResolvedRoot {
            ws: None,
            root: WorkspaceRoot {
                id: "primary".into(),
                abs_path: node_path::resolve(&[&src]),
                source: RootSource::Primary,
            },
        }));
    }
    let Some(ws) = workspaces::get_raw(workspace_id)? else {
        return Ok(None);
    };
    let roots = list_workspace_roots(&ws)?;
    Ok(roots
        .into_iter()
        .find(|r| r.id == id)
        .map(|root| ResolvedRoot { ws: Some(ws), root }))
}
