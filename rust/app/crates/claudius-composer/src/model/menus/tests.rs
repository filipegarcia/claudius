//! The pickers in the model, one test per PromptInput / picker behavior.

use super::*;

const CWD: &str = "/w/proj";

fn ok(body: Value) -> FetchOutcome {
    FetchOutcome::Response {
        status: 200,
        body: body.to_string(),
    }
}

fn status(code: u16, body: Value) -> FetchOutcome {
    FetchOutcome::Response {
        status: code,
        body: body.to_string(),
    }
}

fn session() -> SessionView {
    SessionView {
        session_id: Some("s1".into()),
        ready: true,
        slash_commands: vec!["deploy".into(), "compact".into()],
        skills: vec!["deploy".into()],
        cwd: Some(CWD.into()),
        ..SessionView::default()
    }
}

/// The GET among `outs` whose URL starts with `prefix`.
fn get(outs: &[Out], prefix: &str) -> Option<FetchId> {
    outs.iter().find_map(|o| match o {
        Out::Fetch(r) if r.method == "GET" && r.url.starts_with(prefix) => Some(r.id),
        _ => None,
    })
}

fn urls(outs: &[Out]) -> Vec<String> {
    outs.iter()
        .filter_map(|o| match o {
            Out::Fetch(r) => Some(r.url.clone()),
            _ => None,
        })
        .collect()
}

/// Bound to s1, its draft seeded empty, the session observed, the SDK's
/// command list in.
fn ready() -> Composer {
    let mut c = Composer::new();
    let outs = c.bind(Some("s1"));
    let seed = get(&outs, "/api/sessions/s1/prompt-draft").unwrap();
    c.fetch_settled(seed, &ok(json!({"text": ""})));
    let cmds = get(&outs, "/api/sessions/s1/commands").unwrap();
    c.fetch_settled(
        cmds,
        &ok(json!({"commands": [
            {"name": "deploy", "description": "Ship it.", "argumentHint": "<env>"},
            {"name": "lint:fix", "description": "Fix lints.", "builtin": true},
        ]})),
    );
    let outs = c.observe(&session());
    if let Some(id) = get(&outs, "/api/settings") {
        c.fetch_settled(id, &ok(json!({"settings": {}})));
    }
    c
}

fn typed(c: &mut Composer, text: &str) -> Vec<Out> {
    c.edited(text, text.len(), false)
}

fn press(c: &mut Composer, key: &str) -> KeyOutcome {
    let n = c.value().len();
    c.key(
        &Key::named(key),
        Selection { start: n, end: n },
        &session(),
        10_000.0,
        false,
    )
}

fn slash(c: &Composer) -> SlashMenu {
    match c.menu() {
        Some(Menu::Slash(m)) => m,
        other => panic!("not the slash picker: {other:?}"),
    }
}

fn at(c: &Composer) -> AtMenuView {
    match c.menu() {
        Some(Menu::At(m)) => m,
        other => panic!("not the @ picker: {other:?}"),
    }
}

fn emoji_menu(c: &Composer) -> EmojiMenu {
    match c.menu() {
        Some(Menu::Emoji(m)) => m,
        other => panic!("not the emoji picker: {other:?}"),
    }
}

fn sends(outs: &[Out]) -> Vec<String> {
    outs.iter()
        .filter_map(|o| match o {
            Out::Call {
                call: SessionCall::Send { text, .. },
                ..
            } => Some(text.clone()),
            _ => None,
        })
        .collect()
}

// ---------------------------------------------------------------- slash

