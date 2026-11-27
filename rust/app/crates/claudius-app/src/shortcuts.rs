//! The shell's keyboard shortcuts: the shell-level part of
//! `lib/client/shortcuts.ts`'s registry, with its default bindings, as GPUI
//! actions and key bindings.
//!
//! A binding is the registry's shape (`mod` / `alt` / `shift` plus a
//! `KeyboardEvent.code`); `mod` is ⌘ on macOS and Ctrl elsewhere. User
//! overrides (Settings → shortcuts) are U13's; here every action has its
//! default. The bindings fire wherever focus is in the window, as the
//! Electron menu's do.
//!
//! [`REGISTRY`] is the whole `SHORTCUT_ACTIONS` (labels, descriptions,
//! categories, defaults), which the command palette's shortcut rows and
//! the keyboard cheatsheet list ([`palette_rows`]); [`shortcuts`] binds the
//! part the shell handles (U10a added `nav.commandPalette` and
//! `nav.cheatsheet`).

use std::rc::Rc;

use gpui_kit::{Action, App, KeyBinding, KeyBindingContextPredicate};

/// The key context of the shell's root element.
pub const CONTEXT: &str = "ClaudiusShell";

gpui_kit::actions!(
    shell,
    [
        NextTab,
        PrevTab,
        NewTab,
        CloseTab,
        ReopenTab,
        LastTab,
        GoTab1,
        GoTab2,
        GoTab3,
        GoTab4,
        GoTab5,
        GoTab6,
        GoTab7,
        GoTab8,
        SelectTab1,
        SelectTab2,
        SelectTab3,
        SelectTab4,
        SelectTab5,
        SelectTab6,
        SelectTab7,
        SelectTab8,
        SelectTab9,
        NextWorkspace,
        PrevWorkspace,
        GoWorkspace1,
        GoWorkspace2,
        GoWorkspace3,
        GoWorkspace4,
        GoWorkspace5,
        GoWorkspace6,
        GoWorkspace7,
        GoWorkspace8,
        GoWorkspace9,
        NavChat,
        NavGit,
        NavSessions,
        NavFiles,
        NavMemory,
        NavAssets,
        NavCost,
        NavAgents,
        NavSkills,
        NavMcp,
        NavHooks,
        NavSchedule,
        NavPermissions,
        NavDocker,
        NavTracker,
        NavDatabase,
        NavNotebooks,
        NavWorkspace,
        CycleFocus,
        OpenSettings,
        GoBack,
        GoForward,
        CycleAppearance,
        ToggleCommandPalette,
        ToggleCheatsheet,
    ]
);

/// A registry binding (`ShortcutBinding`). `code: None` is a
/// modifier-only binding whose handler owns the keys (1–9).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Binding {
    pub cmd: bool,
    pub alt: bool,
    pub shift: bool,
    pub code: Option<&'static str>,
}

const fn b(cmd: bool, alt: bool, shift: bool, code: &'static str) -> Binding {
    Binding {
        cmd,
        alt,
        shift,
        code: Some(code),
    }
}

/// A registry action the shell handles.
pub struct Shortcut {
    /// The registry id (`"tab.next"`).
    pub id: &'static str,
    pub label: &'static str,
    pub binding: Binding,
    /// The action it dispatches.
    pub action: fn() -> Box<dyn Action>,
}

fn boxed<A: Action + Default>() -> Box<dyn Action> {
    Box::new(A::default())
}

macro_rules! shortcut {
    ($id:literal, $label:literal, $binding:expr, $action:ty) => {
        Shortcut {
            id: $id,
            label: $label,
            binding: $binding,
            action: boxed::<$action>,
        }
    };
}

