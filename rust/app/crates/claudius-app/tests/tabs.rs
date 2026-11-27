//! The session tab strip's rules (`ChatSurface` + `SessionTabs`): open,
//! activate, close, reopen, pin, reorder, the number shortcuts, labels,
//! statuses, what is saved, and which tabs overflow.

use claudius_app::data::{
    ActiveSessionState, LiveStatus, OpenTabs, SessionSummary, TabStatus, active_tab_status,
};
use claudius_app::tabs::{
    TRAILER_PX, TabStrip, UNMEASURED_PX, clamp_reorder_target, hidden_tabs, readable_session_label,
    reorder, short_id, shortcut_for_tab_index, tab_label,
};
use serde_json::json;

fn ids(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| (*s).to_owned()).collect()
}

fn saved(tabs: &[&str], active: Option<&str>, pinned: &[&str]) -> OpenTabs {
    OpenTabs {
        tabs: ids(tabs),
        active_id: active.map(str::to_owned),
        pinned: ids(pinned),
        ..OpenTabs::default()
    }
}

fn hydrated(tabs: &[&str], pinned: &[&str], bound: &str) -> TabStrip {
    let mut s = TabStrip::default();
    s.hydrate(&saved(tabs, None, pinned));
    s.bind(bound);
    s
}

fn session(id: &str, cwd: &str, title: Option<&str>, status: LiveStatus) -> SessionSummary {
    SessionSummary {
        id: id.into(),
        cwd: cwd.into(),
        model: None,
        title: title.map(str::to_owned),
        created_at: 0.,
        status: Some(status),
        account_id: None,
        account_label: None,
    }
}

#[test]
fn hydrate_keeps_ids_bound_before_it_and_sorts_pins_first() {
    let mut s = TabStrip::default();
    assert!(!s.is_hydrated());
    // The boot bound a session before the saved strip answered.
    s.bind("new");
    let mut tabs = saved(&["a", "b", "c"], Some("b"), &["c"]);
    tabs.label_max_width = 240.;
    tabs.titles = serde_json::from_value(json!({"a": "Alpha", "b": "  ", "c": 3})).unwrap();
    s.hydrate(&tabs);
    assert!(s.is_hydrated());
    assert_eq!(s.tabs(), ids(&["c", "a", "b", "new"]));
    assert_eq!(s.pinned(), ids(&["c"]));
    assert_eq!(s.label_max_width(), 240.);
    assert_eq!(s.saved_title("a"), Some("Alpha"));
    // A blank or non-string title is dropped.
    assert_eq!(s.saved_title("b"), None);
    assert_eq!(s.saved_title("c"), None);
    assert_eq!(s.active(), Some("new"));
}

#[test]
fn bind_adds_a_new_id_once_and_select_activates() {
    let mut s = hydrated(&["a", "b"], &[], "a");
    assert_eq!(s.active(), Some("a"));
    s.select("b");
    assert_eq!(s.bound(), Some("b"));
    assert_eq!(s.tabs(), ids(&["a", "b"]));
    s.bind("c");
    assert_eq!(s.tabs(), ids(&["a", "b", "c"]));
    assert_eq!(s.active(), Some("c"));
    // Closing the bound tab binds its neighbour, so binding `c` again is a
    // change of binding: it's back.
    s.close("c");
    assert_eq!(s.bound(), Some("b"));
    s.bind("c");
    assert_eq!(s.tabs(), ids(&["a", "b", "c"]));
    // But the last tab leaves the binding as it was: binding the same id
    // again isn't a change (`lastAddedKey`), so it stays closed.
    let mut one = hydrated(&["a"], &[], "a");
    one.close("a");
    one.bind("a");
    assert!(one.tabs().is_empty());
    assert_eq!(one.active(), None);
}

#[test]
fn closing_the_bound_tab_binds_its_left_neighbour() {
    let mut s = hydrated(&["a", "b", "c"], &[], "b");
    s.close("b");
    assert_eq!(s.tabs(), ids(&["a", "c"]));
    assert_eq!(s.bound(), Some("a"));
    // The first tab's left neighbour is the new first tab.
    s.close("a");
    assert_eq!(s.bound(), Some("c"));
    // An inactive tab closes alone.
    let mut t = hydrated(&["a", "b", "c"], &["c"], "a");
    t.close("c");
    assert_eq!(t.bound(), Some("a"));
    assert!(t.pinned().is_empty());
    // The last tab leaves the session bound (it lingers off the strip).
    let mut u = hydrated(&["a"], &[], "a");
    u.close_active();
    assert!(u.tabs().is_empty());
    assert_eq!(u.bound(), Some("a"));
    assert_eq!(u.active(), None);
    // Closing an id not on the strip changes nothing.
    let before = hydrated(&["a"], &[], "a");
    let mut after = before.clone();
    after.close("zzz");
    assert_eq!(after, before);
}

