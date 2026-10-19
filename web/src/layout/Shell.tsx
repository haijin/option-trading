import type { ReactNode } from 'react';
import { DISCLAIMER } from '../api/types';
import { useIsMobile } from '../hooks/useMediaQuery';
import type { PageId } from '../lib/route';
import { useOverview } from '../state/overview';
import { Rail } from './Rail';
import { TabBar } from './TabBar';
import { TopBar } from './TopBar';

/**
 * Layout A (Blotter) on desktop: icon rail, top bar with regime and capital meters, one body for the page.
 * On a phone the rail becomes a bottom tab bar, the top bar collapses to a title row plus a scrolling status
 * strip, and the disclaimer scrolls with the page instead of taking a fixed footer.
 */
export function Shell({ page, children }: { page: PageId; children: ReactNode }) {
  const { data: overview } = useOverview();
  const mobile = useIsMobile();
  const disclaimer = overview?.disclaimer ?? DISCLAIMER;
  return (
    <div className="app">
      <Rail page={page} />
      <div className="main">
        <TopBar page={page} />
        <main className="body" id="main">
          {children}
          {mobile ? <p className="foot inline">{disclaimer}</p> : null}
        </main>
        {mobile ? null : <footer className="foot">{disclaimer}</footer>}
      </div>
      <TabBar page={page} />
    </div>
  );
}
