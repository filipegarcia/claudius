//! The content area. Every route is a placeholder naming its page and
//! parameters until its unit ports the screen; the chat shows the bound
//! session's transcript (claudius-chat's `TranscriptView`), or
//! `ChatSurface`'s empty state; over a live chat whose transcript no
//! source holds yet, its state: ready, the turn,
//! the stream and its reconnect badge (`StatusLine`'s "Reconnecting"),
//! "Catching up…", the errors.

use claudius_gpui_theme::fonts;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AnyElement, Context, Div, FontWeight, InteractiveElement as _, IntoElement, ParentElement as _,
    SharedString, StatefulInteractiveElement as _, Styled as _, div, px,
};

use gpui_kit::assets::IconName;
use serde_json::Value;

use crate::route::{Route, WorkspacePage};
use crate::shell::{Shell, focus_label};
use crate::ui::{Colors, icon};

pub(crate) fn screen(this: &Shell, c: &Colors, cx: &mut Context<Shell>) -> AnyElement {
    let route = this.state.route();
    let scrolls_itself = matches!(
        route,
        Route::Workspace {
            page: WorkspacePage::Chat { .. } | WorkspacePage::Files { .. },
            ..
        }
    );
    let content = match route {
        Route::Workspace {
            page: WorkspacePage::Chat { .. },
            ..
        } => with_status_line(this, chat(this, c, cx)),
        Route::Workspace {
            page: WorkspacePage::Sessions | WorkspacePage::Session { .. },
            ..
        } => crate::sessions::view::element(this).unwrap_or_else(|| placeholder(route, c)),
        Route::Workspace {
            page: WorkspacePage::Files { .. },
            ..
        } => crate::files::element(this).unwrap_or_else(|| placeholder(route, c)),
        _ => placeholder(route, c),
    };
    // The transcript scrolls itself (a virtualized list), the Files page
    // its tree and its pane.
    div()
        .id("screen")
        .debug_selector(|| "screen".into())
        .flex()
        .flex_col()
        .flex_1()
        .min_h_0()
        .when(!scrolls_itself, |d| d.overflow_y_scroll())
        .child(content)
        .into_any_element()
}

/// `StatusLine` over the chat (ChatSurface.tsx:2428): over a live chat,
/// once a tab is open (the empty state has none).
fn with_status_line(this: &Shell, chat: AnyElement) -> AnyElement {
    let ws = this.state.active_workspace().map(|w| w.id.as_str());
    let mounted = this
        .live_chat()
        .is_some_and(|l| Some(l.workspace_id()) == ws);
    match this
        .status_view()
        .filter(|_| mounted && this.chat_tab().is_some())
    {
        Some(status) => div()
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .size_full()
            .child(status)
            .child(chat)
            .into_any_element(),
        None => chat,
    }
}

fn row(key: &str, value: impl Into<SharedString>, c: &Colors) -> Div {
    div()
        .flex()
        .gap(px(12.))
        .text_size(px(12.))
        .child(
            div()
                .w(px(96.))
                .flex_none()
                .text_color(c.muted)
                .child(key.to_owned()),
        )
        .child(
            div()
                .min_w_0()
                .font_family(fonts::MONO)
                .text_color(c.foreground)
                .child(value.into()),
        )
}

fn card(c: &Colors) -> Div {
    div()
        .w(px(520.))
        .max_w_full()
        .p(px(20.))
        .rounded(px(8.))
        .border_1()
        .border_color(c.border)
        .bg(c.panel)
        .flex()
        .flex_col()
        .gap(px(8.))
}

fn centered() -> Div {
    div()
        .flex()
        .flex_1()
        .items_center()
        .justify_center()
        .p(px(24.))
}

/// The page that isn't ported yet: its name, path and parameters.
fn placeholder(route: &Route, c: &Colors) -> AnyElement {
    let params = route.params();
    let body = card(c)
        .debug_selector(|| "placeholder".into())
        .child(
            div()
                .text_size(px(18.))
                .font_weight(FontWeight::SEMIBOLD)
                .child(route.title()),
        )
        .child(row("route", route.path(), c))
        .when(params.is_empty(), |d| d.child(row("params", "none", c)))
        .children(params.into_iter().map(|(k, v)| row(k, v, c)))
        .child(
            div()
                .pt(px(4.))
                .text_size(px(11.))
                .text_color(c.muted)
                .child("This screen is a placeholder until its unit ports it."),
        );
    centered().child(body).into_any_element()
}

