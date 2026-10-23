import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import App, { DocumentView } from '../src/App.js';
import { VaultController } from '../src/vault-controller.js';
import type { VaultBridge, VaultState } from '../shared/api.js';

const absent: VaultState = { exists: false, locked: true, vault: null };
const locked: VaultState = { exists: true, locked: true, vault: null };
const raw = '# Fake fixture\r\nFAKE_TOKEN=example-only\r\n\r\n';
const unlocked = (): VaultState => ({ exists: true, locked: false, vault: { projects: [
  { id: 'p', name: 'Example project', environments: [
    { id: 'e', name: 'Development', content: raw },
    { id: 'other', name: 'Staging', content: '' },
  ] },
] } });
function fixture(initial = unlocked()) {
  const calls: unknown[][] = [];
  let stored = initial;
  const bridge: VaultBridge = {
    state: async () => stored,
    create: async password => { calls.push(['create', password]); return stored = unlocked(); },
    unlock: async password => { calls.push(['unlock', password]); return stored = unlocked(); },
    lock: async () => { calls.push(['lock']); return stored = locked; },
    addProject: async name => { calls.push(['project', name]); return stored = absent; },
    addEnvironment: async (p, name) => { calls.push(['environment', p, name]); return stored; },
    saveEnvironment: async (p, e, content) => {
      calls.push(['save', p, e, content]);
      stored = unlocked(); stored.vault!.projects[0].environments[0].content = content;
      return stored;
    },
    importEnvironment: async (...args) => { calls.push(['import', ...args]); return null; },
    previewExport: async (...args) => { calls.push(['preview', ...args]); return {
      id: 'capability', destinationLabel: 'example.env', previousContent: '', proposedContent: raw,
    }; },
    confirmExport: async id => { calls.push(['confirm', id]); return stored; },
    cancelExport: async id => { calls.push(['cancel', id]); },
    backup: async () => { calls.push(['backup']); return null; },
    restore: async password => { calls.push(['restore', password]); return null; },
  };
  return { bridge, calls, stored: () => stored };
}
const html = (controller?: VaultController) => renderToStaticMarkup(createElement(App, { controller }));

test('browser without bridge has an honest desktop-required state and no fake actions', () => {
  assert.match(html(), /Desktop app required/);
  assert.match(html(), /No vault data is saved in this browser/);
  assert.doesNotMatch(html(), /<input|<textarea|<button/);
});

test('absent and locked vaults render password forms and explicit recovery advice', async () => {
  for (const state of [absent, locked]) {
    const controller = new VaultController(fixture(state).bridge);
    await controller.initialize();
    const output = html(controller);
    assert.match(output, /type="password"/);
    assert.match(output, /Restore encrypted backup/);
    assert.match(output, /no password reset/);
    assert.match(output, state.exists ? /Unlock vault/ : /Confirm password/);
  }
});

test('password mismatch rejects create without mutation; successful create and unlock replace state', async () => {
  const f = fixture(absent); const c = new VaultController(f.bridge); await c.initialize();
  await c.authenticate('fake-password', 'different');
  assert.deepEqual(f.calls, []); assert.deepEqual(f.stored(), absent);
  assert.equal(c.getSnapshot().error, 'Passwords do not match.');
  await c.authenticate('fake-password', 'fake-password');
  assert.deepEqual(c.getSnapshot().state, f.stored());
  await c.lock(); await c.authenticate('fake-password');
  assert.deepEqual(f.calls.map(call => call[0]), ['create', 'lock', 'unlock']);
});

test('raw editor stays hidden initially; save preserves exact raw text and authoritative state', async () => {
  const f = fixture(); const c = new VaultController(f.bridge); await c.initialize();
  assert.match(html(c), /FAKE_TOKEN/);
  assert.doesNotMatch(html(c), /example-only|<textarea/);
  c.toggleReveal();
  const rawView = renderToStaticMarkup(createElement(DocumentView, { controller: c, mode: 'raw' }));
  assert.match(rawView, /Raw .env document/);
  assert.match(rawView, /<textarea/);
  const edited = raw + 'FAKE_EMPTY=\r\n'; c.edit(edited);
  await c.save();
  assert.deepEqual(f.calls, [['save', 'p', 'e', edited]]);
  assert.equal(c.getSnapshot().draft, edited); assert.equal(c.dirty, false);
  await c.addProject('Replacement');
  assert.equal(c.getSnapshot().state, f.stored());
  assert.equal(c.getSnapshot().draft, '');
  assert.deepEqual(c.getSnapshot().state, absent);
});

