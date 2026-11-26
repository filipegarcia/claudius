//! The shell's keyboard shortcuts: the shell-level part of
//! `lib/client/shortcuts.ts`'s registry, with its default bindings, as GPUI
//! actions and key bindings.
//!
//! A binding is the registry's shape (`mod` / `alt` / `shift` plus a
//! `KeyboardEvent.code`); `mod` is ⌘ on macOS and Ctrl elsewhere. User
//! overrides (Settings → shortcuts) are U13's; here every action has its
//! default. The bindings fire wherever focus is in the window, as the
//! Electron menu's do.

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
    const NAMED: [(&str, &str); 8] = [
        ("ArrowLeft", "left"),
        ("ArrowRight", "right"),
        ("ArrowUp", "up"),
        ("ArrowDown", "down"),
        ("BracketLeft", "["),
        ("BracketRight", "]"),
        ("Period", "."),
        ("Comma", ","),
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
        other => other,
    };
    s.into()
}
