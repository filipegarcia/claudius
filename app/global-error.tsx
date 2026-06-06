"use client"; // Error boundaries must be Client Components

/**
 * Global error boundary — catches errors thrown in the root layout or any
 * layout/page above a nested `error.tsx`. Must include its own <html> and
 * <body> tags because it replaces the root layout when active.
 */
export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  const details = [error.message, error.digest && `digest: ${error.digest}`, error.stack]
    .filter(Boolean)
    .join("\n\n");

  return (
    <html lang="en">
      <body
        style={{
          fontFamily: "sans-serif",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          minHeight: "100vh",
          margin: 0,
          padding: "2rem",
          background: "#0e0e10",
          color: "#e4e4e7",
          gap: "1rem",
          boxSizing: "border-box",
        }}
      >
        <h2 style={{ margin: 0 }}>Something went wrong</h2>
        {details && (
          <pre
            style={{
              maxWidth: "min(900px, 90vw)",
              maxHeight: "50vh",
              overflow: "auto",
              margin: 0,
              padding: "0.75rem 1rem",
              borderRadius: "0.375rem",
              border: "1px solid #3f3f46",
              background: "#18181b",
              color: "#fca5a5",
              fontSize: "0.75rem",
              lineHeight: 1.5,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              textAlign: "left",
              fontFamily:
                "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
            }}
          >
            {details}
          </pre>
        )}
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <button
            onClick={() => {
              window.location.reload();
            }}
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
            Reopen
          </button>
          {details && (
            <button
              onClick={() => {
                void navigator.clipboard?.writeText(details);
              }}
              style={{
                padding: "0.5rem 1.25rem",
                borderRadius: "0.375rem",
                border: "1px solid #3f3f46",
                background: "#18181b",
                color: "#e4e4e7",
                cursor: "pointer",
                fontSize: "0.875rem",
              }}
            >
              Copy details
            </button>
          )}
        </div>
      </body>
    </html>
  );
}
