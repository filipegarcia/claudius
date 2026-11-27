//! The Files route (U12c): claudius-files' [`FilesScreen`] as the content
//! area on `/<ws>/files`, once [`Shell::set_files_data`] gave it data (the
//! route draws its placeholder without). The screen is made on the first
//! frame (its inputs need the window), told the route each frame, and its
//! asks run here: `router.replace` and links through the shell's history,
//! `localStorage` writes into the shell's store.

use std::sync::Arc;

use claudius_files::{FilesData, FilesEvent, FilesScreen, last_open, view::RouteInfo};
use gpui_kit::{AnyElement, AppContext as _, Context, Entity, IntoElement, Subscription, Window};

use crate::route::{Route, WorkspacePage};
use crate::shell::Shell;

/// The shell's Files page: its data, then its screen.
#[derive(Default)]
pub(crate) struct FilesSlot {
    data: Option<Arc<dyn FilesData>>,
    screen: Option<(Entity<FilesScreen>, Subscription)>,
}

impl Shell {
    /// Puts the Files page on `/<ws>/files`, over `data` (the screen is
    /// made on the next render).
    pub fn set_files_data(&mut self, data: Arc<dyn FilesData>, cx: &mut Context<Self>) {
        self.files = FilesSlot {
            data: Some(data),
            screen: None,
        };
        cx.notify();
    }

    /// The Files page's screen, once shown.
    pub fn files_screen(&self) -> Option<Entity<FilesScreen>> {
        self.files.screen.as_ref().map(|(s, _)| s.clone())
    }
}

/// Makes the screen if it's due and tells it the route (each frame).
pub(crate) fn sync(shell: &mut Shell, window: &mut Window, cx: &mut Context<Shell>) {
    let Some(data) = shell.files.data.clone() else {
        return;
    };
    let screen = match &shell.files.screen {
        Some((s, _)) => s.clone(),
        None => {
            let screen = cx.new(|cx| FilesScreen::new(data, window, cx));
            let sub = cx.subscribe(
                &screen,
                |this: &mut Shell, _, ev: &FilesEvent, cx| match ev {
                    FilesEvent::ReplaceUrl(url) => {
                        this.update_state(cx, |s| s.replace_location(url));
                    }
                    FilesEvent::OpenUrl(url) => this.open_url(url, cx),
                    FilesEvent::Store { key, value } => match value {
                        Some(v) => this.store.set(key, v),
                        None => this.store.remove(key),
                    },
                },
            );
            shell.files.screen = Some((screen.clone(), sub));
            screen
        }
    };
    let state = shell.state();
    let route = state.route();
    let (on_files, root, path) = match route {
        Route::Workspace {
            page: WorkspacePage::Files { root, path },
            ..
        } => (true, root.clone(), path.clone()),
        _ => (false, None, None),
    };
    let workspace = route.workspace().and_then(|id| {
        state
            .workspaces()
            .iter()
            .find(|w| w.id == id)
            .map(|w| (w.id.clone(), w.root_path.clone()))
    });
    let last_open = workspace
        .as_ref()
        .and_then(|(id, _)| shell.store.get(&last_open::key_for(id)))
        .map(str::to_owned);
    let info = RouteInfo {
        on_files,
        workspace,
        root,
        path,
        last_open,
        theme: shell.theme,
    };
    screen.update(cx, |s, cx| s.sync_route(info, window, cx));
}

/// The content area on the Files route, when the shell has the screen.
pub(crate) fn element(shell: &Shell) -> Option<AnyElement> {
    shell
        .files
        .screen
        .as_ref()
        .map(|(s, _)| s.clone().into_any_element())
}
