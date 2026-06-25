# Claudius design system — conventions

Claudius is the Claude Agent SDK in the browser (Next.js + React 19). These
components are the real shipped UI, bundled from source. Build with them as
follows.

## Setup & wrapping

- Every component is a React export on the bundle global — import it as usual;
  it resolves to `window.Claudius.<Name>`.
- **No provider wrapper is required** for styling: the design tokens are plain
  CSS custom properties defined on `:root` in the stylesheet, so any component
  is styled as soon as `styles.css` is loaded. (Some feature components read
  Next.js router / live-session context that doesn't exist outside the app;
  those still render, just without live data — prefer the prop-driven
  primitives when composing screens.)
- **Dark-first.** `:root` defaults to the dark palette. Themes switch by setting
  `data-theme` on the root element: `dark` (default), `light`, `midnight`,
  `paper`, `tui`, `tui-light`, `synthwave`.

## Styling idiom — CSS-variable tokens

The design language lives in seven CSS custom properties (defined in the
stylesheet, dark values by default):

| Token | Role |
|---|---|
| `var(--background)` | app background |
| `var(--foreground)` | primary text |
| `var(--panel)` | raised surface (cards, popovers) |
| `var(--panel-2)` | inset surface (code, list wells) |
| `var(--border)` | hairline borders |
| `var(--muted)` | secondary / metadata text |
| `var(--accent)` | brand accent (terracotta `#d97757` in dark) |

Fonts: `var(--font-sans)` (Geist Sans) and `var(--font-mono)` (Geist Mono).

Apply them with Tailwind utilities. A few token utilities exist as named
classes — `bg-panel`, `text-muted`, `text-accent`, `font-sans`, `font-mono` —
but the dominant pattern in this codebase is the **arbitrary-value utility**
referencing the variable directly:

```
bg-[var(--panel)]   text-[var(--foreground)]   border-[var(--border)]
text-[var(--muted)] bg-[var(--panel-2)]        text-[var(--accent)]
```

Always style from these tokens (named or `[var(--*)]`), never hard-coded hex —
that is what keeps a screen on-brand and theme-correct across all seven themes.

## Where the truth lives

- `styles.css` → `_ds_bundle.css`: the compiled stylesheet (Tailwind v4 + the
  `:root` token definitions). Read it before inventing classes.
- `components/<group>/<Name>/<Name>.d.ts`: the prop contract.
- `components/<group>/<Name>/<Name>.prompt.md`: per-component usage notes.

## One idiomatic snippet

```tsx
import { CollapsibleSection, SystemPill } from "claudius";

export function Sidebar() {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-3">
      <CollapsibleSection storageKey="todos" label="Todos" badge={<span>3</span>}>
        <p className="px-2 py-1 text-[13px] text-[var(--foreground)]">Wire up the session stream</p>
      </CollapsibleSection>
      <div className="mt-3">
        <SystemPill entry={{ uuid: "1", afterMessageUuid: "", kind: "info", label: "Session resumed" }} />
      </div>
    </div>
  );
}
```

Library components for the controls; token-based Tailwind utilities for your own
layout glue.
