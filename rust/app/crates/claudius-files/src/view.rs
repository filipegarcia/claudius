//! [`FilesScreen`]: the Files page on screen over a [`FilesData`]. The
//! shell keeps one, tells it the route ([`FilesScreen::sync_route`], each
//! frame) and draws it as the content area on `/<ws>/files`; it asks the
//! shell for URL replaces, links and `localStorage` writes with
//! [`FilesEvent`]s.
//!
//! The layout is page.tsx's: the header (← Chat, the workspace's root, the
//! extra roots' badge, the filename search, new file / folder), the error
//! line, the tree column (one tree, or a group per root, page.tsx:397-473)
//! and the pane (page.tsx:475-588: the file's bar with rename / delete /
//! Save, the read-only notice, the highlighted editor or the binary
//! placeholder). `prompt()` and `confirm()` are an in-window dialog.
//!
//! The React page has FindInFile and FindInFolder but renders neither; the
//! native page mounts them where their docs say: ⌘F (or the bar's search
//! button) opens find in file over the editor, and ⌘⇧F, the header's
//! folder-search button or a folder's context menu opens find in folder in
//! place of the pane. A binary image shows its picture (the route's
//! `serve=1`, as the chat's previews) where the TS shows the placeholder.

use std::sync::Arc;
use std::time::Duration;

use claudius_gpui_theme::{ThemeName, fonts, hsla, icons};
use claudius_theme::{Rgba, Theme as Tokens, color, tailwind};
use gpui_kit::component::Icon;
use gpui_kit::component::input::{
    Editor, EditorState, Escape as InputEscape, Input, InputEvent, InputState, Position,
};
use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AnyElement, App, AppContext as _, Context, Div, ElementId, Entity, EventEmitter, FocusHandle,
    Focusable, FontWeight, Hsla, Image, ImageFormat, InteractiveElement as _, IntoElement,
    KeyBinding, MouseButton, ParentElement as _, Render, SharedString,
    StatefulInteractiveElement as _, Styled, Subscription, Window, anchored, deferred, div, img,
    point, px,
};

use crate::data::{FilesData, NewKind};
use crate::model::{
    Answer, Busy, Call, Dialog, Effect, FilesPage, Pane, Request, TreeBody, TreeRow,
};
use crate::rules::{self, KeyEvent};

gpui_kit::actions!(files, [OpenFind, OpenFolderFind, Dismiss]);

/// The screen's key context.
pub const CONTEXT: &str = "FilesScreen";

/// ⌘F / Ctrl+F find in file, ⌘⇧F / Ctrl+Shift+F find in folder, Escape
/// closes the menu, the dialog or a find panel.
pub fn bind(cx: &mut App) {
    let (find, folder) = if cfg!(target_os = "macos") {
        ("cmd-f", "cmd-shift-f")
    } else {
        ("ctrl-f", "ctrl-shift-f")
    };
    cx.bind_keys([
        KeyBinding::new(find, OpenFind, Some(CONTEXT)),
        KeyBinding::new(folder, OpenFolderFind, Some(CONTEXT)),
        KeyBinding::new("escape", Dismiss, Some(CONTEXT)),
    ]);
}

/// What the page asks of the shell.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FilesEvent {
    /// `router.replace(url)`.
    ReplaceUrl(String),
    /// A link (`<Link href>`): open the URL.
    OpenUrl(String),
    /// `localStorage.setItem` (`None`: `removeItem`).
    Store { key: String, value: Option<String> },
}

impl EventEmitter<FilesEvent> for FilesScreen {}

impl Focusable for FilesScreen {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

/// What the shell tells the screen each frame.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RouteInfo {
    /// Whether the route is the Files page.
    pub on_files: bool,
    /// The active workspace: its id and root path.
    pub workspace: Option<(String, String)>,
    pub root: Option<String>,
    pub path: Option<String>,
    /// `localStorage`'s last-open entry for the workspace.
    pub last_open: Option<String>,
    pub theme: ThemeName,
}

/// The palette's colors.
#[derive(Clone, Copy)]
struct Colors {
    background: Hsla,
    foreground: Hsla,
    panel: Hsla,
    panel_2: Hsla,
    border: Hsla,
    muted: Hsla,
    accent: Hsla,
    accent_raw: Rgba,
    panel_2_raw: Rgba,
}

impl Colors {
    fn of(name: ThemeName) -> Colors {
        let p = Tokens::of(name).palette;
        Colors {
            background: hsla(p.background),
            foreground: hsla(p.foreground),
            panel: hsla(p.panel),
            panel_2: hsla(p.panel_2),
            border: hsla(p.border),
            muted: hsla(p.muted),
            accent: hsla(p.accent),
            accent_raw: p.accent,
            panel_2_raw: p.panel_2,
        }
    }
}

/// A Tailwind step at an opacity (`bg-red-500/10`).
fn tw(name: &str, pct: f64) -> Hsla {
    let c = tailwind::color(name).unwrap_or_else(|| panic!("{name} is a Tailwind step"));
    if pct >= 100. {
        hsla(c)
    } else {
        hsla(color::with_opacity(c, pct))
    }
}

fn alpha(c: Rgba, pct: f64) -> Hsla {
    hsla(color::with_opacity(c, pct))
}

fn icon(react: &str, size: f32, color: Hsla) -> Icon {
    let name = icons::icon(react).unwrap_or_else(|| panic!("{react} is a mapped icon"));
    Icon::new(name).size(px(size)).text_color(color)
}

fn tooltip(text: String) -> impl Fn(&mut Window, &mut App) -> gpui_kit::AnyView {
    move |window, cx| Tooltip::new(text.clone()).build(window, cx)
}

fn sel(s: impl Into<String>) -> impl Fn() -> String {
    let s = s.into();
    move || s.clone()
}

/// An icon button (`h-6 w-6 rounded`).
fn icon_button(id: impl Into<String>, c: &Colors) -> gpui_kit::Stateful<Div> {
    icon_button_over(id, c.panel_2)
}

/// An icon button with its own hover background.
fn icon_button_over(id: impl Into<String>, hover: Hsla) -> gpui_kit::Stateful<Div> {
    let id = id.into();
    div()
        .id(ElementId::Name(id.clone().into()))
        .debug_selector(sel(id))
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .size(px(24.))
        .rounded(px(4.))
        .hover(move |d| d.bg(hover))
}

/// HighlightedEditor.tsx:61 / :71 paints the file on `var(--background)`.
/// claudius-gpui-theme gives code editors the chat block's `#0a0a0a` on
/// every palette, and gpui-component draws an editor's plain text in the
/// theme's foreground: on a light palette, dark text on black. So while the
/// page shows, code editors (only this page has one) paint on the
/// palette's background, as the TS's does; checked each frame, since a
/// theme change re-applies the highlight style.
fn paint_editors_on_background(theme: ThemeName, cx: &mut App) {
    let want = Some(hsla(Tokens::of(theme).palette.background));
    let t = gpui_kit::component::Theme::global_mut(cx);
    if t.highlight_theme.style.editor_background != want {
        let mut h = (*t.highlight_theme).clone();
        h.style.editor_background = want;
        t.highlight_theme = Arc::new(h);
    }
}

fn image_format(content_type: &str, path: &str) -> Option<ImageFormat> {
    let mime = content_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    let ext = path
        .rsplit('.')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    match (mime.as_str(), ext.as_str()) {
        ("image/png", _) | (_, "png") => Some(ImageFormat::Png),
        ("image/jpeg", _) | (_, "jpg" | "jpeg") => Some(ImageFormat::Jpeg),
        ("image/webp", _) | (_, "webp") => Some(ImageFormat::Webp),
        ("image/gif", _) | (_, "gif") => Some(ImageFormat::Gif),
        ("image/bmp", _) | (_, "bmp") => Some(ImageFormat::Bmp),
        ("image/tiff", _) | (_, "tif" | "tiff") => Some(ImageFormat::Tiff),
        ("image/svg+xml", _) | (_, "svg") => Some(ImageFormat::Svg),
        _ => None,
    }
}

