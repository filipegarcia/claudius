"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Mounts `children` only while the wrapper is on/near the viewport, and
 * unmounts them once it scrolls away.
 *
 * The chat message list is **not** virtualized, so without this every inline
 * preview (`<img>`, and especially sandboxed `<iframe sandbox="allow-scripts">`
 * HTML renders) would stay mounted for the lifetime of the conversation. Live
 * iframes keep executing their scripts forever; over a long session dozens of
 * them accumulate and saturate the single Electron renderer thread, which is
 * what makes switching to git/files/any workspace screen hang for ~20s.
 *
 * Detaching off-screen previews caps live media to roughly what's on screen,
 * independent of conversation length. The wrapper keeps the last measured
 * height while detached so collapsing/re-expanding doesn't shift layout — and
 * so a 0-height collapse can't re-trigger the IntersectionObserver in a loop.
 */
export function LazyPreview({
  as = "div",
  className,
  children,
  rootMargin = "400px 0px",
}: {
  /** Wrapper element — use "span" inside Markdown phrasing content. */
  as?: "div" | "span";
  className?: string;
  children: ReactNode;
  rootMargin?: string;
}) {
  const ref = useRef<HTMLElement>(null);
  const [inView, setInView] = useState(false);
  const [minHeight, setMinHeight] = useState<number | undefined>(undefined);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => setInView(entry.isIntersecting),
      { rootMargin },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [rootMargin]);

  // Remember the rendered height so the placeholder keeps the box size while
  // detached. A ResizeObserver (active only while visible) tracks the real
  // height as content settles — the iframe is a fixed 300px, images resolve
  // once decoded.
  useEffect(() => {
    const el = ref.current;
    if (!inView || !el) return;
    const ro = new ResizeObserver(() => {
      const h = el.offsetHeight;
      if (h) setMinHeight(h);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [inView]);

  const Tag = as;
  const style = !inView && minHeight ? { minHeight } : undefined;
  return (
    <Tag ref={ref as never} className={className} style={style}>
      {inView ? children : null}
    </Tag>
  );
}