/// The chat: the bound session's id, title and status, or the empty state.
fn chat(this: &Shell, c: &Colors, cx: &mut Context<Shell>) -> AnyElement {
    let state = &this.state;
    let Some(ws) = state.active_workspace() else {
        return placeholder(state.route(), c);
    };
    let bound_state = this.bound_state(&ws.id);
    let views = state.tab_views(bound_state, this.now_year);
    let active = views.iter().find(|t| t.active);
    let live = this
        .live_chat()
        .filter(|c| c.workspace_id() == ws.id)
        .map(|c| c.state());
    let Some(tab) = active else {
        let create_error = live.as_ref().and_then(|l| l.create_error.clone());
        // A live chat that hasn't bound yet is still booting.
        let loading = !state.is_loaded(&ws.id)
            || live
                .as_ref()
                .is_some_and(|l| l.session_id.is_none() && l.create_error.is_none());
        return centered()
            .child(
                div()
                    .debug_selector(|| "chat-empty".into())
                    .flex()
                    .flex_col()
                    .items_center()
                    .gap(px(8.))
                    .child(
                        div()
                            .text_size(px(24.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("Claudius"),
                    )
                    .child(
                        div()
                            .text_size(px(13.))
                            .text_color(c.muted)
                            .child(if loading {
                                "Loading session…"
                            } else {
                                "No session open."
                            }),
                    )
                    .children(create_error.map(|e| {
                        div()
                            .debug_selector(|| "chat-create-error".into())
                            .max_w(px(520.))
                            .text_size(px(12.))
                            .text_color(Colors::step("red-400"))
                            .child(e)
                    }))
                    .when(!loading, |d| {
                        d.child(
                            div()
                                .id("chat-new-session")
                                .debug_selector(|| "chat-new-session".into())
                                .mt(px(8.))
                                .px(px(12.))
                                .py(px(6.))
                                .rounded(px(6.))
                                .bg(c.accent)
                                .text_color(Colors::white())
                                .text_size(px(13.))
                                .child("+ New session")
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.update_state(cx, |s| s.new_tab())
                                })),
                        )
                    }),
            )
            .into_any_element();
    };
    // The bound session's transcript (U05): over the fixture always (a
    // session it doesn't hold shows the splash), over a live chat when the
    // transcripts' source has it, over the composer (U07). Its prompt
    // cards (U08a): the plan-mode banner above, the live ask below the
    // transcript (MessageList's last row), the modal cards over the pane.
    if !state.is_live_chat() || this.has_transcript(&tab.id) {
        let transcript = this.chat_view(&tab.id);
        let prompts = this.chat_prompts(&tab.id);
        return div()
            .debug_selector(|| "chat-session".into())
            .relative()
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .size_full()
            .children(prompts.as_ref().map(|p| p.banner.clone()))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_h_0()
                    .children(transcript),
            )
            .children(prompts.as_ref().map(|p| p.inline.clone()))
            .children(this.composer())
            .children(prompts.map(|p| p.overlays))
            .into_any_element();
    }
    let session = state.sessions(&ws.id).iter().find(|s| s.id == tab.id);
    // The bound session's live title (`session.sessionTitle`) first.
    let live_bound = live
        .as_ref()
        .filter(|l| l.session_id.as_deref() == Some(tab.id.as_str()));
    let title = live_bound
        .and_then(|l| l.session_title.as_str())
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_owned)
        .or_else(|| session.and_then(|s| s.title.clone()))
        .or_else(|| {
            state
                .strip(&ws.id)
                .and_then(|s| s.saved_title(&tab.id))
                .map(str::to_owned)
        })
        .unwrap_or_else(|| "(untitled)".into());
    let route = state.route();
    let body = card(c)
        .debug_selector(|| "chat-session".into())
        .child(
            div()
                .text_size(px(11.))
                .text_color(c.muted)
                .child("CHAT · SESSION"),
        )
        .child(
            div()
                .text_size(px(18.))
                .font_weight(FontWeight::SEMIBOLD)
                .child(title),
        )
        .child(row("session", tab.id.clone(), c))
        .child(row("tab label", tab.label.clone(), c))
        .child(row("status", tab.status.as_str(), c))
        .child(row("workspace", format!("{} ({})", ws.name, ws.id), c))
        .child(row("cwd", ws.root_path.clone(), c))
        .child(row("route", route.path(), c))
        .child(row("focus", focus_label(state.focus()), c))
        .children(
            live_bound
                .and_then(|l| l.model.as_str().map(str::to_owned))
                .or_else(|| session.and_then(|s| s.model.clone()))
                .map(|m| row("model", m, c)),
        )
        .children(live.as_ref().map(|l| live_rows(l, live_bound.is_some(), c)))
        .child(
            div()
                .pt(px(4.))
                .text_size(px(11.))
                .text_color(c.muted)
                .child("No transcript source holds this session yet."),
        );
    centered().child(body).into_any_element()
}

