import { RewindFilesButton } from "claudius";

// The idle affordance is hover-only (`opacity-0 group-hover:opacity-100`), so a
// static capture would show nothing. Force the button visible for the card so
// its real idle state (History icon + "Restore files…") is shown.
export const Idle = () => (
  <div style={{ padding: 16 }}>
    <style>{`.ds-rewind button{opacity:1 !important}`}</style>
    <div className="ds-rewind group">
      <RewindFilesButton sessionId="ds-preview-session" messageUuid="ds-preview-message" />
    </div>
  </div>
);
