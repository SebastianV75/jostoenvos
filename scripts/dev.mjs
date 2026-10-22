import { spawn } from 'node:child_process';
import electron from 'electron';
import './build.mjs';

// Local built assets only; rerun to rebuild. Browser iteration uses dev:browser.
const child = spawn(electron, ['.'], { stdio: 'inherit', shell: false });
child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
