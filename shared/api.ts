/** Canonical renderer boundary. No filesystem paths or generic IPC are accepted. */
export interface VaultEnvironment {
  id: string;
  name: string;
  /** Exact .env text: preserve comments, ordering, whitespace and line endings. */
  content: string;
}

export interface VaultProject {
  id: string;
  name: string;
  environments: VaultEnvironment[];
}

export interface VaultSnapshot {
  projects: VaultProject[];
}

export interface VaultState {
  exists: boolean;
  locked: boolean;
  /** Null when locked or absent. Never return keys or passwords. */
  vault: VaultSnapshot | null;
}

export interface ExportPreview {
  /** Opaque, main-owned, single-use capability; not a filesystem path. */
  id: string;
  /** Display only. Must never be passed back as a path. */
  destinationLabel: string;
  /** Null means no existing file; empty string means an existing empty file. */
  previousContent: string | null;
  proposedContent: string;
}

/**
 * All methods reject with Error carrying the exact service error message.
 * No swallowing failures or logging arguments, passwords, or document contents.
 * Successful mutations return the complete resulting state (no renderer merge).
 * Dialog cancellation returns null and changes nothing. Main owns all dialogs,
 * validation, identifiers, encryption (Node crypto), and serialized disk IO.
 */
export interface VaultBridge {
  state(): Promise<VaultState>;
  create(password: string): Promise<VaultState>;
  unlock(password: string): Promise<VaultState>;
  /** Drops decrypted state and invalidates all export previews. */
  lock(): Promise<VaultState>;
  addProject(name: string): Promise<VaultState>;
  addEnvironment(projectId: string, name: string): Promise<VaultState>;
  saveEnvironment(projectId: string, environmentId: string, content: string): Promise<VaultState>;
  importEnvironment(projectId: string, environmentId: string): Promise<VaultState | null>;
  /** Native destination selection only; never writes until explicit confirmation. */
  previewExport(projectId: string, environmentId: string): Promise<ExportPreview | null>;
  /** Reject stale previews without writing; consume the capability on success. */
  confirmExport(previewId: string): Promise<VaultState>;
  /** Discard the preview without touching any file. */
  cancelExport(previewId: string): Promise<void>;
  /** Native save dialog; writes an encrypted, portable snapshot. */
  backup(): Promise<VaultState | null>;
  /** Native open dialog; validate/decrypt fully before replacing the active vault. */
  restore(password: string): Promise<VaultState | null>;
}

declare global {
  interface Window {
    /** Absent in browser development and until the desktop bridge is wired. */
    vault?: VaultBridge;
  }
}
