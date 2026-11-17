//! `lib/shared/session-history.ts` (CC 2.1.309): which DB-only session rows
//! history still shows.
//!
//! `Session::start` upserts a `sessions` row as soon as the session is
//! bound, so a new tab or `/clear` that was abandoned before its first
//! message leaves an untitled row and no transcript. `isHistoryWorthyDbRow`
//! keeps only the rows the user can tell apart — one with a title, or a
//! session that is still live — and both `/api/sessions/all`
//! ([`crate::sessions_all`]) and the move-sessions preview
//! ([`crate::workspace_relocate::list_workspace_session_ids`]) filter with
//! it.
//!
//! The row's `title` is whatever better-sqlite3 handed JS, so the TS
//! `row.title && row.title.trim()` throws V8's `TypeError` on a truthy
//! non-string (a number, a `Buffer`): [`HistoryTitle::NoTrim`]. Replayed
//! against the TS in `tests/cc2309_golden.rs`.

use claudius_agent::js;

use crate::asset_list::Cell;

/// V8's message for `row.title.trim()` on a value without that method.
pub const TITLE_TRIM_TYPE_ERROR: &str = "row.title.trim is not a function";

/// A row's `title` as `isHistoryWorthyDbRow` reads it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HistoryTitle<'a> {
    /// A falsy value: `NULL`, `""`, `0`.
    Falsy,
    /// A truthy string.
    Text(&'a str),
    /// A truthy value with no `trim` method: a non-zero number, a `Buffer`.
    NoTrim,
}

/// `isHistoryWorthyDbRow(row, isLive)`: a title that isn't blank keeps the
/// row; otherwise it is kept only while the session is live. `Err` is the
/// `TypeError` the TS throws on a truthy non-string title (its message).
pub fn is_history_worthy_db_row(
    title: HistoryTitle<'_>,
    is_live: impl FnOnce() -> bool,
) -> Result<bool, &'static str> {
    match title {
        HistoryTitle::Text(t) if !js::trim(t).is_empty() => Ok(true),
        HistoryTitle::NoTrim => Err(TITLE_TRIM_TYPE_ERROR),
        _ => Ok(is_live()),
    }
}

/// A `sessions.title` cell as the filter reads it (an empty `Buffer` is an
/// object, so it is truthy and has no `trim`).
pub fn title_of(cell: &Cell) -> HistoryTitle<'_> {
    match cell {
        Cell::Text(t) if !t.is_empty() => HistoryTitle::Text(t),
        c if c.truthy() => HistoryTitle::NoTrim,
        _ => HistoryTitle::Falsy,
    }
}

/// `isLive(row.id)`: the manager's map is keyed by string, so only a TEXT id
/// can name a live session.
pub fn id_is_live(id: &Cell, is_live: impl FnOnce(&str) -> bool) -> bool {
    match id {
        Cell::Text(s) => is_live(s),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_title_keeps_the_row_and_a_blank_one_asks_the_manager() {
        let t = |title| is_history_worthy_db_row(title, || false);
        assert_eq!(t(HistoryTitle::Text("named")), Ok(true));
        assert_eq!(t(HistoryTitle::Text("  ")), Ok(false));
        assert_eq!(t(HistoryTitle::Text("\u{feff}")), Ok(false));
        assert_eq!(t(HistoryTitle::Falsy), Ok(false));
        assert_eq!(
            is_history_worthy_db_row(HistoryTitle::Falsy, || true),
            Ok(true)
        );
        assert_eq!(t(HistoryTitle::NoTrim), Err(TITLE_TRIM_TYPE_ERROR));
    }
}
