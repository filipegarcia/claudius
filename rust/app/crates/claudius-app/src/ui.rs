//! The shell's elements, laid out as the React app's: the title bar, the
//! workspace rail (`WorkspaceSwitcher.tsx`), the nav-icon rail
//! (`SideNav.tsx`), and the main column with the session tabs
//! (`SessionTabs.tsx`) over the screen. Sizes and colors are the Tailwind
//! classes' (`h-9`, `w-14`, `text-[11px]`, `bg-[var(--panel)]`, …).

use claudius_gpui_theme::{ThemeName, fonts, hsla};
use claudius_theme::{Rgba, Theme as Tokens, color, tailwind};
use gpui_kit::component::{Icon, tooltip::Tooltip};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AnyElement, App, Context, Div, ElementId, FontWeight, Hsla, InteractiveElement as _,
    IntoElement, MouseButton, ParentElement as _, SharedString, StatefulInteractiveElement as _,
    Styled, Window, WindowControlArea, assets::IconName, deferred, div, px,
};

use crate::data::TabStatus;
use crate::nav;
use crate::shell::Shell;
use crate::shortcuts::{self, Binding};
use crate::tabs::{TabView, short_id, shortcut_for_tab_index};

/// The claudius version the rail shows (`CLAUDIUS_VERSION_DISPLAY`: the
/// SDK's version from `package.json`, then the release, `0` locally).
pub const VERSION_DISPLAY: &str = "v0.3.327.0";

/// The palette's colors and the Tailwind steps the shell uses.
#[derive(Clone, Copy)]
pub(crate) struct Colors {
    pub background: Hsla,
    pub foreground: Hsla,
    pub panel: Hsla,
    pub panel_2: Hsla,
    pub border: Hsla,
    pub muted: Hsla,
    pub accent: Hsla,
    raw: [Rgba; 7],
}

impl Colors {
    pub fn of(name: ThemeName) -> Colors {
        let p = Tokens::of(name).palette;
        Colors {
            background: hsla(p.background),
            foreground: hsla(p.foreground),
            panel: hsla(p.panel),
            panel_2: hsla(p.panel_2),
            border: hsla(p.border),
            muted: hsla(p.muted),
            accent: hsla(p.accent),
            raw: [
                p.background,
                p.foreground,
                p.panel,
                p.panel_2,
                p.border,
                p.muted,
                p.accent,
            ],
        }
    }

    /// Tailwind's `/N` on a palette color (`bg-[var(--accent)]/15`).
    fn alpha(&self, c: Hsla, pct: f64) -> Hsla {
        let i = [
            self.background,
            self.foreground,
            self.panel,
            self.panel_2,
            self.border,
            self.muted,
            self.accent,
        ]
        .iter()
        .position(|x| *x == c)
        .expect("a palette color");
        hsla(color::with_opacity(self.raw[i], pct))
    }

    pub fn white() -> Hsla {
        Colors::step("white")
    }

    fn step(name: &str) -> Hsla {
        hsla(tailwind::color(name).unwrap_or_else(|| panic!("{name} is a Tailwind step")))
    }
}

fn icon(name: IconName, size: f32, color: Hsla) -> Icon {
    Icon::new(name).size(px(size)).text_color(color)
}

fn text_px<E: Styled>(size: f32) -> impl Fn(E) -> E {
    move |d: E| d.text_size(px(size)).line_height(px(size))
}

fn tooltip(text: String) -> impl Fn(&mut Window, &mut App) -> gpui_kit::AnyView {
    move |window, cx| Tooltip::new(text.clone()).build(window, cx)
}

fn chord(id: &str) -> Option<String> {
    shortcuts::binding_of(id).map(fmt)
}

fn fmt(b: Binding) -> String {
    shortcuts::format_binding(b, cfg!(target_os = "macos"))
}

/// The whole window.
pub(crate) fn shell(this: &Shell, window: &mut Window, cx: &mut Context<Shell>) -> AnyElement {
    let c = Colors::of(this.theme);
    let focus = this.state.effective_focus();
    let listed = this.state.is_listed();
    let body = div()
        .flex()
        .flex_1()
        .min_h_0()
        .when(listed && this.state.active_workspace().is_some(), |d| {
            d.when(focus.shows_workspace_rail(), |d| {
                d.child(workspace_rail(this, &c, cx))
            })
            .when(focus.shows_nav_rail(), |d| d.child(nav_rail(this, &c, cx)))
        })
        .child(main_column(this, &c, window, cx));
    div()
        .relative()
        .size_full()
        .flex()
        .flex_col()
        .bg(c.background)
        .text_color(c.foreground)
        .font_family(fonts::SANS)
        .child(title_bar(this, &c, cx))
        .child(body)
        .when_some(this.confirm(), |d, confirm| {
            d.child(confirm_dialog(&confirm.message, &c, cx))
        })
        .into_any_element()
}

