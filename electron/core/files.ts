import { constants } from 'node:fs';
import { link, lstat, open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join, parse, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

export function fail(message: string): never { throw new Error(message); }
export const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';
export interface FileImage {
  bytes: Buffer;
  identity: string;
}
function identity(s: Awaited<ReturnType<typeof lstat>>): string {
  return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
}

/** No names become paths. Reject symlinks in every existing component. */
export async function safePath(input: string): Promise<string> {
  if (typeof input !== 'string' || !input || input.includes('\0')) fail('Unsafe file path.');
  const path = resolve(input);
  if (path.split(/[\\/]/).some(part => ['.git', '.jj'].includes(part.toLowerCase()))) fail('Unsafe file path.');
  const root = parse(path).root;
  let cursor = root;
  const parts = path.slice(root.length).split(sep);
  for (let i = 0; i < parts.length; i++) {
    cursor = join(cursor, parts[i]!);
    try {
      const s = await lstat(cursor);
      if (s.isSymbolicLink() || (i < parts.length - 1 ? !s.isDirectory() : !s.isFile() || s.nlink !== 1)) {
        fail('Unsafe file path.');
      }
    } catch (error) {
      if (!missing(error) || i !== parts.length - 1) throw error;
    }
  }
  return path;
}

/** Bounded reads, including when a file grows while being read. */
export async function image(path: string, limit: number): Promise<FileImage | null> {
  await safePath(path);
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if (missing(error)) return null; throw error; }
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1) fail('Unsafe file path.');
    if (before.size > limit) fail('File exceeds size limit.');
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > limit) fail('File exceeds size limit.');
    const after = await handle.stat();
    if (identity(before) !== identity(after)) fail('File changed while reading.');
    return { bytes: buffer.subarray(0, length), identity: identity(after) };
  } finally { await handle.close(); }
}
export function same(a: FileImage | null, b: FileImage | null): boolean {
  return a === null ? b === null : b !== null && a.identity === b.identity && a.bytes.equals(b.bytes);
}

/** Encrypted vault replacement only. Temp and directory live on the same filesystem. */
export async function replaceVault(path: string, bytes: Buffer, before: FileImage | null, limit: number): Promise<void> {
  const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const handle = await open(temp, 'wx', 0o600);
  let renamed = false;
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    await safePath(path);
    if (!same(before, await image(path, limit))) fail('Vault changed on disk. Lock and unlock again.');
    if (before === null) {
      // Publish a fully synced inode exclusively; never overwrite a newly appeared file.
      try { await link(temp, path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail('Vault changed on disk. Lock and unlock again.');
        throw error;
      }
    } else {
      await rename(temp, path);
      renamed = true;
    }
    // The contents are already durable; directory sync is best-effort across OSes.
    try {
      const directory = await open(dirname(path), constants.O_RDONLY);
      try { await directory.sync(); } finally { await directory.close(); }
    } catch { /* Directory fsync is not supported by all supported platforms. */ }
  } finally {
    await handle.close().catch(() => undefined);
    if (!renamed) await unlink(temp);
  }
}

/** Existing destinations use the verified open inode, never a blind rename over a new file. */
export async function writeDestination(path: string, bytes: Buffer, before: FileImage | null, limit: number): Promise<void> {
  await safePath(path);
  if (!same(before, await image(path, limit))) fail('Export preview is stale.');
  let handle;
  try {
    handle = await open(path, before === null ? constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW
      : constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    if (missing(error) || (error as NodeJS.ErrnoException).code === 'EEXIST') fail('Export preview is stale.');
    throw error;
  }
  try {
    const s = await handle.stat();
    if (!s.isFile() || s.nlink !== 1) fail('Unsafe file path.');
    if (before !== null) {
      if (identity(s) !== before.identity || !same(before, await image(path, limit))) fail('Export preview is stale.');
    }
    await handle.chmod(0o600);
    await handle.writeFile(bytes);
    await handle.truncate(bytes.length);
    await handle.sync();
  } finally { await handle.close(); }
}
