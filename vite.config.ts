import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  // Vite injects style tags during HMR. Relax styles only on the loopback dev
  // server; packaged HTML keeps the strict source policy from index.html.
  plugins: [{
    name: 'development-style-policy',
    apply: 'serve',
    transformIndexHtml: (html) => html.replace("style-src 'self'", "style-src 'self' 'unsafe-inline'"),
  }],
  server: { host: '127.0.0.1', strictPort: true },
  build: { outDir: 'dist', emptyOutDir: false },
});