/// `TitleBar.tsx`: 32px, `bg-[var(--panel-2)]`, "Claudius" centered, the
/// traffic lights in the left 78px. The native shell adds back / forward
/// (the browser's) and the appearance toggle.
fn title_bar(this: &Shell, c: &Colors, cx: &mut Context<Shell>) -> AnyElement {
    let nav_button = |id: &'static str, glyph: IconName, enabled: bool, tip: String| {
        div()
            .id(id)
            .debug_selector(move || id.into())
            .flex()
            .items_center()
            .justify_center()
            .size(px(22.))
            .rounded(px(4.))
            .when(enabled, |d| d.hover(|d| d.bg(c.panel)))
            .child(icon(
                glyph,
                14.,
                if enabled {
                    c.muted
                } else {
                    c.alpha(c.muted, 40.)
                },
            ))
            .tooltip(tooltip(tip))
    };
    let back = nav_button(
        "history-back",
        IconName::ArrowLeft,
        this.state.can_go_back(),
        format!("Back  {}", chord("history.back").unwrap_or_default()),
    )
    .on_click(cx.listener(|this, _, _, cx| this.update_state(cx, |s| s.back())));
    let forward = nav_button(
        "history-forward",
        IconName::ArrowRight,
        this.state.can_go_forward(),
        format!("Forward  {}", chord("history.forward").unwrap_or_default()),
    )
    .on_click(cx.listener(|this, _, _, cx| this.update_state(cx, |s| s.forward())));
    let theme_icon = match this.appearance() {
        crate::shell::Appearance::System => IconName::Monitor,
        crate::shell::Appearance::Fixed(n) if n.is_dark() => IconName::Moon,
        crate::shell::Appearance::Fixed(_) => IconName::Sun,
    };
    let appearance = nav_button(
        "appearance",
        theme_icon,
        true,
        format!(
            "{} (click to switch)  {}",
            this.appearance().label(),
            chord("view.appearance").unwrap_or_default()
        ),
    )
    .on_click(cx.listener(|this, _, window, cx| {
        let next = this.appearance().next();
        this.set_appearance(next, window, cx);
    }));
    div()
        .id("titlebar")
        .window_control_area(WindowControlArea::Drag)
        .on_click(|ev, window, _| {
            if ev.click_count() == 2 {
                window.titlebar_double_click();
            }
        })
        .flex()
        .flex_none()
        .items_center()
        .h(px(32.))
        .pl(px(78.))
        .pr(px(8.))
        .gap(px(4.))
        .border_b_1()
        .border_color(c.border)
        .bg(c.panel_2)
        .text_color(c.muted)
        .child(back)
        .child(forward)
        .child(
            div()
                .flex_1()
                .min_w_0()
                .text_center()
                .font_weight(FontWeight::MEDIUM)
                .map(text_px(11.))
                .child("Claudius"),
        )
        .child(appearance)
        .into_any_element()
}

// ---- the workspace rail ---------------------------------------------------

