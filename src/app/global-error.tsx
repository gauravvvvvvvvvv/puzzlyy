'use client';

/**
 * The floor beneath the floor.
 *
 * `error.tsx` catches anything thrown inside the app; this catches the case where
 * the root layout itself failed, which means no fonts, no design tokens and quite
 * possibly no stylesheet. So everything here is inline and self-contained — a page
 * that apologises about being broken has no business depending on the thing that
 * broke.
 *
 * It also has to supply its own `<html>` and `<body>`: at this level Next.js has
 * nothing left to wrap us in.
 */

import { useEffect } from 'react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[puzzly] Fatal error', error);
  }, [error]);

  return (
    // The theme cannot be read here, so the palette is picked with
    // `color-scheme` and both sides are spelled out by hand.
    <html lang="en" style={{ colorScheme: 'dark light' }}>
      <body
        style={{
          margin: 0,
          minHeight: '100dvh',
          display: 'grid',
          placeItems: 'center',
          padding: '2rem 1.5rem',
          background: '#16131c',
          color: '#efeaf6',
          fontFamily:
            'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
          lineHeight: 1.5,
          WebkitFontSmoothing: 'antialiased',
        }}
      >
        <main style={{ maxWidth: '26rem', textAlign: 'center' }}>
          <div
            aria-hidden="true"
            style={{
              margin: '0 auto 1.5rem',
              width: 46,
              height: 46,
              borderRadius: 14,
              display: 'grid',
              placeItems: 'center',
              background: 'rgba(233, 111, 111, 0.14)',
              color: '#e96f6f',
              fontSize: 22,
            }}
          >
            {/* Not an emoji: a broken piece is the one image this page has earned. */}
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M4 6a2 2 0 0 1 2-2h4v1.5a2 2 0 1 0 4 0V4h4a2 2 0 0 1 2 2v4h-1.5a2 2 0 1 0 0 4H20"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
              <path d="M14 20H6a2 2 0 0 1-2-2v-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeDasharray="3 3" />
            </svg>
          </div>

          <h1 style={{ margin: 0, fontSize: '1.5rem', fontWeight: 600, letterSpacing: '-0.01em' }}>
            Puzzly could not start
          </h1>
          <p style={{ margin: '0.75rem 0 0', color: '#a79fb4', fontSize: '0.9375rem' }}>
            Something failed before the page could load. Your puzzle is safe — progress is kept on
            the server, so reloading picks it back up exactly where you left off.
          </p>

          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: '0.5rem',
              justifyContent: 'center',
              marginTop: '1.75rem',
            }}
          >
            <button
              type="button"
              onClick={reset}
              style={{
                minHeight: 44,
                padding: '0 1.25rem',
                borderRadius: 10,
                border: 'none',
                background: '#c9a4ff',
                color: '#1b1424',
                font: 'inherit',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Try again
            </button>
            <a
              href="/"
              style={{
                minHeight: 44,
                display: 'inline-flex',
                alignItems: 'center',
                padding: '0 1.25rem',
                borderRadius: 10,
                border: '1px solid rgba(239, 234, 246, 0.18)',
                color: '#efeaf6',
                textDecoration: 'none',
                font: 'inherit',
              }}
            >
              Back home
            </a>
          </div>

          {error.digest ? (
            <p style={{ margin: '1.75rem 0 0', color: '#7d7589', fontSize: '0.6875rem' }}>
              Reference:{' '}
              <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
                {error.digest}
              </span>
            </p>
          ) : null}
        </main>
      </body>
    </html>
  );
}