#[test]
fn a_slash_opens_the_picker_with_the_registry_and_the_sessions_commands() {
    let mut c = ready();
    typed(&mut c, "/");
    let p = c.picker().clone();
    assert!(p.open && p.slash_at_start);
    assert_eq!(p.slash_query.as_deref(), Some(""));
    let m = slash(&c);
    assert_eq!(m.rows.len(), slash::VISIBLE_LIMIT);
    assert_eq!(m.rows[0].header, Some("Session"));
    assert_eq!(m.hi, 0);
    // The SDK's rows are in the full list: the init's skill, the rich
    // list's plugin command (and its `builtin`).
    let all = c.slash_suggestions();
    let deploy = all.iter().find(|s| s.name == "deploy").unwrap();
    assert_eq!(
        (deploy.category, deploy.args_hint.as_deref()),
        (slash::Category::Skill, Some("<env>"))
    );
    assert!(all.iter().any(|s| s.name == "lint:fix" && s.builtin));
}

#[test]
fn typing_filters_and_bolds_the_match() {
    let mut c = ready();
    typed(&mut c, "/dep");
    let m = slash(&c);
    assert_eq!(m.filter, "dep");
    assert_eq!(m.rows[0].suggestion.name, "deploy");
    assert_eq!(m.rows[0].header, None);
    assert_eq!(
        m.rows[0].name,
        vec![("dep".to_owned(), true), ("loy".to_owned(), false)]
    );
    typed(&mut c, "/zzzz");
    assert!(c.menu().is_none());
    assert!(c.picker().open);
}

#[test]
fn arrows_move_the_highlight_and_wrap() {
    let mut c = ready();
    typed(&mut c, "/co");
    let n = slash(&c).rows.len();
    assert!(n > 2);
    assert!(press(&mut c, "ArrowDown").handled);
    assert_eq!(slash(&c).hi, 1);
    press(&mut c, "ArrowUp");
    press(&mut c, "ArrowUp");
    assert_eq!(slash(&c).hi, n - 1);
    press(&mut c, "ArrowDown");
    assert_eq!(slash(&c).hi, 0);
    // A list of another length starts over at the top.
    press(&mut c, "ArrowDown");
    typed(&mut c, "/com");
    assert_eq!(slash(&c).hi, 0);
}

#[test]
fn enter_on_a_leading_slash_runs_a_confident_match() {
    let mut c = ready();
    typed(&mut c, "/comp");
    let o = press(&mut c, "Enter");
    assert!(o.handled);
    assert!(sends(&o.out).is_empty());
    assert_eq!(c.value(), "/compact ");
    assert_eq!(c.caret(), "/compact ".len());
    assert!(!c.picker().open && c.menu().is_none());
    // The pick is a write: the draft saves.
    assert!(o.out.iter().any(|x| matches!(x, Out::SetTimer { .. })));
}

#[test]
fn enter_on_a_slash_typo_is_swallowed() {
    let mut c = ready();
    typed(&mut c, "/cmp");
    assert_eq!(slash(&c).rows[0].suggestion.name, "compact");
    let rev = c.text_rev();
    let o = press(&mut c, "Enter");
    assert!(o.handled && o.out.is_empty());
    assert_eq!((c.value(), c.text_rev()), ("/cmp", rev));
    assert!(c.menu().is_some());
    // Tab still inserts the top row.
    assert!(press(&mut c, "Tab").handled);
    assert_eq!(c.value(), "/compact ");
}

#[test]
fn enter_on_a_bare_slash_breaks_the_line() {
    let mut c = ready();
    typed(&mut c, "/");
    let rev = c.text_rev();
    let o = press(&mut c, "Enter");
    assert!(o.handled && sends(&o.out).is_empty());
    assert_eq!(c.value(), "/\n");
    assert!(c.text_rev() > rev);
    assert!(c.menu().is_none());
}

#[test]
fn enter_mid_prompt_sends_and_tab_inserts() {
    let mut c = ready();
    typed(&mut c, "fix /co");
    assert!(c.picker().open && !c.picker().slash_at_start);
    let mut t = c.clone();
    assert!(press(&mut t, "Tab").handled);
    assert_eq!(t.value(), "fix /compact ");
    let o = press(&mut c, "Enter");
    assert_eq!(sends(&o.out), ["fix /co"]);
}

