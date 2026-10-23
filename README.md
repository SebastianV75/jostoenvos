# Local vault

An offline Electron vault for projects and environment documents. Main owns the
password-based encryption, local storage and native file dialogs; the sandboxed
renderer edits exact .env text. Use only obvious fake secrets in tests and demos.

## Run

Use Node 22.12+ and npm. Install with `npm ci`.

- `npm run dev`: build local assets and launch Electron; rerun after edits.
- `npm run dev:browser`: loopback Vite server (default port 5173), without a vault
  bridge or persistence. Tests can explicitly inject a typed fake bridge.
- `npm test`: deterministic Node tests via tsx.
- `npm run typecheck`: renderer, shared API, desktop and tests.
- `npm run build`: offline renderer assets in `dist/`, including bundled fonts,
  and sandbox-compatible CommonJS desktop/preload bundles in `dist-electron/`.
- `npm start`: launch the previously built desktop application.
- `node scripts/smoke.mjs`: one bounded native production launch with isolated
  HOME/XDG directories; `--help` explains the test and deadline. Requires an
  installed Electron binary, display and functioning sandbox. Does not download
  or provision runtime dependencies. Timeout is failure, never a smoke pass.

No custom application data-directory flags are supported. The vault is fixed at
`vault/vault.json` under Electron's application-specific `userData` directory.
Only one app instance can own it. Never disable the sandbox to bypass host issues.

## Use

Create a vault with a master password, then add projects and environments. The
default **Variables** view shows separate, ordered read-only assignments from the
current draft, including duplicate names. **Reveal values** shows literal raw RHS
spelling, not evaluated dotenv values; **Hide values** removes values from the DOM.
Select **Raw** and reveal to edit. Unsupported syntax shows an incomplete-display
warning with a line number and a Raw route; import/export retain the whole document.
See [supported display syntax](docs/interface.md#display-grammar-not-runtime-dotenv-semantics).
The editor preserves raw comments, ordering, whitespace and line endings. Lock clears
decrypted state. Lock explicitly before leaving the computer: suspend does not
automatically lock this MVP.

Import uses a native open dialog. Export selects a destination and shows its
previous and proposed contents; only explicit confirmation writes. Cancellation
and stale previews do not write. Encrypted backups require a **new file name**.
Restore uses the backup password and asks explicitly before replacing an existing
vault. Canceling either native dialog changes nothing.

**Losing the password is unrecoverable.** There is no account, password reset,
OS unlock, remote backend, sharing or synchronization. Back up before restoring.

## Implementation and proof

- [Desktop boundary and native checks](docs/desktop.md)
- [Encryption, file safety and limits](docs/vault.md)
- [Renderer and design boundaries](docs/interface.md)
- Canonical 13-method renderer contract: `shared/api.ts`.

No arbitrary paths, commands, filesystem methods, keys or generic IPC cross the
bridge. Service errors remain useful; filesystem failures are redacted. Fonts
load offline. The visual language follows the inspected landing's restrained
surfaces, typography and green accent.

The architecture supports macOS, Windows and Linux, but a build is not a packaged
installer or proof of execution on those platforms. Native smoke results must be
reported separately; browser interaction checks and independent security review
remain separate evidence.
