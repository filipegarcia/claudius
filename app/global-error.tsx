"use client"; // Error boundaries must be Client Components

/**
 * Global error boundary — catches errors thrown in the root layout or any
 * layout/page above a nested `error.tsx`. Must include its own <html> and
 * <body> tags because it replaces the root layout when active.
 *
 * The `unstable_retry` prop (Next.js 16) lets the user attempt a full
 * re-render; prefer it over `reset` which is Next 15 nomenclature.
 */
export default function GlobalError({
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily: "sans-serif",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          height: "100vh",
          margin: 0,
          background: "#0e0e10",
          color: "#e4e4e7",
          gap: "1rem",
        }}
      >
        <h2 style={{ margin: 0 }}>Something went wrong</h2>
        <button
          onClick={unstable_retry}
          style={{
            padding: "0.5rem 1.25rem",
            borderRadius: "0.375rem",
            border: "1px solid #3f3f46",
            background: "#27272a",
            color: "#e4e4e7",
            cursor: "pointer",
            fontSize: "0.875rem",
          }}
        >
          Try again
        </button>
      </body>
    </html>
  );
}