/// `WorkspaceSwitcher.tsx`'s desktop aside: `w-14`, `bg-[var(--background)]`.
fn workspace_rail(this: &Shell, c: &Colors, cx: &mut Context<Shell>) -> AnyElement {
    let state = &this.state;
    let active = state.active_workspace().map(|w| w.id.clone());
    let route_path = state.route().pathname();
    let tiles = state.workspaces().iter().enumerate().map(|(idx, w)| {
        let is_active = active.as_deref() == Some(w.id.as_str());
        let go = shortcuts::binding_of(&format!("workspace.go{}", idx + 1)).filter(|_| idx < 9);
        let mut title = vec![
            format!("{}{}", w.name, if is_active { " (active)" } else { "" }),
            w.root_path.clone(),
        ];
        if let Some(b) = go {
            title.push(format!("Shortcut: {}", fmt(b)));
        }
        let id = w.id.clone();
        let selector = format!("ws-{idx}");
        div()
            .id(ElementId::Name(format!("ws-tile-{}", w.id).into()))
            .debug_selector(move || selector.clone())
            .relative()
            .flex_none()
            .size(px(40.))
            .when(is_active, |d| {
                d.child(
                    // The Slack-style bar at the aside's left edge.
                    div()
                        .absolute()
                        .left(px(-8.))
                        .top(px(4.))
                        .w(px(4.))
                        .h(px(32.))
                        .rounded_r(px(4.))
                        .bg(c.accent),
                )
                .child(
                    // `ring-2 ring-[var(--accent)] ring-offset-2`.
                    div()
                        .absolute()
                        .left(px(-4.))
                        .top(px(-4.))
                        .size(px(48.))
                        .rounded(px(13.))
                        .border_2()
                        .border_color(c.accent),
                )
            })
            .when(!is_active, |d| d.opacity(0.8).hover(|d| d.opacity(1.)))
            .child(workspace_icon(w, 40.))
            .when_some(go.map(|_| idx + 1), |d, n| {
                d.child(
                    div()
                        .absolute()
                        .right(px(-2.))
                        .bottom(px(-2.))
                        .flex()
                        .items_center()
                        .justify_center()
                        .h(px(14.))
                        .min_w(px(14.))
                        .px(px(2.))
                        .rounded(px(4.))
                        .bg(c.panel_2)
                        .border_1()
                        .border_color(c.background)
                        .font_family(fonts::MONO)
                        .font_weight(FontWeight::SEMIBOLD)
                        .map(text_px(9.))
                        .text_color(c.foreground)
                        .child(n.to_string()),
                )
            })
            .tooltip(tooltip(title.join("\n")))
            .on_click(cx.listener(move |this, _, _, cx| {
                let id = id.clone();
                this.update_state(cx, |s| s.select_workspace(&id));
            }))
    });
    let system = nav::system_tiles().into_iter().map(|t| {
        let is_active = route_path.starts_with(t.prefix);
        let route = t.route.clone();
        let selector = format!("sys-{}", t.label);
        div()
            .id(ElementId::Name(format!("sys-{}", t.label).into()))
            .debug_selector(move || selector.clone())
            .flex()
            .flex_none()
            .items_center()
            .justify_center()
            .size(px(40.))
            .rounded(px(8.))
            .border_1()
            .border_color(if is_active {
                c.border
            } else {
                gpui_kit::transparent_black()
            })
            .when(is_active, |d| d.bg(c.panel_2))
            .when(!is_active, |d| d.hover(|d| d.bg(c.panel_2)))
            .child(icon(
                t.icon,
                16.,
                if is_active { c.foreground } else { c.muted },
            ))
            .tooltip(tooltip(t.label.into()))
            .on_click(cx.listener(move |this, _, _, cx| {
                let route = route.clone();
                this.update_state(cx, |s| s.navigate(route));
            }))
    });
    let cycle_hint = if state.workspaces().len() > 1 {
        let prev = chord("workspace.prev").unwrap_or_default();
        let next = chord("workspace.next").unwrap_or_default();
        Some(format!("{prev} {next}"))
    } else {
        None
    };
    let dim = c.alpha(c.muted, 60.);
    div()
        .id("workspace-rail")
        .debug_selector(|| "workspace-rail".into())
        .flex()
        .flex_col()
        .items_center()
        .flex_none()
        .h_full()
        .w(px(56.))
        .gap(px(8.))
        .py(px(12.))
        .border_r_1()
        .border_color(c.border)
        .bg(c.background)
        .children(tiles)
        .child(
            // The customizations drawer (U17): its tile, no drawer yet.
            div()
                .id("customizations")
                .flex()
                .flex_none()
                .items_center()
                .justify_center()
                .size(px(40.))
                .rounded(px(8.))
                .hover(|d| d.bg(c.panel_2))
                .child(icon(IconName::WandSparkles, 16., c.muted))
                .tooltip(tooltip("Customizations".into())),
        )
        .child(
            // "New workspace" (the form is U13's).
            div()
                .id("new-workspace")
                .mt(px(4.))
                .flex()
                .flex_none()
                .items_center()
                .justify_center()
                .size(px(40.))
                .rounded(px(8.))
                .border_1()
                .border_dashed()
                .border_color(c.border)
                .hover(|d| d.bg(c.panel_2))
                .child(icon(IconName::Plus, 16., c.muted))
                .tooltip(tooltip("New workspace".into())),
        )
        .child(div().mt(px(12.)).h(px(1.)).w(px(32.)).bg(c.border))
        .children(system)
        .child(
            div()
                .mt_auto()
                .pt(px(8.))
                .flex()
                .flex_col()
                .items_center()
                .gap(px(4.))
                .text_color(dim)
                .map(text_px(8.))
                .when_some(cycle_hint, |d, hint| d.child(div().px(px(4.)).child(hint)))
                .child(
                    div()
                        .id("claudius-version")
                        .flex()
                        .flex_col()
                        .items_center()
                        .px(px(4.))
                        .rounded(px(4.))
                        .hover(|d| d.text_color(c.foreground))
                        .whitespace_nowrap()
                        .child("claudius")
                        .child(div().font_family(fonts::MONO).child(VERSION_DISPLAY))
                        .tooltip(tooltip(format!("Claudius {VERSION_DISPLAY} · What's new"))),
                ),
        )
        .into_any_element()
}

