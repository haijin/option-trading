import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import '@fontsource-variable/schibsted-grotesk';
import '@fontsource/spline-sans-mono/400.css';
import '@fontsource/spline-sans-mono/500.css';
import './styles.css';
import './styles/layout.css';
import './styles/content.css';
import './styles/news.css';
import './styles/leaders.css';
import './styles/watchlist.css';
import './styles/login.css';
import './styles/dashboard.css';

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
