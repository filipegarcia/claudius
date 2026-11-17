//! `lib/shared/schedule-skip.ts`: the reason codes the scheduler records
//! when a fire doesn't start a run, or a run didn't finish, and the readable
//! text the notification inbox carries for them (CC 2.1.302).
//!
//! `activeSkip` is client-only (the Schedule page's banner reads it off the
//! job it already has), so only the codes and [`run_note_text`] — what
//! `scheduler.ts` sends to the bus — are ported.

/// A fire was skipped because the job's previous run was still going.
pub const SKIP_PREVIOUS_RUN: &str = "previous_run_in_progress";
/// A fire was skipped because the job's working folder no longer exists.
pub const SKIP_FOLDER_MISSING: &str = "workspace_folder_missing";
/// The agent stream ended without a final result message.
pub const RUN_ENDED_WITHOUT_RESULT: &str = "session_ended_without_result";
/// Claudius stopped (quit, crashed, restarted) while the run was in flight.
pub const RUN_INTERRUPTED: &str = "interrupted";

/// `NOTE_TEXT`, in its source order.
const NOTE_TEXT: [(&str, &str); 4] = [
    (SKIP_PREVIOUS_RUN, "The previous run was still in progress"),
    (SKIP_FOLDER_MISSING, "The job's folder no longer exists"),
    (
        RUN_ENDED_WITHOUT_RESULT,
        "The session ended before the run finished",
    ),
    (
        RUN_INTERRUPTED,
        "Claudius stopped while this run was in progress",
    ),
];

/// `runNoteText(note)`: the readable text of a known note; an unknown one
/// passes through. A `NOTE_TEXT[note]` lookup, so only a string can match
/// (the scheduler also notes a result's `subtype`, which the CLI could send
/// as anything).
pub fn run_note_text(note: &str) -> &str {
    NOTE_TEXT
        .iter()
        .find(|(code, _)| *code == note)
        .map_or(note, |(_, text)| *text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_notes_read_as_text_and_others_pass_through() {
        assert_eq!(
            run_note_text("workspace_folder_missing"),
            "The job's folder no longer exists"
        );
        assert_eq!(
            run_note_text("interrupted"),
            "Claudius stopped while this run was in progress"
        );
        assert_eq!(
            run_note_text("session_ended_without_result"),
            "The session ended before the run finished"
        );
        assert_eq!(
            run_note_text("previous_run_in_progress"),
            "The previous run was still in progress"
        );
        for other in ["error_max_turns", "", "7", "toString", "__proto__"] {
            assert_eq!(run_note_text(other), other, "{other}");
        }
    }
}