/// The shell's shortcuts with their default bindings, in the registry's
/// order. `tab.selectByNumber` (⌘⇧ + 1–9) is listed per digit; the browser
/// history's ⌘[ / ⌘] and the appearance toggle are the native shell's own.
pub fn shortcuts() -> Vec<Shortcut> {
    let (t, f) = (true, false);
    vec![
        shortcut!("tab.next", "Next tab", b(t, t, f, "ArrowRight"), NextTab),
        shortcut!("tab.prev", "Previous tab", b(t, t, f, "ArrowLeft"), PrevTab),
        shortcut!(
            "tab.selectByNumber",
            "Select tab 1",
            b(t, f, t, "Digit1"),
            SelectTab1
        ),
        shortcut!(
            "tab.selectByNumber",
            "Select tab 2",
            b(t, f, t, "Digit2"),
            SelectTab2
        ),
        shortcut!(
            "tab.selectByNumber",
            "Select tab 3",
            b(t, f, t, "Digit3"),
            SelectTab3
        ),
        shortcut!(
            "tab.selectByNumber",
            "Select tab 4",
            b(t, f, t, "Digit4"),
            SelectTab4
        ),
        shortcut!(
            "tab.selectByNumber",
            "Select tab 5",
            b(t, f, t, "Digit5"),
            SelectTab5
        ),
        shortcut!(
            "tab.selectByNumber",
            "Select tab 6",
            b(t, f, t, "Digit6"),
            SelectTab6
        ),
        shortcut!(
            "tab.selectByNumber",
            "Select tab 7",
            b(t, f, t, "Digit7"),
            SelectTab7
        ),
        shortcut!(
            "tab.selectByNumber",
            "Select tab 8",
            b(t, f, t, "Digit8"),
            SelectTab8
        ),
        shortcut!(
            "tab.selectByNumber",
            "Select tab 9 (the last past 9)",
            b(t, f, t, "Digit9"),
            SelectTab9
        ),
        shortcut!(
            "workspace.next",
            "Next workspace",
            b(t, f, t, "BracketRight"),
            NextWorkspace
        ),
        shortcut!(
            "workspace.prev",
            "Previous workspace",
            b(t, f, t, "BracketLeft"),
            PrevWorkspace
        ),
        shortcut!(
            "workspace.go1",
            "Go to workspace 1",
            b(t, t, f, "Digit1"),
            GoWorkspace1
        ),
        shortcut!(
            "workspace.go2",
            "Go to workspace 2",
            b(t, t, f, "Digit2"),
            GoWorkspace2
        ),
        shortcut!(
            "workspace.go3",
            "Go to workspace 3",
            b(t, t, f, "Digit3"),
            GoWorkspace3
        ),
        shortcut!(
            "workspace.go4",
            "Go to workspace 4",
            b(t, t, f, "Digit4"),
            GoWorkspace4
        ),
        shortcut!(
            "workspace.go5",
            "Go to workspace 5",
            b(t, t, f, "Digit5"),
            GoWorkspace5
        ),
        shortcut!(
            "workspace.go6",
            "Go to workspace 6",
            b(t, t, f, "Digit6"),
            GoWorkspace6
        ),
        shortcut!(
            "workspace.go7",
            "Go to workspace 7",
            b(t, t, f, "Digit7"),
            GoWorkspace7
        ),
        shortcut!(
            "workspace.go8",
            "Go to workspace 8",
            b(t, t, f, "Digit8"),
            GoWorkspace8
        ),
        shortcut!(
            "workspace.go9",
            "Go to workspace 9",
            b(t, t, f, "Digit9"),
            GoWorkspace9
        ),
        shortcut!("nav.chat", "Open Chat", b(t, t, f, "KeyC"), NavChat),
        shortcut!(
            "nav.sessions",
            "Open Sessions",
            b(t, t, f, "KeyS"),
            NavSessions
        ),
        shortcut!("nav.files", "Open Files", b(t, t, f, "KeyF"), NavFiles),
        shortcut!("nav.git", "Open Git", b(t, t, f, "KeyG"), NavGit),
        shortcut!("nav.memory", "Open Memory", b(t, t, f, "KeyM"), NavMemory),
        shortcut!("nav.assets", "Open Assets", b(t, t, f, "KeyI"), NavAssets),
        shortcut!("nav.cost", "Open Cost", b(t, t, f, "KeyB"), NavCost),
        shortcut!("nav.agents", "Open Agents", b(t, t, f, "KeyA"), NavAgents),
        shortcut!("nav.skills", "Open Skills", b(t, t, f, "KeyK"), NavSkills),
        shortcut!("nav.mcp", "Open MCP", b(t, t, f, "KeyN"), NavMcp),
        shortcut!("nav.hooks", "Open Hooks", b(t, t, f, "KeyH"), NavHooks),
        shortcut!(
            "nav.schedule",
            "Open Schedule",
            b(t, t, f, "KeyL"),
            NavSchedule
        ),
        shortcut!(
            "nav.permissions",
            "Open Permissions",
            b(t, t, f, "KeyP"),
            NavPermissions
        ),
        shortcut!("nav.docker", "Open Docker", b(t, t, f, "KeyD"), NavDocker),
        shortcut!(
            "nav.tracker",
            "Open Tracker",
            b(t, t, f, "KeyR"),
            NavTracker
        ),
        shortcut!(
            "nav.database",
            "Open Database",
            b(t, t, f, "KeyE"),
            NavDatabase
        ),
        shortcut!(
            "nav.notebooks",
            "Open Notebooks",
            b(t, t, f, "KeyJ"),
            NavNotebooks
        ),
        shortcut!(
            "nav.workspace",
            "Open Workspace settings",
            b(t, t, f, "KeyW"),
            NavWorkspace
        ),
        shortcut!("tab.new", "New tab", b(t, f, f, "KeyT"), NewTab),
        shortcut!("tab.close", "Close tab", b(t, f, f, "KeyW"), CloseTab),
        shortcut!(
            "tab.reopen",
            "Reopen closed tab",
            b(t, f, t, "KeyT"),
            ReopenTab
        ),
        shortcut!("tab.last", "Last tab", b(t, f, f, "Digit9"), LastTab),
        shortcut!("tab.go1", "Go to tab 1", b(t, f, f, "Digit1"), GoTab1),
        shortcut!("tab.go2", "Go to tab 2", b(t, f, f, "Digit2"), GoTab2),
        shortcut!("tab.go3", "Go to tab 3", b(t, f, f, "Digit3"), GoTab3),
        shortcut!("tab.go4", "Go to tab 4", b(t, f, f, "Digit4"), GoTab4),
        shortcut!("tab.go5", "Go to tab 5", b(t, f, f, "Digit5"), GoTab5),
        shortcut!("tab.go6", "Go to tab 6", b(t, f, f, "Digit6"), GoTab6),
        shortcut!("tab.go7", "Go to tab 7", b(t, f, f, "Digit7"), GoTab7),
        shortcut!("tab.go8", "Go to tab 8", b(t, f, f, "Digit8"), GoTab8),
        shortcut!(
            "view.focusMode",
            "Cycle focus mode",
            b(t, f, f, "Period"),
            CycleFocus
        ),
        shortcut!(
            "app.preferences",
            "Open Settings",
            b(t, f, f, "Comma"),
            OpenSettings
        ),
        shortcut!("history.back", "Back", b(t, f, f, "BracketLeft"), GoBack),
        shortcut!(
            "history.forward",
            "Forward",
            b(t, f, f, "BracketRight"),
            GoForward
        ),
        shortcut!(
            "view.appearance",
            "Cycle appearance (system, light, dark)",
            b(t, t, t, "KeyL"),
            CycleAppearance
        ),
        shortcut!(
            "nav.commandPalette",
            "Open command palette",
            b(t, f, f, "KeyK"),
            ToggleCommandPalette
        ),
        shortcut!(
            "nav.cheatsheet",
            "Show keyboard cheatsheet",
            b(t, f, f, "Slash"),
            ToggleCheatsheet
        ),
    ]
}

