import { build as buildRenderer } from 'vite';
import { build as buildDesktop } from 'esbuild';

await buildRenderer();
await buildDesktop({
  entryPoints: { main: 'electron/main.ts', preload: 'electron/preload.ts' },
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  external: ['electron'],
  outdir: 'dist-electron',
  outExtension: { '.js': '.cjs' },
});
