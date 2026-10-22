import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { VaultService } from '../electron/core/vault.js';
import { createDispatcher, publicError, type NativeDialogs } from '../electron/bridge.js';
import { channels } from '../electron/channels.js';

const password = 'FAKE-only-password';
const uuid = '00000000-0000-4000-8000-000000000000';
async function fixture(t: import('node:test').TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'vault-desktop-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'vault.json');
  const service = new VaultService(path);
  let selected: string | null = null;
  let approved = false;
  let prompts = 0;
  const dialogs: NativeDialogs = {
    open: async () => selected,
    save: async () => selected,
    confirmRestore: async () => { prompts++; return approved; },
  };
  const frame = { url: 'file:///app/index.html' };
  const sender = { mainFrame: frame };
  const caller = { sender, senderFrame: frame };
  const dispatch = createDispatcher(service, dialogs, () => sender, frame.url);
  const call = (method: keyof typeof channels, ...args: unknown[]) => dispatch(caller, channels[method], args);
  return { dir, path, service, call, dispatch, caller, frame,
    select: (value: string | null) => { selected = value; },
    approve: (value: boolean) => { approved = value; }, prompts: () => prompts };
}

test('all thirteen channels enforce exact arity, types, bounds and trusted main frame without mutation', async t => {
  const f = await fixture(t);
  assert.equal(Object.keys(channels).length, 13);
  await f.call('create', password);
  const before = await readFile(f.path);
  const state = await f.call('state');
  for (const method of Object.keys(channels) as (keyof typeof channels)[]) {
    await assert.rejects(f.call(method, ...Array(4).fill('bad')), /^Error: Invalid IPC arguments\.$/);
    await assert.rejects(f.call(method, 1), /^Error: Invalid IPC arguments\.$/);
    await assert.rejects(f.dispatch({ ...f.caller, senderFrame: { url: f.frame.url } }, channels[method], []), /^Error: Unauthorized IPC caller\.$/);
    await assert.rejects(f.dispatch({ ...f.caller, sender: { mainFrame: f.frame } }, channels[method], []), /^Error: Unauthorized IPC caller\.$/);
  }
  const arities: Record<keyof typeof channels, number> = { state: 0, create: 1, unlock: 1, lock: 0, addProject: 1, addEnvironment: 2, saveEnvironment: 3, importEnvironment: 2, previewExport: 2, confirmExport: 1, cancelExport: 1, backup: 0, restore: 1 };
  for (const method of Object.keys(channels) as (keyof typeof channels)[]) {
    if (arities[method]) {
      await assert.rejects(f.call(method), /Invalid IPC arguments\./);
      await assert.rejects(f.call(method, ...Array(arities[method]).fill({})), /Invalid IPC arguments\./);
    }
  }
  f.frame.url = 'https://foreign.invalid/';
  await assert.rejects(f.call('state'), /Unauthorized IPC caller\./);
  f.frame.url = 'file:///app/index.html';
  await assert.rejects(f.dispatch(f.caller, 'vault:unknown', []), /^Error: Unknown IPC channel\.$/);
  await assert.rejects(f.call('create', 'x'.repeat(1025)), /Invalid IPC arguments\./);
  await assert.rejects(f.call('addProject', 'x'.repeat(129)), /Invalid IPC arguments\./);
  await assert.rejects(f.call('saveEnvironment', uuid, uuid, 'x'.repeat(1024 * 1024 + 1)), /Invalid IPC arguments\./);
  await assert.rejects(f.call('confirmExport', '../path'), /Invalid IPC arguments\./);
  assert.deepEqual(await f.call('state'), state);
  assert.deepEqual(await readFile(f.path), before);
});