/// The Files page.
pub struct FilesScreen {
    data: Arc<dyn FilesData>,
    page: FilesPage,
    mounted: bool,
    theme: ThemeName,
    focus: FocusHandle,
    search: Entity<InputState>,
    find_input: Entity<InputState>,
    folder_input: Entity<InputState>,
    dialog_input: Entity<InputState>,
    editor: Option<Entity<EditorState>>,
    editor_seq: u64,
    reveal_seq: u64,
    image: Option<(u64, Arc<Image>)>,
    dialog_shown: bool,
    find_shown: bool,
    folder_shown: bool,
    editor_sub: Option<Subscription>,
    _subscriptions: Vec<Subscription>,
}

impl FilesScreen {
    pub fn new(data: Arc<dyn FilesData>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let search = cx.new(|cx| {
            InputState::new(window, cx).placeholder("Search files (incl. nested folders)")
        });
        let find_input = cx.new(|cx| InputState::new(window, cx).placeholder("Find in file"));
        let folder_input = cx.new(|cx| InputState::new(window, cx));
        let dialog_input = cx.new(|cx| InputState::new(window, cx));
        let subs = vec![
            cx.subscribe(&search, |this: &mut Self, input, ev: &InputEvent, cx| {
                if matches!(ev, InputEvent::Change) {
                    let q = input.read(cx).value().to_string();
                    if q != this.page.query {
                        let fx = this.page.set_query(&q);
                        this.run(fx, cx);
                    }
                }
            }),
            cx.subscribe(
                &find_input,
                |this: &mut Self, input, ev: &InputEvent, cx| {
                    match ev {
                        // A Change that leaves the text as it was (the input
                        // emits one after Enter) isn't React's onChange.
                        InputEvent::Change => {
                            let q = input.read(cx).value().to_string();
                            if this.page.find.as_ref().is_some_and(|f| f.query == q) {
                                return;
                            }
                            this.page.set_find_query(&q);
                        }
                        InputEvent::PressEnter { shift, .. } => this.page.find_step(!shift),
                        _ => return,
                    }
                    cx.notify();
                },
            ),
            cx.subscribe(
                &folder_input,
                |this: &mut Self, input, ev: &InputEvent, cx| {
                    if matches!(ev, InputEvent::Change) {
                        let q = input.read(cx).value().to_string();
                        let fx = this.page.set_folder_query(&q);
                        this.run(fx, cx);
                    }
                },
            ),
            cx.subscribe(
                &dialog_input,
                |this: &mut Self, input, ev: &InputEvent, cx| {
                    if let InputEvent::PressEnter { .. } = ev {
                        let v = input.read(cx).value().to_string();
                        let fx = this.page.confirm_dialog(&v);
                        this.run(fx, cx);
                    }
                },
            ),
        ];
        FilesScreen {
            data,
            page: FilesPage::new(),
            mounted: false,
            theme: ThemeName::Dark,
            focus: cx.focus_handle(),
            search,
            find_input,
            folder_input,
            dialog_input,
            editor: None,
            editor_seq: 0,
            reveal_seq: 0,
            image: None,
            dialog_shown: false,
            find_shown: false,
            folder_shown: false,
            editor_sub: None,
            _subscriptions: subs,
        }
    }

    /// The page's state.
    pub fn page(&self) -> &FilesPage {
        &self.page
    }

    /// The editor, while a text file shows.
    pub fn editor(&self) -> Option<&Entity<EditorState>> {
        self.editor.as_ref()
    }

    /// Runs a handler of the page and its effects (tests, screenshots).
    pub fn act(&mut self, cx: &mut Context<Self>, f: impl FnOnce(&mut FilesPage) -> Vec<Effect>) {
        let fx = f(&mut self.page);
        self.run(fx, cx);
    }

    /// The route, each frame: mounts the page on arriving (the workspace,
    /// the URL, the last-open entry), passes later URL changes, unmounts on
    /// leaving.
    pub fn sync_route(&mut self, info: RouteInfo, window: &mut Window, cx: &mut Context<Self>) {
        if info.theme != self.theme {
            self.theme = info.theme;
            cx.notify();
        }
        if info.on_files {
            paint_editors_on_background(info.theme, cx);
        }
        if !info.on_files {
            if self.mounted {
                self.mounted = false;
                self.page = FilesPage::new();
                self.editor = None;
                self.editor_sub = None;
                self.image = None;
                cx.notify();
            }
            return;
        }
        if !self.mounted || self.page.workspace != info.workspace {
            self.mounted = true;
            self.editor = None;
            self.editor_sub = None;
            self.image = None;
            self.search.update(cx, |s, cx| s.set_value("", window, cx));
            let fx = self.page.mount(
                info.workspace,
                info.root,
                info.path,
                info.last_open.as_deref(),
            );
            self.run(fx, cx);
            return;
        }
        if self.page.url_root != info.root || self.page.url_path != info.path {
            let fx = self.page.set_url(info.root, info.path);
            self.run(fx, cx);
        }
    }

    /// Runs effects: requests and timers spawn, the rest go to the shell.
    pub fn run(&mut self, effects: Vec<Effect>, cx: &mut Context<Self>) {
        for effect in effects {
            match effect {
                Effect::Send(call, req) => self.send(call, req, cx),
                Effect::Timer(timer, ms) => {
                    cx.spawn(async move |this, cx| {
                        cx.background_executor()
                            .timer(Duration::from_millis(ms))
                            .await;
                        this.update(cx, |this, cx| {
                            let fx = this.page.timer_fired(timer);
                            this.run(fx, cx);
                        })
                        .ok();
                    })
                    .detach();
                }
                Effect::ReplaceUrl(url) => cx.emit(FilesEvent::ReplaceUrl(url)),
                Effect::OpenUrl(url) => cx.emit(FilesEvent::OpenUrl(url)),
                Effect::Store { key, value } => cx.emit(FilesEvent::Store { key, value }),
            }
        }
        cx.notify();
    }

