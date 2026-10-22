import { app, BrowserWindow, dialog, ipcMain, session } from 'electron';
import { mkdir, chmod, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { VaultService } from './core/vault.js';
import { createDispatcher, publicError, type NativeDialogs } from './bridge.js';
import { channels } from './channels.js';

const appPath = join(__dirname, '../dist/index.html');
const appURL = pathToFileURL(appPath).href;
let mainWindow: BrowserWindow | undefined;

function createWindow() {
  const window = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 640,
    minHeight: 480,
    backgroundColor: '#f8f9fa',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
    },
  });
  mainWindow = window;
  window.on('closed', () => { if (mainWindow === window) mainWindow = undefined; });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('will-frame-navigate', (event) => event.preventDefault());
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  // Trusted parent-process smoke only: no renderer IPC or production flag can
  // request shutdown. The test uses an isolated HOME and an inherited IPC pipe.
  if (process.env.LOCAL_VAULT_SMOKE === '1' && process.send) {
    window.webContents.once('did-finish-load', () => {
      void window.webContents.executeJavaScript(`(async () => {
        const bridge = window.vault;
        if (!bridge || !Object.isFrozen(bridge) || Object.keys(bridge).length !== 13) throw new Error('Bridge unavailable');
        const state = await bridge.state();
        if (state.exists || !state.locked || state.vault !== null) throw new Error('Expected isolated empty vault');
        if (typeof window.require !== 'undefined' || typeof window.process !== 'undefined') throw new Error('Node leaked');
        return true;
      })()`).then(() => {
        process.send?.({ type: 'vault-smoke', ok: true });
        app.quit();
      }).catch(() => {
        process.send?.({ type: 'vault-smoke', ok: false });
        app.exit(1);
      });
    });
  }
  void window.loadFile(appPath).catch(() => {
    dialog.showErrorBox('Local vault', 'Unable to load the local application.');
    app.quit();
  });
}

function owner(): BrowserWindow {
  if (!mainWindow || mainWindow.isDestroyed()) throw new Error('Application window unavailable.');
  return mainWindow;
}
const dialogs: NativeDialogs = {
  async open(kind) {
    const result = await dialog.showOpenDialog(owner(), {
      title: kind === 'environment' ? 'Import .env file' : 'Restore encrypted backup',
      properties: ['openFile', 'showHiddenFiles'],
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  },
  async save(kind) {
    const result = await dialog.showSaveDialog(owner(), {
      title: kind === 'environment' ? 'Preview .env export' : 'Encrypted backup — choose a new name (existing files are rejected)',
      defaultPath: kind === 'environment' ? '.env' : 'backup.vault',
      properties: ['showHiddenFiles', 'showOverwriteConfirmation'],
    });
    return result.canceled ? null : result.filePath ?? null;
  },
  async confirmRestore() {
    const result = await dialog.showMessageBox(owner(), {
      type: 'warning', title: 'Replace existing vault?',
      message: 'Restoring replaces the entire existing vault.',
      detail: 'Unsaved changes will be lost. This cannot be undone. Keep an encrypted backup first.',
      buttons: ['Cancel', 'Replace vault'], defaultId: 0, cancelId: 0, noLink: true,
    });
    return result.response === 1;
  },
};

// No renderer-selected or CLI-selected vault path. A second process must never
// open the service, including while the first instance has no macOS window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { mainWindow?.show(); mainWindow?.focus(); });
  void app.whenReady().then(async () => {
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !details.url.startsWith('file:') });
    });
    const directory = join(app.getPath('userData'), 'vault');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe vault directory.');
    await chmod(directory, 0o700);
    const dispatch = createDispatcher(new VaultService(join(directory, 'vault.json')), dialogs,
      () => mainWindow?.webContents, appURL);
    for (const channel of Object.values(channels)) {
      ipcMain.handle(channel, async (event, ...args: unknown[]) => {
        try { return { ok: true, value: await dispatch(event, channel, args) }; }
        catch (error) { return { ok: false, error: publicError(error) }; }
      });
    }
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  }).catch(() => {
    dialog.showErrorBox('Local vault', 'Unable to initialize the local vault directory.');
    app.quit();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
