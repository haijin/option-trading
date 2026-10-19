import { lazy, Suspense } from 'react';
import { Skeleton } from './components/Skeleton';
import { Shell } from './layout/Shell';
import type { PageId } from './lib/route';
import { BacktestsPage } from './pages/backtests/BacktestsPage';
import { DataPage } from './pages/data/DataPage';
import { HomePage } from './pages/home/HomePage';
import { LeadersPage } from './pages/leaders/LeadersPage';
import { AuthGate } from './pages/login/AuthGate';
import { NewsPage } from './pages/news/NewsPage';
import { PositionsPage } from './pages/positions/PositionsPage';
import { RemindersPage } from './pages/reminders/RemindersPage';
import { ResearchPage } from './pages/research/ResearchPage';
import { SettingsPage } from './pages/settings/SettingsPage';
import { TodayPage } from './pages/today/TodayPage';
import { WatchlistPage } from './pages/watchlist/WatchlistPage';
import { AuthProvider } from './state/auth';
import { DataVersionProvider } from './state/dataVersion';
import { OverviewProvider } from './state/overview';
import { RemindersProvider } from './state/reminders';
import { RouterProvider, useRouter } from './state/router';
import { ThemeProvider } from './state/theme';
import { ToastProvider } from './state/toast';

/** The Journal pulls in the rich-text editor, so it loads as its own chunk the first time its tab is opened. */
const JournalPage = lazy(() => import('./pages/journal/JournalPage'));

function JournalFallback() {
  return (
    <div className="page" aria-busy="true">
      <Skeleton height={44} />
      <Skeleton height={120} />
      <Skeleton height={200} />
    </div>
  );
}

function Page({ page }: { page: PageId }) {
  switch (page) {
    case 'home':
      return <HomePage />;
    case 'puts':
      return <TodayPage />;
    case 'journal':
      return (
        <Suspense fallback={<JournalFallback />}>
          <JournalPage />
        </Suspense>
      );
    case 'research':
      return <ResearchPage />;
    case 'news':
      return <NewsPage />;
    case 'leaders':
      return <LeadersPage />;
    case 'watchlist':
      return <WatchlistPage />;
    case 'positions':
      return <PositionsPage />;
    case 'reminders':
      return <RemindersPage />;
    case 'backtests':
      return <BacktestsPage />;
    case 'data':
      return <DataPage />;
    case 'settings':
      return <SettingsPage />;
  }
}

function Routes() {
  const { route } = useRouter();
  return (
    <Shell page={route.page}>
      <Page page={route.page} />
    </Shell>
  );
}

/**
 * The gate sits above every provider that fetches data: until the server accepts this browser, nothing asks it for
 * the overview (which would only answer 401), and signing out unmounts all of it, so no data lingers on screen.
 */
export function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <AuthProvider>
          <AuthGate>
            <DataVersionProvider>
              <OverviewProvider>
                <RemindersProvider>
                  <RouterProvider>
                    <Routes />
                  </RouterProvider>
                </RemindersProvider>
              </OverviewProvider>
            </DataVersionProvider>
          </AuthGate>
        </AuthProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}
