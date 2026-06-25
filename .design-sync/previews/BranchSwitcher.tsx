import { BranchSwitcher } from "claudius";

const noop = async () => ({ ok: true }) as never;

export const OnBranch = () => (
  <div style={{ padding: 8 }}>
    <BranchSwitcher current="main" onCheckout={noop} onCreate={noop} />
  </div>
);

export const FeatureBranch = () => (
  <div style={{ padding: 8 }}>
    <BranchSwitcher current="feat/design-sync" onCheckout={noop} onCreate={noop} />
  </div>
);

export const Detached = () => (
  <div style={{ padding: 8 }}>
    <BranchSwitcher current="a1b2c3d" detached onCheckout={noop} onCreate={noop} />
  </div>
);
