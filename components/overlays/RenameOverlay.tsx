"use client";

import { useState } from "react";
import { Overlay } from "./Overlay";

type Props = {
  initial?: string;
  onSubmit: (title: string) => void;
  onClose: () => void;
};

export function RenameOverlay({ initial = "", onSubmit, onClose }: Props) {
  const [title, setTitle] = useState(initial);
  return (
    <Overlay title="Rename session" subtitle="/rename" onClose={onClose} width={460}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (title.trim()) onSubmit(title.trim());
        }}
        className="flex flex-col gap-3 px-4 py-4"
      >
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="New title"
          className="rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2 text-sm focus:border-[var(--accent)]/60 focus:outline-none"
        />
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-3 py-1.5 text-xs hover:bg-[var(--panel)]"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!title.trim()}
            className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs text-white hover:opacity-90 disabled:opacity-40"
          >
            Save
          </button>
        </div>
      </form>
    </Overlay>
  );
}