/// `WorkspaceIcon.tsx`: a letter on its color (the radius is 22% of the
/// size); a customization shows the wand. An image icon draws its letter
/// until the icon route is wired (U04b).
pub(crate) fn workspace_icon(w: &crate::data::Workspace, size: f32) -> Div {
    let radius = (size * 0.22).round();
    let bg = match w.icon() {
        crate::data::WorkspaceIcon::Letter { color, .. } => parse_hex(&color),
        crate::data::WorkspaceIcon::Image { .. } => None,
    }
    .unwrap_or_else(|| hsla(Tokens::of(ThemeName::Dark).palette.accent));
    let white = Colors::white();
    let base = div()
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .size(px(size))
        .rounded(px(radius))
        .bg(bg)
        .text_color(white);
    if w.is_customization() {
        let s = (size * 0.55).round();
        return base.child(icon(IconName::WandSparkles, s, white));
    }
    base.font_weight(FontWeight::SEMIBOLD)
        .text_size(px((size * 0.5).round()))
        .child(w.letter())
}

fn parse_hex(s: &str) -> Option<Hsla> {
    color::parse(s).map(hsla)
}

// ---- the nav rail ---------------------------------------------------------

/// `SideNav.tsx`'s aside: `w-14`, `bg-[var(--panel)]`, the glyph, then the
/// tiles.
fn nav_rail(this: &Shell, c: &Colors, cx: &mut Context<Shell>) -> AnyElement {
    let route = this.state.route().clone();
    let items = this.state.nav_items();
    let tiles = items.into_iter().map(|it| {
        let active = nav::is_active(&it, &route);
        let tip = match chord(it.action_id) {
            Some(k) => format!("{}  {k}", it.label),
            None => it.label.into(),
        };
        let action = it.action_id;
        let selector = format!("nav-{}", it.action_id);
        div()
            .id(ElementId::Name(format!("nav-{}", it.action_id).into()))
            .debug_selector(move || selector.clone())
            .relative()
            .flex()
            .flex_none()
            .items_center()
            .justify_center()
            .size(px(36.))
            .rounded(px(6.))
            .border_1()
            .border_color(if active {
                c.alpha(c.accent, 40.)
            } else {
                gpui_kit::transparent_black()
            })
            .when(active, |d| {
                d.bg(c.alpha(c.accent, 15.)).child(
                    div()
                        .absolute()
                        .left(px(-12.))
                        .top(px(7.))
                        .w(px(4.))
                        .h(px(20.))
                        .rounded_r(px(4.))
                        .bg(c.accent),
                )
            })
            .when(!active, |d| d.hover(|d| d.bg(c.panel_2)))
            .child(icon(it.icon, 18., if active { c.accent } else { c.muted }))
            .tooltip(tooltip(tip))
            .on_click(cx.listener(move |this, _, _, cx| {
                this.update_state(cx, |s| s.nav(action));
            }))
    });
    div()
        .id("nav-rail")
        .debug_selector(|| "nav-rail".into())
        .flex()
        .flex_col()
        .items_center()
        .flex_none()
        .h_full()
        .w(px(56.))
        .gap(px(4.))
        .py(px(12.))
        .border_r_1()
        .border_color(c.border)
        .bg(c.panel)
        .child(
            // `AnimatedGlyph` at rest: 𐌂 on the accent.
            div()
                .mb(px(8.))
                .flex()
                .flex_none()
                .items_center()
                .justify_center()
                .size(px(32.))
                .rounded(px(6.))
                .bg(c.accent)
                .text_color(Colors::white())
                .text_size(px(16.))
                .child("\u{10302}"),
        )
        .children(tiles)
        .into_any_element()
}

