# Local vault — foundation

T1 provides an Electron + React + TypeScript + Vite foundation, not a working
vault. The screen stores nothing. Encryption, native dialogs, persistence, and
renderer/IPC integration follow in T2–T4. Never enter real secrets into test data.

## Run

Use Node 22.12+ and npm. Install with `npm ci`.

- `npm run dev:browser`: loopback-only Vite development server (default port 5173),
  with hot updates (development-only CSP allows Vite's inline styles; packaged
  HTML does not). `window.vault` is absent; subsequent browser tests may inject
  a typed fake bridge explicitly. No production browser demo is seeded.
- `npm run dev`: build local assets and launch Electron; rerun after edits.
- `npm test`: deterministic Node tests via tsx.
- `npm run typecheck`: renderer, shared API, desktop, tests, and Vite config.
- `npm run build`: offline renderer assets in `dist/` and CommonJS desktop bundles
  in `dist-electron/`. Fonts are bundled from the three Fontsource packages.
- `npm start`: launch the previously built desktop application.

Desktop launch requires the host's Electron runtime libraries and a graphical
session with a working sandbox. Do not disable the sandbox to bypass host issues.
The architecture uses Electron's macOS/Windows/Linux lifecycle; this is not a
packaging configuration or evidence of native checks on those platforms.

## Canonical bridge: `shared/api.ts`

Exports `VaultEnvironment`, `VaultProject`, `VaultSnapshot`, `VaultState`,
`ExportPreview`, and `VaultBridge`; also declares optional `Window.vault`.
T2 service and T3 renderer must import these types rather than redefine them.
T4 implements the bridge in a sandboxed preload with per-operation IPC validation.
The foundation preload intentionally exposes nothing.

- Snapshot: projects `{id, name, environments}`; environments `{id, name, content}`.
  Content is raw .env text, preserving comments, ordering, whitespace and line endings.
- State: `{exists, locked, vault}`; `vault` is null while absent or locked.
- `state`, `create(password)`, `unlock(password)`, `lock`, `addProject(name)`,
  `addEnvironment(projectId, name)`, and
  `saveEnvironment(projectId, environmentId, content)` resolve full state.
- `importEnvironment(projectId, environmentId)` opens a native file dialog and
  resolves full state, or null on cancellation without changing anything.
- `previewExport(projectId, environmentId)` opens a native destination dialog,
  returning null on cancellation or `{id, destinationLabel, previousContent,
  proposedContent}`. Null previous content means no existing file, not an empty file.
  The label is display-only; the opaque id is the only confirmation capability.
- `confirmExport(previewId)` resolves state after writing; stale previews reject
  without writing. `cancelExport(previewId)` resolves void without touching files.
  Preview ids are main-owned, single-use, and invalidated on lock.
- `backup()` opens a native save dialog and resolves state or null cancellation.
  It writes only an encrypted portable snapshot. `restore(password)` opens a
  native file dialog and resolves state or null cancellation. It validates and
  decrypts completely before replacing the active vault.

Every method returns a Promise. Failures reject with an Error whose message is the
exact service message; never swallow, replace, or log secret-bearing arguments.
Specific service validation/error strings will be established by T2, not invented
by the foundation. No arbitrary paths, commands, generic IPC, or keys cross this
API. Main owns Node built-in crypto and all vault IO; no cryptography is implemented
yet. Password loss will be unrecoverable; OS unlock and remote services are deferred.

## Design and verification boundaries

The foundation adapts the inspected landing: Newsreader headings, Geist body,
Geist Mono technical copy, light #f8f9fa ground, white surfaces, restrained 56px
grid, and #38e08a accent. All fonts load offline. There is no decorative motion.
Tests pin the shared contract, explicit sandbox/isolation settings, restricted
navigation, CSP, and honest placeholder output. Structural security tests are not
a replacement for T4 native integration or the independent security verification.
No macOS/Windows packaging or native execution is claimed by T1.