#[test]
fn reopen_restores_where_it_was_clamped_and_binds_it() {
    let mut s = hydrated(&["a", "b", "c", "d"], &[], "a");
    s.close("c");
    s.close("d");
    s.close("b");
    s.reopen();
    assert_eq!(s.tabs(), ids(&["a", "b"]));
    assert_eq!(s.bound(), Some("b"));
    // `d` was at 2 (after `c` closed); clamped to the end.
    s.reopen();
    assert_eq!(s.tabs(), ids(&["a", "b", "d"]));
    s.reopen();
    assert_eq!(s.tabs(), ids(&["a", "b", "c", "d"]));
    assert_eq!(s.active(), Some("c"));
    // Nothing left to reopen.
    let before = s.clone();
    s.reopen();
    assert_eq!(s, before);
}

#[test]
fn the_closed_stack_keeps_the_last_64() {
    let names: Vec<String> = (0..70).map(|i| format!("t{i}")).collect();
    let refs: Vec<&str> = names.iter().map(String::as_str).collect();
    let mut s = hydrated(&refs, &[], "t0");
    for n in &names[1..] {
        s.close(n);
    }
    let mut reopened = 0;
    loop {
        let before = s.tabs().len();
        s.reopen();
        if s.tabs().len() == before {
            break;
        }
        reopened += 1;
    }
    assert_eq!(reopened, 64);
}

#[test]
fn close_all_keeps_the_pins_and_the_binding() {
    let mut s = hydrated(&["a", "b", "c"], &["b"], "c");
    assert_eq!(s.closable(), ids(&["a", "c"]));
    assert_eq!(s.close_all(), ids(&["a", "c"]));
    assert_eq!(s.tabs(), ids(&["b"]));
    // The quirk: the bound session doesn't change, so no tab is active.
    assert_eq!(s.bound(), Some("c"));
    assert_eq!(s.active(), None);
}

#[test]
fn pins_sort_first_and_reorder_stays_in_its_group() {
    let mut s = hydrated(&["a", "b", "c", "d"], &[], "a");
    s.toggle_pin("c");
    assert_eq!(s.tabs(), ids(&["c", "a", "b", "d"]));
    s.toggle_pin("d");
    assert_eq!(s.tabs(), ids(&["c", "d", "a", "b"]));
    // An unpinned tab dragged into the pins stops at the first unpinned
    // place; a pin dragged right stops at the last pin.
    s.reorder(3, 0);
    assert_eq!(s.tabs(), ids(&["c", "d", "b", "a"]));
    s.reorder(0, 3);
    assert_eq!(s.tabs(), ids(&["d", "c", "b", "a"]));
    s.toggle_pin("c");
    assert_eq!(s.tabs(), ids(&["d", "c", "b", "a"]));
    assert_eq!(s.pinned(), ids(&["d"]));
    assert!(s.is_pinned("d"));
    assert!(!s.is_pinned("c"));

    assert_eq!(clamp_reorder_target(0, 5, 2, 6), 1);
    assert_eq!(clamp_reorder_target(4, 0, 2, 6), 2);
    assert_eq!(clamp_reorder_target(3, 4, 2, 6), 4);
    assert_eq!(clamp_reorder_target(0, 3, 0, 4), 3);
    let mut v = vec![1, 2, 3];
    reorder(&mut v, 0, 2);
    assert_eq!(v, vec![2, 3, 1]);
    reorder(&mut v, 0, 9);
    assert_eq!(v, vec![2, 3, 1]);
}

