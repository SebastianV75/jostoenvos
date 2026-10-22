import { contextBridge, ipcRenderer } from 'electron';
import type { VaultBridge } from '../shared/api.js';
import { channels, type BridgeReply } from './channels.js';

// Rest parameters preserve actual runtime arity for main's exact validation.
// Only these closures cross the context boundary, never the transport itself.
async function call<K extends keyof VaultBridge>(method: K, args: unknown[]): Promise<Awaited<ReturnType<VaultBridge[K]>>> {
  const reply: BridgeReply = await ipcRenderer.invoke(channels[method], ...args);
  if (!reply.ok) throw new Error(reply.error);
  return reply.value as Awaited<ReturnType<VaultBridge[K]>>;
}
const bridge: VaultBridge = Object.freeze({
  state: (...args: unknown[]) => call('state', args),
  create: (...args: unknown[]) => call('create', args),
  unlock: (...args: unknown[]) => call('unlock', args),
  lock: (...args: unknown[]) => call('lock', args),
  addProject: (...args: unknown[]) => call('addProject', args),
  addEnvironment: (...args: unknown[]) => call('addEnvironment', args),
  saveEnvironment: (...args: unknown[]) => call('saveEnvironment', args),
  importEnvironment: (...args: unknown[]) => call('importEnvironment', args),
  previewExport: (...args: unknown[]) => call('previewExport', args),
  confirmExport: (...args: unknown[]) => call('confirmExport', args),
  cancelExport: (...args: unknown[]) => call('cancelExport', args),
  backup: (...args: unknown[]) => call('backup', args),
  restore: (...args: unknown[]) => call('restore', args),
});
contextBridge.exposeInMainWorld('vault', bridge);
