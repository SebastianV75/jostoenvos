import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, symlink, link, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { VaultService } from '../electron/core/vault.js';

const password = 'FAKE master password for tests';
const raw = '# fake values only\r\nFAKE_TOKEN="example-not-real"\r\nEMPTY=\r\n';
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), 'local-vault-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'vault.enc');
  return { dir, path, service: new VaultService(path) };
}
async function populated(service: VaultService) {
  await service.create(password);
  let state = await service.addProject('Fake project');
  const project = state.vault!.projects[0]!.id;
  state = await service.addEnvironment(project, 'Development');
  const environment = state.vault!.projects[0]!.environments[0]!.id;
  await service.saveEnvironment(project, environment, raw);
  return { project, environment };
}
async function unchanged(service: VaultService, path: string, action: () => Promise<unknown>, message?: string) {
  const before = await service.state();
  const bytes = await readFile(path);
  if (message) await assert.rejects(action, { message });
  else await assert.rejects(action);
  assert.deepEqual(await service.state(), before);
  assert.deepEqual(await readFile(path), bytes);
  const reopened = await new VaultService(path).unlock(password);
  assert.deepEqual(reopened.vault, before.vault);
}

test('create, detached state, organization, raw text, lock and portable persistence', async t => {
  const { dir, path, service } = await fixture(t);
  assert.deepEqual(await service.state(), { exists: false, locked: true, vault: null });
  const { project, environment } = await populated(service);
  const state = await service.state();
  state.vault!.projects[0]!.name = 'detached mutation';
  assert.equal((await service.state()).vault!.projects[0]!.name, 'Fake project');
  const bytes = await readFile(path, 'utf8');
  assert.equal(bytes.includes('example-not-real'), false);
  assert.equal(bytes.includes('Fake project'), false);
  assert.equal(bytes.includes(password), false);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const source = join(dir, 'fake.env');
  await writeFile(source, raw + '# imported\r\n');
  await service.importEnvironment(project, environment, source);
  assert.equal((await service.state()).vault!.projects[0]!.environments[0]!.content, raw + '# imported\r\n');
  await service.lock();
  assert.deepEqual(await service.state(), { exists: true, locked: true, vault: null });
  await assert.rejects(service.addProject('No'), { message: 'Vault is locked.' });
  assert.equal((await new VaultService(path).unlock(password)).vault!.projects[0]!.environments[0]!.content, raw + '# imported\r\n');
});

test('wrong password and authenticated tampering do not mutate stored bytes', async t => {
  const { path, service } = await fixture(t);
  await populated(service);
  await service.lock();
  const bytes = await readFile(path);
  await assert.rejects(service.unlock('FAKE wrong'), { message: 'Unable to unlock vault.' });
  assert.deepEqual(await readFile(path), bytes);
  assert.deepEqual(await service.state(), { exists: true, locked: true, vault: null });
  const envelope = JSON.parse(bytes.toString());
  const encrypted = Buffer.from(envelope.ciphertext, 'base64');
  encrypted[0] ^= 1;
  envelope.ciphertext = encrypted.toString('base64');
  await writeFile(path, JSON.stringify(envelope));
  const tampered = await readFile(path);
  await assert.rejects(service.unlock(password), { message: 'Unable to unlock vault.' });
  assert.deepEqual(await readFile(path), tampered);
  await writeFile(path, bytes);
  assert.equal((await service.unlock(password)).vault!.projects.length, 1);
});

test('backup and cross-instance restore validate before replacement', async t => {
  const { dir, path, service } = await fixture(t);
  await populated(service);
  const backup = join(dir, 'portable.enc');
  await service.backup(backup);
  assert.equal((await readFile(backup, 'utf8')).includes('example-not-real'), false);
  const otherPath = join(dir, 'other.enc');
  const other = new VaultService(otherPath);
  await other.restore(password, backup);
  assert.deepEqual((await other.state()).vault, (await service.state()).vault);
  await unchanged(other, otherPath, () => other.restore('wrong', backup), 'Unable to restore vault.');
  const bad = join(dir, 'bad.enc');
  await writeFile(bad, '{"version":1}');
  await unchanged(service, path, () => service.restore(password, bad), 'Unable to restore vault.');
});

