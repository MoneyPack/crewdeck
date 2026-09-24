import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/archivo/wdth.css';
import '@fontsource-variable/jetbrains-mono/index.css';
import 'remixicon/fonts/remixicon.css';
import '@xterm/xterm/css/xterm.css';
import './styles.css';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';

const root = document.getElementById('root');
if (!root) throw new Error('#root element missing');

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
