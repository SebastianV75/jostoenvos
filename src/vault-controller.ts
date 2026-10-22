import type { ExportPreview, VaultBridge, VaultState } from '../shared/api.js';

export interface VaultView {
  state: VaultState | null;
  pending: boolean;
  draft: string;
  projectId: string;
  environmentId: string;
  revealed: boolean;
  preview: ExportPreview | null;
  status: string;
  error: string;
}

/** In-memory renderer coordinator. All persisted mutations belong to main. */
export class VaultController {
  private view: VaultView = {
    state: null, pending: false, draft: '', projectId: '', environmentId: '',
    revealed: false, preview: null, status: '', error: '',
  };
  private listeners = new Set<() => void>();
  constructor(readonly bridge?: VaultBridge) {}
  getSnapshot = () => this.view;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private update(patch: Partial<VaultView>) {
    this.view = { ...this.view, ...patch };
    this.listeners.forEach(listener => listener());
  }
  get project() { return this.view.state?.vault?.projects.find(p => p.id === this.view.projectId); }
  get environment() { return this.project?.environments.find(e => e.id === this.view.environmentId); }
  get dirty() { return this.view.draft !== (this.environment?.content ?? ''); }

  private replace(state: VaultState, projectId = this.view.projectId, environmentId = this.view.environmentId) {
    const projects = state.locked ? [] : state.vault?.projects ?? [];
    const project = projects.find(p => p.id === projectId) ?? projects[0];
    const environment = project?.environments.find(e => e.id === environmentId) ?? project?.environments[0];
    this.update({ state, projectId: project?.id ?? '', environmentId: environment?.id ?? '',
      draft: environment?.content ?? '', revealed: false, preview: null });
  }
  private ready(requireClean = true) {
    if (!this.bridge || this.view.pending || this.view.preview) return false;
    if (requireClean && this.dirty) {
      this.update({ error: 'Save or discard your unsaved changes before continuing.', status: '' });
      return false;
    }
    return true;
  }
  private async run(action: () => Promise<void>) {
    this.update({ pending: true, error: '', status: '' });
    try { await action(); }
    catch (error) { this.update({ error: error instanceof Error ? error.message : 'The operation failed.' }); }
    finally { this.update({ pending: false }); }
  }
  async initialize() {
    if (!this.ready()) return;
    await this.run(async () => this.replace(await this.bridge!.state()));
  }
  async authenticate(password: string, confirmation?: string) {
    if (!this.ready()) return;
    if (!password) { this.update({ error: 'Enter your master password.' }); return; }
    if (!this.view.state?.exists && password !== confirmation) {
      this.update({ error: 'Passwords do not match.' }); return;
    }
    await this.run(async () => {
      const state = this.view.state?.exists
        ? await this.bridge!.unlock(password) : await this.bridge!.create(password);
      this.replace(state);
      this.update({ status: 'Vault unlocked.' });
    });
  }
  select(projectId: string, environmentId = '') {
    if (!this.ready()) return;
    const state = this.view.state;
    if (state) this.replace(state, projectId, environmentId);
    this.update({ error: '', status: '' });
  }
  edit(content: string) {
    if (!this.view.pending && !this.view.preview && this.environment) this.update({ draft: content });
  }
  /** HTML textareas normalize CRLF/CR to LF. Splice only the actual edit into
   * the raw document so untouched line endings survive, including mixed files. */
  editFromTextarea(value: string) {
    const raw = this.view.draft;
    const normalized = raw.replace(/\r\n?/g, '\n');
    if (value === normalized) return;
    let start = 0;
    while (start < normalized.length && start < value.length && normalized[start] === value[start]) start++;
    let oldEnd = normalized.length;
    let newEnd = value.length;
    while (oldEnd > start && newEnd > start && normalized[oldEnd - 1] === value[newEnd - 1]) {
      oldEnd--; newEnd--;
    }
    const rawOffset = (offset: number) => {
      let index = 0;
      for (let count = 0; count < offset; count++) {
        index += raw[index] === '\r' && raw[index + 1] === '\n' ? 2 : 1;
      }
      return index;
    };
    const ending = raw.match(/\r\n|\r|\n/)?.[0] ?? '\n';
    const inserted = value.slice(start, newEnd).replace(/\n/g, ending);
    this.edit(raw.slice(0, rawOffset(start)) + inserted + raw.slice(rawOffset(oldEnd)));
  }
  toggleReveal() {
    if (!this.view.pending && !this.view.preview) this.update({ revealed: !this.view.revealed });
  }
  discard() {
    if (!this.view.pending && !this.view.preview) {
      this.update({ draft: this.environment?.content ?? '', error: '', status: 'Unsaved changes discarded.' });
    }
  }
  async save() {
    if (!this.ready(false) || !this.environment) return;
    await this.run(async () => {
      const { projectId, environmentId, draft } = this.view;
      this.replace(await this.bridge!.saveEnvironment(projectId, environmentId, draft));
      this.update({ status: 'Environment saved.' });
    });
  }
  async addProject(name: string) {
    if (!this.ready()) return;
    await this.run(async () => {
      const state = await this.bridge!.addProject(name);
      this.replace(state, state.vault?.projects.at(-1)?.id, '');
      this.update({ status: 'Project added.' });
    });
  }
  async addEnvironment(name: string) {
    if (!this.ready() || !this.project) return;
    await this.run(async () => {
      const projectId = this.view.projectId;
      const state = await this.bridge!.addEnvironment(projectId, name);
      const project = state.vault?.projects.find(p => p.id === projectId);
      this.replace(state, projectId, project?.environments.at(-1)?.id);
      this.update({ status: 'Environment added.' });
    });
  }
  async importDocument() {
    if (!this.ready() || !this.environment) return;
    await this.run(async () => {
      const state = await this.bridge!.importEnvironment(this.view.projectId, this.view.environmentId);
      if (state) this.replace(state);
      this.update({ status: state ? 'Environment imported.' : 'Import canceled.' });
    });
  }
  async previewExport() {
    if (!this.ready() || !this.environment) return;
    await this.run(async () => {
      const preview = await this.bridge!.previewExport(this.view.projectId, this.view.environmentId);
      this.update({ preview, status: preview ? '' : 'Export canceled.' });
    });
  }
  async confirmExport() {
    if (!this.bridge || this.view.pending || !this.view.preview) return;
    const id = this.view.preview.id;
    await this.run(async () => {
      this.replace(await this.bridge!.confirmExport(id));
      this.update({ status: 'Plaintext file exported.' });
    });
  }
  async cancelExport() {
    if (!this.bridge || this.view.pending || !this.view.preview) return;
    const id = this.view.preview.id;
    await this.run(async () => {
      await this.bridge!.cancelExport(id);
      this.update({ preview: null, status: 'Export canceled.' });
    });
  }
  async backup() {
    if (!this.ready()) return;
    await this.run(async () => {
      const state = await this.bridge!.backup();
      if (state) this.replace(state);
      this.update({ status: state ? 'Encrypted backup saved.' : 'Backup canceled.' });
    });
  }
  async lock() {
    if (!this.ready()) return;
    await this.run(async () => {
      this.replace(await this.bridge!.lock());
      this.update({ status: 'Vault locked. Decrypted editor state cleared.' });
    });
  }
  async restore(password: string) {
    if (!this.ready()) return;
    if (!password) { this.update({ error: 'Enter the backup master password.' }); return; }
    await this.run(async () => {
      const state = await this.bridge!.restore(password);
      if (state) this.replace(state);
      this.update({ status: state ? 'Encrypted backup restored.' : 'Restore canceled.' });
    });
  }
}
