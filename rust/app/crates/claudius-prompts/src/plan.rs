//! Plan approval: `components/overlays/PlanOverlay.tsx`, the decisions and
//! toasts `ChatSurface.tsx` wires to it (ChatSurface.tsx:3091-3115), and
//! `components/chat/PlanModeBanner.tsx`.

use claudius_agent::js;
use serde_json::{Map, Value, json};

/// The pending plan (`PendingPlan`: `{ requestId, toolUseId, plan, raw? }`
/// as `on_plan_request` stored it).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingPlan {
    pub tool_use_id: String,
    pub plan: String,
}

impl PendingPlan {
    /// `session.pendingPlan`, when one is up (`null` / not an object: none).
    pub fn from_state(pending: &Value) -> Option<PendingPlan> {
        let o = pending.as_object()?;
        Some(PendingPlan {
            tool_use_id: js::to_string(o.get("toolUseId")),
            plan: o
                .get("plan")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
        })
    }
}

/// The overlay's state (PlanOverlay.tsx:24-26). ChatSurface doesn't key
/// it, so it lives while a plan is pending: a plan that replaces the shown
/// one keeps the draft (and so the preview) of the first, as the TS does.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlanForm {
    /// `plan.plan` when the overlay mounted.
    pub original: String,
    pub editing: bool,
    pub draft: String,
    pub minimized: bool,
}

/// `PlanDecision` (events.ts), the toast ChatSurface shows for it, and
/// what [`PlanForm`] does next.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlanResolution {
    pub decision: Value,
    pub toast: &'static str,
}

impl PlanForm {
    pub fn new(plan: &PendingPlan) -> Self {
        PlanForm {
            original: plan.plan.clone(),
            editing: false,
            draft: plan.plan.clone(),
            minimized: false,
        }
    }

    /// `isDirty`: editing, and the draft differs from the plan once both
    /// are trimmed (PlanOverlay.tsx:28). `plan` is the current
    /// `pendingPlan.plan`.
    pub fn is_dirty(&self, plan: &str) -> bool {
        self.editing && js::trim(&self.draft) != js::trim(plan)
    }

    /// The accept button: "Accept edited plan" when dirty, else "Accept &
    /// execute".
    pub fn accept_label(&self, plan: &str) -> &'static str {
        if self.is_dirty(plan) {
            "Accept edited plan"
        } else {
            "Accept & execute"
        }
    }

    /// "Edit".
    pub fn edit(&mut self) {
        self.editing = true;
    }

    /// "Discard edits", and Escape in the editor: back to the plan.
    pub fn discard(&mut self, plan: &str) {
        self.draft = plan.to_owned();
        self.editing = false;
    }

    /// The accept button, and Cmd/Ctrl+Enter in the editor:
    /// `onAccept(isDirty ? draft : undefined)`.
    pub fn accept(&self, plan: &str) -> PlanResolution {
        let mut d = Map::new();
        d.insert("kind".into(), json!("accept"));
        let dirty = self.is_dirty(plan);
        if dirty {
            d.insert("editedPlan".into(), json!(self.draft));
        }
        PlanResolution {
            decision: Value::Object(d),
            toast: if dirty {
                "Edited plan accepted \u{2014} switched to acceptEdits"
            } else {
                "Plan accepted \u{2014} switched to acceptEdits"
            },
        }
    }

    /// "Reject & iterate".
    pub fn reject() -> PlanResolution {
        PlanResolution {
            decision: json!({ "kind": "reject" }),
            toast: "Plan rejected \u{2014} keep iterating",
        }
    }

    /// The close (X): a soft reject, so the agent doesn't hang.
    pub fn dismiss() -> PlanResolution {
        PlanResolution {
            decision: json!({ "kind": "reject", "message": "User dismissed the plan." }),
            toast: "Plan dismissed \u{2014} still in plan mode",
        }
    }
}

/// The plan-mode banner shows in `plan` mode only (PlanModeBanner.tsx:12);
/// its Exit switches to `default`.
pub fn plan_mode_banner(mode: Option<&str>) -> bool {
    mode == Some("plan")
}

/// The mode the banner's Exit sets.
pub const PLAN_EXIT_MODE: &str = "default";

#[cfg(test)]
mod tests {
    use super::*;
    use claudius_core::js_string::stringify;

    fn plan(text: &str) -> PendingPlan {
        PendingPlan {
            tool_use_id: "toolu_1".into(),
            plan: text.into(),
        }
    }

    #[test]
    fn pending_plan_reads_the_state() {
        assert_eq!(PendingPlan::from_state(&Value::Null), None);
        let p =
            PendingPlan::from_state(&json!({ "requestId": "r", "toolUseId": "t", "plan": "# P" }))
                .unwrap();
        assert_eq!(
            p,
            PendingPlan {
                tool_use_id: "t".into(),
                plan: "# P".into()
            }
        );
        // A plan without its toolUseId prints `undefined`, as the footer's
        // template literal does.
        assert_eq!(
            PendingPlan::from_state(&json!({})).unwrap().tool_use_id,
            "undefined"
        );
    }

    #[test]
    fn accept_sends_the_edit_only_when_dirty() {
        let p = plan("Step 1\n");
        let mut f = PlanForm::new(&p);
        let r = f.accept(&p.plan);
        assert_eq!(stringify(&r.decision), r#"{"kind":"accept"}"#);
        assert_eq!(r.toast, "Plan accepted \u{2014} switched to acceptEdits");
        assert_eq!(f.accept_label(&p.plan), "Accept & execute");
        // Editing alone, or a whitespace-only change, isn't dirty.
        f.edit();
        f.draft = "  Step 1".into();
        assert!(!f.is_dirty(&p.plan));
        assert_eq!(
            stringify(&f.accept(&p.plan).decision),
            r#"{"kind":"accept"}"#
        );
        f.draft = "Step 1\nStep 2".into();
        assert!(f.is_dirty(&p.plan));
        assert_eq!(f.accept_label(&p.plan), "Accept edited plan");
        let r = f.accept(&p.plan);
        assert_eq!(
            stringify(&r.decision),
            r#"{"kind":"accept","editedPlan":"Step 1\nStep 2"}"#
        );
        assert_eq!(
            r.toast,
            "Edited plan accepted \u{2014} switched to acceptEdits"
        );
        // A draft left over from editing isn't sent once editing stops.
        f.editing = false;
        assert!(!f.is_dirty(&p.plan));
    }

    #[test]
    fn discard_restores_the_plan() {
        let p = plan("A");
        let mut f = PlanForm::new(&p);
        f.edit();
        f.draft = "B".into();
        f.discard(&p.plan);
        assert_eq!((f.editing, f.draft.as_str()), (false, "A"));
    }

    #[test]
    fn reject_and_dismiss_are_rejects() {
        assert_eq!(
            stringify(&PlanForm::reject().decision),
            r#"{"kind":"reject"}"#
        );
        assert_eq!(
            PlanForm::reject().toast,
            "Plan rejected \u{2014} keep iterating"
        );
        assert_eq!(
            stringify(&PlanForm::dismiss().decision),
            r#"{"kind":"reject","message":"User dismissed the plan."}"#
        );
        assert_eq!(
            PlanForm::dismiss().toast,
            "Plan dismissed \u{2014} still in plan mode"
        );
    }

    #[test]
    fn plan_mode_banner_is_plan_mode_only() {
        assert!(plan_mode_banner(Some("plan")));
        assert!(!plan_mode_banner(Some("default")));
        assert!(!plan_mode_banner(None));
        assert_eq!(PLAN_EXIT_MODE, "default");
    }
}
