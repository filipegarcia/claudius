//! Boot-time customization work: port of `lib/server/customizations-startup.ts`
//! (D14). [`run_customizations_startup`] is what `instrumentation.ts` runs —
//! the upgrade check first, then the workspace reconcile. Wiring it into the
//! server's startup is G12, so nothing calls it here yet.
//!
//! The upgrade check auto-reverts every active publish whose `baseHash` no
//! longer matches the live tree (an npm update, a git pull, a manual edit
//! after the publish): restoring its snapshot over a newer base would undo
//! the upgrade. A preview server running from inside a mirror
//! ([`is_running_inside_customization_mirror_for`], D16's port of the
//! module's third export) skips both: its tree is divergent by design.
//!
//! Best-effort throughout: the TS logs and moves on, so only
//! `activePublishesOrdered`'s own failure (an unreadable index) propagates.

use crate::customizations::{Store, hash_tree};
use crate::customize_runtime::is_running_inside_customization_mirror_for;
use crate::{log, workspaces};

/// `reconcileCustomizationWorkspaces()`: drop the legacy `workspaceId` of
/// every customization record and delete every workspace tagged
/// `kind: "customization"`. One thrown error ends it with a warning, as the
/// TS `try` does.
pub fn reconcile_customization_workspaces(store: &Store, live: &str) {
    if is_running_inside_customization_mirror_for(live, store.root()) {
        return;
    }
    if let Err(e) = reconcile(store) {
        tracing::warn!(target: log::API, "[customizations] could not reconcile customization workspaces: {e:#}");
    }
}

fn reconcile(store: &Store) -> anyhow::Result<()> {
    let stripped = store.strip_customization_workspace_ids()?;
    if stripped > 0 {
        tracing::info!(target: log::API, "[customizations] stripped legacy workspaceId from {stripped} record(s)");
    }
    for ws in workspaces::list_raw()? {
        if ws.get("kind").map(|k| k == "customization") != Some(true) {
            continue;
        }
        // A non-string id can't be deleted here (TS passes it through);
        // see PORT_PLAN's known gaps.
        let Some(id) = ws.get("id").and_then(|i| i.as_str()) else {
            continue;
        };
        workspaces::delete_raw(id)?;
        tracing::info!(target: log::API, "[customizations] removed legacy customization workspace {id}");
    }
    Ok(())
}

/// `runCustomizationsUpgradeCheck()`: revert every active publish whose
/// `baseHash !== hashTree(live)`, then mark it `stale_at_upgrade`. `node`
/// runs the revert script ([`crate::customization_revert`]).
pub async fn run_customizations_upgrade_check(
    store: &Store,
    live: &str,
    node: &str,
) -> anyhow::Result<()> {
    if is_running_inside_customization_mirror_for(live, store.root()) {
        return Ok(());
    }
    let active = store.active_publishes_ordered()?;
    if active.is_empty() {
        return Ok(());
    }
    let current = match hash_tree(live) {
        Ok(h) => h,
        Err(e) => {
            tracing::warn!(target: log::API, "[customizations] could not hash live source: {}", e.message);
            return Ok(());
        }
    };
    for p in &active {
        if p.get("baseHash").map(|h| h == current.as_str()) == Some(true) {
            continue;
        }
        let id = p.get("id").map_or_else(
            || "undefined".to_owned(),
            |v| claudius_agent::js::to_string(Some(v)),
        );
        tracing::warn!(target: log::API,
            "[customizations] active publish {id} is stale (base tree changed); auto-reverting");
        if let Err(e) = revert_one(store, live, node, &id).await {
            tracing::warn!(target: log::API, "[customizations] auto-revert of {id} failed: {e:#}");
        }
    }
    Ok(())
}

async fn revert_one(store: &Store, live: &str, node: &str, id: &str) -> anyhow::Result<()> {
    crate::customization_revert::revert_publish(node, live, id)
        .await
        .map_err(|e| anyhow::anyhow!(e.message))?;
    store.mark_publish_reverted(id, Some("stale_at_upgrade"))?;
    Ok(())
}

/// What `instrumentation.ts` runs at boot, on the store and live source dir
/// of this process: the upgrade check, then the reconcile.
pub async fn run_customizations_startup() -> anyhow::Result<()> {
    let store = Store::from_env();
    let live = crate::runtime_dir::live_source_dir();
    let node = crate::customization_revert::node_program();
    run_customizations_upgrade_check(&store, &live, &node).await?;
    reconcile_customization_workspaces(&store, &live);
    Ok(())
}