test('preview, cancellation, confirmation and single-use capability preserve raw bytes', async t => {
  const { dir, path, service } = await fixture(t);
  const { project, environment } = await populated(service);
  const dest = join(dir, 'output.env');
  await writeFile(dest, 'FAKE=old\r\n');
  let preview = await service.previewExport(project, environment, dest);
  assert.equal(preview.previousContent, 'FAKE=old\r\n');
  assert.equal(preview.proposedContent, raw);
  assert.equal(preview.destinationLabel, 'output.env');
  await service.cancelExport(preview.id);
  assert.equal(await readFile(dest, 'utf8'), 'FAKE=old\r\n');
  await unchanged(service, path, () => service.confirmExport(preview.id), 'Invalid export preview.');
  preview = await service.previewExport(project, environment, dest);
  await service.confirmExport(preview.id);
  assert.equal(await readFile(dest, 'utf8'), raw);
  await unchanged(service, path, () => service.confirmExport(preview.id), 'Invalid export preview.');
  const fresh = join(dir, 'new.env');
  const next = await service.previewExport(project, environment, fresh);
  assert.equal(next.previousContent, null);
  await service.confirmExport(next.id);
  assert.equal(await readFile(fresh, 'utf8'), raw);
});

test('changed destinations, source revisions and lock invalidate previews without writes', async t => {
  const { dir, path, service } = await fixture(t);
  const { project, environment } = await populated(service);
  const dest = join(dir, 'output.env');
  await writeFile(dest, 'old');
  let preview = await service.previewExport(project, environment, dest);
  await writeFile(dest, 'external change');
  await unchanged(service, path, () => service.confirmExport(preview.id), 'Export preview is stale.');
  assert.equal(await readFile(dest, 'utf8'), 'external change');
  preview = await service.previewExport(project, environment, dest);
  await service.saveEnvironment(project, environment, 'FAKE=new');
  await unchanged(service, path, () => service.confirmExport(preview.id), 'Export preview is stale.');
  assert.equal(await readFile(dest, 'utf8'), 'external change');
  const fresh = join(dir, 'appeared.env');
  preview = await service.previewExport(project, environment, fresh);
  await writeFile(fresh, 'appeared');
  await unchanged(service, path, () => service.confirmExport(preview.id), 'Export preview is stale.');
  assert.equal(await readFile(fresh, 'utf8'), 'appeared');
  preview = await service.previewExport(project, environment, dest);
  await service.lock();
  await assert.rejects(service.confirmExport(preview.id), { message: 'Vault is locked.' });
  assert.equal(await readFile(dest, 'utf8'), 'external change');
  await service.unlock(password);
  assert.equal((await service.state()).vault!.projects[0]!.environments[0]!.content, 'FAKE=new');
});

test('validation, symlinks, metadata and protected vault destinations are rejected', async t => {
  const { dir, path, service } = await fixture(t);
  const { project, environment } = await populated(service);
  for (const name of ['', ' '.repeat(4), 'x'.repeat(129), 'bad\nname']) {
    await unchanged(service, path, () => service.addProject(name), 'Invalid name.');
  }
  await unchanged(service, path, () => service.addEnvironment('not-an-id', 'Fake'), 'Invalid identifier.');
  await unchanged(service, path, () => service.saveEnvironment(project, environment, 'x'.repeat(1024 * 1024 + 1)), 'Environment exceeds 1 MiB.');
  await unchanged(service, path, () => service.previewExport(project, environment, path), 'Unsafe file path.');
  await unchanged(service, path, () => service.backup(path), 'Unsafe file path.');
  const metadata = join(dir, '.git');
  await mkdir(metadata);
  await unchanged(service, path, () => service.backup(join(metadata, 'config')), 'Unsafe file path.');
  const link = join(dir, 'link.env');
  await symlink(path, link);
  await unchanged(service, path, () => service.importEnvironment(project, environment, link), 'Unsafe file path.');
  const huge = join(dir, 'huge.env');
  await writeFile(huge, 'x'.repeat(1024 * 1024 + 1));
  await unchanged(service, path, () => service.importEnvironment(project, environment, huge), 'File exceeds size limit.');
});