#[test]
fn cycle_wraps_and_numbers_follow_iterm() {
    let mut s = hydrated(&["a", "b", "c"], &[], "c");
    s.cycle(true);
    assert_eq!(s.active(), Some("a"));
    s.cycle(false);
    assert_eq!(s.active(), Some("c"));
    s.cycle(false);
    assert_eq!(s.active(), Some("b"));
    // Closing a just-added last tab binds the one on its left.
    let mut pins = hydrated(&["a", "b", "c"], &["a", "b", "c"], "x");
    pins.close("x");
    assert_eq!(pins.active(), Some("c"));

    let mut s = hydrated(&["a", "b", "c"], &[], "a");
    s.go_to(3);
    assert_eq!(s.active(), Some("c"));
    s.go_to(4);
    assert_eq!(s.active(), Some("c"));
    s.go_to(0);
    assert_eq!(s.active(), Some("c"));
    s.go_to(1);
    s.go_to_last();
    assert_eq!(s.active(), Some("c"));
    // ⌘⇧9 is nothing under 9 tabs.
    s.select_by_number(1);
    s.select_by_number(9);
    assert_eq!(s.active(), Some("a"));
    s.select_by_number(2);
    assert_eq!(s.active(), Some("b"));

    // Exactly 9 tabs: ⌘⇧9 is the ninth, which is the last.
    let nine: Vec<String> = (1..=9).map(|i| format!("t{i}")).collect();
    let refs: Vec<&str> = nine.iter().map(String::as_str).collect();
    let mut s9 = hydrated(&refs, &[], "t1");
    s9.select_by_number(9);
    assert_eq!(s9.active(), Some("t9"));
    // Eight: nothing.
    let mut s8 = hydrated(&refs[..8], &[], "t1");
    s8.select_by_number(9);
    assert_eq!(s8.active(), Some("t1"));

    let names: Vec<String> = (1..=11).map(|i| format!("t{i}")).collect();
    let refs: Vec<&str> = names.iter().map(String::as_str).collect();
    let mut big = hydrated(&refs, &[], "t1");
    big.select_by_number(9);
    assert_eq!(big.active(), Some("t11"));
    big.select_by_number(8);
    assert_eq!(big.active(), Some("t8"));

    assert_eq!(shortcut_for_tab_index(0, 3), Some(1));
    assert_eq!(shortcut_for_tab_index(2, 3), Some(3));
    assert_eq!(shortcut_for_tab_index(3, 3), None);
    assert_eq!(shortcut_for_tab_index(8, 9), Some(9));
    assert_eq!(shortcut_for_tab_index(7, 12), Some(8));
    assert_eq!(shortcut_for_tab_index(8, 12), None);
    assert_eq!(shortcut_for_tab_index(10, 12), None);
    assert_eq!(shortcut_for_tab_index(11, 12), Some(9));
}

#[test]
fn cycle_with_no_active_tab_starts_at_an_end() {
    // `x` bound, then the strip closed around it: no active tab.
    let mut s = TabStrip::default();
    s.hydrate(&saved(&["a", "b", "c"], None, &[]));
    assert_eq!(s.active(), None);
    let mut f = s.clone();
    f.cycle(true);
    assert_eq!(f.active(), Some("a"));
    let mut b = s.clone();
    b.cycle(false);
    assert_eq!(b.active(), Some("c"));
    let mut e = TabStrip::default();
    e.cycle(true);
    assert_eq!(e.active(), None);
}

#[test]
fn label_width_clamps() {
    let mut s = TabStrip::default();
    assert_eq!(s.set_label_max_width(10.), 60.);
    assert_eq!(s.set_label_max_width(900.), 600.);
    assert_eq!(s.set_label_max_width(222.), 222.);
    assert_eq!(s.label_max_width(), 222.);
}

#[test]
fn persist_waits_for_hydration_and_leaves_foreign_tabs_out() {
    let mut s = TabStrip::default();
    s.bind("a");
    assert_eq!(s.persist("/r", &[]), None);
    s.hydrate(&saved(&["a", "f", "n"], None, &["f", "a"]));
    s.bind("f");
    let sessions = [
        session("a", "/r", None, LiveStatus::Idle),
        session("f", "/elsewhere", None, LiveStatus::Idle),
    ];
    let body = s.persist("/r", &sessions).unwrap();
    // `n` has no row yet: kept. `f` lives elsewhere: out, with its pin and
    // as the active id.
    assert_eq!(body.tabs, Some(ids(&["a", "n"])));
    assert_eq!(body.pinned, Some(ids(&["a"])));
    assert_eq!(body.active_id, Some(None));
    assert_eq!(body.label_max_width, None);
    s.select("a");
    let body = s.persist("/r", &sessions).unwrap();
    assert_eq!(body.active_id, Some(Some("a".into())));
    // The PUT body's JSON: `activeId: null` is sent, absent fields aren't.
    s.select("f");
    let v = serde_json::to_value(s.persist("/r", &sessions).unwrap()).unwrap();
    assert_eq!(
        v,
        json!({"tabs": ["a", "n"], "activeId": null, "pinned": ["a"]})
    );
}

