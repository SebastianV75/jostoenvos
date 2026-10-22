import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/geist/400.css';
import '@fontsource/geist/500.css';
import '@fontsource/geist-mono/400.css';
import '@fontsource/newsreader/500.css';
import './style.css';
import App from './App.js';

createRoot(document.getElementById('root')!).render(
  <StrictMode><App /></StrictMode>,
);