fn yes_no(b: bool) -> &'static str {
    if b { "yes" } else { "no" }
}

/// The live chat's own state under the session's rows.
fn live_rows(l: &claudius_client::state::ChatState, bound: bool, c: &Colors) -> Div {
    let amber = Colors::step("amber-300");
    let reconnecting = l.stream_status == "reconnecting";
    let last_error = l.errors.last().map(|e| match e {
        Value::String(s) => s.clone(),
        Value::Null => "(no message)".into(),
        other => other.to_string(),
    });
    div()
        .debug_selector(|| "chat-live".into())
        .flex()
        .flex_col()
        .gap(px(8.))
        .pt(px(8.))
        .border_t_1()
        .border_color(c.border)
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(8.))
                .child(
                    div()
                        .text_size(px(11.))
                        .text_color(c.muted)
                        .child("LIVE · useSession"),
                )
                .when(reconnecting, |d| {
                    // `StatusLine`'s badge.
                    d.child(
                        div()
                            .debug_selector(|| "chat-reconnecting".into())
                            .flex()
                            .items_center()
                            .gap(px(4.))
                            .px(px(6.))
                            .py(px(2.))
                            .rounded(px(4.))
                            .border_1()
                            .border_color(gpui_kit::Hsla {
                                a: 0.4,
                                ..Colors::step("amber-500")
                            })
                            .bg(gpui_kit::Hsla {
                                a: 0.1,
                                ..Colors::step("amber-500")
                            })
                            .font_family(fonts::MONO)
                            .text_size(px(10.))
                            .text_color(Colors::step("amber-200"))
                            .child(icon(IconName::WifiOff, 12., Colors::step("amber-200")))
                            .child("Reconnecting"),
                    )
                }),
        )
        .child(row(
            "bound",
            l.session_id.clone().unwrap_or_else(|| "(none)".into()),
            c,
        ))
        .child(row("ready", yes_no(l.ready), c))
        .child(row("pending", yes_no(l.pending), c))
        .child(row("stream", l.stream_status, c))
        .when(l.catching_up, |d| d.child(row("catching up", "yes", c)))
        .child(row("messages", l.messages.len().to_string(), c))
        .when(l.needs_input, |d| d.child(row("needs input", "yes", c)))
        .children(last_error.map(|e| row("error", format!("{} · {e}", l.errors.len()), c)))
        .when(bound && l.pending, |d| {
            // `MessageList`'s working row.
            d.child(
                div()
                    .debug_selector(|| "chat-working".into())
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .text_size(px(12.))
                    .child(if reconnecting {
                        icon(IconName::WifiOff, 14., amber)
                    } else {
                        icon(IconName::LoaderCircle, 14., c.accent)
                    })
                    .child(if reconnecting {
                        "Disconnected — reconnecting…"
                    } else {
                        "Claude is working…"
                    }),
            )
        })
        .when(bound && l.catching_up && !l.pending, |d| {
            d.child(
                div()
                    .debug_selector(|| "chat-catching-up".into())
                    .text_size(px(12.))
                    .text_color(c.muted)
                    .child(if reconnecting {
                        "Disconnected — reconnecting…"
                    } else {
                        "Catching up…"
                    }),
            )
        })
}
