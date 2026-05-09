import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";

import { getLiveSourceDir } from "./runtime-dir";

const execFileP = promisify(execFile);

/**
 * Revert is implemented in `bin/claudius-revert` — a zero-runtime-deps Node
 * script. The API endpoint shells out to that same script so we have a single
 * source of truth, and so the CLI escape-hatch (`make claudius-revert`)
 * exercises exactly the path the UI button uses.
 */
export async function revertPublish(publishId: string): Promise<{ stdout: string; stderr: string }> {
  const live = getLiveSourceDir();
  const script = join(live, "bin", "claudius-revert");
  const { stdout, stderr } = await execFileP(process.execPath, [script, "--id", publishId, "--live", live], {
    cwd: live,
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return { stdout, stderr };
}

export async function revertLast(): Promise<{ stdout: string; stderr: string }> {
  const live = getLiveSourceDir();
  const script = join(live, "bin", "claudius-revert");
  const { stdout, stderr } = await execFileP(process.execPath, [script, "--last", "--live", live], {
    cwd: live,
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return { stdout, stderr };
}
