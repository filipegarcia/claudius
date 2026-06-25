import { LoadingBar } from "claudius";

const Frame = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div style={{ width: 360, border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden", background: "var(--panel)" }}>
    {children}
    <div style={{ padding: "10px 12px", fontSize: 12, color: "var(--muted)" }}>{label}</div>
  </div>
);

export const Working = () => (
  <Frame label="Agent working — indeterminate bar slides L→R">
    <LoadingBar ready pending />
  </Frame>
);

export const SpinningUp = () => (
  <Frame label="Session binding — not yet ready">
    <LoadingBar ready={false} pending={false} />
  </Frame>
);

export const Idle = () => (
  <Frame label="Idle — 2px row reserved, no animation">
    <LoadingBar ready pending={false} />
  </Frame>
);