/// The registry binding of an action id, for tooltips.
pub fn binding_of(id: &str) -> Option<Binding> {
    shortcuts()
        .into_iter()
        .find(|s| s.id == id)
        .map(|s| s.binding)
}

/// A `KeyboardEvent.code` as GPUI's key name.
fn key_name(code: &str) -> Option<&'static str> {
    const NAMED: [(&str, &str); 9] = [
        ("ArrowLeft", "left"),
        ("ArrowRight", "right"),
        ("ArrowUp", "up"),
        ("ArrowDown", "down"),
        ("BracketLeft", "["),
        ("BracketRight", "]"),
        ("Period", "."),
        ("Comma", ","),
        ("Slash", "/"),
    ];
    const LETTERS: [&str; 26] = [
        "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o", "p", "q", "r",
        "s", "t", "u", "v", "w", "x", "y", "z",
    ];
    const DIGITS: [&str; 10] = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];
    if let Some((_, k)) = NAMED.iter().find(|(c, _)| *c == code) {
        return Some(k);
    }
    if let Some(l) = code.strip_prefix("Key") {
        return LETTERS.iter().find(|x| x.eq_ignore_ascii_case(l)).copied();
    }
    let d = code.strip_prefix("Digit")?;
    DIGITS.iter().find(|x| **x == d).copied()
}