#[test]
fn labels_fall_back_override_title_date_id() {
    let mut row = session("abcdef0123", "/r", Some("  Title  "), LiveStatus::Idle);
    assert_eq!(
        tab_label("abcdef0123", &[row.clone()], None, Some(" Live "), 2026),
        "Live"
    );
    assert_eq!(
        tab_label("abcdef0123", &[row.clone()], None, None, 2026),
        "Title"
    );
    row.title = Some("   ".into());
    row.created_at = 0.;
    assert_eq!(
        tab_label("abcdef0123", &[row.clone()], None, None, 2026),
        "abcdef01"
    );
    row.created_at = f64::NAN;
    assert_eq!(
        tab_label("abcdef0123", &[row.clone()], None, None, 2026),
        "abcdef01"
    );
    row.created_at = 1_782_000_000_000.;
    let label = tab_label("abcdef0123", &[row.clone()], Some("Saved"), None, 2026);
    assert_eq!(label, readable_session_label(row.created_at, 2026));
    // A saved title only counts with no live row.
    assert_eq!(
        tab_label("abcdef0123", &[], Some(" Saved "), None, 2026),
        "Saved"
    );
    assert_eq!(
        tab_label("abcdef0123", &[], Some(" "), None, 2026),
        "abcdef01"
    );
    assert_eq!(short_id("ab"), "ab");
    assert_eq!(short_id("😀😀😀😀😀"), "😀😀😀😀");
}

#[test]
fn readable_labels_read_like_intl() {
    use chrono::{Local, TimeZone};
    let at = |y, mo, d, h, mi| {
        Local
            .with_ymd_and_hms(y, mo, d, h, mi, 0)
            .single()
            .unwrap()
            .timestamp_millis() as f64
    };
    assert_eq!(
        readable_session_label(at(2026, 6, 30, 14, 15), 2026),
        "Jun 30 at 2:15\u{202f}PM"
    );
    assert_eq!(
        readable_session_label(at(2024, 1, 5, 0, 7), 2026),
        "Jan 5, 2024 at 12:07\u{202f}AM"
    );
    assert_eq!(
        readable_session_label(at(2026, 12, 1, 11, 59), 2026),
        "Dec 1 at 11:59\u{202f}AM"
    );
}

#[test]
fn statuses_follow_the_chat_then_the_live_list() {
    let s = |ready, pending, has_error, needs_input| ActiveSessionState {
        ready,
        pending,
        has_error,
        needs_input,
    };
    assert_eq!(
        active_tab_status(s(true, true, true, true)),
        TabStatus::Error
    );
    assert_eq!(
        active_tab_status(s(false, true, false, true)),
        TabStatus::Starting
    );
    assert_eq!(
        active_tab_status(s(true, true, false, true)),
        TabStatus::NeedsInput
    );
    assert_eq!(
        active_tab_status(s(true, true, false, false)),
        TabStatus::Running
    );
    assert_eq!(
        active_tab_status(s(true, false, false, false)),
        TabStatus::Idle
    );

    let strip = hydrated(&["a", "b", "c"], &["c"], "a");
    let live = [
        session("a", "/r", Some("A"), LiveStatus::Running),
        session("b", "/r", None, LiveStatus::NeedsInput),
    ];
    // The bound tab reads the chat's state when there is one.
    let v = strip.view("a", &live, Some(s(true, false, true, false)), 2026);
    assert_eq!(
        (v.status, v.active, v.label.as_str()),
        (TabStatus::Error, true, "A")
    );
    let v = strip.view("a", &live, None, 2026);
    assert_eq!(v.status, TabStatus::Running);
    let v = strip.view("b", &live, Some(s(true, false, true, false)), 2026);
    assert_eq!((v.status, v.active), (TabStatus::NeedsInput, false));
    let v = strip.view("c", &live, None, 2026);
    assert_eq!(v.status, TabStatus::Background);
    assert!(v.pinned && v.compact());
    assert_eq!(TabStatus::NeedsInput.as_str(), "needs_input");
    assert_eq!(TabStatus::Background.as_str(), "background");
}

