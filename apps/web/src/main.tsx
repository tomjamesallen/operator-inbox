import { RegistryProvider } from '@effect/atom-react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';
import { installRowContextMenu } from './pake-row-menu';

// A sidebar row's right-click, past Pake's own link menu (`pake-row-menu.ts`).
installRowContextMenu();

const root = document.getElementById('root');
if (root === null) throw new Error('index.html has no #root');
createRoot(root).render(
  <StrictMode>
    <RegistryProvider>
      <App />
    </RegistryProvider>
  </StrictMode>,
);

// The service worker makes the app installable and caches its SHELL, never
// the data (`sw/sw.js`). Production builds only: under the dev server a
// worker would cache modules Vite is busy replacing.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
      // Not fatal: the page works without a worker, it just cannot install.
    });
  });
}
