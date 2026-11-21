import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { initAnalytics } from './analytics';
import { ErrorBoundary } from './components/ErrorBoundary';
import './styles.css';

initAnalytics();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