/// U04e: over a live chat the strip reads the chat's merged list
/// (`session.sessions`): live rows carry a status; disk-only rows (the
/// last 25 on disk) carry a title but no status, so their tab is
/// "background" and still takes its label from the row.
#[test]
fn the_chats_merged_list_drives_the_dots_and_lends_disk_titles() {
    let merged = [
        json!({"id": "live", "cwd": "/r", "title": null, "createdAt": 5.0,
               "status": "running", "lastModified": 9}),
        json!({"id": "disk", "cwd": "/r", "title": "From disk", "lastModified": 7,
               "accountId": "acc"}),
        json!({"id": "bare"}),
        json!({"title": "no id, skipped"}),
    ];
    let rows = claudius_app::chat::session_rows(&merged);
    assert_eq!(
        rows.iter()
            .map(|r| (r.id.as_str(), r.status))
            .collect::<Vec<_>>(),
        [
            ("live", Some(LiveStatus::Running)),
            ("disk", None),
            ("bare", None)
        ]
    );
    assert_eq!(rows[1].account_id.as_deref(), Some("acc"));
    assert_eq!((rows[2].cwd.as_str(), rows[2].created_at), ("", 0.));

    let strip = hydrated(&["live", "disk", "bare", "gone"], &[], "live");
    let v = |id| strip.view(id, &rows, None, 2026);
    assert_eq!(v("live").status, TabStatus::Running);
    let d = v("disk");
    assert_eq!(
        (d.status, d.label.as_str()),
        (TabStatus::Background, "From disk")
    );
    assert_eq!(v("bare").label, "bare");
    assert_eq!(v("gone").status, TabStatus::Background);
    // A row with no cwd isn't the workspace's: its tab isn't saved, as
    // `sess.cwd === root` is false for `undefined`. No row at all keeps it.
    let put = strip.persist("/r", &rows).unwrap();
    assert_eq!(put.tabs, Some(ids(&["live", "disk", "gone"])));
}

#[test]
fn overflow_fits_left_to_right_and_keeps_the_active_tab() {
    let tabs = ids(&["a", "b", "c", "d", "e"]);
    let w = |id: &str| match id {
        "a" => Some(100.),
        "b" => Some(150.),
        "c" => Some(200.),
        "e" => Some(80.),
        _ => None,
    };
    // Unmeasured or empty: nothing hidden.
    assert!(hidden_tabs(&tabs, w, 0., Some("a")).is_empty());
    assert!(hidden_tabs(&[], w, 500., None).is_empty());
    // 470 - 120 = 350: a (100) + b (150) fit, c (200) doesn't, and the
    // pass stops there (d would have fit).
    let strip = 350. + TRAILER_PX;
    assert_eq!(
        hidden_tabs(&tabs, w, strip, Some("a")),
        ids(&["c", "d", "e"])
    );
    // The active tab is kept by dropping tabs off the end.
    assert_eq!(hidden_tabs(&tabs, w, strip, Some("e")), ids(&["c", "d"]));
    assert_eq!(
        hidden_tabs(&tabs, w, strip, Some("c")),
        ids(&["b", "d", "e"])
    );
    // A tab that fits exactly is shown.
    assert_eq!(
        hidden_tabs(&tabs, w, 250. + TRAILER_PX, Some("a")),
        ids(&["c", "d", "e"])
    );
    assert_eq!(
        hidden_tabs(&tabs, w, 249. + TRAILER_PX, Some("a")),
        ids(&["b", "c", "d", "e"])
    );
    // Unmeasured tabs count as 100: a + b + c + d + e = 630.
    assert!(hidden_tabs(&tabs, w, 630. + TRAILER_PX, Some("c")).is_empty());
    assert_eq!(
        hidden_tabs(&tabs, w, 629. + TRAILER_PX, Some("c")),
        ids(&["e"])
    );
    // Everything fits.
    assert!(hidden_tabs(&tabs, w, 1000., Some("c")).is_empty());
    // Nothing fits but the active tab.
    assert_eq!(
        hidden_tabs(&tabs, w, TRAILER_PX + 10., Some("b")),
        ids(&["a", "c", "d", "e"])
    );
    assert_eq!(UNMEASURED_PX, 100.);
}