    fn send(&mut self, call: Call, req: Request, cx: &mut Context<Self>) {
        let Some(ws) = self.page.ws().map(str::to_owned) else {
            return;
        };
        let d = &self.data;
        let fut: futures::future::BoxFuture<'static, Answer> = match req {
            Request::Roots => {
                let f = d.roots(&ws);
                Box::pin(async move { Answer::Roots(f.await) })
            }
            Request::List { root, path } => {
                let f = d.list(&ws, root.as_deref(), &path);
                Box::pin(async move { Answer::Listing(f.await) })
            }
            Request::Search { root, q } => {
                let f = d.search(&ws, root.as_deref(), &q);
                Box::pin(async move { Answer::Search(f.await) })
            }
            Request::Read { root, rel } => {
                let f = d.read(&ws, &root, &rel);
                Box::pin(async move { Answer::File(f.await) })
            }
            Request::Save { root, rel, text } => {
                let f = d.save(&ws, &root, &rel, &text);
                Box::pin(async move { Answer::Done(f.await) })
            }
            Request::Delete { root, rel } => {
                let f = d.delete(&ws, &root, &rel);
                Box::pin(async move { Answer::Done(f.await) })
            }
            Request::Rename { root, rel, next } => {
                let f = d.rename(&ws, &root, &rel, &next);
                Box::pin(async move { Answer::Done(f.await) })
            }
            Request::Create { root, path, kind } => {
                let f = d.create(&ws, &root, &path, kind);
                Box::pin(async move { Answer::Done(f.await) })
            }
            Request::ContentSearch {
                root,
                folder,
                q,
                case_sensitive,
            } => {
                let f = d.content_search(&ws, &root, &folder, &q, case_sensitive);
                Box::pin(async move { Answer::ContentSearch(f.await) })
            }
            Request::Reveal { root, rel } => {
                let f = d.reveal(&ws, root.as_deref(), &rel);
                Box::pin(async move { Answer::Done(f.await) })
            }
            Request::Image { root, rel } => {
                let f = d.image(&ws, &root, &rel);
                Box::pin(async move { Answer::Image(f.await) })
            }
        };
        cx.spawn(async move |this, cx| {
            let answer = fut.await;
            this.update(cx, |this, cx| {
                let fx = this.page.answered(call, answer);
                this.run(fx, cx);
            })
            .ok();
        })
        .detach();
    }

    // ---- keeping the inputs and the editor in step ------------------------

    fn sync_widgets(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        // The editor: a new one for each opened file.
        if self.page.pane() == Pane::Text {
            if self.editor.is_none() || self.editor_seq != self.page.open_seq {
                self.make_editor(window, cx);
            }
        } else if self.page.open.is_none() {
            self.editor = None;
            self.editor_sub = None;
        }
        if let (Some(editor), Some(line)) = (self.editor.clone(), self.page.pending_line.take()) {
            editor.update(cx, |s, cx| {
                s.set_cursor_position(
                    Position {
                        line: line.saturating_sub(1),
                        character: 0,
                    },
                    window,
                    cx,
                );
            });
        }
        // The image preview's decoded bytes.
        match (&self.page.image, &self.image) {
            (None, Some(_)) => self.image = None,
            (Some((bytes, ty)), cached)
                if cached
                    .as_ref()
                    .is_none_or(|(s, _)| *s != self.page.open_seq) =>
            {
                let path = self
                    .page
                    .open
                    .as_ref()
                    .map(|o| o.rel_path.clone())
                    .unwrap_or_default();
                self.image = image_format(ty, &path).map(|f| {
                    (
                        self.page.open_seq,
                        Arc::new(Image::from_bytes(f, bytes.clone())),
                    )
                });
            }
            _ => {}
        }
        // Find in file: focus its input on open (FindInFile.tsx:118), and
        // put the active match in the editor's selection.
        let find_open = self.page.find.is_some();
        if find_open && !self.find_shown {
            let q = self
                .page
                .find
                .as_ref()
                .map(|f| f.query.clone())
                .unwrap_or_default();
            self.find_input.update(cx, |s, cx| {
                s.set_value(q, window, cx);
                s.focus(window, cx);
            });
        }
        if !find_open && self.find_shown {
            self.focus_editor(window, cx);
        }
        self.find_shown = find_open;
        if let (Some(f), Some(editor)) = (&self.page.find, &self.editor)
            && f.reveal_seq != self.reveal_seq
        {
            self.reveal_seq = f.reveal_seq;
            if let Some(m) = self.page.active_match() {
                let draft = &self.page.draft;
                let range = rules::byte_offset(draft, m.start)..rules::byte_offset(draft, m.end);
                editor.update(cx, |s, cx| s.set_selected_range(range, cx));
            }
        }
        // Find in folder: a fresh query box on each open.
        let folder_open = self.page.folder_find.is_some();
        if folder_open && !self.folder_shown {
            let label = self
                .page
                .folder_find
                .as_ref()
                .map(|f| f.label.clone())
                .unwrap_or_default();
            self.folder_input.update(cx, |s, cx| {
                s.set_value("", window, cx);
                s.set_placeholder(format!("Search in {label}\u{2026}"), window, cx);
                s.focus(window, cx);
            });
        }
        if !folder_open && self.folder_shown {
            self.focus.focus(window, cx);
        }
        self.folder_shown = folder_open;
        // The dialog's input: its default, selected.
        let dialog = self.page.dialog.clone();
        let wants_input = matches!(dialog, Some(Dialog::Rename { .. } | Dialog::Create { .. }));
        if dialog.is_some() && !self.dialog_shown {
            let default = match &dialog {
                Some(Dialog::Rename { default }) | Some(Dialog::Create { default, .. }) => {
                    default.clone()
                }
                _ => String::new(),
            };
            if wants_input {
                self.dialog_input.update(cx, |s, cx| {
                    s.set_value(default, window, cx);
                    s.focus(window, cx);
                    s.select_all(window, cx);
                });
            } else {
                self.focus.focus(window, cx);
            }
        }
        if dialog.is_none() && self.dialog_shown {
            self.focus.focus(window, cx);
        }
        self.dialog_shown = dialog.is_some();
    }

    fn make_editor(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(open) = &self.page.open else { return };
        let lang = rules::editor_language(&open.rel_path);
        let draft = self.page.draft.clone();
        let editor = cx.new(|cx| {
            EditorState::new(window, cx)
                .language(lang)
                .searchable(false)
                .default_value(draft)
        });
        let sub = cx.subscribe(&editor, |this: &mut Self, ed, ev: &InputEvent, cx| {
            if matches!(ev, InputEvent::Change) {
                let v = ed.read(cx).value().to_string();
                this.page.edit(&v);
                cx.notify();
            }
        });
        self.editor = Some(editor);
        self.editor_sub = Some(sub);
        self.editor_seq = self.page.open_seq;
        self.reveal_seq = 0;
    }

    fn focus_editor(&self, window: &mut Window, cx: &mut Context<Self>) {
        match &self.editor {
            Some(e) => e.update(cx, |s, cx| s.focus(window, cx)),
            None => self.focus.focus(window, cx),
        }
    }

    // ---- handlers ---------------------------------------------------------

    fn on_dismiss(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.page.menu.is_some() {
            self.page.close_menu();
        } else if self.page.dialog.is_some() {
            self.page.cancel_dialog();
        } else if self.page.find.is_some() {
            self.page.close_find();
        } else if self.page.folder_find.is_some() {
            self.page.close_folder_find();
        } else {
            return;
        }
        let _ = window;
        cx.notify();
    }

    /// Types into the header's search box (tests, screenshots).
    pub fn type_search(&mut self, q: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.search
            .update(cx, |s, cx| s.set_value(q.to_owned(), window, cx));
        let fx = self.page.set_query(q);
        self.run(fx, cx);
    }

    /// Opens find in file and types the query (tests, screenshots).
    pub fn type_find_in_file(&mut self, q: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.page.open_find();
        self.sync_widgets(window, cx);
        self.find_input
            .update(cx, |s, cx| s.set_value(q.to_owned(), window, cx));
        self.page.set_find_query(q);
        cx.notify();
    }

    /// Opens find in folder over the root and types the query (tests,
    /// screenshots).
    pub fn type_find_in_folder(&mut self, q: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.page.open_root_folder_find();
        self.sync_widgets(window, cx);
        self.folder_input
            .update(cx, |s, cx| s.set_value(q.to_owned(), window, cx));
        let fx = self.page.set_folder_query(q);
        self.run(fx, cx);
    }

    /// Replaces the editor's text, as typing would (tests).
    pub fn type_in_editor(&mut self, text: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.sync_widgets(window, cx);
        if let Some(e) = &self.editor {
            e.update(cx, |s, cx| s.set_value(text.to_owned(), window, cx));
        }
        self.page.edit(text);
        cx.notify();
    }

    /// The dialog's text field (tests).
    pub fn set_dialog_text(&mut self, text: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.sync_widgets(window, cx);
        self.dialog_input
            .update(cx, |s, cx| s.set_value(text.to_owned(), window, cx));
    }

    fn confirm_dialog(&mut self, cx: &mut Context<Self>) {
        let v = self.dialog_input.read(cx).value().to_string();
        let fx = self.page.confirm_dialog(&v);
        self.run(fx, cx);
    }

    fn editor_key(&mut self, ev: &gpui_kit::KeyDownEvent, cx: &mut Context<Self>) {
        let ks = &ev.keystroke;
        let key = ks
            .key_char
            .clone()
            .filter(|k| k.chars().count() == 1 && !ks.modifiers.platform)
            .unwrap_or_else(|| ks.key.clone());
        let code = if ks.key.len() == 1 && ks.key.as_bytes()[0].is_ascii_alphabetic() {
            format!("Key{}", ks.key.to_ascii_uppercase())
        } else {
            String::new()
        };
        let e = KeyEvent {
            key,
            code,
            meta: ks.modifiers.platform,
            ctrl: ks.modifiers.control,
            shift: ks.modifiers.shift,
            alt: ks.modifiers.alt,
        };
        if let Some(fx) = self.page.editor_key(&e) {
            cx.stop_propagation();
            self.run(fx, cx);
        }
    }

    // ---- drawing ----------------------------------------------------------

    fn header(&self, c: &Colors, cx: &mut Context<Self>) -> AnyElement {
        let p = &self.page;
        let ws = p.workspace.clone();
        let extras = p.extra_roots();
        let busy_create = p.busy == Some(Busy::Create);
        let disabled = ws.is_none() || busy_create;
        let muted = c.muted;
        div()
            .id("files-header")
            .debug_selector(sel("files-header"))
            .flex()
            .flex_none()
            .h(px(36.))
            .items_center()
            .gap(px(12.))
            .px(px(16.))
            .border_b_1()
            .border_color(c.border)
            .bg(c.panel)
            .text_size(px(12.))
            .child(
                div()
                    .id("files-back")
                    .debug_selector(sel("files-back"))
                    .flex()
                    .items_center()
                    .gap(px(4.))
                    .text_color(c.muted)
                    .hover({
                        let f = c.foreground;
                        move |d| d.text_color(f)
                    })
                    .child(icon("ArrowLeft", 14., muted))
                    .child("Chat")
                    .on_click(cx.listener(|this, _, _, cx| {
                        let fx = this.page.back_to_chat();
                        this.run(fx, cx);
                    })),
            )
            .child(div().opacity(0.5).child("\u{b7}"))
            .child(icon("FolderTree", 14., muted))
            .child(div().font_weight(FontWeight::MEDIUM).child("Files"))
            .when_some(ws.clone(), |d, (_, root)| {
                d.child(
                    div()
                        .max_w(px(240.))
                        .truncate()
                        .font_family(fonts::MONO)
                        .text_color(c.muted)
                        .child(root),
                )
            })
            .when(!extras.is_empty(), |d| {
                let title = extras
                    .iter()
                    .map(|r| r.abs_path.clone())
                    .collect::<Vec<_>>()
                    .join("\n");
                d.child(
                    div()
                        .id("files-extra-roots")
                        .debug_selector(sel("files-extra-roots"))
                        .rounded(px(6.))
                        .border_1()
                        .border_color(c.border)
                        .bg(c.panel_2)
                        .px(px(6.))
                        .text_size(px(10.))
                        .text_color(c.muted)
                        .child(rules::extra_roots_badge(extras.len()))
                        .tooltip(tooltip(title)),
                )
            })
            .child(
                div().flex().flex_1().justify_center().px(px(12.)).child(
                    div()
                        .debug_selector(sel("files-search"))
                        .w_full()
                        .max_w(px(448.))
                        .child(
                            Input::new(&self.search)
                                .prefix(icon("Search", 14., muted))
                                .cleanable(true)
                                .disabled(ws.is_none())
                                .h(px(26.))
                                .text_size(px(12.)),
                        ),
                ),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(4.))
                    .child(
                        icon_button("files-find-folder", c)
                            .child(icon("FolderSearch", 14., muted))
                            .tooltip(tooltip("Find in folder".into()))
                            .when(ws.is_none(), |d| d.opacity(0.4))
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.page.open_root_folder_find();
                                cx.notify();
                            })),
                    )
                    .child(
                        icon_button("files-new-file", c)
                            .child(icon("FilePlus", 14., muted))
                            .tooltip(tooltip("New file".into()))
                            .when(disabled, |d| d.opacity(0.4))
                            .when(!disabled, |d| {
                                d.on_click(cx.listener(|this, _, _, cx| {
                                    this.page.ask_create(NewKind::File);
                                    cx.notify();
                                }))
                            }),
                    )
                    .child(
                        icon_button("files-new-folder", c)
                            .child(icon("FolderPlus", 14., muted))
                            .tooltip(tooltip("New folder".into()))
                            .when(disabled, |d| d.opacity(0.4))
                            .when(!disabled, |d| {
                                d.on_click(cx.listener(|this, _, _, cx| {
                                    this.page.ask_create(NewKind::Dir);
                                    cx.notify();
                                }))
                            }),
                    ),
            )
            .into_any_element()
    }

    fn tree_column(&self, c: &Colors, cx: &mut Context<Self>) -> AnyElement {
        let p = &self.page;
        let body = if p.workspace.is_none() {
            div()
                .px(px(16.))
                .py(px(48.))
                .text_center()
                .text_size(px(14.))
                .text_color(c.muted)
                .child("No active workspace.")
                .into_any_element()
        } else if p.extra_roots().is_empty() {
            match p.trees.first() {
                Some(t) => self.tree(t.id, c, cx),
                None => div().into_any_element(),
            }
        } else {
            let roots = p.roots.clone().unwrap_or_default();
            let n = roots.len();
            div()
                .py(px(4.))
                .children(roots.into_iter().enumerate().map(|(i, r)| {
                    let open = p.group_open(&r.id);
                    let label = rules::root_label(&r.source, &r.abs_path).to_owned();
                    let badge = rules::source_badge(&r.source);
                    let id = r.id.clone();
                    let tree = p.trees.iter().find(|t| t.root.as_deref() == Some(&r.id));
                    let hover = c.panel_2;
                    div()
                        .when(i + 1 < n, |d| d.border_b_1().border_color(c.border))
                        .child(
                            div()
                                .id(ElementId::Name(format!("files-group-{}", r.id).into()))
                                .debug_selector(sel(format!("files-group-{}", r.id)))
                                .flex()
                                .w_full()
                                .items_center()
                                .gap(px(4.))
                                .px(px(8.))
                                .py(px(4.))
                                .text_size(px(11.))
                                .hover(move |d| d.bg(hover))
                                .tooltip(tooltip(r.abs_path.clone()))
                                .child(icon(
                                    if open { "ChevronDown" } else { "ChevronRight" },
                                    12.,
                                    c.muted,
                                ))
                                .child(
                                    div()
                                        .min_w_0()
                                        .flex_1()
                                        .truncate()
                                        .font_weight(FontWeight::MEDIUM)
                                        .child(label),
                                )
                                .when_some(badge, |d, b| {
                                    d.child(
                                        div()
                                            .flex_none()
                                            .rounded(px(4.))
                                            .bg(c.panel_2)
                                            .px(px(4.))
                                            .text_size(px(9.))
                                            .text_color(c.muted)
                                            .child(b.to_uppercase()),
                                    )
                                })
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    let fx = this.page.toggle_group(&id);
                                    this.run(fx, cx);
                                })),
                        )
                        .when_some(tree.map(|t| t.id), |d, tid| {
                            d.child(div().pb(px(4.)).child(self.tree(tid, c, cx)))
                        })
                }))
                .into_any_element()
        };
        div()
            .id("files-aside")
            .debug_selector(sel("files-aside"))
            .w(px(320.))
            .flex_none()
            .overflow_y_scroll()
            .border_r_1()
            .border_color(c.border)
            .child(body)
            .into_any_element()
    }

    fn tree(&self, tree_id: u64, c: &Colors, cx: &mut Context<Self>) -> AnyElement {
        let Some(t) = self.page.trees.iter().find(|t| t.id == tree_id) else {
            return div().into_any_element();
        };
        let note = |s: String| {
            div()
                .px(px(12.))
                .py(px(12.))
                .text_size(px(12.))
                .text_color(c.muted)
                .child(s)
        };
        let red = tw("red-300", 100.);
        match t.body(&self.page.query) {
            TreeBody::Searching => note("Searching\u{2026}".into()).into_any_element(),
            TreeBody::SearchError(e) => note(e.to_owned())
                .debug_selector(sel("file-search-error"))
                .text_color(red)
                .into_any_element(),
            TreeBody::NoMatch => note("No files match.".into()).into_any_element(),
            TreeBody::Loading => note("Loading\u{2026}".into()).into_any_element(),
            TreeBody::Error(e) => div()
                .debug_selector(sel("file-tree-error"))
                .rounded(px(6.))
                .border_1()
                .border_color(tw("red-500", 30.))
                .bg(tw("red-500", 10.))
                .px(px(12.))
                .py(px(8.))
                .text_size(px(12.))
                .text_color(red)
                .child(e.to_owned())
                .into_any_element(),
            TreeBody::Empty(text) => {
                let hidden = t.hidden_in.get("").copied().unwrap_or(0.0) > 0.0;
                note(text)
                    .id("file-tree-empty")
                    .debug_selector(sel("file-tree-empty"))
                    .when(hidden, |d| d.tooltip(tooltip(rules::HIDDEN_HINT.into())))
                    .into_any_element()
            }
            TreeBody::Results { entries, truncated } => {
                let selected = t.selected.clone();
                let n = entries.len();
                div()
                    .text_size(px(12.))
                    .children(entries.iter().map(|e| {
                        let rel = e.rel_path.clone();
                        let rel2 = rel.clone();
                        let is_sel = selected.as_deref() == Some(rel.as_str());
                        let hover = c.panel_2;
                        div()
                            .id(ElementId::Name(format!("files-hit-{tree_id}-{rel}").into()))
                            .debug_selector(sel(format!("files-hit-{rel}")))
                            .flex()
                            .w_full()
                            .min_w_0()
                            .items_center()
                            .gap(px(4.))
                            .rounded(px(6.))
                            .px(px(8.))
                            .py(px(2.))
                            .hover(move |d| d.bg(hover))
                            .when(is_sel, |d| d.bg(c.panel_2))
                            .tooltip(tooltip(rel.clone()))
                            .child(icon("File", 12., c.muted))
                            .child(
                                div()
                                    .min_w_0()
                                    .flex_1()
                                    .truncate()
                                    .font_family(fonts::MONO)
                                    .child(rel.clone()),
                            )
                            .on_click(cx.listener(move |this, _, _, cx| {
                                let fx = this.page.click_result(tree_id, &rel);
                                this.run(fx, cx);
                            }))
                            .on_mouse_down(
                                MouseButton::Right,
                                cx.listener(move |this, ev: &gpui_kit::MouseDownEvent, _, cx| {
                                    cx.stop_propagation();
                                    let at = ev.position;
                                    this.page.open_menu(
                                        tree_id,
                                        &rel2,
                                        false,
                                        f64::from(f32::from(at.x)),
                                        f64::from(f32::from(at.y)),
                                    );
                                    cx.notify();
                                }),
                            )
                    }))
                    .when(truncated, |d| {
                        d.child(
                            div()
                                .px(px(12.))
                                .py(px(4.))
                                .text_size(px(10.))
                                .italic()
                                .text_color(c.muted)
                                .child(rules::search_truncated_text(n)),
                        )
                    })
                    .into_any_element()
            }
            TreeBody::Rows => {
                let selected = t.selected.clone();
                let rows = t.rows();
                div()
                    .text_size(px(12.))
                    .children(rows.into_iter().map(|row| match row {
                        TreeRow::Entry { depth, entry } => self.row(
                            tree_id,
                            depth,
                            entry,
                            t.is_open(&entry.rel_path),
                            &selected,
                            c,
                            cx,
                        ),
                        TreeRow::Empty {
                            depth,
                            error,
                            hidden,
                        } => {
                            // FileTree.tsx:448 lined up with the children's names.
                            let pad = 8. + depth as f32 * 12. + 32.;
                            let el = div().py(px(2.)).pr(px(8.)).pl(px(pad)).text_size(px(11.));
                            match error {
                                Some(e) => el
                                    .debug_selector(sel("file-tree-dir-error"))
                                    .text_color(red)
                                    .child(e.to_owned())
                                    .into_any_element(),
                                None => el
                                    .italic()
                                    .text_color(c.muted)
                                    .child(rules::empty_dir_text(hidden))
                                    .into_any_element(),
                            }
                        }
                    }))
                    .into_any_element()
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn row(
        &self,
        tree_id: u64,
        depth: usize,
        entry: &crate::data::Entry,
        open: bool,
        selected: &Option<String>,
        c: &Colors,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let rel = entry.rel_path.clone();
        let rel_menu = rel.clone();
        let is_dir = entry.is_dir;
        let is_sel = selected.as_deref() == Some(rel.as_str());
        let hover = c.panel_2;
        div()
            .id(ElementId::Name(format!("files-row-{tree_id}-{rel}").into()))
            .debug_selector(sel(format!("files-row-{rel}")))
            .flex()
            .w_full()
            .min_w_0()
            .items_center()
            .gap(px(4.))
            .rounded(px(6.))
            .pr(px(8.))
            .py(px(2.))
            .pl(px(8. + depth as f32 * 12.))
            .hover(move |d| d.bg(hover))
            .when(is_sel, |d| d.bg(c.panel_2))
            .tooltip(tooltip(entry.name.clone()))
            .child(if is_dir {
                icon(
                    if open { "ChevronDown" } else { "ChevronRight" },
                    12.,
                    c.muted,
                )
                .into_any_element()
            } else {
                div().w(px(12.)).flex_none().into_any_element()
            })
            .child(if is_dir {
                icon("Folder", 12., c.accent)
            } else {
                icon("File", 12., c.muted)
            })
            .child(
                div()
                    .min_w_0()
                    .flex_1()
                    .truncate()
                    .font_family(fonts::MONO)
                    .child(entry.name.clone()),
            )
            .when_some(entry.size_bytes.filter(|_| !is_dir), |d, n| {
                d.child(
                    div()
                        .flex_none()
                        .pl(px(4.))
                        .text_size(px(10.))
                        .text_color(c.muted)
                        .child(rules::fmt_size(n)),
                )
            })
            .on_click(cx.listener(move |this, _, _, cx| {
                let fx = this.page.click_row(tree_id, &rel);
                this.run(fx, cx);
            }))
            .on_mouse_down(
                MouseButton::Right,
                cx.listener(move |this, ev: &gpui_kit::MouseDownEvent, _, cx| {
                    cx.stop_propagation();
                    let at = ev.position;
                    this.page.open_menu(
                        tree_id,
                        &rel_menu,
                        is_dir,
                        f64::from(f32::from(at.x)),
                        f64::from(f32::from(at.y)),
                    );
                    cx.notify();
                }),
            )
            .into_any_element()
    }

    fn pane(&self, c: &Colors, cx: &mut Context<Self>) -> AnyElement {
        let p = &self.page;
        let section = div()
            .id("files-pane")
            .debug_selector(sel("files-pane"))
            .flex()
            .flex_col()
            .flex_1()
            .min_w_0()
            .overflow_hidden();
        match p.pane() {
            Pane::FindInFolder => section.child(self.find_in_folder(c, cx)).into_any_element(),
            Pane::Empty => section
                .items_center()
                .justify_center()
                .text_size(px(14.))
                .text_color(c.muted)
                .child(
                    div()
                        .debug_selector(sel("files-pick-a-file"))
                        .child("Pick a file to view or edit."),
                )
                .into_any_element(),
            pane => {
                let Some(open) = &p.open else {
                    return section.into_any_element();
                };
                let section = section.child(self.file_bar(c, cx));
                match pane {
                    Pane::Binary => section
                        .child(binary_placeholder(open, c))
                        .into_any_element(),
                    Pane::Image => section.child(self.image_preview(c)).into_any_element(),
                    _ => {
                        let read_only = p.read_only();
                        section
                            .when(p.find.is_some(), |d| d.child(self.find_bar(c, cx)))
                            .when(read_only, |d| {
                                d.child(
                                    div()
                                        .debug_selector(sel("files-encoding-readonly"))
                                        .flex()
                                        .flex_none()
                                        .items_center()
                                        .gap(px(6.))
                                        .border_b_1()
                                        .border_color(tw("amber-500", 30.))
                                        .bg(tw("amber-500", 10.))
                                        .px(px(12.))
                                        .py(px(4.))
                                        .text_size(px(11.))
                                        .text_color(tw("amber-200", 100.))
                                        .child(icon("AlertTriangle", 12., tw("amber-200", 100.)))
                                        .child(
                                            open.read_only_reason
                                                .clone()
                                                .unwrap_or_else(|| rules::READ_ONLY_DEFAULT.into()),
                                        ),
                                )
                            })
                            .child(self.editor_area(read_only, c, cx))
                            .into_any_element()
                    }
                }
            }
        }
    }

    fn file_bar(&self, c: &Colors, cx: &mut Context<Self>) -> AnyElement {
        let p = &self.page;
        let Some(open) = &p.open else {
            return div().into_any_element();
        };
        let busy = p.busy.is_some();
        let read_only = p.read_only();
        let can_save = p.can_save();
        let badge = rules::encoding_badge(
            open.binary,
            open.encoding.as_deref(),
            open.encoding_label.as_deref(),
        )
        .map(str::to_owned);
        let extra_title = p
            .roots
            .iter()
            .flatten()
            .find(|r| r.id == open.root)
            .map(|r| r.abs_path.clone())
            .unwrap_or_else(|| "additional directory".into());
        let save_title = rules::save_button_title(open.binary, read_only);
        let muted = c.muted;
        div()
            .debug_selector(sel("files-file-bar"))
            .flex()
            .flex_none()
            .h(px(36.))
            .items_center()
            .gap(px(8.))
            .border_b_1()
            .border_color(c.border)
            .bg(alpha(c.panel_2_raw, 40.))
            .px(px(12.))
            .text_size(px(12.))
            .when(open.root != "primary", |d| {
                d.child(
                    div()
                        .id("files-extra-badge")
                        .flex_none()
                        .rounded(px(4.))
                        .bg(c.panel_2)
                        .px(px(4.))
                        .text_size(px(9.))
                        .text_color(c.muted)
                        .child("EXTRA")
                        .tooltip(tooltip(extra_title)),
                )
            })
            .child(
                div()
                    .debug_selector(sel("files-open-path"))
                    .truncate()
                    .font_family(fonts::MONO)
                    .child(open.rel_path.clone()),
            )
            .when(p.dirty, |d| {
                d.child(
                    div()
                        .debug_selector(sel("files-dirty"))
                        .text_color(tw("amber-400", 100.))
                        .child("\u{25cf}"),
                )
            })
            .when_some(badge, |d, b| {
                d.child(
                    div()
                        .id("files-encoding-badge")
                        .debug_selector(sel("files-encoding-badge"))
                        .flex_none()
                        .rounded(px(4.))
                        .bg(c.panel_2)
                        .px(px(4.))
                        .font_family(fonts::MONO)
                        .text_size(px(9.))
                        .text_color(c.muted)
                        .child(b.to_uppercase())
                        .tooltip(tooltip("Saved back in this encoding".into())),
                )
            })
            .child(div().flex_1())
            .when(!open.binary, |d| {
                d.child(
                    icon_button("files-find-button", c)
                        .child(icon("Search", 14., muted))
                        .tooltip(tooltip("Find in file".into()))
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.page.open_find();
                            cx.notify();
                        })),
                )
            })
            .child(
                icon_button("files-rename", c)
                    .child(icon("Pencil", 14., muted))
                    .tooltip(tooltip("Rename / move".into()))
                    .when(busy, |d| d.opacity(0.4))
                    .when(!busy, |d| {
                        d.on_click(cx.listener(|this, _, _, cx| {
                            this.page.ask_rename();
                            cx.notify();
                        }))
                    }),
            )
            .child({
                icon_button_over("files-delete", tw("red-500", 20.))
                    .child(icon("Trash2", 14., tw("red-300", 100.)))
                    .tooltip(tooltip("Delete".into()))
                    .when(busy, |d| d.opacity(0.4))
                    .when(!busy, |d| {
                        d.on_click(cx.listener(|this, _, _, cx| {
                            this.page.ask_delete();
                            cx.notify();
                        }))
                    })
            })
            .child(
                div()
                    .id("files-save")
                    .debug_selector(sel("files-save"))
                    .flex()
                    .items_center()
                    .gap(px(4.))
                    .rounded(px(6.))
                    .bg(c.accent)
                    .px(px(8.))
                    .py(px(2.))
                    .text_size(px(11.))
                    .text_color(tw("white", 100.))
                    .when(!can_save, |d| d.opacity(0.4))
                    .when_some(save_title, |d, t| d.tooltip(tooltip(t.into())))
                    .child(icon("Save", 12., tw("white", 100.)))
                    .child(if p.busy == Some(Busy::Save) {
                        "Saving\u{2026}"
                    } else {
                        "Save"
                    })
                    .when(can_save, |d| {
                        d.on_click(cx.listener(|this, _, _, cx| {
                            let fx = this.page.save();
                            this.run(fx, cx);
                        }))
                    }),
            )
            .into_any_element()
    }

    fn editor_area(&self, read_only: bool, c: &Colors, cx: &mut Context<Self>) -> AnyElement {
        let lang = self
            .page
            .open
            .as_ref()
            .map_or("text", |o| rules::editor_language(&o.rel_path));
        let body = match &self.editor {
            Some(e) => Editor::new(e)
                .readonly(read_only)
                .bordered(false)
                .h_full()
                .into_any_element(),
            // The first frame, before the editor exists: the text, plain
            // (HighlightedEditor.tsx:56-66).
            None => div()
                .debug_selector(sel("files-highlighted-editor-loading"))
                .p(px(16.))
                .font_family(fonts::MONO)
                .text_size(px(12.))
                .line_height(px(20.))
                .child(self.page.draft.clone())
                .into_any_element(),
        };
        div()
            .id("files-editor")
            .debug_selector(sel(format!("files-editor-{lang}")))
            .flex_1()
            .min_h_0()
            .overflow_hidden()
            // HighlightedEditor.tsx paints on `var(--background)`.
            .bg(c.background)
            .on_key_down(cx.listener(|this, ev: &gpui_kit::KeyDownEvent, _, cx| {
                this.editor_key(ev, cx);
            }))
            .child(body)
            .into_any_element()
    }

    fn image_preview(&self, c: &Colors) -> AnyElement {
        let Some((_, image)) = &self.image else {
            return div().into_any_element();
        };
        div()
            .debug_selector(sel("files-image"))
            .flex()
            .flex_1()
            .items_center()
            .justify_center()
            .p(px(24.))
            .bg(c.background)
            .child(img(image.clone()).max_w_full().max_h_full())
            .into_any_element()
    }

    fn find_bar(&self, c: &Colors, cx: &mut Context<Self>) -> AnyElement {
        let p = &self.page;
        let Some(f) = &p.find else {
            return div().into_any_element();
        };
        let matches = p.find_matches().len();
        let counter = rules::find_counter(&f.query, matches, f.active);
        let case_on = f.case_sensitive;
        let muted = c.muted;
        let arrow = |id: &str, name: &str, title: &str, forward: bool, cx: &mut Context<Self>| {
            icon_button(id, c)
                .child(icon(name, 14., muted))
                .tooltip(tooltip(title.into()))
                .when(matches == 0, |d| d.opacity(0.4))
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.page.find_step(forward);
                    cx.notify();
                }))
        };
        div()
            .debug_selector(sel("files-find-in-file"))
            .flex()
            .flex_none()
            .h(px(36.))
            .items_center()
            .gap(px(8.))
            .border_b_1()
            .border_color(c.border)
            .bg(alpha(c.panel_2_raw, 60.))
            .px(px(12.))
            .text_size(px(12.))
            .child(
                div()
                    .debug_selector(sel("files-find-input"))
                    .w(px(256.))
                    .on_action(cx.listener(|this, _: &InputEscape, _, cx| {
                        this.page.close_find();
                        cx.notify();
                    }))
                    .child(
                        Input::new(&self.find_input)
                            .h(px(22.))
                            .font_family(fonts::MONO)
                            .text_size(px(12.)),
                    ),
            )
            .child(
                div()
                    .id("files-find-case")
                    .debug_selector(sel("files-find-case"))
                    .flex()
                    .items_center()
                    .justify_center()
                    .size(px(20.))
                    .rounded(px(4.))
                    .when(case_on, |d| d.bg(c.panel))
                    .child(icon(
                        "CaseSensitive",
                        14.,
                        if case_on { c.foreground } else { c.muted },
                    ))
                    .tooltip(tooltip(rules::case_title(case_on).into()))
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.page.toggle_find_case();
                        cx.notify();
                    })),
            )
            .child(
                div()
                    .debug_selector(sel("files-find-counter"))
                    .text_color(c.muted)
                    .child(counter),
            )
            .child(div().flex_1())
            .child(arrow(
                "files-find-prev",
                "ArrowUp",
                "Previous match (Shift+Enter)",
                false,
                cx,
            ))
            .child(arrow(
                "files-find-next",
                "ArrowDown",
                "Next match (Enter)",
                true,
                cx,
            ))
            .child(
                icon_button("files-find-close", c)
                    .child(icon("X", 14., muted))
                    .tooltip(tooltip("Close find (Esc)".into()))
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.page.close_find();
                        cx.notify();
                    })),
            )
            .into_any_element()
    }

    fn find_in_folder(&self, c: &Colors, cx: &mut Context<Self>) -> AnyElement {
        let Some(f) = &self.page.folder_find else {
            return div().into_any_element();
        };
        let muted = c.muted;
        let grouped = f.grouped();
        let total = f.total();
        let display = f.display().to_owned();
        let query_empty = claudius_agent::js::trim(&f.query).is_empty();
        let case_on = f.case_sensitive;
        let header = div()
            .flex()
            .flex_none()
            .h(px(36.))
            .items_center()
            .gap(px(8.))
            .border_b_1()
            .border_color(c.border)
            .bg(alpha(c.panel_2_raw, 40.))
            .px(px(12.))
            .text_size(px(12.))
            .child(icon("FolderSearch", 14., muted))
            .child(
                div()
                    .font_weight(FontWeight::MEDIUM)
                    .child("Find in folder"),
            )
            .child(
                div()
                    .truncate()
                    .font_family(fonts::MONO)
                    .text_color(c.muted)
                    .child(display.clone()),
            )
            .child(div().flex_1())
            .child(
                icon_button("files-folder-close", c)
                    .child(icon("X", 14., muted))
                    .tooltip(tooltip("Close (Esc)".into()))
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.page.close_folder_find();
                        cx.notify();
                    })),
            );
        let status = f.status();
        let bar = div()
            .flex()
            .flex_none()
            .h(px(36.))
            .items_center()
            .gap(px(8.))
            .border_b_1()
            .border_color(c.border)
            .px(px(12.))
            .text_size(px(12.))
            .child(
                div()
                    .flex_1()
                    .on_action(cx.listener(|this, _: &InputEscape, _, cx| {
                        this.page.close_folder_find();
                        cx.notify();
                    }))
                    .child(
                        Input::new(&self.folder_input)
                            .prefix(icon("Search", 14., muted))
                            .cleanable(true)
                            .h(px(26.))
                            .font_family(fonts::MONO)
                            .text_size(px(12.)),
                    ),
            )
            .child(
                div()
                    .id("files-folder-case")
                    .debug_selector(sel("files-folder-case"))
                    .rounded(px(4.))
                    .border_1()
                    .border_color(c.border)
                    .px(px(6.))
                    .text_size(px(10.))
                    .text_color(if case_on { c.foreground } else { c.muted })
                    .when(case_on, |d| d.bg(c.panel_2))
                    .child("Aa")
                    .tooltip(tooltip(rules::case_title(case_on).into()))
                    .on_click(cx.listener(|this, _, _, cx| {
                        let fx = this.page.toggle_folder_case();
                        this.run(fx, cx);
                    })),
            )
            .child(
                div()
                    .debug_selector(sel("files-folder-status"))
                    .min_w(px(110.))
                    .flex()
                    .justify_end()
                    .items_center()
                    .gap(px(4.))
                    .text_size(px(10.))
                    .text_color(c.muted)
                    .when(f.loading, |d| d.child(icon("Loader2", 12., muted)))
                    .child(status),
            );
        let error = f.error.clone().map(|e| {
            div()
                .debug_selector(sel("find-in-folder-error"))
                .border_b_1()
                .border_color(tw("red-500", 30.))
                .bg(tw("red-500", 10.))
                .px(px(12.))
                .py(px(4.))
                .text_size(px(11.))
                .text_color(tw("red-300", 100.))
                .child(e)
        });
        let center = |s: String| {
            div()
                .flex()
                .size_full()
                .items_center()
                .justify_center()
                .px(px(16.))
                .py(px(40.))
                .text_size(px(12.))
                .text_color(c.muted)
                .child(s)
        };
        let body = if query_empty {
            center(format!("Type to search inside {display}.")).into_any_element()
        } else if grouped.is_empty() && !f.loading && f.error.is_none() {
            center("No matches in this folder.".into())
                .debug_selector(sel("files-folder-none"))
                .into_any_element()
        } else {
            let matches = f.matches.clone().unwrap_or_default();
            let ng = grouped.len();
            let footer = rules::folder_footer(f.truncated, f.scanned, total);
            div()
                .py(px(4.))
                .text_size(px(12.))
                .children(grouped.into_iter().enumerate().map(|(gi, (rel, hits))| {
                    let open = !f.collapsed.contains(&rel);
                    let rel_toggle = rel.clone();
                    let hover = c.panel_2;
                    div()
                        .when(gi + 1 < ng, |d| d.border_b_1().border_color(c.border))
                        .child(
                            div()
                                .id(ElementId::Name(format!("files-folder-file-{rel}").into()))
                                .debug_selector(sel(format!("files-folder-file-{rel}")))
                                .flex()
                                .w_full()
                                .items_center()
                                .gap(px(4.))
                                .px(px(12.))
                                .py(px(4.))
                                .hover(move |d| d.bg(hover))
                                .tooltip(tooltip(rel.clone()))
                                .child(icon(
                                    if open { "ChevronDown" } else { "ChevronRight" },
                                    12.,
                                    muted,
                                ))
                                .child(
                                    div()
                                        .min_w_0()
                                        .flex_1()
                                        .truncate()
                                        .font_family(fonts::MONO)
                                        .child(rel.clone()),
                                )
                                .child(
                                    div()
                                        .flex_none()
                                        .text_size(px(10.))
                                        .text_color(muted)
                                        .child(hits.len().to_string()),
                                )
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.page.toggle_folder_group(&rel_toggle);
                                    cx.notify();
                                })),
                        )
                        .when(open, |d| {
                            d.children(hits.into_iter().map(|i| {
                                let m = &matches[i];
                                let line =
                                    div().min_w_0().flex_1().truncate().font_family(fonts::MONO);
                                let line = match rules::matched_line(&m.text, m.col, m.col_end) {
                                    None => {
                                        line.child(rules::collapse_spaces(&[&m.text]).remove(0))
                                    }
                                    Some((a, b, z)) => {
                                        let [a, b, z]: [String; 3] =
                                            rules::collapse_spaces(&[&a, &b, &z])
                                                .try_into()
                                                .unwrap_or_default();
                                        line.flex()
                                            .child(div().flex_none().child(a))
                                            .child(
                                                div()
                                                    .flex_none()
                                                    .rounded(px(2.))
                                                    .bg(alpha(c.accent_raw, 30.))
                                                    .text_color(c.foreground)
                                                    .child(b),
                                            )
                                            .child(div().min_w_0().truncate().child(z))
                                    }
                                };
                                div()
                                    .id(ElementId::Name(format!("files-folder-hit-{i}").into()))
                                    .debug_selector(sel(format!("files-folder-hit-{i}")))
                                    .flex()
                                    .w_full()
                                    .items_center()
                                    .gap(px(8.))
                                    .px(px(24.))
                                    .py(px(2.))
                                    .hover(move |d| d.bg(hover))
                                    .child(
                                        div()
                                            .w(px(48.))
                                            .flex_none()
                                            .text_right()
                                            .text_size(px(10.))
                                            .text_color(muted)
                                            .child(rules::num(m.line)),
                                    )
                                    .child(line)
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        let fx = this.page.pick_hit(i);
                                        this.run(fx, cx);
                                    }))
                            }))
                        })
                }))
                .when_some(footer, |d, t| {
                    d.child(
                        div()
                            .debug_selector(sel("files-folder-footer"))
                            .px(px(12.))
                            .py(px(8.))
                            .text_size(px(10.))
                            .italic()
                            .text_color(muted)
                            .child(t),
                    )
                })
                .into_any_element()
        };
        div()
            .debug_selector(sel("files-find-in-folder"))
            .flex()
            .flex_col()
            .size_full()
            .overflow_hidden()
            .child(header)
            .child(bar)
            .children(error)
            .child(
                div()
                    .id("files-folder-results")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .child(body),
            )
            .into_any_element()
    }

    fn menu(&self, c: &Colors, window: &Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        let m = self.page.menu.as_ref()?;
        let vp = window.viewport_size();
        let (left, top) = rules::clamp_menu(
            m.x,
            m.y,
            rules::MENU_EST_WIDTH,
            rules::MENU_EST_HEIGHT,
            f64::from(f32::from(vp.width)),
            f64::from(f32::from(vp.height)),
        );
        let hover = c.panel_2;
        let busy = m.busy;
        let item = |id: &str, icon_name: &str, label: String| {
            div()
                .id(ElementId::Name(id.to_owned().into()))
                .debug_selector(sel(id.to_owned()))
                .flex()
                .w_full()
                .items_center()
                .gap(px(8.))
                .px(px(12.))
                .py(px(6.))
                .hover(move |d| d.bg(hover))
                .child(icon(icon_name, 12., c.muted))
                .child(div().text_color(c.foreground).child(label))
        };
        let panel = div()
            .id("file-path-context-menu")
            .debug_selector(sel("file-path-context-menu"))
            .w(px(224.))
            .rounded(px(6.))
            .border_1()
            .border_color(c.border)
            .bg(c.panel)
            .py(px(4.))
            .text_size(px(12.))
            .shadow_lg()
            .occlude()
            .on_mouse_down_out(cx.listener(|this, ev: &gpui_kit::MouseDownEvent, _, cx| {
                if ev.button != MouseButton::Right {
                    this.page.close_menu();
                    cx.notify();
                }
            }))
            .child(
                item(
                    "files-menu-reveal",
                    "FolderOpen",
                    rules::reveal_label().to_owned(),
                )
                .when(busy, |d| d.opacity(0.5))
                .on_click(cx.listener(|this, _, _, cx| {
                    let fx = this.page.reveal();
                    this.run(fx, cx);
                })),
            )
            .when(m.is_dir, |d| {
                d.child(
                    item("files-menu-find", "FolderSearch", "Find in folder".into()).on_click(
                        cx.listener(|this, _, _, cx| {
                            this.page.menu_find_in_folder();
                            cx.notify();
                        }),
                    ),
                )
            });
        Some(
            deferred(
                anchored()
                    .position(point(px(left as f32), px(top as f32)))
                    .child(panel),
            )
            .with_priority(1)
            .into_any_element(),
        )
    }

    fn dialog(&self, c: &Colors, cx: &mut Context<Self>) -> Option<AnyElement> {
        let d = self.page.dialog.as_ref()?;
        let (message, input) = match d {
            Dialog::Rename { .. } => (rules::RENAME_PROMPT.to_owned(), true),
            Dialog::Create { message, .. } => ((*message).to_owned(), true),
            Dialog::Delete { question } => (question.clone(), false),
        };
        let choice = |id: &'static str, label: &'static str, primary: bool| {
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
                        .text_color(tw("white", 100.))
                        .border_color(c.accent)
                })
                .when(!primary, |d| d.bg(c.panel).hover(|d| d.bg(c.panel_2)))
                .child(label)
        };
        Some(
            div()
                .id("files-dialog")
                .debug_selector(sel("files-dialog"))
                .absolute()
                .inset_0()
                .flex()
                .items_center()
                .justify_center()
                .bg(tw("black", 40.))
                .occlude()
                .child(
                    div()
                        .w(px(420.))
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
                                .debug_selector(sel("files-dialog-message"))
                                .text_size(px(13.))
                                .child(SharedString::from(message)),
                        )
                        .when(input, |d| {
                            d.child(
                                div()
                                    .debug_selector(sel("files-dialog-input"))
                                    .on_action(cx.listener(|this, _: &InputEscape, _, cx| {
                                        this.page.cancel_dialog();
                                        cx.notify();
                                    }))
                                    .child(
                                        Input::new(&self.dialog_input)
                                            .h(px(26.))
                                            .font_family(fonts::MONO)
                                            .text_size(px(12.)),
                                    ),
                            )
                        })
                        .child(
                            div()
                                .flex()
                                .justify_end()
                                .gap(px(8.))
                                .child(choice("files-dialog-cancel", "Cancel", false).on_click(
                                    cx.listener(|this, _, _, cx| {
                                        this.page.cancel_dialog();
                                        cx.notify();
                                    }),
                                ))
                                .child(choice("files-dialog-ok", "OK", true).on_click(
                                    cx.listener(|this, _, _, cx| this.confirm_dialog(cx)),
                                )),
                        ),
                )
                .into_any_element(),
        )
    }
}

