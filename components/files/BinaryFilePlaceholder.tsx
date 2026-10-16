"use client";

import { FileQuestion } from "lucide-react";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Disabled-Save tooltip for a binary file (it's not an encoding problem). */
export const BINARY_SAVE_TITLE = "Binary file — can't be edited here";

/** Disabled-Save tooltip for a file we won't write back in its encoding. */
export const ENCODING_READONLY_SAVE_TITLE = "Read-only — saving would convert this file's encoding";

/**
 * Save-button tooltip shared by the Files page and the /git FileEditor:
 * binary first (a binary is also `readOnly`, but the encoding wording would
 * be misleading), then the encoding read-only reason; `undefined` otherwise
 * so each caller keeps its own default.
 */
export function saveButtonTitle({ binary, readOnly }: { binary: boolean; readOnly: boolean }): string | undefined {
  if (binary) return BINARY_SAVE_TITLE;
  if (readOnly) return ENCODING_READONLY_SAVE_TITLE;
  return undefined;
}

/**
 * CC 2.1.301 ("Fixed the Read tool reading binary files such as .xlsm,
 * .parquet, .epub and .heic as text") — shown in place of the text editor
 * when the files route reports `binary: true`, instead of a garbled lossy
 * decode. Shared by the Files page and the /git FileEditor.
 */
export function BinaryFilePlaceholder({
  path,
  sizeBytes,
  testId,
}: {
  path: string;
  sizeBytes?: number;
  testId: string;
}) {
  const name = path.split("/").pop() || path;
  return (
    <div
      data-testid={testId}
      role="status"
      className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-[var(--muted)]"
    >
      <FileQuestion className="h-8 w-8 opacity-60" />
      <div className="text-sm text-[var(--foreground)]">Binary file — not shown as text</div>
      <div className="font-mono text-[11px]">
        {name}
        {typeof sizeBytes === "number" ? ` · ${formatSize(sizeBytes)}` : ""}
      </div>
      <div className="max-w-sm text-[11px]">
        This file isn&apos;t text (a spreadsheet, archive, database, media file or similar), so it can&apos;t be
        opened in the editor.
      </div>
    </div>
  );
}
