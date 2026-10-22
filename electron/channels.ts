import type { VaultBridge } from '../shared/api.js';

/** Closed allowlist shared by main and the bundled sandbox preload. */
export const channels = Object.freeze({
  state: 'vault:state', create: 'vault:create', unlock: 'vault:unlock',
  lock: 'vault:lock', addProject: 'vault:add-project',
  addEnvironment: 'vault:add-environment', saveEnvironment: 'vault:save-environment',
  importEnvironment: 'vault:import-environment', previewExport: 'vault:preview-export',
  confirmExport: 'vault:confirm-export', cancelExport: 'vault:cancel-export',
  backup: 'vault:backup', restore: 'vault:restore',
} satisfies Record<keyof VaultBridge, string>);

export type BridgeReply = { ok: true; value: unknown } | { ok: false; error: string };
