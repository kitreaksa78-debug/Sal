import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import {CANONICAL_ORIGIN, isAliasOrigin} from './lib/google';
import './index.css';

// Vercel deployment URLs and the older Cloudflare Pages address are the same app
// on hosts Google does not know, so sign-in there fails with `origin_mismatch`.
// Send those visitors to the domain the OAuth client is registered for, keeping
// the path they asked for.
if (isAliasOrigin(window.location.origin)) {
  window.location.replace(
    CANONICAL_ORIGIN + window.location.pathname + window.location.search + window.location.hash
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