// ---- the main column ------------------------------------------------------

fn main_column(
    this: &Shell,
    c: &Colors,
    window: &mut Window,
    cx: &mut Context<Shell>,
) -> AnyElement {
    let state = &this.state;
    let on_chat = state.on_chat() && state.active_workspace().is_some();
    div()
        .relative()
        .flex()
        .flex_col()
        .flex_1()
        .min_w_0()
        .h_full()
        .when(on_chat, |d| d.child(tab_strip(this, c, window, cx)))
        .child(crate::screens::screen(this, c, cx))
        .into_any_element()
}

/// `StatusDot`: running pulses the accent, needs-input pulses amber.
fn status_dot(status: TabStatus, c: &Colors) -> Div {
    let tone = match status {
        TabStatus::Running => c.accent,
        TabStatus::NeedsInput | TabStatus::Starting => Colors::step("amber-400"),
        TabStatus::Error => Colors::step("red-500"),
        TabStatus::Idle => Colors::step("emerald-400"),
        TabStatus::Background => c.alpha(c.muted, 60.),
    };
    div().flex_none().size(px(6.)).rounded_full().bg(tone)
}

/// `SessionTabs.tsx`: `h-9`, `bg-[var(--panel)]`, the tabs (the ones that
/// don't fit behind the chevron), `+`, the overflow menu, "Close all".
fn tab_strip(
    this: &Shell,
    c: &Colors,
    _window: &mut Window,
    cx: &mut Context<Shell>,
) -> AnyElement {
    let ws_id = this
        .state
        .active_workspace()
        .map(|w| w.id.clone())
        .unwrap_or_default();
    let bound_state = this.data.active_session_state(&ws_id);
    let views = this.state.tab_views(bound_state, this.now_year);
    let len = views.len();
    let label_w = this
        .state
        .strip(&ws_id)
        .map(|s| s.label_max_width())
        .unwrap_or(crate::data::TAB_LABEL_DEFAULT) as f32;
    let hidden = this.hidden_tabs().to_vec();
    let visible: Vec<(usize, TabView)> = views
        .iter()
        .cloned()
        .enumerate()
        .filter(|(_, t)| !hidden.contains(&t.id))
        .collect();
    let visible_ids: Vec<String> = visible.iter().map(|(_, t)| t.id.clone()).collect();
    let tabs = visible
        .into_iter()
        .map(|(i, t)| tab(&t, i, len, label_w, c, cx))
        .collect::<Vec<_>>();
    let new_tab = div()
        .id("tabs-new")
        .debug_selector(|| "tabs-new".into())
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .w(px(32.))
        .hover(|d| d.bg(c.alpha(c.panel_2, 60.)))
        .child(icon(IconName::Plus, 14., c.muted))
        .tooltip(tooltip("New session tab".into()))
        .on_click(cx.listener(|this, _, _, cx| this.update_state(cx, |s| s.new_tab())));
    let entity = cx.entity().downgrade();
    let strip = div()
        .flex()
        .flex_1()
        .min_w_0()
        .items_stretch()
        .gap(px(1.))
        .overflow_hidden()
        .children(tabs)
        .child(new_tab)
        .on_children_prepainted(move |bounds, _, cx| {
            let widths = visible_ids
                .iter()
                .zip(bounds.iter())
                .map(|(id, b)| (id.clone(), f32::from(b.size.width)))
                .collect();
            entity
                .update(cx, |this, cx| this.measured(None, widths, cx))
                .ok();
        });
    let entity = cx.entity().downgrade();
    let overflow = (!hidden.is_empty()).then(|| {
        let n = hidden.len();
        let open = this.overflow_open();
        div()
            .relative()
            .flex()
            .flex_none()
            .items_stretch()
            .border_l_1()
            .border_color(c.border)
            .child(
                div()
                    .id("tabs-overflow")
                    .debug_selector(|| "tabs-overflow".into())
                    .flex()
                    .items_center()
                    .gap(px(4.))
                    .px(px(8.))
                    .map(text_px(11.))
                    .text_color(if open { c.foreground } else { c.muted })
                    .when(open, |d| d.bg(c.alpha(c.panel_2, 60.)))
                    .hover(|d| d.bg(c.alpha(c.panel_2, 60.)))
                    .child(icon(IconName::ChevronDown, 12., c.muted))
                    .child(div().font_family(fonts::MONO).child(n.to_string()))
                    .tooltip(tooltip(format!(
                        "{n} hidden tab{}",
                        if n == 1 { "" } else { "s" }
                    )))
                    .on_click(cx.listener(|this, _, _, cx| this.toggle_overflow(cx))),
            )
            .when(open, |d| {
                d.child(overflow_menu(&views, &hidden, len, c, cx))
            })
    });
    let close_all = (len > 0).then(|| {
        div()
            .id("tabs-close-all")
            .debug_selector(|| "tabs-close-all".into())
            .flex()
            .flex_none()
            .items_center()
            .justify_center()
            .w(px(32.))
            .border_l_1()
            .border_color(c.border)
            .hover(|d| d.bg(c.alpha(c.panel_2, 60.)))
            .child(icon(IconName::SquareX, 14., c.muted))
            .tooltip(tooltip("Close all tabs".into()))
            .on_click(cx.listener(|this, _, _, cx| this.update_state(cx, |s| s.close_all_tabs())))
    });
    div()
        .on_children_prepainted(move |bounds, _, cx| {
            if let Some(first) = bounds.first() {
                let w = f32::from(first.size.width);
                entity
                    .update(cx, |this, cx| this.measured(Some(w), Vec::new(), cx))
                    .ok();
            }
        })
        .id("session-tabs")
        .debug_selector(|| "session-tabs".into())
        .flex()
        .flex_none()
        .items_stretch()
        .h(px(36.))
        .border_b_1()
        .border_color(c.border)
        .bg(c.panel)
        .child(strip)
        .children(overflow)
        .children(close_all)
        .into_any_element()
}

