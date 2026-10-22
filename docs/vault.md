# Trusted local vault core

`electron/core/vault.ts` exports `VaultService`. Construct one instance per vault with a main-selected absolute file path in an existing private directory. All public methods return promises and share one failure-resilient operation queue. No network access, keychain, dotenv expansion, or new dependencies are involved.

## Main-process API

- `state()`, `create(password)`, `unlock(password)`, `lock()`
- `addProject(name)`, `addEnvironment(projectId, name)`
- `saveEnvironment(projectId, environmentId, content)`
- `importEnvironment(projectId, environmentId, sourcePath)`
- `previewExport(projectId, environmentId, destinationPath)`
- `confirmExport(previewId)`, `cancelExport(previewId)`
- `backup(destinationPath)`, `restore(password, sourcePath)`

State and export preview results match `shared/api.ts`. Mutations return complete, detached state; cancellation resolves without a value. Import/export/backup/restore paths belong only to main. T4 must obtain paths using native dialogs, translate dialog cancellation to `null`, and expose only the frozen path-free bridge. The service does not implement IPC or dialogs.

An empty vault contains no projects. Projects may have no environments; environments may contain an empty document. Names do not become paths. IDs are generated UUID v4 values. Names must have 1–128 UTF-16 code units, no leading/trailing whitespace, and no ASCII control characters. Duplicate display names are permitted; IDs distinguish documents.

## Encryption and recovery

Version 1 is an exact JSON envelope with `version`, `salt`, `nonce`, `tag`, and `ciphertext`. Binary values are canonical base64. The key is derived with Node scrypt, fixed `N=32768, r=8, p=1`, a 64 MiB memory cap, a random 16-byte salt, and a 32-byte output. AES-256-GCM uses a fresh random 12-byte nonce per encrypted write and a 16-byte authentication tag. Authenticated additional data binds the version and fixed algorithm parameters. No envelope field can request a more expensive KDF.

Passwords contain 1–1024 UTF-8 bytes. No password verifier, password, or key is stored in state or on disk. The derived key exists in service memory while unlocked. Lock overwrites its Buffer best-effort, drops decrypted references, and invalidates previews. JavaScript strings, returned state copies, garbage collection, swap, and a compromised local process cannot be securely erased by this implementation. Callers must discard plaintext state when locking.

Backups are encrypted portable snapshots; restoring on another machine requires only the same password, not an account or original OS. **A lost password is unrecoverable.** Backups require a new destination and never silently overwrite an existing file. Restore authenticates and validates the entire source before changing active bytes or unlocked state, and encrypts a fresh nonce when installing it. A failed password, malformed envelope, unsupported version, or authentication failure has the same unlock error. Restore source/decryption failures likewise have one restore error. Errors never include arguments or document contents; the service logs nothing.

## Bounds and text fidelity

- Environment text and import/export files: 1 MiB of UTF-8 each, inclusive.
- Serialized decrypted vault: 8 MiB, inclusive (including JSON syntax/escaping).
- Encrypted vault, restore, and backup file reads: 12 MiB, inclusive.
- 100 projects; 100 environments per project; 1,000 environments total.
- 16 outstanding export capabilities per service, bounded to 1 MiB of prior/proposed document data each.

Bounds and exact envelope fields are checked before KDF and binary decoding. Decrypted project/environment schemas and globally unique IDs are checked before acceptance. Invalid UTF-8 and unpaired surrogate text are rejected. Raw `.env` content is preserved, including BOMs, comments, ordering, quotes, CRLF, and trailing newlines; no normalization, interpolation, or parser is applied. Tests use only `FAKE`/example values and isolated OS temporary directories.

## File writes and previews

Inputs must be regular files with a single hardlink; symlinks in any existing path component, directories as files, and `.git`/`.jj` path segments (case-insensitive) are rejected. External operations cannot target the vault itself, its hardlinks, or repository metadata. File reads are bounded even if an input grows during reading, and check file identity/size/timestamps before and after.

Encrypted writes use exclusive 0600 same-directory temporary files, file sync, and atomic replacement of a previously checked existing vault. New vaults/backups publish a synced inode with an exclusive hardlink operation, not a rename that could overwrite a newly appeared file. Directory sync is best-effort because it is not supported uniformly across operating systems. Temporary files are cleaned up on ordinary completion/failure; a process crash may leave encrypted temporary files. No recursive deletion occurs. A crash during replacement yields the previous or new encrypted vault on filesystems honoring these operations. The directory should be main-owned/private; this is not a general-purpose hostile-filesystem service.

A preview is a random, main-owned, single-use capability holding destination identity and bytes, source text, and vault revision. Preview/cancel never write. Confirmation rejects changed bytes, inode, timestamps, any service mutation, lock/unlock/restore, or an externally changed vault. Even changing a document back to the same text invalidates old previews. Failed confirmation consumes its capability; request a new preview. Lock clears all capabilities. Cancellation is idempotent.

New exports use exclusive creation. Existing exports use a bounded, revalidated open inode, then write/truncate/sync in place with mode 0600. They **do not** rename blindly over an intervening file. Existing export updates are not crash-atomic: an IO failure or crash during this explicit plaintext overwrite can leave partial output. The original remains available in the preview shown before confirmation, but the service does not automatically create plaintext recovery files.

There is no portable filesystem compare-and-swap. Another local process can race after final validation or modify an already open inode; parent-directory replacement can also race checks. In-process operations are serialized, but separate service instances/processes are not mutually locked. Preflight disk-revision checks detect ordinary external changes, not all adversarial races. Do not claim absolute resistance to a hostile local filesystem. Native macOS/Windows durability and permission semantics remain unverified on this Linux host.

## Exact service errors

| Condition | Message |
| --- | --- |
| Locked operation | `Vault is locked.` |
| Wrong password, tampering, invalid/missing unlock input | `Unable to unlock vault.` |
| Invalid source/password during restore | `Unable to restore vault.` |
| Invalid create password | `Password must contain 1–1024 UTF-8 bytes.` |
| Create over existing vault | `Vault already exists.` |
| Invalid name / ID | `Invalid name.` / `Invalid identifier.` |
| Missing project / environment | `Project not found.` / `Environment not found.` |
| Invalid content type | `Invalid environment content.` |
| Oversized document | `Environment exceeds 1 MiB.` |
| Oversized serialized vault | `Vault exceeds 8 MiB.` |
| Project limit | `Project limit reached (100).` |
| Environment limit | `Environment limit reached (100 per project, 1000 total).` |
| Unsafe path / oversized file | `Unsafe file path.` / `File exceeds size limit.` |
| Invalid text | `Invalid UTF-8.` |
| Missing import file | `File not found.` |
| Input changed during read | `File changed while reading.` |
| External vault change | `Vault changed on disk. Lock and unlock again.` |
| Too many previews | `Too many export previews (16).` |
| Missing/consumed preview | `Invalid export preview.` |
| Changed preview target/source | `Export preview is stale.` |
| Existing backup destination | `Backup destination already exists.` |

Unexpected filesystem/permission/IO errors propagate as Errors; main should display a safe failure and must not log sensitive method arguments. Internal schema errors (`Invalid envelope.`, `Invalid vault data.`) are hidden behind uniform unlock/restore errors when processing untrusted snapshots.

## Verification

Run `npm exec tsx -- --test tests/vault.test.ts`, `npm test`, `npm run typecheck`, and `npm run build`. Tests exercise the public service and actual encrypted/external files, not private fields. Native dialogs, IPC validation, renderer plaintext lifecycle, and desktop smoke tests are integration work, not evidence supplied by these core tests.
