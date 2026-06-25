import { CollapsibleSection } from "claudius";

const Row = ({ children }: { children: string }) => (
  <div style={{ padding: "6px 10px", fontSize: 13, color: "var(--foreground)" }}>{children}</div>
);

export const Expanded = () => (
  <div style={{ width: 360 }}>
    <CollapsibleSection storageKey="ds-preview-todos" label="Todos" badge={<span>3</span>}>
      <Row>Wire up the session stream</Row>
      <Row>Add the cost overlay</Row>
      <Row>Polish the empty state</Row>
    </CollapsibleSection>
  </div>
);

export const Collapsed = () => (
  <div style={{ width: 360 }}>
    <CollapsibleSection storageKey="ds-preview-files" label="Recent edits" badge={<span>12</span>} defaultCollapsed>
      <Row>app/page.tsx</Row>
    </CollapsibleSection>
  </div>
);