/// BinaryFilePlaceholder.tsx:35.
fn binary_placeholder(open: &crate::data::FileContent, c: &Colors) -> AnyElement {
    div()
        .debug_selector(sel("files-binary-placeholder"))
        .flex()
        .flex_col()
        .flex_1()
        .items_center()
        .justify_center()
        .gap(px(8.))
        .p(px(24.))
        .text_center()
        .text_color(c.muted)
        .child(icon("FileQuestion", 32., c.muted).opacity(0.6))
        .child(
            div()
                .text_size(px(14.))
                .text_color(c.foreground)
                .child(rules::BINARY_HEADLINE),
        )
        .child(
            div()
                .font_family(fonts::MONO)
                .text_size(px(11.))
                .child(rules::binary_caption(&open.rel_path, open.size_bytes)),
        )
        .child(
            div()
                .max_w(px(384.))
                .text_size(px(11.))
                .child(rules::BINARY_BODY),
        )
        .into_any_element()
}

impl Render for FilesScreen {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.sync_widgets(window, cx);
        let c = Colors::of(self.theme);
        let error = self.page.error.clone();
        let menu = self.menu(&c, window, cx);
        let dialog = self.dialog(&c, cx);
        div()
            .id("files-screen")
            .debug_selector(sel("files-screen"))
            .key_context(CONTEXT)
            .track_focus(&self.focus)
            .relative()
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .size_full()
            .overflow_hidden()
            .bg(c.background)
            .text_color(c.foreground)
            .on_action(cx.listener(|this, _: &OpenFind, _, cx| {
                this.page.open_find();
                cx.notify();
            }))
            .on_action(cx.listener(|this, _: &OpenFolderFind, _, cx| {
                this.page.open_root_folder_find();
                cx.notify();
            }))
            .on_action(cx.listener(|this, _: &Dismiss, window, cx| this.on_dismiss(window, cx)))
            .on_mouse_down(
                MouseButton::Right,
                cx.listener(|this, _, _, cx| {
                    if this.page.menu.is_some() {
                        this.page.close_menu();
                        cx.notify();
                    }
                }),
            )
            .child(self.header(&c, cx))
            .when_some(error, |d, e| {
                d.child(
                    div()
                        .debug_selector(sel("files-error"))
                        .border_b_1()
                        .border_color(tw("red-500", 30.))
                        .bg(tw("red-500", 10.))
                        .px(px(12.))
                        .py(px(4.))
                        .text_size(px(11.))
                        .text_color(tw("red-300", 100.))
                        .child(e),
                )
            })
            .child(
                div()
                    .flex()
                    .flex_1()
                    .min_h_0()
                    .overflow_hidden()
                    .child(self.tree_column(&c, cx))
                    .child(self.pane(&c, cx)),
            )
            .children(menu)
            .children(dialog)
    }
}
