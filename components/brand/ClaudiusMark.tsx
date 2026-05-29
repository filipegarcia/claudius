import type { CSSProperties } from "react";
import { CLAUDIUS_SVG } from "./claudius-svg";

type Props = {
  color?: string;
  size?: number;
  className?: string;
  title?: string;
};

// Inlines the Claudius silhouette so its color follows the wrapping element's
// CSS `color`. The inlined SVG uses fill="currentColor"; we set `color` on
// the wrapper to whatever the caller passed in (theme variable, hex, etc.).
// Inlining (rather than `mask-image: url(...)`) sidesteps browser differences
// in mask-mode default (luminance vs. alpha) for external SVG sources.
export function ClaudiusMark({
  color = "currentColor",
  size = 96,
  className,
  title = "Claudius",
}: Props) {
  const style: CSSProperties = {
    color,
    width: size,
    height: size * 1.25,
  };
  return (
    <div
      role="img"
      aria-label={title}
      className={className}
      style={style}
      // The inlined SVG has width="100%" height="100%" style="display:block"
      // and fill="currentColor", so it fills this div and themes via `color`.
      dangerouslySetInnerHTML={{ __html: CLAUDIUS_SVG }}
    />
  );
}
