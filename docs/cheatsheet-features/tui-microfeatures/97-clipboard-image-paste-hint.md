# Clipboard Image-Paste Hint on Focus Regain

**Source:** Claude Code TUI — hooks-ux
**Status:** MISSING

## What it is
When the terminal regains focus and the system clipboard holds an image, the TUI queues a transient toast nudging the user to paste it. The leaked `hooks/useClipboardImageHint.ts` queues exactly one notification per focus-regain via `q({key:xD5,text:`Image in clipboard \xB7 ${RX("chat:imagePaste","Chat","ctrl+v")} to paste`,priority:"immediate",timeoutMs:8000})` — `priority:"immediate"` jumps the feed, `timeoutMs:8000` auto-dismisses after 8s, and the wrapping hook debounces focus events with a 30s cooldown so flipping windows doesn't spam the surface.

## Claudius today
Not surfaced in Claudius. The composer already accepts pasted images via `components/chat/PromptInput.tsx` `onPaste` (line 881, walks `e.clipboardData.items` for `kind === "file"` and routes them through `ingestFiles`) and the placeholder ("drop or paste images", line 1128) advertises the path, but nothing proactively reads `navigator.clipboard.read()` on focus. There's a `window.addEventListener("focus", onWindowFocus)` in the same file (line 325) that just re-focuses the textarea — the natural seam to add a clipboard-probe + transient toast routed through `components/notifications/NotificationsProvider.tsx`, which already has its own `window.addEventListener("focus", onRegain)` (line 528) for the Electron away-recap flow.

## Decision
MISSING. The leaked `hooks/useClipboardImageHint.ts` shows a small standalone hook that calls `navigator.clipboard.read()` on focus-regain, checks each `ClipboardItem` for an image MIME type, and queues a single 8-second toast keyed by `xD5` with a 30s focus-cooldown. The Permissions API gates `clipboard-read` on user activation, so a Claudius port would best ride the existing focus-regain wiring in `components/notifications/NotificationsProvider.tsx` (which already handles permission-sensitive surfaces) and emit through the same notification feed, with the `chat:imagePaste` keybind label resolved via the shared keybindings table rather than hardcoded `ctrl+v`.