/// The US-layout character a shifted key types, which macOS can report as
/// the key (`⌘⇧]` as `⌘}`).
fn shifted(key: &str) -> Option<&'static str> {
    const PAIRS: [(&str, &str); 12] = [
        ("1", "!"),
        ("2", "@"),
        ("3", "#"),
        ("4", "$"),
        ("5", "%"),
        ("6", "^"),
        ("7", "&"),
        ("8", "*"),
        ("9", "("),
        ("0", ")"),
        ("[", "{"),
        ("]", "}"),
    ];
    PAIRS.iter().find(|(k, _)| *k == key).map(|(_, s)| *s)
}

/// The GPUI keystrokes a binding matches: `cmd-alt-right`, and for a
/// shifted digit or bracket also the typed form (`cmd-}`). `mac` picks ⌘
/// or Ctrl for `mod`.
pub fn keystrokes(binding: Binding, mac: bool) -> Vec<String> {
    let Some(key) = binding.code.and_then(key_name) else {
        return Vec::new();
    };
    let mut mods = Vec::new();
    if binding.cmd {
        mods.push(if mac { "cmd" } else { "ctrl" });
    }
    if binding.alt {
        mods.push("alt");
    }
    let join = |mods: &[&str], key: &str| {
        let mut parts = mods.to_vec();
        parts.push(key);
        parts.join("-")
    };
    let mut out = Vec::new();
    if binding.shift {
        let mut with_shift = mods.clone();
        with_shift.push("shift");
        out.push(join(&with_shift, key));
        if let Some(typed) = shifted(key) {
            out.push(join(&mods, typed));
        }
    } else {
        out.push(join(&mods, key));
    }
    out
}

/// Binds every shortcut in the shell's key context.
pub fn bind(cx: &mut App) {
    let mac = cfg!(target_os = "macos");
    let context = Rc::new(
        KeyBindingContextPredicate::parse(CONTEXT).expect("the shell's context is a predicate"),
    );
    let mut bindings = Vec::new();
    for s in shortcuts() {
        for keys in keystrokes(s.binding, mac) {
            let binding =
                KeyBinding::load(&keys, (s.action)(), Some(context.clone()), false, None, cx)
                    .unwrap_or_else(|e| panic!("{keys} is a keystroke: {e}"));
            bindings.push(binding);
        }
    }
    cx.bind_keys(bindings);
}

/// `formatBinding`: `⌘⌥→` on macOS, `Ctrl+Alt+Right` elsewhere; a
/// modifier-only binding ends in `1…9` / `1-9`.
pub fn format_binding(binding: Binding, mac: bool) -> String {
    let mut parts: Vec<String> = Vec::new();
    if binding.cmd {
        parts.push(if mac { "⌘" } else { "Ctrl" }.into());
    }
    if binding.alt {
        parts.push(if mac { "⌥" } else { "Alt" }.into());
    }
    if binding.shift {
        parts.push(if mac { "⇧" } else { "Shift" }.into());
    }
    match binding.code {
        Some(code) => parts.push(format_code(code, mac)),
        None => parts.push(if mac { "1…9" } else { "1-9" }.into()),
    }
    if mac { parts.concat() } else { parts.join("+") }
}

