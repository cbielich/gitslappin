import '@fontsource/open-sans/400.css';
import '@fontsource/open-sans/600.css';
import '@fontsource/open-sans/700.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { startAlive } from './lib/alive';
import './theme/dark.css';
import './theme/light.css';
import './styles/global.css';
import './styles/chrome.css';
import './styles/open-repo.css';
import './styles/graph.css';
import './styles/diff.css';
import './styles/staging.css';
import './styles/menu.css';
import './styles/conflict.css';
import './styles/merge.css';
import './styles/polish.css';

startAlive();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
