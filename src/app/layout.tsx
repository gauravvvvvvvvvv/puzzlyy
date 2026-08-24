import type { Metadata, Viewport } from 'next';
import { Fraunces, Inter, JetBrains_Mono } from 'next/font/google';

import { THEME_BOOTSTRAP } from '@/lib/storage/theme';

import './globals.css';

/**
 * The three faces are wired to the CSS variables `globals.css` consumes, so the
 * design system never hard-codes a family name that `next/font` would hash.
 */
const display = Fraunces({
  subsets: ['latin'],
  display: 'swap',
  axes: ['SOFT', 'WONK', 'opsz'],
  variable: '--font-display-face',
});

const sans = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-sans-face',
});

const mono = JetBrains_Mono({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-mono-face',
});

const DESCRIPTION =
  'Turn any picture into a jigsaw and solve it together in real time. No signup — just send your friend a link.';

export const metadata: Metadata = {
  title: {
    default: 'Puzzly — solve puzzles together',
    template: '%s · Puzzly',
  },
  description: DESCRIPTION,
  applicationName: 'Puzzly',
  metadataBase: process.env.NEXT_PUBLIC_SITE_URL
    ? new URL(process.env.NEXT_PUBLIC_SITE_URL)
    : undefined,
  openGraph: {
    title: 'Puzzly — solve puzzles together',
    description: DESCRIPTION,
    siteName: 'Puzzly',
    type: 'website',
  },
  twitter: { card: 'summary_large_image', title: 'Puzzly', description: DESCRIPTION },
  robots: { index: true, follow: true },
  formatDetection: { telephone: false, address: false, email: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Deliberately not capping the scale: the board has its own zoom, and blocking
  // browser zoom would break the page for anyone who needs it (spec §25).
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f5f1e9' },
    { media: '(prefers-color-scheme: dark)', color: '#16131c' },
  ],
  colorScheme: 'dark light',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${display.variable} ${sans.variable} ${mono.variable}`}
      // The bootstrap script writes `data-theme` before React sees the document.
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