#[test]
fn escape_closes_the_slash_picker_and_passes_the_key_on() {
    let mut c = ready();
    typed(&mut c, "/co");
    let o = press(&mut c, "Escape");
    assert!(!o.handled && o.out.is_empty());
    assert!(c.menu().is_none() && !c.picker().open);
    assert_eq!(c.value(), "/co");
    // `onKeyDown` never saw it: the next Escape is a first one.
    let o = press(&mut c, "Escape");
    assert!(!o.handled);
    assert_eq!(c.value(), "/co");
    // An edit brings the picker back.
    typed(&mut c, "/com");
    assert!(c.menu().is_some());
}

#[test]
fn cmd_arrows_pass_through_an_open_picker() {
    let mut c = ready();
    typed(&mut c, "/co");
    let n = c.value().len();
    let mut k = Key::named("ArrowDown");
    k.meta = true;
    c.key(
        &k,
        Selection { start: n, end: n },
        &session(),
        10_000.0,
        false,
    );
    assert_eq!(slash(&c).hi, 0);
    // Ctrl too (the history chord on other platforms).
    k.meta = false;
    k.ctrl = true;
    c.key(
        &k,
        Selection { start: n, end: n },
        &session(),
        10_000.0,
        false,
    );
    assert_eq!(slash(&c).hi, 0);
}

#[test]
fn a_recalled_prompt_keeps_the_pickers_closed() {
    let mut c = ready();
    c.inject("/comp", Vec::new(), true);
    assert!(c.menu().is_none());
    c.inject("/comp", Vec::new(), false);
    assert!(c.menu().is_some());
}

#[test]
fn another_sessions_command_list_is_not_shown() {
    let mut c = Composer::new();
    let a = c.bind(Some("a"));
    c.bind(Some("b"));
    let cmds = get(&a, "/api/sessions/a/commands").unwrap();
    c.fetch_settled(cmds, &ok(json!({"commands": [{"name": "only-a"}]})));
    assert!(c.sdk_commands().is_none());
    assert!(!c.slash_suggestions().iter().any(|s| s.name == "only-a"));
}

#[test]
fn a_failed_command_list_falls_back_to_the_registry() {
    let mut c = Composer::new();
    let outs = c.bind(Some("s1"));
    let cmds = get(&outs, "/api/sessions/s1/commands").unwrap();
    c.fetch_settled(cmds, &status(503, json!({"error": "session not active"})));
    assert!(c.sdk_commands().is_none());
    assert_eq!(c.slash_suggestions().len(), slash::SLASH_COMMANDS.len());
}

#[test]
fn a_click_picks_and_a_hover_highlights() {
    let mut c = ready();
    typed(&mut c, "/co");
    c.menu_hover(2);
    assert_eq!(slash(&c).hi, 2);
    let name = slash(&c).rows[1].suggestion.name.clone();
    c.menu_pick(1, 3);
    assert_eq!(c.value(), format!("/{name} "));
}

// -------------------------------------------------------------------- @

#[test]
fn an_at_token_searches_files_and_loads_the_agents() {
    let mut c = ready();
    let outs = typed(&mut c, "see @./src");
    assert_eq!(c.picker().at_query.as_deref(), Some("./src"));
    let u = urls(&outs);
    assert_eq!(
        u[..2],
        [
            "/api/fs/list?q=src&limit=50&cwd=%2Fw%2Fproj".to_owned(),
            "/api/sessions/s1/agents".to_owned()
        ]
    );
    let m = at(&c);
    assert_eq!((m.count.as_str(), m.rows.len()), ("loading\u{2026}", 0));
    let fs = get(&outs, "/api/fs/list").unwrap();
    c.fetch_settled(
        fs,
        &ok(json!({"entries": [
            {"relPath": "src", "type": "dir"},
            {"relPath": "src/lib.rs", "type": "file"},
        ]})),
    );
    let m = at(&c);
    assert_eq!(m.count, "2 files");
    assert_eq!(m.rows[0].icon(), "Folder");
    press(&mut c, "ArrowDown");
    let o = press(&mut c, "Enter");
    assert!(o.handled && sends(&o.out).is_empty());
    assert_eq!(c.value(), "see @src/lib.rs ");
    assert!(c.menu().is_none());
}

