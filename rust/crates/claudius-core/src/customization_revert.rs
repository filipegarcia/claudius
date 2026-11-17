//! Reverting a publish: port of `lib/server/customization-revert.ts` (D14).
//! Like TS, it runs the standalone `<live>/bin/claudius-revert` script (the
//! same one `make claudius-revert` runs), in the live source dir, through
//! `execFileP` (60 s, 8 MiB per stream), so its stdout and stderr come back
//! and a failure is `Command failed: <node> <script> …\n<stderr>`.
//!
//! TS runs the script on `process.execPath`, the node serving Next. This
//! process isn't a node, so it uses the build's launcher
//! ([`crate::customization_build::resolve_launcher`]: the first `node` on
//! `PATH`, the usual install dirs, then bun); with none it tries `node`,
//! which fails as `spawn node ENOENT`.

use std::path::Path;

use crate::customization_build::resolve_launcher;
use crate::exec_file::{ExecFileError, ExecFileOptions, ExecFileOutput, exec_file};
use crate::node_path;

const TIMEOUT_MS: u64 = 60_000;
const MAX_BUFFER: usize = 8 * 1024 * 1024;

/// The program that runs the revert script.
pub fn node_program() -> String {
    resolve_launcher().map_or_else(|| "node".to_owned(), |l| l.bin)
}

/// `<live>/bin/claudius-revert`.
pub fn revert_script(live: &str) -> String {
    node_path::join(&[live, "bin", "claudius-revert"])
}

async fn run(node: &str, live: &str, args: &[&str]) -> Result<ExecFileOutput, ExecFileError> {
    let script = revert_script(live);
    let mut argv = vec![script.as_str()];
    argv.extend_from_slice(args);
    argv.extend_from_slice(&["--live", live]);
    exec_file(
        node,
        &argv,
        ExecFileOptions {
            cwd: Some(Path::new(live)),
            timeout_ms: TIMEOUT_MS,
            max_buffer: MAX_BUFFER,
        },
    )
    .await
}

/// `revertPublish(publishId)` on `node`: `<script> --id <id> --live <live>`.
pub async fn revert_publish(
    node: &str,
    live: &str,
    publish_id: &str,
) -> Result<ExecFileOutput, ExecFileError> {
    run(node, live, &["--id", publish_id]).await
}

/// `revertLast()` on `node`: `<script> --last --live <live>`.
pub async fn revert_last(node: &str, live: &str) -> Result<ExecFileOutput, ExecFileError> {
    run(node, live, &["--last"]).await
}