/// One tab. A pinned tab that isn't active is compact (its pin and
/// number).
fn tab(
    t: &TabView,
    idx: usize,
    len: usize,
    label_w: f32,
    c: &Colors,
    cx: &mut Context<Shell>,
) -> AnyElement {
    let shortcut = shortcut_for_tab_index(idx, len);
    let by_number = shortcuts::binding_of("tab.selectByNumber");
    let hint = match (shortcut, by_number) {
        (Some(n), Some(b)) => {
            let prefix = fmt(Binding { code: None, ..b });
            let prefix = prefix
                .strip_suffix("1…9")
                .or_else(|| prefix.strip_suffix("1-9"))
                .unwrap_or(&prefix)
                .to_owned();
            format!("\nShortcut: {prefix}{n}")
        }
        _ => String::new(),
    };
    let compact = t.compact();
    let id = t.id.clone();
    let close_id = t.id.clone();
    let pin_id = t.id.clone();
    let selector = format!("tab-{idx}");
    let close_selector = format!("tab-close-{idx}");
    let pin_selector = format!("tab-pin-{idx}");
    let number = || {
        shortcut.map(|n| {
            div()
                .flex_none()
                .font_family(fonts::MONO)
                .map(text_px(9.))
                .text_color(if t.active {
                    c.muted
                } else {
                    c.alpha(c.muted, 60.)
                })
                .child(n.to_string())
        })
    };
    let small_button = |id: ElementId, sel: String, glyph: IconName, color: Hsla| {
        div()
            .id(id)
            .debug_selector(move || sel.clone())
            .flex()
            .flex_none()
            .items_center()
            .justify_center()
            .size(px(16.))
            .rounded(px(4.))
            .hover(|d| d.bg(c.panel_2))
            .child(icon(glyph, 12., color))
    };
    let body = div()
        .flex()
        .min_w_0()
        .items_center()
        .gap(px(6.))
        .when(compact, |d| {
            d.child(icon(IconName::Pin, 10., c.accent))
                .children(number())
        })
        .when(!compact, |d| {
            d.child(status_dot(t.status, c)).children(number()).child(
                div()
                    .min_w_0()
                    .max_w(px(label_w))
                    .truncate()
                    .font_family(fonts::MONO)
                    .when(t.active, |d| d.font_weight(FontWeight::MEDIUM))
                    .child(t.label.clone()),
            )
        });
    let pin = (!compact).then(|| {
        small_button(
            ElementId::Name(format!("tab-pin-{}", t.id).into()),
            pin_selector,
            IconName::Pin,
            if t.pinned { c.accent } else { c.muted },
        )
        .tooltip(tooltip(
            if t.pinned { "Unpin tab" } else { "Pin tab" }.into(),
        ))
        .when(!t.pinned, |d| {
            d.opacity(0.).group_hover("tab", |s| s.opacity(1.))
        })
        .on_click(cx.listener(move |this, _, _, cx| {
            cx.stop_propagation();
            let id = pin_id.clone();
            this.update_state(cx, |s| s.toggle_pin(&id));
        }))
    });
    let close = (!compact).then(|| {
        small_button(
            ElementId::Name(format!("tab-close-{}", t.id).into()),
            close_selector,
            IconName::X,
            c.muted,
        )
        .tooltip(tooltip("Close tab".into()))
        .when(!t.active, |d| {
            d.opacity(0.).group_hover("tab", |s| s.opacity(1.))
        })
        .on_click(cx.listener(move |this, _, _, cx| {
            cx.stop_propagation();
            let id = close_id.clone();
            this.update_state(cx, |s| s.close_tab(&id));
        }))
    });
    div()
        .id(ElementId::Name(format!("tab-{}", t.id).into()))
        .debug_selector(move || selector.clone())
        .group("tab")
        .relative()
        .flex()
        .flex_none()
        .items_center()
        .gap(px(6.))
        .px(px(if compact { 6. } else { 8. }))
        .border_r_1()
        .border_color(c.border)
        .map(text_px(11.))
        .when(t.active, |d| {
            d.bg(c.panel_2).text_color(c.foreground).child(
                // `before:h-[2px] before:bg-[var(--accent)]`.
                div()
                    .absolute()
                    .top_0()
                    .left_0()
                    .right_0()
                    .h(px(2.))
                    .bg(c.accent),
            )
        })
        .when(!t.active, |d| {
            d.bg(c.alpha(c.panel, 40.))
                .text_color(c.muted)
                .hover(|d| d.bg(c.alpha(c.panel_2, 60.)))
        })
        .child(body)
        .children(pin)
        .children(close)
        .tooltip(tooltip(format!(
            "{}\n{}{hint}",
            if t.label.is_empty() {
                short_id(&t.id)
            } else {
                t.label.clone()
            },
            t.status.as_str()
        )))
        .on_mouse_down(MouseButton::Middle, {
            let id = t.id.clone();
            cx.listener(move |this, _, _, cx| {
                let id = id.clone();
                this.update_state(cx, |s| s.close_tab(&id));
            })
        })
        .on_click(cx.listener(move |this, _, _, cx| {
            let id = id.clone();
            this.update_state(cx, |s| s.select_tab(&id));
        }))
        .into_any_element()
}

