import { SpinnerTip } from "claudius";

export const Default = () => (
  <div style={{ padding: 12, minWidth: 320 }}>
    <SpinnerTip />
  </div>
);

export const WithTips = () => (
  <div style={{ padding: 12, minWidth: 320 }}>
    <SpinnerTip
      tips={[
        { text: "Press / to run a slash command", command: "/help" },
        { text: "Drop an image into the composer to attach it" },
      ] as never}
    />
  </div>
);
