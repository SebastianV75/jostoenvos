import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { VaultBridge } from '../shared/api.js';

const source = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

// Exhaustiveness is also checked by tsc: later writers share precisely this API.
const methods: Record<keyof VaultBridge, true> = {
  state: true, create: true, unlock: true, lock: true,
  addProject: true, addEnvironment: true, saveEnvironment: true,
  importEnvironment: true, previewExport: true, confirmExport: true,
  cancelExport: true, backup: true, restore: true,
};

test('canonical bridge contains only the scoped vault operations', async () => {
  const api = await source('shared/api.ts');
  for (const method of Object.keys(methods)) assert.match(api, new RegExp(`\\b${method}\\(`));
  assert.match(api, /vault\?: VaultBridge/);
  assert.doesNotMatch(api, /(?:readFile|writeFile|execute|send|invoke)\(/);
});

test('desktop foundation enforces isolated sandbox and blocks new navigation', async () => {
  const main = await source('electron/main.ts');
  assert.match(main, /contextIsolation: true/);
  assert.match(main, /nodeIntegration: false/);
  assert.match(main, /sandbox: true/);
  assert.match(main, /webSecurity: true/);
  assert.match(main, /setWindowOpenHandler\(.*deny/s);
  assert.match(main, /will-navigate.*preventDefault/s);
  assert.doesNotMatch(main, /loadURL\(|disable.*sandbox|webSecurity: false/);
  const preload = await source('electron/preload.ts');
  assert.doesNotMatch(preload, /ipcRenderer|exposeInMainWorld|require\(/);
  const html = await source('index.html');
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /connect-src 'self'/);
});

test('browser screen honestly identifies foundation without creating a fake vault', async () => {
  const { default: App } = await import('../src/App.js');
  const html = renderToStaticMarkup(createElement(App));
  assert.match(html, /Foundation/);
  assert.match(html, /not yet available/);
  assert.doesNotMatch(html, /<input|<button/);
  const renderer = await source('src/App.tsx');
  assert.doesNotMatch(renderer, /localStorage|sessionStorage|https?:/);
});