/// The hidden tabs' popover (`w-72`, under the chevron, right-aligned).
fn overflow_menu(
    views: &[TabView],
    hidden: &[String],
    len: usize,
    c: &Colors,
    cx: &mut Context<Shell>,
) -> AnyElement {
    let rows = views
        .iter()
        .enumerate()
        .filter(|(_, t)| hidden.contains(&t.id))
        .map(|(i, t)| {
            let id = t.id.clone();
            let close_id = t.id.clone();
            let pin_id = t.id.clone();
            let selector = format!("overflow-{i}");
            let shortcut = shortcut_for_tab_index(i, len);
            div()
                .id(ElementId::Name(format!("overflow-{}", t.id).into()))
                .debug_selector(move || selector.clone())
                .flex()
                .items_center()
                .gap(px(8.))
                .w_full()
                .px(px(12.))
                .py(px(6.))
                .map(text_px(11.))
                .hover(|d| d.bg(c.panel_2))
                .child(status_dot(t.status, c))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .font_family(fonts::MONO)
                        .child(t.label.clone()),
                )
                .when_some(shortcut, |d, n| {
                    let prefix = shortcuts::binding_of("tab.selectByNumber")
                        .map(|b| fmt(Binding { code: None, ..b }))
                        .unwrap_or_default();
                    let prefix = prefix
                        .strip_suffix("1…9")
                        .or_else(|| prefix.strip_suffix("1-9"))
                        .unwrap_or(&prefix)
                        .to_owned();
                    d.child(
                        div()
                            .flex_none()
                            .font_family(fonts::MONO)
                            .map(text_px(9.))
                            .text_color(c.alpha(c.muted, 70.))
                            .child(format!("{prefix}{n}")),
                    )
                })
                .child(
                    div()
                        .id(ElementId::Name(format!("overflow-pin-{}", t.id).into()))
                        .debug_selector({
                            let sel = format!("overflow-pin-{i}");
                            move || sel.clone()
                        })
                        .flex()
                        .flex_none()
                        .items_center()
                        .justify_center()
                        .size(px(16.))
                        .rounded(px(4.))
                        .hover(|d| d.bg(c.panel))
                        .child(icon(
                            IconName::Pin,
                            12.,
                            if t.pinned { c.accent } else { c.muted },
                        ))
                        .tooltip(tooltip(
                            if t.pinned { "Unpin tab" } else { "Pin tab" }.into(),
                        ))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            cx.stop_propagation();
                            let id = pin_id.clone();
                            // The menu stays open (the button stops the
                            // row's click, which would close it).
                            this.update_state(cx, |s| s.toggle_pin(&id));
                            this.overflow_open = true;
                        })),
                )
                .child(
                    div()
                        .id(ElementId::Name(format!("overflow-close-{}", t.id).into()))
                        .debug_selector({
                            let sel = format!("overflow-close-{i}");
                            move || sel.clone()
                        })
                        .flex()
                        .flex_none()
                        .items_center()
                        .justify_center()
                        .size(px(16.))
                        .rounded(px(4.))
                        .hover(|d| d.bg(c.panel))
                        .child(icon(IconName::X, 12., c.muted))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            cx.stop_propagation();
                            let id = close_id.clone();
                            this.update_state(cx, |s| s.close_tab(&id));
                            this.overflow_open = true;
                        })),
                )
                .on_click(cx.listener(move |this, _, _, cx| {
                    let id = id.clone();
                    this.update_state(cx, |s| s.select_tab(&id));
                }))
        });
    deferred(
        div()
            .id("tabs-overflow-menu")
            .occlude()
            .absolute()
            .right_0()
            .top_full()
            .mt(px(1.))
            .w(px(288.))
            .rounded(px(6.))
            .border_1()
            .border_color(c.border)
            .bg(c.panel)
            .shadow_2xl()
            .overflow_hidden()
            .child(
                div()
                    .px(px(12.))
                    .py(px(6.))
                    .border_b_1()
                    .border_color(c.border)
                    .map(text_px(10.))
                    .text_color(c.muted)
                    .child(format!("Hidden tabs ({})", hidden.len()).to_uppercase()),
            )
            .children(rows)
            .on_mouse_down_out(cx.listener(|this, _, _, cx| {
                this.overflow_open = false;
                cx.notify();
            })),
    )
    .with_priority(1)
    .into_any_element()
}

