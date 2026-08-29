import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, HashRouter } from 'react-router-dom';
import App from './App';
import { IS_STATIC } from './lib/api';
import './styles.css';

// A single-file build is opened from a URL with no server to rewrite paths, so routing goes
// through the hash. Everything else about the application is identical.
const Router = IS_STATIC ? HashRouter : BrowserRouter;

function mount() {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <Router>
        <App />
      </Router>
    </React.StrictMode>,
  );
}

if (IS_STATIC) {
  const root = document.getElementById('root')!;
  root.innerHTML = '<div style="display:grid;place-items:center;height:100vh;'
    + 'font:14px/1.5 system-ui;color:#5B6B8C">Loading the national dataset…</div>';
  import('./lib/api.static')
    .then((m) => m.loadBundle())
    .then(mount)
    .catch((e) => {
      root.innerHTML = '<div style="display:grid;place-items:center;height:100vh;padding:24px;'
        + 'font:14px/1.6 system-ui;color:#A81E2D;text-align:center">'
        + `<div><strong>The dataset could not be loaded.</strong><br>${e.message}</div></div>`;
    });
} else {
  mount();
}
