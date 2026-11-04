//! The account a live session runs under, and whether it still is the
//! active one: session.ts `accountProfileId` / `accountProfileLabel` /
//! `accountDriftFromActive` and `refreshAccountDrift`, plus
//! session-manager.ts `notifyActiveAccountChanged` (G02c).
//!
//! A session is pinned to a profile when it starts (`resolveAccountProfile`,
//! S30). Switching the active account doesn't move it: `PATCH /api/accounts`
//! asks every live session to recompute its drift, and each one whose answer
//! changed tells its tabs (`account_changed`), so the StatusLine badge warns
//! at once. A session started with no account configured has an empty pin,
//! and a refresh does nothing for it, as in TS. The pin is decided at start
//! by [`crate::account_pinning`] (S30).

use serde_json::{Map, Value, json};

use crate::accounts::{AccountProfile, AccountsStore};
use crate::session_manager::SessionManager;

/// `{ id, label }` of a profile.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AccountRef {
    pub id: String,
    pub label: String,
}

impl AccountRef {
    pub(crate) fn of(p: &AccountProfile) -> AccountRef {
        AccountRef {
            id: p.id().to_owned(),
            label: p.label().to_owned(),
        }
    }

    pub fn to_json(&self) -> Value {
        json!({"id": self.id, "label": self.label})
    }
}

/// A session's account fields. Empty (the default) when no profile was
/// configured at start.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AccountPin {
    /// `accountProfileId`: the profile the session spawned under.
    pub id: Option<String>,
    /// `accountProfileLabel`: its label, captured with the id.
    pub label: Option<String>,
    /// `accountDriftFromActive`: the active profile, while it isn't `id`.
    pub drift_from_active: Option<AccountRef>,
}

impl AccountPin {
    /// `this.accountProfileId && this.accountProfileLabel`: both set and
    /// non-empty, the only case where the session reports an account.
    pub fn is_set(&self) -> bool {
        self.pinned().is_some()
    }

    fn pinned(&self) -> Option<(&str, &str)> {
        let id = self.id.as_deref().filter(|s| !s.is_empty())?;
        let label = self.label.as_deref().filter(|s| !s.is_empty())?;
        Some((id, label))
    }

    /// `{ id, label, ...(drift ? { driftFromActive } : {}) }`, the `account`
    /// the session reports (`ready`, `account_changed`, `GET /:id/account`).
    /// `None` when [`is_set`](Self::is_set) isn't.
    pub fn account_json(&self) -> Option<Value> {
        let (id, label) = self.pinned()?;
        let mut m = Map::new();
        m.insert("id".into(), id.into());
        m.insert("label".into(), label.into());
        if let Some(d) = &self.drift_from_active {
            m.insert("driftFromActive".into(), d.to_json());
        }
        Some(Value::Object(m))
    }

    /// `refreshAccountDrift` once `getActiveProfile()` answered `active`
    /// (`None` too when the store failed to read: its `.catch(() => null)`).
    /// The drift becomes the active profile unless that is the pinned one;
    /// when it changed (id or label), the `account_changed` event to
    /// broadcast. Nothing for a session without a pin.
    pub fn refresh(&mut self, active: Option<&AccountProfile>) -> Option<Value> {
        let (id, _) = self.pinned()?;
        let next = active.filter(|a| a.id() != id).map(AccountRef::of);
        if next == self.drift_from_active {
            return None;
        }
        self.drift_from_active = next;
        Some(json!({"type": "account_changed", "account": self.account_json()?}))
    }
}

impl SessionManager {
    /// `notifyActiveAccountChanged`: after an account switch, every live
    /// session re-checks its drift against `store`'s active profile (no
    /// credential changes: that's the point of the pin). Returns how many
    /// sessions were asked. A store that fails to read counts as no active
    /// profile for each, as TS's per-session `.catch` has it, so this never
    /// fails.
    pub fn notify_active_account_changed(&self, store: &AccountsStore) -> usize {
        let targets = self.list();
        for s in &targets {
            s.refresh_account_drift(store);
        }
        targets.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(id: &str, label: &str) -> AccountProfile {
        AccountProfile::from_value(&json!({
            "id": id, "label": label, "kind": "api-key", "secret": "s", "createdAt": "c"
        }))
        .unwrap()
    }

    fn pin(id: Option<&str>, label: Option<&str>, drift: Option<(&str, &str)>) -> AccountPin {
        AccountPin {
            id: id.map(Into::into),
            label: label.map(Into::into),
            drift_from_active: drift.map(|(id, label)| AccountRef {
                id: id.into(),
                label: label.into(),
            }),
        }
    }

    #[test]
    fn an_unpinned_session_never_reports() {
        let other = profile("acc_b", "B");
        for mut p in [
            pin(None, None, None),
            pin(Some("acc_a"), None, None),
            pin(None, Some("A"), None),
            pin(Some(""), Some("A"), None),
            pin(Some("acc_a"), Some(""), Some(("acc_b", "B"))),
        ] {
            let before = p.clone();
            assert_eq!(p.refresh(Some(&other)), None, "{before:?}");
            assert_eq!(p.refresh(None), None, "{before:?}");
            assert_eq!(p, before);
            assert_eq!(p.account_json(), None);
        }
    }

    #[test]
    fn drift_follows_the_active_profile() {
        let (a, b) = (profile("acc_a", "A"), profile("acc_b", "B"));
        let mut p = pin(Some("acc_a"), Some("A"), None);
        assert_eq!(p.refresh(Some(&a)), None);
        assert_eq!(
            p.refresh(Some(&b)),
            Some(
                json!({"type": "account_changed", "account": {"id": "acc_a", "label": "A", "driftFromActive": {"id": "acc_b", "label": "B"}}})
            )
        );
        assert_eq!(p.refresh(Some(&b)), None);
        // A relabelled active profile is a change.
        let b2 = profile("acc_b", "B2");
        assert!(p.refresh(Some(&b2)).is_some());
        assert_eq!(p.drift_from_active.as_ref().unwrap().label, "B2");
        assert_eq!(
            p.refresh(None),
            Some(json!({"type": "account_changed", "account": {"id": "acc_a", "label": "A"}}))
        );
        assert_eq!(p.drift_from_active, None);
    }
}