/// "Close all tabs"' question (the React app's `confirm()`), in the window.
fn confirm_dialog(message: &str, c: &Colors, cx: &mut Context<Shell>) -> AnyElement {
    let button = |id: &'static str, label: &'static str, primary: bool| {
        div()
            .id(id)
            .debug_selector(move || id.into())
            .px(px(12.))
            .py(px(6.))
            .rounded(px(6.))
            .border_1()
            .border_color(c.border)
            .text_size(px(12.))
            .when(primary, |d| {
                d.bg(c.accent)
                    .text_color(Colors::white())
                    .border_color(c.accent)
            })
            .when(!primary, |d| d.bg(c.panel).hover(|d| d.bg(c.panel_2)))
            .child(label)
    };
    div()
        .id("confirm")
        .absolute()
        .inset_0()
        .flex()
        .items_center()
        .justify_center()
        .bg(hsla(color::with_opacity(
            tailwind::color("black").expect("black"),
            40.,
        )))
        .occlude()
        .child(
            div()
                .w(px(380.))
                .p(px(16.))
                .rounded(px(8.))
                .border_1()
                .border_color(c.border)
                .bg(c.panel)
                .shadow_2xl()
                .flex()
                .flex_col()
                .gap(px(12.))
                .child(
                    div()
                        .text_size(px(13.))
                        .child(SharedString::from(message.to_owned())),
                )
                .child(
                    div()
                        .flex()
                        .justify_end()
                        .gap(px(8.))
                        .child(
                            button("confirm-no", "Cancel", false).on_click(
                                cx.listener(|this, _, _, cx| this.answer_confirm(false, cx)),
                            ),
                        )
                        .child(
                            button("confirm-yes", "OK", true).on_click(
                                cx.listener(|this, _, _, cx| this.answer_confirm(true, cx)),
                            ),
                        ),
                ),
        )
        .into_any_element()
}
