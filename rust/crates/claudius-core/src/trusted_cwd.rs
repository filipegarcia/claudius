//! Which working directories a client may start a session in — port of
//! `lib/server/trusted-cwd.ts`, plus the fork-worktree lookup and the
//! `isCustomizationCwd` check `POST /api/sessions` needs (the customization
//! store itself is [`crate::customizations`]).

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::{customizations, node_path, paths, sessions_store, workspaces};

const CACHE_TTL: Duration = Duration::from_secs(5);

/// `isCustomizationCwd` (`app/api/sessions/route.ts`): `<root>/<id>/src`.
pub fn is_customization_cwd(cwd: &str) -> bool {
    let root = customizations::customizations_root();
    let sep = std::path::MAIN_SEPARATOR;
    (cwd == root || cwd.starts_with(&format!("{root}{sep}"))) && cwd.ends_with(&format!("{sep}src"))
}

/// The `id`s of the stored customizations that are strings (an unreadable
/// store has none, as `listCustomizations().catch(() => [])`).
fn list_customization_ids() -> Vec<String> {
    customizations::list_customizations()
        .unwrap_or_default()
        .iter()
        .filter_map(|c| c.get("id")?.as_str().map(str::to_owned))
        .collect()
}

/// `forkWorktreeCwd(sessionId)` → `(cwd, sourceCwd)` when the fork's
/// worktree still exists.
pub fn fork_worktree_cwd(session_id: &str) -> Option<(String, String)> {
    let idx: Value = std::fs::read_to_string(
        paths::claudius_root()
            .join("fork-worktrees")
            .join("index.json"),
    )
    .ok()
    .and_then(|s| serde_json::from_str(&s).ok())?;
    let assoc = idx.get("forks")?.get(session_id)?;
    let cwd = assoc.get("cwd")?.as_str()?.to_owned();
    let source = assoc.get("sourceCwd")?.as_str()?.to_owned();
    std::fs::metadata(&cwd).ok().filter(|m| m.is_dir())?;
    Some((cwd, source))
}

/// `path.resolve(p)` against the process cwd ([`node_path::resolve`]).
fn resolve(p: &str) -> String {
    node_path::resolve(&[p])
}

fn compute_trusted_roots() -> Vec<String> {
    let mut stored: Vec<String> = vec![resolve(".")];
    let add = |v: &mut Vec<String>, p: String| {
        if !v.contains(&p) {
            v.push(p);
        }
    };
    for ws in workspaces::list().unwrap_or_default() {
        if !claudius_agent::js::trim(&ws.root_path).is_empty() {
            add(&mut stored, resolve(&ws.root_path));
        }
        if let Some(dirs) = ws
            .default_value("additionalDirectories")
            .and_then(Value::as_array)
        {
            for d in dirs
                .iter()
                .filter_map(Value::as_str)
                .filter(|d| !claudius_agent::js::trim(d).is_empty())
            {
                add(&mut stored, resolve(d));
            }
        }
    }
    for id in list_customization_ids() {
        add(
            &mut stored,
            resolve(&customizations::customization_src_dir(&id)),
        );
    }
    let mut out = stored.clone();
    for d in &stored {
        if let Ok(real) = std::fs::canonicalize(d) {
            add(&mut out, real.display().to_string());
        }
    }
    out
}

static ROOTS: Mutex<Option<(Vec<String>, Instant)>> = Mutex::new(None);

fn trusted_roots(force: bool) -> Vec<String> {
    let mut g = ROOTS.lock().unwrap();
    if !force
        && let Some((r, at)) = g.as_ref()
        && at.elapsed() < CACHE_TTL
    {
        return r.clone();
    }
    let r = compute_trusted_roots();
    *g = Some((r.clone(), Instant::now()));
    r
}

/// `resolveTrustedCwd(input)` — a configured root, its realpath, or a git
/// worktree of one; `None` otherwise. Empty input → the first root.
pub fn resolve_trusted_cwd(input: Option<&str>) -> Option<String> {
    let Some(input) = input.filter(|s| !claudius_agent::js::trim(s).is_empty()) else {
        return trusted_roots(false).into_iter().next();
    };
    let wanted = resolve(input);
    if trusted_roots(false).contains(&wanted) {
        return Some(wanted);
    }
    let fresh = trusted_roots(true);
    if fresh.contains(&wanted) {
        return Some(wanted);
    }
    for root in &fresh {
        if sessions_store::git_worktrees(root)
            .iter()
            .map(|w| resolve(w))
            .any(|w| w == wanted)
        {
            return Some(wanted);
        }
    }
    None
}

/// `projectConfigRootFor(cwd)` — the trusted root a worktree belongs to.
pub fn project_config_root_for(cwd: &str) -> Option<String> {
    if claudius_agent::js::trim(cwd).is_empty() {
        return None;
    }
    let wanted = resolve(cwd);
    let roots = trusted_roots(false);
    if roots.contains(&wanted) {
        return None;
    }
    roots.into_iter().find(|root| {
        sessions_store::git_worktrees(root)
            .iter()
            .any(|w| resolve(w) == wanted)
    })
}
