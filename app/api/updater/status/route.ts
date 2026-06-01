import { NextResponse } from "next/server";
import { readUpdaterFile } from "@/lib/server/updater/settings";
import { installRoot, runtimeMode } from "@/lib/server/updater/root";
import {
  currentBranch,
  headSha,
  isAncestor,
  isGitCheckout,
} from "@/lib/server/updater/git";

export const runtime = "nodejs";

export async function GET() {
  const root = installRoot();
  const file = await readUpdaterFile();
  const isRepo = await isGitCheckout(root);
  const head = isRepo ? await headSha(root).catch(() => undefined) : undefined;
  const branch = isRepo ? await currentBranch(root).catch(() => null) : null;

  // Reconcile stale `pending` against the live HEAD. The cached pending was
  // written by the last `checkForUpdates()` run; if the user has since done
  // `git pull` outside Claudius (clean ff, merge, or rebase), HEAD now
  // contains `pending.remoteSha` and the banner is bogus. We don't touch the
  // persisted file here — a GET shouldn't side-effect, and the next real
  // check will overwrite it anyway. We just suppress the field on the wire.
  let state = file.state;
  if (state.pending && isRepo && head) {
    const incorporated = await isAncestor(root, state.pending.remoteSha, head);
    if (incorporated) {
      state = { ...state, pending: undefined };
    }
  }

  return NextResponse.json({
    settings: {
      mode: file.mode,
      remote: file.remote,
      branch: file.branch,
      intervalHours: file.intervalHours,
    },
    state,
    install: {
      root,
      isGitCheckout: isRepo,
      currentSha: head,
      currentBranch: branch,
      runtimeMode: runtimeMode(),
    },
  });
}