#[test]
fn agent_mode_lists_the_sessions_agents() {
    let mut c = ready();
    let outs = typed(&mut c, "@agent-");
    // No file search in agent mode.
    assert!(get(&outs, "/api/fs/list").is_none());
    assert_eq!(at(&c).count, "loading\u{2026}");
    let id = get(&outs, "/api/sessions/s1/agents").unwrap();
    c.fetch_settled(
        id,
        &ok(json!({"agents": [
            {"name": "reviewer", "description": "Reviews.", "model": "sonnet"},
            {"name": "Explore", "description": "Searches."},
        ]})),
    );
    let m = at(&c);
    assert_eq!(m.count, "2 agents");
    assert_eq!(m.rows[0].label(), "Explore");
    assert_eq!(m.rows[1].aside(), Some("sonnet"));
    // The list is cached for the mount: filtering fetches nothing.
    let outs = typed(&mut c, "@agent-rev");
    assert!(urls(&outs).is_empty());
    assert_eq!(at(&c).rows.len(), 1);
    press(&mut c, "Tab");
    assert_eq!(c.value(), "@agent-reviewer ");
}

#[test]
fn a_failed_search_shows_the_error_row() {
    let mut c = ready();
    let outs = typed(&mut c, "@x");
    let fs = get(&outs, "/api/fs/list").unwrap();
    c.fetch_settled(
        fs,
        &status(403, json!({"error": "Search failed: permission denied"})),
    );
    let m = at(&c);
    assert_eq!(m.error.as_deref(), Some("Search failed: permission denied"));
    assert_eq!(m.count, "0 files");
    // No rows: keys pass, Tab moves focus as the browser's would.
    let o = press(&mut c, "Tab");
    assert_eq!(o.move_focus, Some(true));
    // A 400 (no trusted cwd) closes quietly, as an empty answer.
    let outs = typed(&mut c, "@xy");
    let fs = get(&outs, "/api/fs/list").unwrap();
    c.fetch_settled(fs, &status(400, json!({"error": "unknown cwd"})));
    assert!(c.menu().is_none());
}

#[test]
fn a_new_query_shows_loading_until_its_search_lands() {
    let mut c = ready();
    let first = typed(&mut c, "@s");
    c.fetch_settled(
        get(&first, "/api/fs/list").unwrap(),
        &ok(json!({"entries": [{"relPath": "src", "type": "dir"}]})),
    );
    assert_eq!(at(&c).count, "1 file");
    let second = typed(&mut c, "@sr");
    assert_eq!(at(&c).count, "loading\u{2026}");
    c.fetch_settled(
        get(&second, "/api/fs/list").unwrap(),
        &ok(json!({"entries": []})),
    );
    assert!(c.menu().is_none());
}

#[test]
fn a_new_query_aborts_the_last_search() {
    let mut c = ready();
    let first = typed(&mut c, "@s");
    let second = typed(&mut c, "@sr");
    c.fetch_settled(
        get(&first, "/api/fs/list").unwrap(),
        &ok(json!({"entries": [{"relPath": "stale", "type": "file"}]})),
    );
    assert_eq!(at(&c).count, "loading\u{2026}");
    c.fetch_settled(
        get(&second, "/api/fs/list").unwrap(),
        &ok(json!({"entries": [{"relPath": "src", "type": "dir"}]})),
    );
    assert_eq!(at(&c).rows[0].label(), "src");
    // The agent list is fetched once per mount.
    assert!(get(&second, "/api/sessions/s1/agents").is_none());
}