/// `formatCode`.
fn format_code(code: &str, mac: bool) -> String {
    if let Some(k) = code.strip_prefix("Key") {
        return k.into();
    }
    if let Some(d) = code.strip_prefix("Digit") {
        return d.into();
    }
    let s = match code {
        "ArrowLeft" if mac => "←",
        "ArrowLeft" => "Left",
        "ArrowRight" if mac => "→",
        "ArrowRight" => "Right",
        "ArrowUp" if mac => "↑",
        "ArrowUp" => "Up",
        "ArrowDown" if mac => "↓",
        "ArrowDown" => "Down",
        "BracketLeft" => "[",
        "BracketRight" => "]",
        "Comma" => ",",
        "Period" => ".",
        "Slash" => "/",
        "Backslash" => "\\",
        "Semicolon" => ";",
        "Quote" => "'",
        "Minus" => "-",
        "Equal" => "=",
        "Backquote" => "`",
        "Space" => "Space",
        "Enter" if mac => "\u{21a9}\u{fe0e}",
        "Enter" => "Enter",
        "Escape" => "Esc",
        "Tab" => "Tab",
        "Backspace" if mac => "\u{232b}",
        "Backspace" => "Backspace",
        other => other,
    };
    s.into()
}

/// `ShortcutCategory`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Category {
    Tabs,
    Workspaces,
    Navigation,
    Window,
    View,
    App,
}

impl Category {
    /// The TS id (`"tabs"`).
    pub fn id(self) -> &'static str {
        match self {
            Category::Tabs => "tabs",
            Category::Workspaces => "workspaces",
            Category::Navigation => "navigation",
            Category::Window => "window",
            Category::View => "view",
            Category::App => "app",
        }
    }
}

/// A `SHORTCUT_ACTIONS` entry (`ShortcutAction`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RegistryAction {
    pub id: &'static str,
    pub label: &'static str,
    pub description: Option<&'static str>,
    pub category: Category,
    /// The default binding; `None` is "no default (off)".
    pub default: Option<Binding>,
    /// The handler owns the key range (`tab.selectByNumber`'s 1–9).
    pub modifier_only: bool,
    /// `electronMenuOwned`.
    pub menu_owned: bool,
}

const fn reg(
    id: &'static str,
    label: &'static str,
    description: Option<&'static str>,
    category: Category,
    default: Option<Binding>,
    modifier_only: bool,
    menu_owned: bool,
) -> RegistryAction {
    RegistryAction {
        id,
        label,
        description,
        category,
        default,
        modifier_only,
        menu_owned,
    }
}