test('public adapter supports create, documents, native cancellation, previews, backup and confirmed portable restore', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.call('state'), { exists: false, locked: true, vault: null });
  await f.call('create', password);
  let state = await f.call('addProject', 'Fake project') as Awaited<ReturnType<VaultService['state']>>;
  const project = state.vault!.projects[0]!.id;
  // Preserve the public addProject route as well.
  await f.call('addProject', 'Another fake project');
  state = await f.call('addEnvironment', project, 'Fake local') as typeof state;
  const env = state.vault!.projects[0]!.environments[0]!.id;
  await f.call('saveEnvironment', project, env, 'FAKE_KEY=example\r\n');
  const before = await readFile(f.path);
  for (const [method, args] of [['importEnvironment', [project, env]], ['previewExport', [project, env]], ['backup', []], ['restore', [password]]] as const) {
    assert.equal(await f.call(method, ...args), null);
    assert.deepEqual(await readFile(f.path), before);
  }
  const external = join(f.dir, 'fake.env');
  await writeFile(external, 'FAKE_KEY=old\n');
  f.select(external);
  const preview = await f.call('previewExport', project, env) as { id: string; destinationLabel: string };
  assert.equal(preview.destinationLabel, 'fake.env');
  assert.equal(await readFile(external, 'utf8'), 'FAKE_KEY=old\n');
  await f.call('cancelExport', preview.id);
  await assert.rejects(f.call('confirmExport', preview.id), /Invalid export preview\./);
  const next = await f.call('previewExport', project, env) as typeof preview;
  await f.call('confirmExport', next.id);
  assert.equal(await readFile(external, 'utf8'), 'FAKE_KEY=example\r\n');
  const stale = await f.call('previewExport', project, env) as typeof preview;
  await writeFile(external, 'FAKE_KEY=changed\n');
  await assert.rejects(f.call('confirmExport', stale.id), /Export preview is stale\./);
  assert.equal(await readFile(external, 'utf8'), 'FAKE_KEY=changed\n');
  await f.call('importEnvironment', project, env);
  const backup = join(f.dir, 'portable.vault');
  f.select(backup);
  await f.call('backup');
  const encrypted = await readFile(backup);
  assert.equal(encrypted.includes('FAKE_KEY'), false);
  await assert.rejects(f.call('backup'), /^Error: Backup destination already exists\. Choose a new name\.$/);
  assert.deepEqual(await readFile(backup), encrypted);
  await f.call('saveEnvironment', project, env, 'FAKE_KEY=current\n');
  const current = await readFile(f.path);
  const currentState = await f.call('state');
  assert.equal(await f.call('restore', password), null);
  assert.equal(f.prompts(), 1);
  assert.deepEqual(await readFile(f.path), current);
  assert.deepEqual(await f.call('state'), currentState);
  f.approve(true);
  await assert.rejects(f.call('restore', 'FAKE-wrong'), /Unable to restore vault\./);
  assert.deepEqual(await readFile(f.path), current);
  assert.deepEqual(await f.call('state'), currentState);
  await f.call('restore', password);
  assert.equal((await f.service.state()).vault!.projects[0]!.environments[0]!.content, 'FAKE_KEY=changed\n');
  await f.call('lock');
  await assert.rejects(f.call('unlock', 'FAKE-wrong'), /Unable to unlock vault\./);
  assert.equal((await f.service.state()).locked, true);
  await f.call('unlock', password);
  const portable = new VaultService(join(f.dir, 'another-machine.json'));
  const other = createDispatcher(portable, { open: async () => backup, save: async () => null, confirmRestore: async () => { throw Error('Must not ask for absent vault'); } }, () => f.caller.sender, f.frame.url);
  await other(f.caller, channels.restore, [password]);
  assert.deepEqual((await portable.state()).vault, (await f.service.state()).vault);
});

test('bundled sandbox preload exposes only a frozen bridge and preserves runtime arguments and exact errors', async () => {
  const result = await build({ entryPoints: ['electron/preload.ts'], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['electron'] });
  let exposed!: Record<string, (...args: unknown[]) => Promise<unknown>>;
  let invocation: unknown[] = [];
  let error: string | null = null;
  runInNewContext(result.outputFiles[0]!.text, {
    require: (module: string) => {
      assert.equal(module, 'electron');
      return {
        contextBridge: { exposeInMainWorld: (key: string, value: typeof exposed) => { assert.equal(key, 'vault'); exposed = value; } },
        ipcRenderer: { invoke: async (...args: unknown[]) => { invocation = args; return error === null ? { ok: true, value: null } : { ok: false, error }; } },
      };
    },
  });
  assert.equal(Object.isFrozen(exposed), true);
  assert.deepEqual(Object.keys(exposed).sort(), Object.keys(channels).sort());
  for (const [method, channel] of Object.entries(channels)) {
    assert.equal(await exposed[method]!('FAKE', 'extra'), null);
    assert.deepEqual(invocation, [channel, 'FAKE', 'extra']);
  }
  error = 'Unable to unlock vault.';
  await assert.rejects(exposed.unlock!('FAKE-wrong'), { message: error });
  assert.equal(publicError(new Error(error)), error);
  const changed = 'Vault changed on disk. Lock and unlock again.';
  assert.equal(publicError(new Error(changed)), changed);
  assert.equal(publicError(new Error('Cannot open /private/fake-path.')), 'Unable to access local file.');
  assert.equal(publicError(Object.assign(new Error('EACCES /private/path'), { code: 'EACCES' })), 'Unable to access local file.');
});

test('dialog resolution is serialized with lock and restore, and errors do not poison the queue', async t => {
  const f = await fixture(t);
  await f.call('create', password);
  const state = await f.call('addProject', 'Fake project') as Awaited<ReturnType<VaultService['state']>>;
  const project = state.vault!.projects[0]!.id;
  const withEnv = await f.call('addEnvironment', project, 'Fake') as typeof state;
  const env = withEnv.vault!.projects[0]!.environments[0]!.id;
  const external = join(f.dir, 'fake.env');
  await writeFile(external, 'FAKE=example');
  let resolve!: (value: string | null) => void;
  let opened!: () => void;
  const opening = new Promise<void>(r => { opened = r; });
  const pending = new Promise<string | null>(r => { resolve = r; });
  const dispatch = createDispatcher(f.service, { open: async () => { opened(); return pending; }, save: async () => null, confirmRestore: async () => false }, () => f.caller.sender, f.frame.url);
  const importing = dispatch(f.caller, channels.importEnvironment, [project, env]);
  await opening;
  const locking = dispatch(f.caller, channels.lock, []);
  resolve(external);
  await importing;
  assert.equal((await locking as typeof state).locked, true);
  await assert.rejects(dispatch(f.caller, channels.addProject, ['Fake']), /Vault is locked\./);
  assert.equal((await dispatch(f.caller, channels.state, []) as typeof state).locked, true);
});