#[test]
fn escape_closes_the_at_picker_and_unmounting_aborts() {
    let mut c = ready();
    let outs = typed(&mut c, "@s");
    let fs = get(&outs, "/api/fs/list").unwrap();
    c.fetch_settled(
        fs,
        &ok(json!({"entries": [{"relPath": "src", "type": "dir"}]})),
    );
    let o = press(&mut c, "Escape");
    assert!(o.handled);
    assert!(c.menu().is_none());
    // A late answer for a closed picker is dropped.
    let outs = typed(&mut c, "@sx");
    typed(&mut c, "done ");
    assert!(
        c.fetch_settled(
            get(&outs, "/api/fs/list").unwrap(),
            &ok(json!({"entries": []}))
        )
        .is_empty()
    );
    assert!(c.menu().is_none());
}

#[test]
fn a_network_failure_closes_the_at_picker_quietly() {
    let mut c = ready();
    let outs = typed(&mut c, "@s");
    c.fetch_settled(
        get(&outs, "/api/fs/list").unwrap(),
        &FetchOutcome::Failed("down".into()),
    );
    assert!(c.menu().is_none());
    assert!(c.picker().at_query.is_some());
    // Enter with nothing to pick breaks the line (the browser default).
    let o = press(&mut c, "Enter");
    assert!(sends(&o.out).is_empty());
    assert_eq!(c.value(), "@s\n");
}

// ---------------------------------------------------------------- emoji

#[test]
fn a_colon_token_offers_shortcodes_and_a_pick_inserts_the_emoji() {
    let mut c = ready();
    typed(&mut c, "hi :smi");
    let m = emoji_menu(&c);
    assert_eq!(m.rows[0], ("smile", "\u{1f604}"));
    assert_eq!(m.count, emoji::count_label(m.rows.len()));
    let o = press(&mut c, "Enter");
    assert!(o.handled && sends(&o.out).is_empty());
    assert_eq!(c.value(), "hi \u{1f604} ");
    assert_eq!(c.caret(), c.value().len());
    assert!(c.menu().is_none());
}

#[test]
fn typing_the_closing_colon_completes_the_emoji() {
    let mut c = ready();
    typed(&mut c, "hi :heart x");
    let rev = c.text_rev();
    // The `:` typed after `heart`, mid-text.
    c.edited("hi :heart: x", "hi :heart:".len(), false);
    let heart = emoji::lookup_emoji_shortcode("heart").unwrap();
    assert_eq!(c.value(), format!("hi {heart} x"));
    assert_eq!(c.caret(), 3 + heart.len());
    assert!(c.text_rev() > rev);
}

#[test]
fn the_setting_turns_emoji_completion_off() {
    let mut c = Composer::new();
    c.bind(Some("s1"));
    let outs = c.observe(&session());
    let id = get(&outs, "/api/settings?scope=user&cwd=%2Fw%2Fproj").unwrap();
    assert!(c.emoji_completion_enabled());
    c.fetch_settled(
        id,
        &ok(json!({"settings": {"emojiCompletionEnabled": false}})),
    );
    assert!(!c.emoji_completion_enabled());
    typed(&mut c, ":smi");
    assert!(c.picker().emoji_query.is_none() && c.menu().is_none());
    typed(&mut c, ":heart");
    c.edited(":heart:", 7, false);
    assert_eq!(c.value(), ":heart:");
    // The same cwd doesn't ask again; another one does.
    assert!(get(&c.observe(&session()), "/api/settings").is_none());
    let mut other = session();
    other.cwd = Some("/w/other".into());
    assert!(get(&c.observe(&other), "/api/settings").is_some());
}

#[test]
fn a_failed_settings_read_keeps_the_setting() {
    let mut c = Composer::new();
    let outs = c.observe(&session());
    let id = get(&outs, "/api/settings").unwrap();
    c.fetch_settled(id, &status(500, json!({})));
    assert!(c.emoji_completion_enabled());
    // No cwd: no request.
    let mut none = session();
    none.cwd = None;
    assert!(get(&c.observe(&none), "/api/settings").is_none());
}

#[test]
fn escape_closes_the_emoji_picker() {
    let mut c = ready();
    typed(&mut c, ":smi");
    assert!(press(&mut c, "Escape").handled);
    assert!(c.menu().is_none());
    assert_eq!(c.value(), ":smi");
}
