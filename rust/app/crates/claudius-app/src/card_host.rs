//! The transcript cards' host (U06a): what `MessageList` and `ChatSurface`
//! give the cards claudius-chat draws.
//!
//! - Where files link (`FileLinkProvider`): the route's workspace and its
//!   root, as `MessageList` computes `fileLink` from `useWorkspaces()`.
//! - The settings they read: `useMediaPreferences().showPreviews` and
//!   `useEditor().editor` from `localStorage` (`store.rs`), and
//!   `useWorkflowSizeGuideline(fileLink.cwd)` from the user settings, over
//!   the live chat's transport.
//! - Where their links go: a path opens the Files route, "Open" the
//!   editor's URL, and an AskUserQuestion's pill ChatSurface's
//!   `onReopenAsk` (the prompt cards' `reopen_ask`).

use claudius_chat::TranscriptView;
use claudius_chat::cards::FileLink;
use claudius_chat::tool_text::effective_workflow_size;
use claudius_chat::view::{ActionHandler, CardAction};
use claudius_client::DisplayBlock;
use claudius_client::effect::FetchOutcome;
use claudius_client::state::ChatState;
use claudius_client::task_status::find_tool_use_block;
use gpui_kit::{Context, Entity, WeakEntity};
use serde_json::Value;

use crate::shell::Shell;
use crate::targets::settings_reply;

/// `useMediaPreferences`' key (`lib/client/useMediaPreferences.ts`).
pub const SHOW_PREVIEWS_KEY: &str = "claudius.showPreviews";

/// `useEditor`'s key (`lib/client/ide.ts`).
pub const EDITOR_KEY: &str = "claudius.editor";

/// `EDITORS`' ids (`lib/client/ide.ts`).
const EDITORS: [&str; 6] = ["vscode", "cursor", "windsurf", "zed", "jetbrains", "system"];

/// `readSnapshot` (`useMediaPreferences.ts`): `saved !== "false"`, and on
/// when nothing is saved.
pub fn show_previews(saved: Option<&str>) -> bool {
    saved != Some("false")
}

/// `readSnapshot` (`ide.ts`): a saved editor `EDITORS` knows, else
/// `vscode`.
pub fn editor(saved: Option<&str>) -> &'static str {
    saved
        .and_then(|s| EDITORS.iter().copied().find(|e| *e == s))
        .unwrap_or("vscode")
}

/// `useWorkflowSizeGuideline`'s `.then`: the effective size, or `None` to
/// keep the last one ([`settings_reply`]; `data.settings` nullish throws
/// at `.workflowSizeGuideline`, into the `.catch`).
pub fn workflow_size_answer(outcome: &FetchOutcome) -> Option<&'static str> {
    let data = settings_reply(outcome)?;
    let settings = claudius_agent::js::prop(Some(&data), "settings").filter(|s| !s.is_null())?;
    Some(effective_workflow_size(claudius_agent::js::prop(
        Some(settings),
        "workflowSizeGuideline",
    )))
}

/// The input of the row's tool_use block (`AssistantMessage`'s
/// `onReopenAsk({ toolUseId: b.id, input: b.input })`).
pub fn ask_input(state: &ChatState, tool_use_id: &str) -> Option<Value> {
    match find_tool_use_block(tool_use_id, &[&state.messages])? {
        DisplayBlock::ToolUse { input, .. } => Some(input.clone()),
        _ => None,
    }
}

/// The shell's part: the workflow size asked for and its answer.
#[derive(Default)]
pub(crate) struct CardHost {
    /// The cwd the user settings were asked for (the hook's `[cwd]`).
    asked: Option<String>,
    /// The last answer; `medium` (`DEFAULT_WORKFLOW_SIZE`) until one lands.
    workflow_size: Option<&'static str>,
}

/// The route's workspace as the cards' file link.
fn file_link(shell: &Shell) -> Option<FileLink> {
    let state = shell.state();
    let id = state.route().workspace()?;
    state
        .workspaces()
        .iter()
        .find(|w| w.id == id)
        .map(|w| FileLink {
            workspace_id: w.id.clone(),
            cwd: w.root_path.clone(),
        })
}

/// Hands the bound transcript view its file link and settings, and asks
/// for the workflow size when the workspace root changed.
pub(crate) fn sync(shell: &mut Shell, view: &Entity<TranscriptView>, cx: &mut Context<Shell>) {
    let link = file_link(shell);
    if let Some(l) = &link {
        ask_workflow_size(shell, &l.cwd, cx);
    }
    let show = show_previews(shell.store.get(SHOW_PREVIEWS_KEY));
    let editor = editor(shell.store.get(EDITOR_KEY));
    let size = shell.cards.workflow_size.unwrap_or("medium");
    view.update(cx, |v, cx| {
        v.set_file_link(link, cx);
        v.set_card_settings(show, editor, size, cx);
    });
}

