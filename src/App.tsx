import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import { VaultController } from './vault-controller.js';

function Modal({ title, onCancel, pending, children }: {
  title: string; onCancel: () => void; pending: boolean; children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    ref.current?.showModal();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  return <dialog ref={ref} aria-labelledby="dialog-title" onCancel={event => {
    event.preventDefault(); if (!pending) onCancel();
  }}>
    <h2 id="dialog-title">{title}</h2>
    {children}
  </dialog>;
}

function NameForm({ kind, pending, onAdd }: {
  kind: 'project' | 'environment'; pending: boolean; onAdd: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState('');
  return <form className="name-form" onSubmit={async event => {
    event.preventDefault(); await onAdd(name); setName('');
  }}>
    <label htmlFor={`${kind}-name`}>New {kind} name</label>
    <div className="input-action">
      <input id={`${kind}-name`} value={name} onChange={e => setName(e.target.value)} required disabled={pending} />
      <button disabled={pending || !name.trim()} type="submit">Add {kind}</button>
    </div>
  </form>;
}

function Access({ controller }: { controller: VaultController }) {
  const view = controller.getSnapshot();
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [backupPassword, setBackupPassword] = useState('');
  const exists = view.state?.exists;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const entered = password; const confirmed = confirmation;
    setPassword(''); setConfirmation('');
    await controller.authenticate(entered, confirmed);
  };
  return <section className="access card" aria-labelledby="access-title">
    <p className="eyebrow">{exists ? 'Encrypted · Locked' : 'Private by default'}</p>
    <h1 id="access-title">{exists ? 'Welcome back.' : 'Your environments. Only yours.'}</h1>
    <p>{exists ? 'Unlock your local vault to work with your projects.' : 'Create a local encrypted vault for your projects and environment documents.'}</p>
    <form onSubmit={submit}>
      <fieldset disabled={view.pending}>
        <label htmlFor="master-password">Master password</label>
        <input id="master-password" type="password" autoComplete={exists ? 'current-password' : 'new-password'}
          autoFocus value={password} required onChange={e => setPassword(e.target.value)} />
        {!exists && <><label htmlFor="confirm-password">Confirm password</label>
          <input id="confirm-password" type="password" autoComplete="new-password" value={confirmation}
            required onChange={e => setConfirmation(e.target.value)} /></>}
        <button className="primary" type="submit">{view.pending ? 'Working…' : exists ? 'Unlock vault' : 'Create vault'}</button>
      </fieldset>
    </form>
    <p className="security-note">There is no password reset. Losing your master password means losing access.
      Keep your password safe and save an encrypted backup on another device. Backups restore with the same password, without the original computer.</p>
    <button disabled={view.pending} onClick={() => setRestoreOpen(true)}>Restore encrypted backup</button>
    {restoreOpen && <Modal title="Restore encrypted backup" pending={view.pending} onCancel={() => {
      setBackupPassword(''); setRestoreOpen(false);
    }}>
      <p>This replaces the local vault after the backup is validated. You need the backup’s master password. Canceling the file picker leaves your vault unchanged.</p>
      <form onSubmit={async event => {
        event.preventDefault(); const entered = backupPassword; setBackupPassword('');
        await controller.restore(entered);
        if (!controller.getSnapshot().error) setRestoreOpen(false);
      }}>
        <fieldset disabled={view.pending}>
          <label htmlFor="backup-password">Backup master password</label>
          <input id="backup-password" type="password" autoComplete="current-password" autoFocus
            required value={backupPassword} onChange={e => setBackupPassword(e.target.value)} />
          {view.error && <p role="alert" className="error">{view.error}</p>}
          <div className="actions"><button type="button" onClick={() => { setBackupPassword(''); setRestoreOpen(false); }}>Cancel</button>
            <button className="primary" type="submit">Choose backup and restore</button></div>
        </fieldset>
      </form>
    </Modal>}
  </section>;
}

function Workspace({ controller }: { controller: VaultController }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  const view = controller.getSnapshot();
  const project = controller.project;
  const environment = controller.environment;
  return <div className="vault-layout">
    <aside className="sidebar card" aria-label="Projects">
      <div className="section-heading"><h2>Projects</h2><span className="count">{view.state?.vault?.projects.length ?? 0}</span></div>
      <nav aria-label="Project selection">
        {view.state?.vault?.projects.map(p => <button key={p.id} aria-current={p.id === view.projectId ? 'page' : undefined}
          disabled={view.pending} onClick={() => controller.select(p.id)}>{p.name}<span className="count">{p.environments.length}</span></button>)}
      </nav>
      <NameForm kind="project" pending={view.pending} onAdd={name => controller.addProject(name)} />
      <p className="sidebar-note">On this computer.<br />No account. No sync.</p>
    </aside>
    <section className="workspace card" aria-labelledby="workspace-title">
      <div className="workspace-heading"><div><p className="eyebrow">Local workspace</p>
        <h1 id="workspace-title" ref={heading} tabIndex={-1}>{project?.name ?? 'Start with a project.'}</h1></div>
        <span className="badge"><span aria-hidden="true">●</span> Unlocked</span></div>
      {!project ? <p>Add your first project in the sidebar to organize your environments.</p> : <>
        <div className="environment-list" role="group" aria-label="Environment selection">
          {project.environments.map(e => <button key={e.id} aria-pressed={e.id === view.environmentId}
            disabled={view.pending} onClick={() => controller.select(project.id, e.id)}>{e.name}</button>)}
        </div>
        <NameForm key={project.id} kind="environment" pending={view.pending} onAdd={name => controller.addEnvironment(name)} />
        {!environment ? <div className="empty-state"><h2>No environments yet.</h2><p>Add an environment above, then edit or import a .env document.</p></div> : <>
          <div className="editor-heading"><div><h2>{environment.name}</h2>
            <p className="technical">.env · {controller.dirty ? 'Unsaved changes' : 'Saved document'}</p></div>
            <button disabled={view.pending} aria-pressed={view.revealed} onClick={() => controller.toggleReveal()}>
              {view.revealed ? 'Hide values' : 'Reveal values'}</button></div>
          {view.revealed ? <><label className="editor-label" htmlFor="env-document">Raw .env document</label>
            <textarea id="env-document" spellCheck={false} autoCapitalize="off" autoComplete="off" autoCorrect="off"
              disabled={view.pending} value={view.draft} onChange={e => controller.editFromTextarea(e.target.value)}
              aria-describedby="raw-advice" /></> : <div className="hidden-document"><span aria-hidden="true">••••••••••••</span><p>Document hidden. Reveal to view or edit.</p></div>}
          <p id="raw-advice" className="technical">Raw text, not parsed. Comments, order and existing line endings are preserved.</p>
          <div className="editor-actions actions">
            <button className="primary" disabled={view.pending || !controller.dirty} onClick={() => controller.save()}>Save changes</button>
            <button disabled={view.pending || !controller.dirty} onClick={() => controller.discard()}>Discard changes</button>
            <span className="action-spacer" />
            <button disabled={view.pending} onClick={() => controller.importDocument()}>Import .env</button>
            <button disabled={view.pending} onClick={() => controller.previewExport()}>Export .env…</button>
          </div>
          <p className="technical">Import replaces this saved document. Save or discard edits before importing, exporting, switching or locking.</p>
        </>}
      </>}
    </section>
  </div>;
}

export default function App({ controller: supplied }: { controller?: VaultController }) {
  const [controller] = useState(() => supplied ?? new VaultController(typeof window === 'undefined' ? undefined : window.vault));
  const view = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => { if (!controller.getSnapshot().state) void controller.initialize(); }, [controller]);
  const unlocked = view.state && !view.state.locked && view.state.vault;
  return <main className="app-shell">
    <header className="app-header"><a className="brand" href="#main-content"><span className="brand-mark" aria-hidden="true" />Local Vault</a>
      {unlocked && <div className="actions">
        <button disabled={view.pending || !!view.preview} onClick={() => controller.backup()}>Encrypted backup</button>
        <button disabled={view.pending || !!view.preview} onClick={() => controller.lock()}>Lock vault</button>
      </div>}
    </header>
    <div className="feedback" aria-live="polite" role="status">{view.pending ? 'Working…' : view.status}</div>
    {view.error && !view.preview && <p className="error global-error" role="alert">{view.error}</p>}
    <div id="main-content">
      {!controller.bridge ? <section className="access card"><p className="eyebrow">Local · Encrypted · Desktop</p>
        <h1>Desktop app required</h1><p>Open Local Vault in the desktop app to create or unlock an encrypted vault.</p>
        <p className="security-note">No vault data is saved in this browser. No account. No remote service.</p></section>
        : !view.state ? <section className="access card"><h1>Connecting to your vault…</h1>
          {!view.pending && <button onClick={() => controller.initialize()}>Retry connection</button>}</section>
          : unlocked ? <Workspace controller={controller} /> : <Access controller={controller} />}
    </div>
    <footer>Local Vault <span aria-hidden="true">/</span> Encrypted at rest. Plaintext only when you choose to export.</footer>
    {view.preview && <Modal title="Plaintext export" pending={view.pending} onCancel={() => { void controller.cancelExport(); }}>
      <p className="warning">This exports unencrypted secrets. Anyone with access to the destination can read them.</p>
      <p className="destination">Destination: <strong>{view.preview.destinationLabel}</strong></p>
      <p>Review both documents before writing. Cancel leaves the destination unchanged. A changed destination requires a new preview.</p>
      <div className="comparison">
        <section><h3>Previous content</h3><p className="technical">{view.preview.previousContent === null ? 'New file — no existing content' : view.preview.previousContent === '' ? 'Existing file is empty' : 'Existing file'}</p>
          <pre tabIndex={0} aria-label="Previous content">{view.preview.previousContent ?? ''}</pre></section>
        <section><h3>Proposed content</h3><p className="technical">Saved environment document</p>
          <pre tabIndex={0} aria-label="Proposed content">{view.preview.proposedContent}</pre></section>
      </div>
      {view.error && <p className="error" role="alert">{view.error}</p>}
      <div className="actions dialog-actions"><button autoFocus disabled={view.pending} onClick={() => controller.cancelExport()}>Cancel export</button>
        <button className="primary" disabled={view.pending} onClick={() => controller.confirmExport()}>Confirm export</button></div>
    </Modal>}
  </main>;
}
