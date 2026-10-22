import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

if (process.argv.includes('--help')) {
  console.log('Usage: node scripts/smoke.mjs\nLaunch the production build once with isolated HOME/XDG directories. Requires a display and working Electron sandbox. A trusted IPC parent receives the bridge check; main quits intentionally. Deadline: 15 seconds (timeout is failure). No sandbox bypass or application data-path flags.');
} else if (process.argv.length !== 2) {
  console.error('Unknown argument. Use --help.');
  process.exitCode = 1;
} else {
  const root = await mkdtemp(join(tmpdir(), 'local-vault-smoke-'));
  console.log(`Isolated runtime directory: ${root}`);
  try {
    const env = { ...process.env, HOME: root, LOCAL_VAULT_SMOKE: '1' };
    delete env.ELECTRON_RUN_AS_NODE;
    for (const [key, suffix] of Object.entries({ XDG_CONFIG_HOME: 'config', XDG_CACHE_HOME: 'cache', XDG_DATA_HOME: 'data', XDG_RUNTIME_DIR: 'runtime' })) {
      env[key] = join(root, suffix);
      await mkdir(env[key], { mode: 0o700 });
    }
    // Read package metadata without executing its lazy binary downloader.
    const relative = (await readFile(new URL('../node_modules/electron/path.txt', import.meta.url), 'utf8')).trim();
    const binary = resolve('node_modules/electron/dist', relative);
    const child = spawn(binary, ['.'], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], shell: false });
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
    let confirmed = false;
    let expired = false;
    child.on('message', message => {
      if (message?.type === 'vault-smoke' && message.ok === true) confirmed = true;
    });
    const deadline = setTimeout(() => { expired = true; child.kill('SIGKILL'); }, 15_000);
    const result = await new Promise(resolveExit => {
      child.once('error', error => resolveExit({ error: error.message }));
      child.once('exit', (code, signal) => resolveExit({ code, signal }));
    });
    clearTimeout(deadline);
    console.log(`Native result: ${JSON.stringify({ ...result, confirmed, expired })}`);
    process.exitCode = result.code === 0 && confirmed && !expired ? 0 : 1;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
