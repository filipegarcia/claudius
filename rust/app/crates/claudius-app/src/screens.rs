//! The content area. Every route is a placeholder naming its page and
//! parameters until its unit ports the screen; the chat shows the bound
//! session (or `ChatSurface`'s empty state).

use claudius_gpui_theme::fonts;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AnyElement, Context, Div, FontWeight, InteractiveElement as _, IntoElement, ParentElement as _,
    SharedString, StatefulInteractiveElement as _, Styled as _, div, px,
};

use crate::route::{Route, WorkspacePage};
use crate::shell::{Shell, focus_label};
use crate::ui::Colors;

pub(crate) fn screen(this: &Shell, c: &Colors, cx: &mut Context<Shell>) -> AnyElement {
    let route = this.state.route();
    let content = match route {
        Route::Workspace {
            page: WorkspacePage::Chat { .. },
            ..
        } => chat(this, c, cx),
        _ => placeholder(route, c),
    };
    div()
        .id("screen")
        .debug_selector(|| "screen".into())
        .flex()
        .flex_col()
        .flex_1()
        .min_h_0()
        .overflow_y_scroll()
        .child(content)
        .into_any_element()
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
    let bound_state = this.data.active_session_state(&ws.id);
    let views = state.tab_views(bound_state, this.now_year);
    let active = views.iter().find(|t| t.active);
    let Some(tab) = active else {
        let loading = !state.is_loaded(&ws.id);
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
    let session = state.sessions(&ws.id).iter().find(|s| s.id == tab.id);
    let title = session
        .and_then(|s| s.title.clone())
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
            session
                .and_then(|s| s.model.clone())
                .map(|m| row("model", m, c)),
        )
        .child(
            div()
                .pt(px(4.))
                .text_size(px(11.))
                .text_color(c.muted)
                .child("The transcript and composer land with U05/U06."),
        );
    centered().child(body).into_any_element()
}