test('bounded envelopes, invalid UTF-8 and unsafe filesystem inputs preserve the vault', async t => {
  const { dir, path, service } = await fixture(t);
  const { project, environment } = await populated(service);
  const bytes = await readFile(path);
  const invalid = join(dir, 'invalid.enc');
  const envelope = JSON.parse(bytes.toString());
  for (const value of [
    { ...envelope, version: 2 }, { ...envelope, extra: true },
    { ...envelope, salt: 'a'.repeat(1024 * 1024) },
    { ...envelope, nonce: '' }, { ...envelope, tag: 1 },
    { ...envelope, ciphertext: '!!!!' },
  ]) {
    await writeFile(invalid, JSON.stringify(value));
    await unchanged(service, path, () => service.restore(password, invalid), 'Unable to restore vault.');
  }
  await writeFile(invalid, 'x'.repeat(12 * 1024 * 1024 + 1));
  await unchanged(service, path, () => service.restore(password, invalid), 'Unable to restore vault.');
  const badText = join(dir, 'bad.env');
  await writeFile(badText, Buffer.from([0xff]));
  await unchanged(service, path, () => service.importEnvironment(project, environment, badText), 'Invalid UTF-8.');
  await unchanged(service, path, () => service.saveEnvironment(project, environment, '\ud800'), 'Invalid UTF-8.');
  await unchanged(service, path, () => service.previewExport(project, environment, badText), 'Invalid UTF-8.');
  await unchanged(service, path, () => service.backup(dir), 'Unsafe file path.');
  const hardlink = join(dir, 'hardlink');
  await link(path, hardlink);
  const linkedBytes = await readFile(path);
  const before = (await service.state().catch(() => null));
  assert.equal(before, null); // The vault itself is now unsafe, not silently accepted.
  await assert.rejects(service.previewExport(project, environment, hardlink), { message: 'Unsafe file path.' });
  assert.deepEqual(await readFile(path), linkedBytes);
  await rm(hardlink);
  assert.deepEqual((await new VaultService(path).unlock(password)).vault, (await service.state()).vault);
  // Creating/removing a hardlink changes ctime; explicitly accept that external revision.
  await service.lock();
  await service.unlock(password);
  const parentLink = join(dir, 'parent-link');
  await symlink(dir, parentLink);
  await unchanged(service, path, () => service.backup(join(parentLink, 'backup')), 'Unsafe file path.');
});

test('empty documents, exact byte limit, bounded previews and replaced destination inode', async t => {
  const { dir, path, service } = await fixture(t);
  const { project, environment } = await populated(service);
  await service.saveEnvironment(project, environment, '');
  assert.equal((await new VaultService(path).unlock(password)).vault!.projects[0]!.environments[0]!.content, '');
  const maximum = 'x'.repeat(1024 * 1024);
  await service.saveEnvironment(project, environment, maximum);
  assert.equal((await new VaultService(path).unlock(password)).vault!.projects[0]!.environments[0]!.content, maximum);
  const dest = join(dir, 'replaced.env');
  await writeFile(dest, 'previous');
  const preview = await service.previewExport(project, environment, dest);
  await rename(dest, join(dir, 'old.env'));
  await writeFile(dest, 'previous');
  await unchanged(service, path, () => service.confirmExport(preview.id), 'Export preview is stale.');
  assert.equal(await readFile(dest, 'utf8'), 'previous');
  const previews = await Promise.all(Array.from({ length: 16 }, (_, i) => service.previewExport(project, environment, join(dir, `out-${i}.env`))));
  await unchanged(service, path, () => service.previewExport(project, environment, join(dir, 'overflow.env')), 'Too many export previews (16).');
  await service.cancelExport(previews[0]!.id);
  await service.previewExport(project, environment, join(dir, 'replacement.env'));
  await service.lock();
  await service.unlock(password);
  await unchanged(service, path, () => service.addEnvironment(project, ''), 'Invalid name.');
  await unchanged(service, path, () => service.create(password), 'Vault already exists.');
  const backup = join(dir, 'backup.enc');
  await service.backup(backup);
  const backupBytes = await readFile(backup);
  await unchanged(service, path, () => service.backup(backup), 'Backup destination already exists.');
  assert.deepEqual(await readFile(backup), backupBytes);
});

test('serialized concurrent mutations retain all updates and reject externally changed vault', async t => {
  const { dir, path, service } = await fixture(t);
  await service.create(password);
  await Promise.all(Array.from({ length: 8 }, (_, i) => service.addProject(`Fake ${i}`)));
  const state = await service.state();
  assert.equal(state.vault!.projects.length, 8);
  assert.deepEqual((await new VaultService(path).unlock(password)).vault, state.vault);
  const foreign = new VaultService(path);
  await foreign.unlock(password);
  await foreign.addProject('External fake');
  const bytes = await readFile(path);
  await assert.rejects(service.addProject('Must not overwrite'), { message: 'Vault changed on disk. Lock and unlock again.' });
  assert.deepEqual(await readFile(path), bytes);
  assert.deepEqual(await service.state(), state);
  await service.lock();
  await service.unlock(password);
  const preview = await service.previewExport(state.vault!.projects[0]!.id,
    (await service.addEnvironment(state.vault!.projects[0]!.id, 'Fake')).vault!.projects[0]!.environments[0]!.id,
    join(dir, 'out.env'));
  await foreign.lock();
  await foreign.unlock(password);
  await foreign.addProject('Another external fake');
  await assert.rejects(service.confirmExport(preview.id), { message: 'Vault changed on disk. Lock and unlock again.' });
  await assert.rejects(readFile(join(dir, 'out.env')), { code: 'ENOENT' });
});