/// `useWorkflowSizeGuideline(cwd)`'s effect, over the live chat's
/// transport. One request per root (the hook asks once per mounted
/// block); a later root's answer wins, as its abort would.
fn ask_workflow_size(shell: &mut Shell, cwd: &str, cx: &mut Context<Shell>) {
    if shell.cards.asked.as_deref() == Some(cwd) {
        return;
    }
    let Some(chat) = shell.live_chat() else {
        return;
    };
    let Some(url) = claudius_status::picker::settings_url(Some(cwd)) else {
        return;
    };
    let rx = chat.fetch(claudius_status::target::get(url));
    shell.cards.asked = Some(cwd.to_owned());
    let cwd = cwd.to_owned();
    cx.spawn(async move |this, cx| {
        let Ok(outcome) = rx.await else { return };
        let Some(size) = workflow_size_answer(&outcome) else {
            return;
        };
        let _ = this.update(cx, |s, cx| {
            if s.cards.asked.as_deref() == Some(cwd.as_str()) && s.cards.workflow_size != Some(size)
            {
                s.cards.workflow_size = Some(size);
                cx.notify();
            }
        });
    })
    .detach();
}

/// Where a tab's card links go. The shell's part runs after the view's
/// click (`defer`), outside the view's update.
pub(crate) fn on_action(shell: WeakEntity<Shell>, tab: String) -> ActionHandler {
    Box::new(move |action, _window, cx| match action {
        CardAction::OpenInEditor(link) => cx.open_url(&link.url),
        CardAction::OpenFiles(link) => {
            let (shell, href) = (shell.clone(), link.href.clone());
            cx.defer(move |cx| {
                let _ = shell.update(cx, |s, cx| s.open_url(&href, cx));
            });
        }
        CardAction::ReopenAsk { tool_use_id } => {
            let (shell, tab, id) = (shell.clone(), tab.clone(), tool_use_id.clone());
            cx.defer(move |cx| {
                let _ = shell.update(cx, |s, cx| reopen_ask(s, &tab, &id, cx));
            });
        }
    })
}

/// ChatSurface's `onReopenAsk`: the live ask's own row needs no scrolling
/// (the native inline ask sits under the transcript, always in view);
/// another resurrects the question, or toasts when its input has none.
fn reopen_ask(shell: &mut Shell, tab: &str, tool_use_id: &str, cx: &mut Context<Shell>) {
    let mut input = None;
    shell
        .transcripts
        .read(tab, &mut |st| input = ask_input(st, tool_use_id));
    let (Some(input), Some(prompts)) = (input, shell.chat_prompts(tab)) else {
        return;
    };
    prompts.reopen_ask(tool_use_id, &input, cx);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reply(status: u16, body: &str) -> FetchOutcome {
        FetchOutcome::Response {
            status,
            body: body.to_owned(),
        }
    }

    #[test]
    fn show_previews_is_off_only_for_the_string_false() {
        assert!(show_previews(None));
        assert!(!show_previews(Some("false")));
        for saved in ["true", "", "0", "False", "no"] {
            assert!(show_previews(Some(saved)), "{saved}");
        }
    }

    #[test]
    fn the_editor_is_a_known_id_else_vscode() {
        for id in EDITORS {
            assert_eq!(editor(Some(id)), id);
        }
        for saved in [None, Some(""), Some("Zed"), Some("emacs")] {
            assert_eq!(editor(saved), "vscode", "{saved:?}");
        }
    }

    #[test]
    fn workflow_size_answer_reads_the_user_setting() {
        for (body, size) in [
            (r#"{"settings":{"workflowSizeGuideline":"large"}}"#, "large"),
            (r#"{"settings":{"workflowSizeGuideline":"small"}}"#, "small"),
            (
                r#"{"settings":{"workflowSizeGuideline":"unrestricted"}}"#,
                "unrestricted",
            ),
            // `effectiveWorkflowSize`: anything else is the default.
            (r#"{"settings":{}}"#, "medium"),
            (r#"{"settings":{"workflowSizeGuideline":"huge"}}"#, "medium"),
            (r#"{"settings":{"workflowSizeGuideline":3}}"#, "medium"),
            // `"x".workflowSizeGuideline` is undefined, no throw.
            (r#"{"settings":"x"}"#, "medium"),
        ] {
            assert_eq!(
                workflow_size_answer(&reply(200, body)),
                Some(size),
                "{body}"
            );
        }
        // `res.json()` skips a BOM.
        let bom = "\u{feff}{\"settings\":{\"workflowSizeGuideline\":\"large\"}}";
        assert_eq!(workflow_size_answer(&reply(200, bom)), Some("large"));
    }

    #[test]
    fn workflow_size_answer_keeps_the_last_one_when_the_hook_would() {
        // `if (!res.ok) return`, and the `.catch`: a failed fetch, a body
        // that isn't JSON, `null.settings`, and a nullish `settings`.
        for outcome in [
            reply(404, r#"{"settings":{"workflowSizeGuideline":"large"}}"#),
            reply(200, "not json"),
            reply(200, "null"),
            reply(200, "{}"),
            reply(200, "5"),
            reply(200, r#"{"settings":null}"#),
            FetchOutcome::Failed("offline".into()),
        ] {
            assert_eq!(workflow_size_answer(&outcome), None, "{outcome:?}");
        }
    }
}