test('import projects three distinct rows, current draft and duplicates without exposing hidden secrets', async () => {
  const f = fixture(); const c = new VaultController(f.bridge); await c.initialize();
  const imported = unlocked();
  const content = '\uFEFF# fake\r\nFAKE_A=example-first\r\nFAKE_EMPTY=\r\nFAKE_A="example-last\r\nFAKE_INSIDE=not-a-row"\r\n';
  imported.vault!.projects[0].environments[0].content = content;
  f.bridge.importEnvironment = async () => imported;
  f.bridge.previewExport = async () => ({ id: 'import-preview', destinationLabel: 'fake.env', previousContent: null, proposedContent: content });
  await c.importDocument();
  assert.equal(c.getSnapshot().draft, content);
  assert.equal((html(c).match(/class="variable-row"/g) ?? []).length, 3);
  assert.doesNotMatch(html(c), /example-first|example-last|FAKE_INSIDE|not-a-row|<textarea/);
  c.toggleReveal();
  assert.match(html(c), /example-first/); assert.match(html(c), /Empty value/);
  assert.match(html(c), /FAKE_INSIDE=not-a-row/);
  c.edit(content + 'FAKE_DRAFT=example-draft\r\n');
  assert.match(html(c), /FAKE_DRAFT/); assert.match(html(c), /example-draft/);
  c.toggleReveal(); assert.doesNotMatch(html(c), /example-draft|example-first|example-last/);
  assert.equal(c.getSnapshot().draft, content + 'FAKE_DRAFT=example-draft\r\n');
  c.discard(); assert.equal(c.getSnapshot().draft, content);
  await c.previewExport(); assert.equal(c.getSnapshot().preview?.proposedContent, content);
  await c.cancelExport(); assert.equal(c.getSnapshot().draft, content);
  assert.equal(c.getSnapshot().state, imported);
  await c.lock(); assert.doesNotMatch(html(c), /FAKE_A|example-first|FAKE_INSIDE/);
});

test('incomplete display gives only a line diagnostic and Raw route, with hidden DOM free of invalid secrets', async () => {
  const f = fixture(); const c = new VaultController(f.bridge); await c.initialize();
  c.edit('FAKE_OK=example-visible\ninvalid-example-secret\nFAKE_LATER=example-later');
  const hidden = html(c);
  assert.match(hidden, /Incomplete variable display/); assert.match(hidden, /line 2/);
  assert.match(hidden, />Raw</);
  assert.doesNotMatch(hidden, /example-visible|invalid-example-secret|FAKE_LATER|example-later/);
  const hiddenRaw = renderToStaticMarkup(createElement(DocumentView, { controller: c, mode: 'raw' }));
  assert.doesNotMatch(hiddenRaw, /<textarea|invalid-example-secret/);
  c.toggleReveal();
  const revealedRaw = renderToStaticMarkup(createElement(DocumentView, { controller: c, mode: 'raw' }));
  assert.match(revealedRaw, /<textarea/); assert.match(revealedRaw, /invalid-example-secret/);
  assert.equal(c.getSnapshot().draft, 'FAKE_OK=example-visible\ninvalid-example-secret\nFAKE_LATER=example-later');
});

test('textarea edits preserve untouched CRLF and mixed endings instead of normalizing the document', async () => {
  const f = fixture(); const c = new VaultController(f.bridge); await c.initialize();
  c.edit('FAKE_A=one\r\nFAKE_B=two\n# end\r\n');
  c.editFromTextarea('FAKE_A=changed\nFAKE_B=two\n# end\n');
  assert.equal(c.getSnapshot().draft, 'FAKE_A=changed\r\nFAKE_B=two\n# end\r\n');
  await c.save();
  assert.deepEqual(f.calls.at(-1), ['save', 'p', 'e', 'FAKE_A=changed\r\nFAKE_B=two\n# end\r\n']);
});

test('dirty edits protect navigation, import, export, backup, lock and adding records until explicit discard', async () => {
  const f = fixture(); const c = new VaultController(f.bridge); await c.initialize();
  c.edit('FAKE_UNSAVED=example');
  c.select('p', 'other'); await c.importDocument(); await c.previewExport();
  await c.backup(); await c.lock(); await c.addProject('New'); await c.addEnvironment('New');
  assert.deepEqual(f.calls, []); assert.deepEqual(f.stored(), unlocked());
  assert.equal(c.getSnapshot().state, f.stored()); assert.equal(c.getSnapshot().environmentId, 'e');
  assert.equal(c.getSnapshot().draft, 'FAKE_UNSAVED=example');
  assert.match(c.getSnapshot().error, /Save or discard/);
  c.discard(); c.select('p', 'other'); assert.equal(c.getSnapshot().draft, '');
  assert.equal(c.getSnapshot().environmentId, 'other');
});

test('export preview compares empty existing file with proposed text; cancel never confirms', async () => {
  const f = fixture(); const c = new VaultController(f.bridge); await c.initialize();
  await c.previewExport();
  assert.deepEqual(f.calls, [['preview', 'p', 'e']]);
  const output = html(c);
  assert.match(output, /Plaintext export/); assert.match(output, /Previous content/);
  assert.match(output, /Proposed content/); assert.match(output, /Confirm export/);
  const beforeCancel = c.getSnapshot(); const storedBeforeCancel = structuredClone(f.stored());
  await c.cancelExport();
  assert.equal(c.getSnapshot().state, beforeCancel.state); assert.equal(c.getSnapshot().draft, beforeCancel.draft);
  assert.deepEqual(f.stored(), storedBeforeCancel);
  assert.deepEqual(f.calls.at(-1), ['cancel', 'capability']);
  assert.equal(c.getSnapshot().preview, null);
  await c.previewExport(); await c.confirmExport();
  assert.deepEqual(f.calls.at(-1), ['confirm', 'capability']);
  assert.equal(c.getSnapshot().preview, null);
});

