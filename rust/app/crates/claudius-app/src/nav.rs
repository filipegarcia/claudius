//! The two rails' contents (`components/nav/SideNav.tsx`,
//! `WorkspaceSwitcher.tsx`): the workspace pages' tiles in the user's
//! order, the system tiles, and focus mode.

use gpui_kit::assets::IconName;

use crate::route::{Route, WorkspacePage};

/// A tile of the nav-icon rail: a workspace page.
#[derive(Clone, Debug, PartialEq)]
pub struct NavItem {
    pub label: &'static str,
    pub icon: IconName,
    /// The shortcut registry id (`"nav.git"`), also the `navOrder` key.
    pub action_id: &'static str,
    pub page: WorkspacePage,
    /// Shown only while this customization is published (case-insensitive
    /// name match). Built-in tiles have none.
    pub customization: Option<&'static str>,
}

/// `SideNav.tsx`'s `items`, in its default order.
pub fn items() -> Vec<NavItem> {
    let item = |label, icon, action_id, page| NavItem {
        label,
        icon,
        action_id,
        page,
        customization: None,
    };
    let gated = |label, icon, action_id, page, name| NavItem {
        label,
        icon,
        action_id,
        page,
        customization: Some(name),
    };
    use WorkspacePage as P;
    vec![
        item(
            "Chat",
            IconName::MessageSquare,
            "nav.chat",
            P::Chat { session: None },
        ),
        item("Git", IconName::GitBranch, "nav.git", P::Git),
        item(
            "Sessions",
            IconName::FolderTree,
            "nav.sessions",
            P::Sessions,
        ),
        item(
            "Files",
            IconName::Folder,
            "nav.files",
            P::Files {
                root: None,
                path: None,
            },
        ),
        item("Memory", IconName::BookText, "nav.memory", P::Memory),
        item("Assets", IconName::Image, "nav.assets", P::Assets),
        item("Cost", IconName::ChartColumn, "nav.cost", P::Cost),
        item("Agents", IconName::Bot, "nav.agents", P::Agents),
        item("Skills", IconName::Sparkles, "nav.skills", P::Skills),
        item("MCP", IconName::Network, "nav.mcp", P::Mcp),
        item("Hooks", IconName::Webhook, "nav.hooks", P::Hooks),
        item("Schedule", IconName::Calendar, "nav.schedule", P::Schedule),
        item(
            "Permissions",
            IconName::ShieldCheck,
            "nav.permissions",
            P::Permissions,
        ),
        gated(
            "Docker",
            IconName::Container,
            "nav.docker",
            P::Docker,
            "Docker Monitoring",
        ),
        gated(
            "Tracker",
            IconName::CircleDot,
            "nav.tracker",
            P::Tracker,
            "Tracker",
        ),
        gated(
            "Database",
            IconName::Database,
            "nav.database",
            P::Database,
            "Database Console",
        ),
        gated(
            "Notebooks",
            IconName::BookOpen,
            "nav.notebooks",
            P::Notebooks,
            "Notebooks",
        ),
        item(
            "Workspace",
            IconName::Briefcase,
            "nav.workspace",
            P::Workspace,
        ),
    ]
}

/// The tiles the rail shows: the customization gate (`enabled` holds the
/// published customizations' names; a gated tile hides while it's unknown,
/// as before `/api/customizations` answers), then the saved order.
pub fn visible_items(enabled: Option<&[String]>, order: Option<&[String]>) -> Vec<NavItem> {
    let gated: Vec<NavItem> = items()
        .into_iter()
        .filter(|it| match it.customization {
            None => true,
            Some(name) => enabled.is_some_and(|names| {
                names
                    .iter()
                    .any(|n| n.to_lowercase() == name.to_lowercase())
            }),
        })
        .collect();
    apply_nav_order(gated, order)
}

/// `applyNavOrder`: the ids in `order` first, in its order (a repeat or an
/// id with no tile skipped), then every other tile in its default place.
pub fn apply_nav_order(items: Vec<NavItem>, order: Option<&[String]>) -> Vec<NavItem> {
    let Some(order) = order.filter(|o| !o.is_empty()) else {
        return items;
    };
    let mut taken: Vec<&str> = Vec::new();
    let mut ordered = Vec::with_capacity(items.len());
    for id in order {
        if taken.contains(&id.as_str()) {
            continue;
        }
        if let Some(it) = items.iter().find(|it| it.action_id == id) {
            ordered.push(it.clone());
            taken.push(it.action_id);
        }
    }
    for it in items {
        if !taken.contains(&it.action_id) {
            ordered.push(it);
        }
    }
    ordered
}

/// Whether a tile lights up on a route: the route's pathname under the
/// workspace equals the tile's (`stripWorkspacePrefix(pathname) ===
/// href`), so `/git/file` doesn't light Git and `/sessions/<id>` doesn't
/// light Sessions.
pub fn is_active(item: &NavItem, route: &Route) -> bool {
    match route {
        Route::Workspace { page, .. } => page.inner_pathname() == item.page.inner_pathname(),
        _ => false,
    }
}

/// A system tile under the workspace rail's divider.
#[derive(Clone, Debug, PartialEq)]
pub struct SystemTile {
    pub label: &'static str,
    pub icon: IconName,
    pub route: Route,
    /// `pathname.startsWith(prefix)` lights it.
    pub prefix: &'static str,
}

/// Community, Plugins, Settings, Account, in the rail's order.
pub fn system_tiles() -> [SystemTile; 4] {
    [
        SystemTile {
            label: "Community",
            icon: IconName::Radio,
            route: Route::Community,
            prefix: "/community",
        },
        SystemTile {
            label: "Plugins",
            icon: IconName::Plug,
            route: Route::Plugins,
            prefix: "/plugins",
        },
        SystemTile {
            label: "Settings",
            icon: IconName::Settings,
            route: Route::Settings,
            prefix: "/settings",
        },
        SystemTile {
            label: "Account",
            icon: IconName::CircleUser,
            route: Route::Usage,
            prefix: "/usage",
        },
    ]
}

/// Focus mode (`useFocusMode`): `Focus` hides the nav-icon rail, `Zen` the
/// workspace rail too. Only the chat applies it, as in the React app.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum FocusLevel {
    #[default]
    Off,
    Focus,
    Zen,
}

impl FocusLevel {
    /// off → focus → zen → off.
    pub fn next(self) -> FocusLevel {
        match self {
            FocusLevel::Off => FocusLevel::Focus,
            FocusLevel::Focus => FocusLevel::Zen,
            FocusLevel::Zen => FocusLevel::Off,
        }
    }

    /// The stored value (`claudius.focusMode`).
    pub fn as_str(self) -> &'static str {
        match self {
            FocusLevel::Off => "off",
            FocusLevel::Focus => "focus",
            FocusLevel::Zen => "zen",
        }
    }

    pub fn shows_workspace_rail(self) -> bool {
        self != FocusLevel::Zen
    }

    pub fn shows_nav_rail(self) -> bool {
        self == FocusLevel::Off
    }
}
