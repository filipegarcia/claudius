import { NextResponse } from "next/server";
import { readUpdaterFile } from "@/lib/server/updater/settings";
import { installRoot, runtimeMode } from "@/lib/server/updater/root";
import { isGitCheckout, headSha, currentBranch } from "@/lib/server/updater/git";

export const runtime = "nodejs";

export async function GET() {
  const root = installRoot();
  const file = await readUpdaterFile();
  const isRepo = await isGitCheckout(root);
  const head = isRepo ? await headSha(root).catch(() => undefined) : undefined;
  const branch = isRepo ? await currentBranch(root).catch(() => null) : null;
  return NextResponse.json({
    settings: {
      mode: file.mode,
      remote: file.remote,
      branch: file.branch,
      intervalHours: file.intervalHours,
    },
    state: file.state,
    install: {
      root,
      isGitCheckout: isRepo,
      currentSha: head,
      currentBranch: branch,
      runtimeMode: runtimeMode(),
    },
  });
}