test('native cancellation is accurate and leaves data intact; bridge errors surface exactly', async () => {
  const f = fixture(); const c = new VaultController(f.bridge); await c.initialize();
  const before = f.stored();
  await c.importDocument(); assert.equal(c.getSnapshot().status, 'Import canceled.');
  await c.backup(); assert.equal(c.getSnapshot().status, 'Backup canceled.');
  assert.equal(f.stored(), before); assert.equal(c.getSnapshot().draft, raw);
  f.bridge.previewExport = async () => null;
  await c.previewExport(); assert.equal(c.getSnapshot().status, 'Export canceled.');
  f.bridge.saveEnvironment = async () => { throw new Error('Example service failure.'); };
  c.edit('FAKE_CHANGED=example'); await c.save();
  assert.equal(c.getSnapshot().error, 'Example service failure.');
  assert.equal(c.getSnapshot().draft, 'FAKE_CHANGED=example'); assert.equal(f.stored(), before);
  assert.match(html(c), /role="alert"/);
});

test('successful environment creation, import and backup adopt only complete returned snapshots', async () => {
  const f = fixture(); const c = new VaultController(f.bridge); await c.initialize();
  const created = unlocked();
  created.vault!.projects[0].environments.push({ id: 'created', name: 'Test', content: 'FAKE_CREATED=yes\n' });
  f.bridge.addEnvironment = async (projectId, name) => {
    assert.equal(projectId, 'p'); assert.equal(name, 'Test'); return created;
  };
  await c.addEnvironment('Test');
  assert.equal(c.getSnapshot().state, created); assert.equal(c.getSnapshot().environmentId, 'created');
  const imported = unlocked(); imported.vault!.projects[0].environments[0].content = 'FAKE_IMPORTED=yes\r\n';
  f.bridge.importEnvironment = async () => imported;
  await c.importDocument(); assert.equal(c.getSnapshot().state, imported);
  assert.equal(c.getSnapshot().draft, 'FAKE_IMPORTED=yes\r\n');
  f.bridge.backup = async () => locked;
  await c.backup(); assert.equal(c.getSnapshot().state, locked);
  assert.equal(c.getSnapshot().draft, '');
});

test('stale export errors retain preview and state for safe cancellation without a success message', async () => {
  const f = fixture(); const c = new VaultController(f.bridge); await c.initialize();
  const before = f.stored();
  f.bridge.confirmExport = async id => { f.calls.push(['rejected confirm', id]); throw new Error('Export preview is stale.'); };
  await c.previewExport(); await c.confirmExport();
  assert.equal(c.getSnapshot().error, 'Export preview is stale.');
  assert.equal(c.getSnapshot().status, ''); assert.equal(c.getSnapshot().state, before);
  assert.equal(c.getSnapshot().draft, raw); assert.equal(c.getSnapshot().preview?.id, 'capability');
  assert.match(html(c), /Export preview is stale\./);
  await c.lock(); assert.equal(f.calls.some(call => call[0] === 'lock'), false);
  await c.cancelExport(); assert.equal(c.getSnapshot().preview, null);
  assert.equal(f.stored(), before);
});

test('pending operations cannot race, and successful lock clears all decrypted renderer state', async () => {
  const f = fixture(); let finish!: (state: VaultState) => void;
  f.bridge.saveEnvironment = () => new Promise(resolve => { finish = resolve; });
  const c = new VaultController(f.bridge); await c.initialize();
  c.toggleReveal(); c.edit(raw + '# changed'); const saving = c.save();
  await c.lock(); c.select('p', 'other'); c.edit('ignored');
  assert.equal(c.getSnapshot().pending, true); assert.equal(c.getSnapshot().environmentId, 'e');
  assert.equal(c.getSnapshot().draft, raw + '# changed'); assert.deepEqual(f.stored(), unlocked());
  finish(unlocked()); await saving; await c.lock();
  const view = c.getSnapshot();
  assert.equal(view.state?.vault, null); assert.equal(view.draft, '');
  assert.equal(view.projectId, ''); assert.equal(view.environmentId, '');
  assert.equal(view.revealed, false); assert.equal(view.preview, null);
  assert.doesNotMatch(html(c), /FAKE_TOKEN|Example project/);
});

test('restore cancellation and rejection retain locked state, successful restore adopts returned snapshot', async () => {
  const f = fixture(locked); const c = new VaultController(f.bridge); await c.initialize();
  await c.restore('fake-password'); assert.equal(c.getSnapshot().status, 'Restore canceled.');
  assert.equal(c.getSnapshot().state, locked);
  f.bridge.restore = async () => { throw new Error('Invalid backup.'); };
  await c.restore('fake-password'); assert.equal(c.getSnapshot().error, 'Invalid backup.');
  assert.equal(c.getSnapshot().state, locked);
  f.bridge.restore = async () => unlocked(); await c.restore('fake-password');
  assert.equal(c.getSnapshot().draft, raw);
});