/// `SHORTCUT_ACTIONS` (lib/client/shortcuts.ts:92-374), in the registry's
/// order. `tests/palette_golden.rs` checks it against the TS entry by
/// entry, and the shell's bindings ([`shortcuts`]) against it.
pub const REGISTRY: [RegistryAction; 61] = [
    reg(
        "tab.next",
        "Next tab",
        Some("Cycle to the next session tab. Wraps at the end."),
        Category::Tabs,
        Some(b(true, true, false, "ArrowRight")),
        false,
        true,
    ),
    reg(
        "tab.prev",
        "Previous tab",
        Some("Cycle to the previous session tab. Wraps at the start."),
        Category::Tabs,
        Some(b(true, true, false, "ArrowLeft")),
        false,
        true,
    ),
    reg(
        "tab.selectByNumber",
        "Select tab by number",
        Some(
            "Pressed with 1\u{2013}9 selects that tab (or the last tab when 9 is pressed and >9 tabs are open).",
        ),
        Category::Tabs,
        Some(Binding {
            cmd: true,
            alt: false,
            shift: true,
            code: None,
        }),
        true,
        false,
    ),
    reg(
        "workspace.next",
        "Next workspace",
        Some("Cycle to the next workspace in the rail."),
        Category::Workspaces,
        Some(b(true, false, true, "BracketRight")),
        false,
        false,
    ),
    reg(
        "workspace.prev",
        "Previous workspace",
        Some("Cycle to the previous workspace in the rail."),
        Category::Workspaces,
        Some(b(true, false, true, "BracketLeft")),
        false,
        false,
    ),
    reg(
        "workspace.go1",
        "Go to workspace 1",
        Some(
            "Jump to the workspace in position 1 of the rail. No-op when fewer workspaces are configured.",
        ),
        Category::Workspaces,
        Some(b(true, true, false, "Digit1")),
        false,
        false,
    ),
    reg(
        "workspace.go2",
        "Go to workspace 2",
        Some(
            "Jump to the workspace in position 2 of the rail. No-op when fewer workspaces are configured.",
        ),
        Category::Workspaces,
        Some(b(true, true, false, "Digit2")),
        false,
        false,
    ),
    reg(
        "workspace.go3",
        "Go to workspace 3",
        Some(
            "Jump to the workspace in position 3 of the rail. No-op when fewer workspaces are configured.",
        ),
        Category::Workspaces,
        Some(b(true, true, false, "Digit3")),
        false,
        false,
    ),
    reg(
        "workspace.go4",
        "Go to workspace 4",
        Some(
            "Jump to the workspace in position 4 of the rail. No-op when fewer workspaces are configured.",
        ),
        Category::Workspaces,
        Some(b(true, true, false, "Digit4")),
        false,
        false,
    ),
    reg(
        "workspace.go5",
        "Go to workspace 5",
        Some(
            "Jump to the workspace in position 5 of the rail. No-op when fewer workspaces are configured.",
        ),
        Category::Workspaces,
        Some(b(true, true, false, "Digit5")),
        false,
        false,
    ),
    reg(
        "workspace.go6",
        "Go to workspace 6",
        Some(
            "Jump to the workspace in position 6 of the rail. No-op when fewer workspaces are configured.",
        ),
        Category::Workspaces,
        Some(b(true, true, false, "Digit6")),
        false,
        false,
    ),
    reg(
        "workspace.go7",
        "Go to workspace 7",
        Some(
            "Jump to the workspace in position 7 of the rail. No-op when fewer workspaces are configured.",
        ),
        Category::Workspaces,
        Some(b(true, true, false, "Digit7")),
        false,
        false,
    ),
    reg(
        "workspace.go8",
        "Go to workspace 8",
        Some(
            "Jump to the workspace in position 8 of the rail. No-op when fewer workspaces are configured.",
        ),
        Category::Workspaces,
        Some(b(true, true, false, "Digit8")),
        false,
        false,
    ),
    reg(
        "workspace.go9",
        "Go to workspace 9",
        Some(
            "Jump to the workspace in position 9 of the rail. No-op when fewer workspaces are configured.",
        ),
        Category::Workspaces,
        Some(b(true, true, false, "Digit9")),
        false,
        false,
    ),
    reg(
        "nav.chat",
        "Open Chat",
        None,
        Category::Navigation,
        Some(b(true, true, false, "KeyC")),
        false,
        false,
    ),
    reg(
        "nav.sessions",
        "Open Sessions",
        None,
        Category::Navigation,
        Some(b(true, true, false, "KeyS")),
        false,
        false,
    ),
    reg(
        "nav.files",
        "Open Files",
        None,
        Category::Navigation,
        Some(b(true, true, false, "KeyF")),
        false,
        false,
    ),
    reg(
        "nav.git",
        "Open Git",
        None,
        Category::Navigation,
        Some(b(true, true, false, "KeyG")),
        false,
        false,
    ),
    reg(
        "nav.memory",
        "Open Memory",
        None,
        Category::Navigation,
        Some(b(true, true, false, "KeyM")),
        false,
        false,
    ),
    reg(
        "nav.assets",
        "Open Assets",
        None,
        Category::Navigation,
        Some(b(true, true, false, "KeyI")),
        false,
        false,
    ),
    reg(
        "nav.cost",
        "Open Cost",
        None,
        Category::Navigation,
        Some(b(true, true, false, "KeyB")),
        false,
        false,
    ),
    reg(
        "nav.agents",
        "Open Agents",
        None,
        Category::Navigation,
        Some(b(true, true, false, "KeyA")),
        false,
        false,
    ),
    reg(
        "nav.skills",
        "Open Skills",
        None,
        Category::Navigation,
        Some(b(true, true, false, "KeyK")),
        false,
        false,
    ),
    reg(
        "nav.mcp",
        "Open MCP",
        None,
        Category::Navigation,
        Some(b(true, true, false, "KeyN")),
        false,
        false,
    ),
    reg(
        "nav.hooks",
        "Open Hooks",
        None,
        Category::Navigation,
        Some(b(true, true, false, "KeyH")),
        false,
        false,
    ),
    reg(
        "nav.schedule",
        "Open Schedule",
        None,
        Category::Navigation,
        Some(b(true, true, false, "KeyL")),
        false,
        false,
    ),
    reg(
        "nav.permissions",
        "Open Permissions",
        None,
        Category::Navigation,
        Some(b(true, true, false, "KeyP")),
        false,
        false,
    ),
    reg(
        "nav.docker",
        "Open Docker",
        None,
        Category::Navigation,
        Some(b(true, true, false, "KeyD")),
        false,
        false,
    ),
    reg(
        "nav.tracker",
        "Open Tracker",
        None,
        Category::Navigation,
        Some(b(true, true, false, "KeyR")),
        false,
        false,
    ),
    reg(
        "nav.database",
        "Open Database",
        None,
        Category::Navigation,
        Some(b(true, true, false, "KeyE")),
        false,
        false,
    ),
    reg(
        "nav.notebooks",
        "Open Notebooks",
        None,
        Category::Navigation,
        Some(b(true, true, false, "KeyJ")),
        false,
        false,
    ),
    reg(
        "nav.workspace",
        "Open Workspace settings",
        None,
        Category::Navigation,
        Some(b(true, true, false, "KeyW")),
        false,
        false,
    ),
    reg(
        "tab.new",
        "New tab",
        Some(
            "Open a new chat session in a new tab. In the browser build this chord is reserved \u{2014} remap to Cmd+Shift+N if needed.",
        ),
        Category::Tabs,
        Some(b(true, false, false, "KeyT")),
        false,
        true,
    ),
    reg(
        "tab.close",
        "Close tab",
        Some(
            "Close the active tab. On the last remaining tab, opens a fresh chat instead of closing the window.",
        ),
        Category::Tabs,
        Some(b(true, false, false, "KeyW")),
        false,
        true,
    ),
    reg(
        "tab.reopen",
        "Reopen closed tab",
        Some("Restore the most recently closed tab."),
        Category::Tabs,
        Some(b(true, false, true, "KeyT")),
        false,
        true,
    ),
    reg(
        "tab.last",
        "Last tab",
        Some("Jump to the rightmost tab."),
        Category::Tabs,
        Some(b(true, false, false, "Digit9")),
        false,
        true,
    ),
    reg(
        "tab.go1",
        "Go to tab 1",
        None,
        Category::Tabs,
        Some(b(true, false, false, "Digit1")),
        false,
        true,
    ),
    reg(
        "tab.go2",
        "Go to tab 2",
        None,
        Category::Tabs,
        Some(b(true, false, false, "Digit2")),
        false,
        true,
    ),
    reg(
        "tab.go3",
        "Go to tab 3",
        None,
        Category::Tabs,
        Some(b(true, false, false, "Digit3")),
        false,
        true,
    ),
    reg(
        "tab.go4",
        "Go to tab 4",
        None,
        Category::Tabs,
        Some(b(true, false, false, "Digit4")),
        false,
        true,
    ),
    reg(
        "tab.go5",
        "Go to tab 5",
        None,
        Category::Tabs,
        Some(b(true, false, false, "Digit5")),
        false,
        true,
    ),
    reg(
        "tab.go6",
        "Go to tab 6",
        None,
        Category::Tabs,
        Some(b(true, false, false, "Digit6")),
        false,
        true,
    ),
    reg(
        "tab.go7",
        "Go to tab 7",
        None,
        Category::Tabs,
        Some(b(true, false, false, "Digit7")),
        false,
        true,
    ),
    reg(
        "tab.go8",
        "Go to tab 8",
        None,
        Category::Tabs,
        Some(b(true, false, false, "Digit8")),
        false,
        true,
    ),
    reg(
        "nav.commandPalette",
        "Open command palette",
        Some("Fuzzy-search across nav, sessions, slash commands, and shortcuts."),
        Category::Navigation,
        Some(b(true, false, false, "KeyK")),
        false,
        false,
    ),
    reg(
        "nav.toggleSidebar",
        "Toggle sidebar",
        Some("Show or hide the left navigation rail."),
        Category::Navigation,
        Some(b(true, false, false, "KeyB")),
        false,
        false,
    ),
    reg(
        "nav.cheatsheet",
        "Show keyboard cheatsheet",
        Some("Open the keyboard-shortcut help overlay."),
        Category::Navigation,
        Some(b(true, false, false, "Slash")),
        false,
        false,
    ),
    reg(
        "nav.findSession",
        "Find session",
        Some("Focus the search box on the Sessions page."),
        Category::Navigation,
        Some(b(true, false, false, "KeyF")),
        false,
        false,
    ),
    reg(
        "view.focusMode",
        "Cycle focus mode",
        Some("Cycle off \u{2192} focus \u{2192} zen (hide rails, then everything but chat)."),
        Category::Navigation,
        Some(b(true, false, false, "Period")),
        false,
        false,
    ),
    reg(
        "session.focusTitle",
        "Rename session",
        Some("Focus the session title input so you can rename the current session."),
        Category::Navigation,
        Some(b(true, true, false, "KeyT")),
        false,
        false,
    ),
    reg(
        "window.minimize",
        "Minimize window",
        None,
        Category::Window,
        Some(b(true, false, false, "KeyM")),
        false,
        true,
    ),
    reg(
        "window.zoom",
        "Zoom window",
        Some("macOS only \u{2014} toggle the green traffic-light zoom."),
        Category::Window,
        None,
        false,
        true,
    ),
    reg(
        "window.toggleFullscreen",
        "Toggle fullscreen",
        None,
        Category::Window,
        Some(b(true, false, false, "KeyF")),
        false,
        true,
    ),
    reg(
        "view.toggleDevTools",
        "Toggle developer tools",
        None,
        Category::View,
        Some(b(true, true, false, "KeyI")),
        false,
        true,
    ),
    reg(
        "view.reload",
        "Reload window",
        None,
        Category::View,
        Some(b(true, false, false, "KeyR")),
        false,
        true,
    ),
    reg(
        "view.zoomIn",
        "Zoom in",
        None,
        Category::View,
        Some(b(true, false, false, "Equal")),
        false,
        true,
    ),
    reg(
        "view.zoomOut",
        "Zoom out",
        None,
        Category::View,
        Some(b(true, false, false, "Minus")),
        false,
        true,
    ),
    reg(
        "view.zoomReset",
        "Actual size",
        None,
        Category::View,
        Some(b(true, false, false, "Digit0")),
        false,
        true,
    ),
    reg(
        "app.preferences",
        "Open Settings",
        None,
        Category::App,
        Some(b(true, false, false, "Comma")),
        false,
        true,
    ),
    reg(
        "app.openWorkspace",
        "Open Workspace\u{2026}",
        Some("Pick a folder to add as a workspace."),
        Category::App,
        Some(b(true, false, false, "KeyO")),
        false,
        true,
    ),
    reg(
        "app.quit",
        "Quit Claudius",
        None,
        Category::App,
        Some(b(true, false, false, "KeyQ")),
        false,
        true,
    ),
];

/// The registry as the command palette's shortcut rows and the cheatsheet
/// list it: each action's chord is `formatBinding(default)` for the
/// platform (`mac`), `None` without a default.
pub fn palette_rows(mac: bool) -> Vec<claudius_overlays::ShortcutRow> {
    REGISTRY
        .iter()
        .map(|a| claudius_overlays::ShortcutRow {
            id: a.id.into(),
            label: a.label.into(),
            description: a.description.map(Into::into),
            category: a.category.id().into(),
            chord: a.default.map(|b| format_binding(b, mac)),
        })
        .collect()
}
