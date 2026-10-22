# Desktop vault boundary

The production renderer is local and offline. Its only privileged interface is
`window.vault`: thirteen frozen methods matching `shared/api.ts`. Main owns the
VaultService, a fixed encrypted vault file and all native file selection.

## Security decisions

| Boundary | Enforcement |
| --- | --- |
| Renderer | Sandbox and context isolation on; Node integration off; web security on; webviews, navigation and new windows denied |
| Network and permissions | Non-file requests and permission requests/checks denied |
| IPC | Enumerated channels, exact arity, bounded string types and identifier validation before service dispatch |
| Caller | Current window's webContents, its exact mainFrame and exact production file URL; checked again after queued waits/dialogs |
| Preload | Bundled CommonJS for sandbox; only frozen named closures exposed, never Electron, require, process, generic invoke or paths |
| Storage | `app.getPath('userData')/vault/vault.json`; directory mode 0700 where supported; encrypted files mode 0600; app single-instance lock |
| Concurrency | One adapter queue covers dialogs and every service call, in addition to core serialization; rejected requests cannot poison it |
| Errors | Domain messages returned in a structured envelope so Electron does not prefix them; OS errors redacted and no argument/path/secret logging |

Main does not accept a CLI data path. Import/export/backup/restore paths come only
from native dialogs. Backup save text says to choose a new name, and an existing
destination rejects with `Backup destination already exists. Choose a new name.`
A save dialog overwrite acknowledgment does **not** authorize backup overwrite.

Restore of an existing vault always asks a separate native destructive-confirmation
question with Cancel as default, including when locked. Declining returns null
without calling core restore. A missing vault needs no overwrite confirmation.
Core still decrypts and validates the backup before replacing anything.

Export previews are core-owned, single-use capabilities, never renderer paths.
Choosing a destination does not write. Cancellation discards only the preview;
confirmation is the only write. Core rejects stale file images and revisions.

Calls queue while a native dialog is open: an explicit lock requested during it
runs after the pending operation, not before a late import or restore. There is
no suspend auto-lock because the bridge has no renderer state-change event.
No secret-bearing renderer persistence is added.

## Deterministic checks

`npm exec tsx -- --test tests/desktop.test.ts` exercises the public injected
adapter using real VaultService instances, temporary fake files and stub dialogs.
It checks all channels, validation, caller/frame rejection, dialog cancellation,
wrong passwords, stale/canceled/confirmed export, new-only backup, destructive
restore refusal and portability, queue recovery and a lock during a pending dialog.
A bundled-preload VM check verifies the frozen method set and exact error transport.
Existing core and renderer suites remain unchanged.

## Native quick check

1. Inspect Electron's actual binary with `ldd` on Linux before launching.
2. Run `node scripts/smoke.mjs` once when dependencies and display are available.
3. Report its exit, stdout and stderr; do not retry by weakening security.

The script accepts only `--help` (no application flags), creates temporary HOME/XDG
directories, launches the production build with an inherited Node IPC pipe and
sets `LOCAL_VAULT_SMOKE=1`. Main's trusted test branch checks the real renderer's
bridge, empty state and absence of Node globals, sends success to its parent,
and intentionally quits. Neither the environment marker alone nor renderer IPC
can activate this shutdown path. After 15 seconds the harness terminates the
child and **fails**. Temporary runtime data is removed in teardown.

This is a narrow native startup/bridge check, not a visual interaction check,
packaging proof or cross-platform certification. Report unavailable sandbox,
display or libraries explicitly. Never use `--no-sandbox` or a root bypass.

## Limits

See [core safety limits](vault.md) for local filesystem races, non-atomic existing
plaintext export and best-effort JavaScript erasure. Directory permissions are
not a Windows ACL implementation. A privileged local attacker and compromised
OS are outside this MVP's protection. Native macOS and Windows execution and
installer packaging require separate checks on those platforms.
