import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scrypt } from 'node:crypto';
import { basename, resolve } from 'node:path';
import type { ExportPreview, VaultEnvironment, VaultSnapshot, VaultState } from '../../shared/api.js';
import { fail, image, replaceVault, safePath, same, writeDestination, type FileImage } from './files.js';

const ENV_LIMIT = 1024 * 1024;
const DATA_LIMIT = 8 * 1024 * 1024;
const FILE_LIMIT = 12 * 1024 * 1024;
const AAD = Buffer.from('local-vault:version=1;scrypt=N32768,r8,p1;AES-256-GCM');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const copy = <T>(value: T): T => structuredClone(value);
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...keys].sort().join(',');
function name(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 128 || /[\x00-\x1f\x7f]/.test(value)) fail('Invalid name.');
}
function id(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !UUID.test(value)) fail('Invalid identifier.');
}
function content(value: unknown): asserts value is string {
  if (typeof value !== 'string') fail('Invalid environment content.');
  if (Buffer.byteLength(value) > ENV_LIMIT) fail('Environment exceeds 1 MiB.');
  // JS lone surrogates are not losslessly representable as UTF-8.
  if (Buffer.from(value).toString('utf8') !== value) fail('Invalid UTF-8.');
}
function password(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.length || Buffer.byteLength(value) > 1024) fail('Password must contain 1–1024 UTF-8 bytes.');
}
function text(bytes: Buffer): string {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return fail('Invalid UTF-8.'); }
}
function validate(value: unknown): asserts value is VaultSnapshot {
  if (!exact(value, ['projects']) || !Array.isArray(value.projects) || value.projects.length > 100) fail('Invalid vault data.');
  const ids = new Set<string>();
  let environments = 0;
  for (const project of value.projects) {
    if (!exact(project, ['id', 'name', 'environments']) || !Array.isArray(project.environments) || project.environments.length > 100) fail('Invalid vault data.');
    id(project.id); name(project.name);
    if (ids.has(project.id)) fail('Invalid vault data.');
    ids.add(project.id);
    for (const env of project.environments) {
      if (!exact(env, ['id', 'name', 'content'])) fail('Invalid vault data.');
      id(env.id); name(env.name); content(env.content);
      if (ids.has(env.id) || ++environments > 1000) fail('Invalid vault data.');
      ids.add(env.id);
    }
  }
}
function encode(snapshot: VaultSnapshot): Buffer {
  validate(snapshot);
  const bytes = Buffer.from(JSON.stringify(snapshot));
  if (bytes.length > DATA_LIMIT) fail('Vault exceeds 8 MiB.');
  return bytes;
}
function base64(value: unknown, length?: number): Buffer {
  if (typeof value !== 'string' || value.length % 4 !== 0 ||
      (length !== undefined && value.length !== Math.ceil(length / 3) * 4) ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) fail('Invalid envelope.');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || (length !== undefined && bytes.length !== length)) fail('Invalid envelope.');
  return bytes;
}
function derive(pass: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(pass, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key));
  });
}
function encrypt(snapshot: VaultSnapshot, key: Buffer, salt: Buffer): Buffer {
  const plaintext = encode(snapshot);
  try {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(AAD);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.from(JSON.stringify({ version: 1, salt: salt.toString('base64'), nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') }));
  } finally { plaintext.fill(0); }
}
async function decrypt(bytes: Buffer, pass: string): Promise<{ snapshot: VaultSnapshot; key: Buffer; salt: Buffer }> {
  password(pass);
  if (bytes.length > FILE_LIMIT) fail('Invalid envelope.');
  const envelope: unknown = JSON.parse(text(bytes));
  if (!exact(envelope, ['version', 'salt', 'nonce', 'tag', 'ciphertext']) || envelope.version !== 1) fail('Invalid envelope.');
  const salt = base64(envelope.salt, 16);
  const nonce = base64(envelope.nonce, 12);
  const tag = base64(envelope.tag, 16);
  if (typeof envelope.ciphertext !== 'string' || envelope.ciphertext.length > Math.ceil(DATA_LIMIT / 3) * 4) fail('Invalid envelope.');
  const ciphertext = base64(envelope.ciphertext);
  if (ciphertext.length > DATA_LIMIT) fail('Invalid envelope.');
  const key = await derive(pass, salt);
  let plaintext: Buffer | undefined;
  try {
    const cipher = createDecipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(AAD); cipher.setAuthTag(tag);
    plaintext = Buffer.concat([cipher.update(ciphertext), cipher.final()]);
    const snapshot: unknown = JSON.parse(text(plaintext));
    validate(snapshot);
    return { snapshot, key, salt };
  } catch (error) { key.fill(0); throw error; }
  finally { plaintext?.fill(0); }
}

interface Pending {
  path: string;
  before: FileImage | null;
  content: string;
  revision: number;
}

/** Trusted main-process service. Paths are main-selected, never renderer parameters. */
export class VaultService {
  private readonly path: string;
  private queue: Promise<unknown> = Promise.resolve();
  private snapshot: VaultSnapshot | null = null;
  private key: Buffer | null = null;
  private salt: Buffer | null = null;
  private disk: FileImage | null = null;
  private revision = 0;
  private previews = new Map<string, Pending>();

  constructor(vaultPath: string) { this.path = resolve(vaultPath); }
  /** A failed operation cannot poison the queue; all reads and writes share it. */
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => undefined);
    return result;
  }
  private async current(): Promise<VaultState> {
    return { exists: (await image(this.path, FILE_LIMIT)) !== null, locked: this.snapshot === null, vault: copy(this.snapshot) };
  }
  private unlocked(): VaultSnapshot {
    if (!this.snapshot || !this.key || !this.salt) fail('Vault is locked.');
    return this.snapshot;
  }
  private async unchanged(): Promise<void> {
    if (!same(this.disk, await image(this.path, FILE_LIMIT))) fail('Vault changed on disk. Lock and unlock again.');
  }
  private environment(snapshot: VaultSnapshot, projectId: string, environmentId: string): VaultEnvironment {
    id(projectId); id(environmentId);
    const project = snapshot.projects.find(p => p.id === projectId);
    if (!project) fail('Project not found.');
    const env = project.environments.find(e => e.id === environmentId);
    if (!env) fail('Environment not found.');
    return env;
  }
  private async persist(snapshot: VaultSnapshot, key: Buffer, salt: Buffer, before: FileImage | null): Promise<void> {
    await replaceVault(this.path, encrypt(snapshot, key, salt), before, FILE_LIMIT);
    this.disk = await image(this.path, FILE_LIMIT);
    this.snapshot = snapshot;
    if (this.key !== key) this.key?.fill(0);
    this.key = key; this.salt = salt;
    this.revision++;
  }
  private async mutate(change: (next: VaultSnapshot) => void): Promise<VaultState> {
    const next = copy(this.unlocked());
    await this.unchanged();
    change(next);
    await this.persist(next, this.key!, this.salt!, this.disk);
    return this.current();
  }
  private async external(path: string): Promise<string> {
    const safe = await safePath(path);
    if (safe.toLowerCase() === this.path.toLowerCase()) fail('Unsafe file path.');
    // Hardlinks to any file are rejected by safePath, including the vault.
    return safe;
  }

  state(): Promise<VaultState> { return this.serial(() => this.current()); }
  create(pass: string): Promise<VaultState> {
    return this.serial(async () => {
      password(pass);
      if (await image(this.path, FILE_LIMIT)) fail('Vault already exists.');
      const salt = randomBytes(16);
      const key = await derive(pass, salt);
      try { await this.persist({ projects: [] }, key, salt, null); }
      catch (error) { key.fill(0); throw error; }
      this.previews.clear();
      return this.current();
    });
  }
  unlock(pass: string): Promise<VaultState> {
    return this.serial(async () => {
      let decoded: Awaited<ReturnType<typeof decrypt>>;
      let disk: FileImage;
      try {
        const found = await image(this.path, FILE_LIMIT);
        if (!found) fail('Missing vault.');
        disk = found;
        decoded = await decrypt(disk.bytes, pass);
      } catch { return fail('Unable to unlock vault.'); }
      this.key?.fill(0);
      this.key = decoded.key; this.salt = decoded.salt; this.snapshot = decoded.snapshot; this.disk = disk;
      this.revision++; this.previews.clear();
      return this.current();
    });
  }
  lock(): Promise<VaultState> {
    return this.serial(async () => {
      this.key?.fill(0); this.key = null; this.salt = null; this.snapshot = null;
      this.disk = null; this.previews.clear(); this.revision++;
      return this.current();
    });
  }
  addProject(projectName: string): Promise<VaultState> {
    return this.serial(() => this.mutate(next => {
      name(projectName);
      if (next.projects.length >= 100) fail('Project limit reached (100).');
      next.projects.push({ id: randomUUID(), name: projectName, environments: [] });
    }));
  }
  addEnvironment(projectId: string, environmentName: string): Promise<VaultState> {
    return this.serial(() => this.mutate(next => {
      id(projectId); name(environmentName);
      const project = next.projects.find(p => p.id === projectId);
      if (!project) fail('Project not found.');
      if (project.environments.length >= 100 || next.projects.reduce((n, p) => n + p.environments.length, 0) >= 1000) fail('Environment limit reached (100 per project, 1000 total).');
      project.environments.push({ id: randomUUID(), name: environmentName, content: '' });
    }));
  }
  saveEnvironment(projectId: string, environmentId: string, value: string): Promise<VaultState> {
    return this.serial(() => this.mutate(next => {
      content(value);
      this.environment(next, projectId, environmentId).content = value;
    }));
  }
  importEnvironment(projectId: string, environmentId: string, sourcePath: string): Promise<VaultState> {
    return this.serial(async () => {
      this.environment(this.unlocked(), projectId, environmentId);
      const source = await image(await this.external(sourcePath), ENV_LIMIT);
      if (!source) fail('File not found.');
      const value = text(source.bytes);
      return this.mutate(next => { content(value); this.environment(next, projectId, environmentId).content = value; });
    });
  }
  previewExport(projectId: string, environmentId: string, destinationPath: string): Promise<ExportPreview> {
    return this.serial(async () => {
      const env = this.environment(this.unlocked(), projectId, environmentId);
      await this.unchanged();
      if (this.previews.size >= 16) fail('Too many export previews (16).');
      const path = await this.external(destinationPath);
      const before = await image(path, ENV_LIMIT);
      const previousContent = before === null ? null : text(before.bytes);
      const previewId = randomUUID();
      this.previews.set(previewId, { path, before, content: env.content, revision: this.revision });
      return { id: previewId, destinationLabel: basename(path), previousContent, proposedContent: env.content };
    });
  }
  confirmExport(previewId: string): Promise<VaultState> {
    return this.serial(async () => {
      this.unlocked();
      const preview = this.previews.get(previewId);
      if (!preview) fail('Invalid export preview.');
      this.previews.delete(previewId);
      if (preview.revision !== this.revision) fail('Export preview is stale.');
      await this.unchanged();
      await this.external(preview.path);
      await writeDestination(preview.path, Buffer.from(preview.content), preview.before, ENV_LIMIT);
      return this.current();
    });
  }
  cancelExport(previewId: string): Promise<void> {
    return this.serial(async () => { this.previews.delete(previewId); });
  }
  backup(destinationPath: string): Promise<VaultState> {
    return this.serial(async () => {
      this.unlocked(); await this.unchanged();
      const path = await this.external(destinationPath);
      // Backups never silently overwrite another snapshot or arbitrary user file.
      if (await image(path, FILE_LIMIT)) fail('Backup destination already exists.');
      await replaceVault(path, this.disk!.bytes, null, FILE_LIMIT);
      return this.current();
    });
  }
  restore(pass: string, sourcePath: string): Promise<VaultState> {
    return this.serial(async () => {
      let decoded: Awaited<ReturnType<typeof decrypt>>;
      try {
        const source = await image(await this.external(sourcePath), FILE_LIMIT);
        if (!source) fail('File not found.');
        decoded = await decrypt(source.bytes, pass);
      } catch { return fail('Unable to restore vault.'); }
      try {
        const before = await image(this.path, FILE_LIMIT);
        if (this.snapshot) await this.unchanged();
        await this.persist(decoded.snapshot, decoded.key, decoded.salt, before);
      } catch (error) { decoded.key.fill(0); throw error; }
      this.previews.clear();
      return this.current();
    });
  }
}
