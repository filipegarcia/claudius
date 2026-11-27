//! The rail's To-dos: `TodoList.tsx` (a row's icon, tone and text, the
//! toggle and delete it calls), `AddTodosForm.tsx` (the rows, their keys
//! and the submit check) and the prompt `ChatSurface`'s `onAddTodos`
//! sends (ChatSurface.tsx:1052).

use claudius_client::AgentTodo;

use crate::look::{Ink, Paint};

/// A row of the list.
#[derive(Clone, Debug, PartialEq)]
pub struct TodoRow {
    pub id: String,
    pub status: String,
    /// `Circle`, `Loader2` (spinning) or `CheckCircle2`.
    pub icon: &'static str,
    pub ink: Ink,
    pub spinning: bool,
    /// The `activeForm` while in progress, else the content.
    pub text: String,
    /// Struck through and dimmed.
    pub done: bool,
    /// The toggle's action, tooltip and aria label.
    pub toggle: (&'static str, &'static str, &'static str),
}

/// `TodoList`'s row (TodoList.tsx:49).
pub fn todo_row(t: &AgentTodo) -> TodoRow {
    let (icon, ink) = match t.status.as_str() {
        "in_progress" => ("Loader2", Ink::of(Paint::Step("sky-300"))),
        "completed" => ("CheckCircle2", Ink::of(Paint::Step("emerald-300"))),
        // `ICON[t.status] ?? Circle`, `TONE[...] ?? TONE.pending`.
        _ => ("Circle", Ink::of(Paint::Muted)),
    };
    let done = t.status == "completed";
    let text = match (&t.active_form, t.status.as_str()) {
        (Some(a), "in_progress") if !a.is_empty() => a.clone(),
        _ => t.content.clone(),
    };
    TodoRow {
        id: t.id.clone(),
        status: t.status.clone(),
        icon,
        ink,
        spinning: t.status == "in_progress",
        text,
        done,
        toggle: if done {
            ("reopen", "Reopen \u{2014} mark not done", "Reopen item")
        } else {
            ("complete", "Mark done", "Mark item done")
        },
    }
}

/// The section's badge (`(3)`).
pub fn todos_badge(n: usize) -> String {
    format!("({n})")
}

/// The empty list's line (BackgroundTasksPanel.tsx:695).
pub const TODOS_EMPTY: &str = "No tasks yet. Click + to add.";

/// `onAddTodos(texts)` (ChatSurface.tsx:1052): the prompt it sends, or
/// none when every text is blank.
pub fn add_todos_prompt(texts: &[String]) -> Option<String> {
    let cleaned: Vec<&str> = texts
        .iter()
        .map(|t| claudius_agent::js::trim(t))
        .filter(|t| !t.is_empty())
        .collect();
    if cleaned.is_empty() {
        return None;
    }
    let bullets: Vec<String> = cleaned.iter().map(|t| format!("- {t}")).collect();
    Some(
        [
            "Use the TodoWrite tool to APPEND these item(s) to your current todo list.",
            "Preserve every existing item unchanged. New items have status `pending`.",
            "Do not run any other tool and do not write any text in your reply.",
            "",
            "Items to add:",
            &bullets.join("\n"),
        ]
        .join("\n"),
    )
}

/// `AddTodosForm`'s state: one text per row (never fewer than one), the
/// in-flight flag and the error line.
#[derive(Clone, Debug, PartialEq)]
pub struct AddForm {
    pub rows: Vec<String>,
    pub submitting: bool,
    pub error: Option<String>,
}

impl Default for AddForm {
    fn default() -> Self {
        AddForm {
            rows: vec![String::new()],
            submitting: false,
            error: None,
        }
    }
}

/// What a key in a row does (`onKey`, AddTodosForm.tsx:68).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FormKey {
    /// ⌘/Ctrl+Enter.
    Submit,
    /// Enter: a new row (focused) after a non-empty last row, else the
    /// next row.
    Enter,
    Escape,
    /// Backspace in an empty row (with others): it goes, focus moves up.
    Backspace,
}

/// What the view does after a key.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FormStep {
    Nothing,
    /// Focus row `i` (after adding it when it's new).
    Focus(usize),
    Submit,
    Cancel,
}

/// Max chars per row (`maxLength={200}`).
pub const ROW_MAX_LEN: usize = 200;
pub const ROW_PLACEHOLDER: &str = "What should the agent track?";

impl AddForm {
    pub fn set_row(&mut self, i: usize, value: &str) {
        if let Some(r) = self.rows.get_mut(i) {
            *r = value.to_owned();
        }
    }

    /// `addRow()`: a new empty row; its index.
    pub fn add_row(&mut self) -> usize {
        self.rows.push(String::new());
        self.rows.len() - 1
    }

    /// `removeRow(i)`: never below one empty row.
    pub fn remove_row(&mut self, i: usize) {
        if self.rows.len() <= 1 {
            self.rows = vec![String::new()];
            return;
        }
        if i < self.rows.len() {
            self.rows.remove(i);
        }
    }

