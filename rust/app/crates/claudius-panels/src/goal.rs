//! `components/chat/GoalBanner.tsx` (embedded in the session header, as
//! `ChatSurface` mounts it) and `lib/client/useGoalBannerHidden.ts`.

use claudius_agent::js;
use claudius_client::state::GoalState;

/// `useGoalBannerHidden`'s `localStorage` key: `"1"` hides the empty
/// prompt.
pub const GOAL_HIDDEN_KEY: &str = "claudius.goalBannerHidden";

/// `readSnapshot()`.
pub fn goal_hidden(raw: Option<&str>) -> bool {
    raw == Some("1")
}

pub const EDITOR_HEADER: &str = "Session goal \u{2014} Claude starts working on submit";
pub const EDITOR_PLACEHOLDER: &str =
    "What should this session accomplish? Press Enter to start Claude.";
pub const SET_LABEL: &str = "Set a session goal";
pub const SET_TITLE: &str = "Set a goal for this session";
pub const HIDE_TITLE: &str = "Hide this \u{2014} restore by hovering the title or from Settings";

/// What the banner shows.
#[derive(Clone, Debug, PartialEq)]
pub enum Banner {
    /// Nothing: the empty prompt was dismissed.
    Hidden,
    /// The inline editor, prefilled with the goal's text.
    Editor { prefill: String },
    /// "Set a session goal" (and the hide X).
    Empty,
    Goal {
        text: String,
        achieved: bool,
        /// The agent's summary, once achieved.
        summary: Option<String>,
        /// The pencil's label: `Set a new goal` once achieved.
        edit_label: &'static str,
    },
}

/// `GoalBanner` (GoalBanner.tsx:102 on).
pub fn banner(goal: Option<&GoalState>, editing: bool, hidden: bool) -> Banner {
    if editing {
        return Banner::Editor {
            prefill: goal.map(|g| text_of(&g.text)).unwrap_or_default(),
        };
    }
    let Some(g) = goal else {
        return if hidden {
            Banner::Hidden
        } else {
            Banner::Empty
        };
    };
    let summary = Some(&g.summary)
        .filter(|s| g.achieved && js::truthy(s))
        .map(text_of);
    Banner::Goal {
        text: text_of(&g.text),
        achieved: g.achieved,
        summary,
        edit_label: if g.achieved {
            "Set a new goal"
        } else {
            "Edit goal"
        },
    }
}

/// What React prints for a goal's text (a string or a number).
fn text_of(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::Null => String::new(),
        v => js::to_string(Some(v)),
    }
}

/// `RecapBanner`'s `goalRowBelow` / the header's goal row: whether the
/// row draws at all (`hidden` only hides the empty prompt).
pub fn row_shows(goal: Option<&GoalState>, editing: bool, hidden: bool) -> bool {
    banner(goal, editing, hidden) != Banner::Hidden
}

/// `handleGoalSubmit(text)` (ChatSurface.tsx:2090): the trimmed goal, or
/// none for a blank one (nothing is sent).
pub fn goal_submit_text(text: &str) -> Option<String> {
    Some(js::trim(text).to_owned()).filter(|t| !t.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn goal(achieved: bool, summary: Value) -> GoalState {
        GoalState {
            text: json!("Ship the rail"),
            achieved,
            summary,
            set_at: Value::Null,
            achieved_at: Value::Null,
        }
    }

    #[test]
    fn the_banner_states() {
        assert_eq!(banner(None, false, false), Banner::Empty);
        assert_eq!(banner(None, false, true), Banner::Hidden);
        assert_eq!(
            banner(None, true, true),
            Banner::Editor {
                prefill: String::new()
            }
        );
        let g = goal(false, json!("nope"));
        assert_eq!(
            banner(Some(&g), false, true),
            Banner::Goal {
                text: "Ship the rail".into(),
                achieved: false,
                summary: None,
                edit_label: "Edit goal",
            }
        );
        let g = goal(true, json!("Done in 3 turns"));
        let Banner::Goal {
            summary,
            edit_label,
            ..
        } = banner(Some(&g), false, false)
        else {
            panic!("a goal")
        };
        assert_eq!(summary.as_deref(), Some("Done in 3 turns"));
        assert_eq!(edit_label, "Set a new goal");
        assert_eq!(
            banner(Some(&g), true, false),
            Banner::Editor {
                prefill: "Ship the rail".into()
            }
        );
    }

    #[test]
    fn the_hidden_setting_is_a_literal_one() {
        assert!(goal_hidden(Some("1")));
        assert!(!goal_hidden(Some("true")));
        assert!(!goal_hidden(None));
    }

    #[test]
    fn a_blank_goal_sends_nothing() {
        assert_eq!(goal_submit_text("  "), None);
        assert_eq!(goal_submit_text(" ship it "), Some("ship it".into()));
    }
}
