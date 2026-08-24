import { SiteFooter } from '@/components/site/SiteFooter';
import { SiteHeader } from '@/components/site/SiteHeader';

/**
 * Chrome for every page except the puzzle room.
 *
 * The room lives outside this group on purpose: a board wants the whole viewport,
 * and a nested layout could not have removed a header inherited from above.
 */
export default function SiteLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <a href="#main" className="sr-only-focusable">
        Skip to content
      </a>
      <SiteHeader />
      <main id="main" className="relative z-1">
        {children}
      </main>
      <SiteFooter />
    </>
  );
}