    /// The texts a submit sends (`rows.map(trim).filter(Boolean)`).
    pub fn texts(&self) -> Vec<String> {
        self.rows
            .iter()
            .map(|r| claudius_agent::js::trim(r).to_owned())
            .filter(|r| !r.is_empty())
            .collect()
    }

    /// The Add button: off while sending or when every row is blank.
    pub fn can_submit(&self) -> bool {
        !self.submitting
            && !self
                .rows
                .iter()
                .all(|r| claudius_agent::js::trim(r).is_empty())
    }

    /// `submit()`'s check: the texts to send, or the error line.
    pub fn begin_submit(&mut self) -> Option<Vec<String>> {
        let texts = self.texts();
        if texts.is_empty() {
            self.error = Some("Add at least one task".into());
            return None;
        }
        self.error = None;
        self.submitting = true;
        Some(texts)
    }

    /// The send settled: an error keeps the form open with it.
    pub fn end_submit(&mut self, error: Option<String>) {
        self.submitting = false;
        self.error = error;
    }

    /// A key in row `i`.
    pub fn key(&mut self, i: usize, key: FormKey) -> FormStep {
        match key {
            FormKey::Submit => FormStep::Submit,
            FormKey::Enter => {
                let last = i + 1 == self.rows.len();
                if last
                    && self
                        .rows
                        .get(i)
                        .is_some_and(|r| !claudius_agent::js::trim(r).is_empty())
                {
                    FormStep::Focus(self.add_row())
                } else if i + 1 < self.rows.len() {
                    FormStep::Focus(i + 1)
                } else {
                    FormStep::Nothing
                }
            }
            FormKey::Escape => FormStep::Cancel,
            FormKey::Backspace => {
                if self.rows.get(i).is_some_and(String::is_empty) && self.rows.len() > 1 {
                    self.remove_row(i);
                    FormStep::Focus(i.saturating_sub(1))
                } else {
                    FormStep::Nothing
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn todo(status: &str, active: Option<&str>) -> AgentTodo {
        AgentTodo {
            id: "t1".into(),
            content: "Write the tests".into(),
            status: status.into(),
            active_form: active.map(str::to_owned),
        }
    }

    #[test]
    fn a_todo_row_follows_its_status() {
        let r = todo_row(&todo("pending", None));
        assert_eq!((r.icon, r.done, r.toggle.0), ("Circle", false, "complete"));
        let r = todo_row(&todo("in_progress", Some("Writing the tests")));
        assert_eq!(r.text, "Writing the tests");
        assert!(r.spinning);
        let r = todo_row(&todo("completed", Some("Writing")));
        assert_eq!(r.text, "Write the tests");
        assert_eq!(r.toggle.0, "reopen");
        assert!(r.done);
        assert_eq!(todo_row(&todo("weird", None)).icon, "Circle");
    }

    #[test]
    fn the_add_prompt_lists_the_trimmed_items() {
        assert_eq!(add_todos_prompt(&["  ".into()]), None);
        let p = add_todos_prompt(&[" a ".into(), "".into(), "b".into()]).unwrap();
        assert!(p.ends_with("Items to add:\n- a\n- b"));
        assert!(p.starts_with("Use the TodoWrite tool to APPEND"));
    }

    #[test]
    fn the_form_adds_moves_and_removes_rows_on_keys() {
        let mut f = AddForm::default();
        assert!(!f.can_submit());
        assert_eq!(f.key(0, FormKey::Enter), FormStep::Nothing);
        f.set_row(0, "one");
        assert_eq!(f.key(0, FormKey::Enter), FormStep::Focus(1));
        assert_eq!(f.rows.len(), 2);
        assert_eq!(f.key(0, FormKey::Enter), FormStep::Focus(1));
        assert_eq!(f.key(1, FormKey::Backspace), FormStep::Focus(0));
        assert_eq!(f.rows, ["one"]);
        assert_eq!(f.key(0, FormKey::Backspace), FormStep::Nothing);
        assert_eq!(f.key(0, FormKey::Escape), FormStep::Cancel);
        assert_eq!(f.key(0, FormKey::Submit), FormStep::Submit);
        f.remove_row(0);
        assert_eq!(f.rows, [""]);
    }

    #[test]
    fn submitting_needs_a_text_and_keeps_an_error() {
        let mut f = AddForm::default();
        assert_eq!(f.begin_submit(), None);
        assert_eq!(f.error.as_deref(), Some("Add at least one task"));
        f.set_row(0, " x ");
        assert_eq!(f.begin_submit(), Some(vec!["x".to_owned()]));
        assert!(f.submitting && !f.can_submit());
        f.end_submit(Some("couldn't add todos: no session".into()));
        assert!(!f.submitting);
        assert!(f.error.is_some());
    }
}
