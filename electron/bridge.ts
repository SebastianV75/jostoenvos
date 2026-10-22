import type { VaultService } from './core/vault.js';
import { channels } from './channels.js';

/** Paths originate only in trusted native dialogs; never in IPC arguments. */
export interface NativeDialogs {
  open(kind: 'environment' | 'backup'): Promise<string | null>;
  save(kind: 'environment' | 'backup'): Promise<string | null>;
  confirmRestore(): Promise<boolean>;
}
interface Frame { readonly url: string }
interface Sender { readonly mainFrame: Frame }
interface Caller { readonly sender: Sender; readonly senderFrame: Frame | null }
type Method = keyof typeof channels;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const string = (v: unknown, max: number) => typeof v === 'string' && Buffer.byteLength(v) <= max;
const id = (v: unknown) => typeof v === 'string' && uuid.test(v);
const password = (v: unknown) => string(v, 1024) && (v as string).length > 0;
const name = (v: unknown) => typeof v === 'string' && v.length <= 128;
const rules: Record<Method, ((value: unknown) => boolean)[]> = {
  state: [], create: [password], unlock: [password], lock: [],
  addProject: [name], addEnvironment: [id, name],
  saveEnvironment: [id, id, v => string(v, 1024 * 1024)],
  importEnvironment: [id, id], previewExport: [id, id],
  confirmExport: [id], cancelExport: [id], backup: [], restore: [password],
};

/** One queue covers BOTH native-dialog awaits and service calls. A lock queued
 * during a dialog runs after that operation, never before its late mutation.
 * The service retains its own validation, serialization and capability rules.
 */
export function createDispatcher(service: VaultService, dialogs: NativeDialogs,
  expectedSender: () => Sender | undefined, expectedURL: string) {
  let queue: Promise<unknown> = Promise.resolve();
  function guard(caller: Caller) {
    if (caller.sender !== expectedSender() || !caller.senderFrame ||
        caller.senderFrame !== caller.sender.mainFrame || caller.senderFrame.url !== expectedURL) {
      throw new Error('Unauthorized IPC caller.');
    }
  }
  return async (caller: Caller, channel: string, args: unknown[]): Promise<unknown> => {
    guard(caller);
    const method = (Object.keys(channels) as Method[]).find(key => channels[key] === channel);
    if (!method) throw new Error('Unknown IPC channel.');
    if (!Array.isArray(args) || args.length !== rules[method].length ||
        !rules[method].every((validate, i) => validate(args[i]))) throw new Error('Invalid IPC arguments.');
    // Own a fresh argument array while awaiting the queue; strings are immutable.
    const values = args.slice() as string[];
    const result = queue.then(async () => {
      guard(caller);
      const a = values[0]!; const b = values[1]!; const c = values[2]!;
      switch (method) {
        case 'state': return service.state();
        case 'create': return service.create(a);
        case 'unlock': return service.unlock(a);
        case 'lock': return service.lock();
        case 'addProject': return service.addProject(a);
        case 'addEnvironment': return service.addEnvironment(a, b);
        case 'saveEnvironment': return service.saveEnvironment(a, b, c);
        case 'importEnvironment': {
          const path = await dialogs.open('environment');
          guard(caller);
          return path === null ? null : service.importEnvironment(a, b, path);
        }
        case 'previewExport': {
          const path = await dialogs.save('environment');
          guard(caller);
          return path === null ? null : service.previewExport(a, b, path);
        }
        case 'confirmExport': return service.confirmExport(a);
        case 'cancelExport': return service.cancelExport(a);
        case 'backup': {
          const path = await dialogs.save('backup');
          guard(caller);
          if (path === null) return null;
          try { return await service.backup(path); }
          catch (error) {
            if (error instanceof Error && error.message === 'Backup destination already exists.') {
              throw new Error('Backup destination already exists. Choose a new name.');
            }
            throw error;
          }
        }
        case 'restore': {
          const path = await dialogs.open('backup');
          guard(caller);
          if (path === null) return null;
          if ((await service.state()).exists && !await dialogs.confirmRestore()) return null;
          guard(caller);
          return service.restore(a, path);
        }
      }
    });
    queue = result.catch(() => undefined);
    return result;
  };
}

/** Core has no public domain-error class. Enumerate its safe messages instead
 * of forwarding arbitrary Error text (which may contain paths or arguments).
 * This is error classification only; validation and crypto remain in core.
 */
const domainErrors = new Set([
  'Unsafe file path.', 'File exceeds size limit.', 'File changed while reading.',
  'Vault changed on disk. Lock and unlock again.', 'Export preview is stale.',
  'Invalid name.', 'Invalid identifier.', 'Invalid environment content.',
  'Environment exceeds 1 MiB.', 'Invalid UTF-8.',
  'Password must contain 1–1024 UTF-8 bytes.', 'Invalid vault data.',
  'Vault exceeds 8 MiB.', 'Invalid envelope.', 'Vault is locked.',
  'Project not found.', 'Environment not found.', 'Vault already exists.',
  'Missing vault.', 'Unable to unlock vault.', 'Project limit reached (100).',
  'Environment limit reached (100 per project, 1000 total).', 'File not found.',
  'Too many export previews (16).', 'Invalid export preview.',
  'Backup destination already exists. Choose a new name.', 'Unable to restore vault.',
  'Unauthorized IPC caller.', 'Unknown IPC channel.', 'Invalid IPC arguments.',
  'Application window unavailable.',
]);
export function publicError(error: unknown): string {
  return error instanceof Error && !('code' in error) && domainErrors.has(error.message)
    ? error.message : 'Unable to access local file.';
}
