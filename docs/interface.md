# Local Vault interface

Local Vault is a desktop workspace for encrypted, local project/environment documents. It has no account, sharing, sync, or password-reset service. The browser build intentionally shows **Desktop app required** and cannot create or save vault data.

## Create, unlock, recover

- First launch: enter a **Master password** and **Confirm password**, then **Create vault**. Keep the password safe: losing it means losing access.
- Existing vault: enter the master password and select **Unlock vault**.
- **Restore encrypted backup** is available before creation or while locked. Enter the **Backup master password**, then **Choose backup and restore**. Restoration replaces the local vault only after main validates the encrypted backup. The backup is portable to another computer with the same password. There is no reset or OS-unlock fallback.
- After unlocking, use **Encrypted backup** to save a portable encrypted snapshot with a native destination picker. Keep a copy on another device. This is not a plaintext export.

Passwords are cleared from input state on submission or dialog cancellation. Successful locking removes the snapshot, editor draft, selected identifiers, reveal state and export preview from renderer state. JavaScript cannot guarantee physical memory zeroization.

## Projects and documents

1. Use **New project name → Add project** in the sidebar.
2. Select a project, then use **New environment name → Add environment**.
3. Environment selection buttons identify the selected environment with a pressed state.
4. **Variables** is the default read-only view for each selected environment, including existing documents without reimport. It projects the current draft into ordered named rows, retaining duplicate names. **Reveal values** shows literal RHS spelling; **Hide values** removes values from the DOM entirely (including attributes and accessible names), not merely blurring them. Names remain visible. Empty values are labeled **Empty value** when revealed. This is visual privacy, not an additional encryption boundary.
5. Select **Raw** and **Reveal values** to use the **Raw .env document** editor. Switching views preserves unsaved edits and does not save. **Save changes** sends the exact document to main, without expansion, sorting or whitespace cleanup. Untouched BOM, CRLF, CR and LF endings are retained when editing through a browser textarea; inserted newlines use the document’s first line-ending style (LF for a new document).

### Display grammar (not runtime dotenv semantics)

The linear display scanner recognizes an optional leading BOM, spaces/tabs, an optional `export` followed by spaces/tabs, and ASCII keys `[A-Za-z_][A-Za-z0-9_]*` followed by optional spaces/tabs and `=`. Blank lines and full-line `#` comments are not rows. Everything after `=` is displayed verbatim, including leading spaces, quotes, dollar references, hashes and inline comment text. Nothing is expanded, interpolated, unescaped or executed.

A single-, double- or backtick-quoted value must begin at the first non-space/tab RHS character. Quoted spans may cross lines; backslash-escaped delimiters do not close a span. Assignment-looking lines inside the span are never rows. After the closing quote only spaces/tabs and an optional `#` comment are supported. Unquoted RHS text supports literal characters except embedded quote delimiters or a trailing backslash before an optional comment. Quotes inside inline `#` comments are literal.

At the first unsupported statement or unterminated quoted span, projection stops conservatively: **Incomplete variable display** identifies only its starting line number and offers the **Raw** route. The remainder is not advertised as parsed; the diagnostic never echoes potentially secret text. Examples of unsupported syntax include shell commands, non-ASCII/hyphenated keys, embedded quote concatenation and unquoted line continuations. This is deliberately not a runtime dotenv parser. No import is rejected or document rewritten by display; all original text remains available in Raw and export. Long and multiline values wrap within their row.

Dirty edits protect switching projects/environments, adding records, import/export, backup, and lock. Use **Save changes** or explicitly **Discard changes**, then repeat the desired action. While a bridge operation is pending, editing and other controller operations are blocked. **Lock vault** clears decrypted renderer state only after main confirms successful locking; a rejected operation leaves the current work available.

## Import and export

**Import .env** opens a native file picker and replaces the selected saved document. Save or discard local edits first. Canceling the picker changes nothing.

**Export .env…** chooses a destination and opens **Plaintext export** with the destination label, **Previous content**, and **Proposed content**. A new destination and an existing empty file are distinguished. No export is written at this stage.

- **Confirm export** asks main to write using the opaque preview capability. Main rejects stale previews; the error is displayed without claiming success.
- **Cancel export**, or Escape while idle, asks main to discard the preview and leaves the destination unchanged.
- Exported files are **unencrypted secrets**. Anyone with access to the destination can read them. Prefer an encrypted backup for recovery and transfer.

Every successful bridge mutation replaces the renderer snapshot with main’s returned state. Cancellation is reported as cancellation, never as a successful save. Rejected operations show the service error and retain the prior snapshot/draft. There are no renderer filesystem APIs or browser-storage fallback.

## Accessibility and visual direction

Native HTML forms, labels, buttons and modal dialogs support keyboard operation. Dialogs use native focus trapping, restore focus to their opening control when it still exists, and handle Escape as cancellation unless an operation is pending. Export initially focuses its safe cancellation control. Status and error messages use live status/alert regions. Environment selectors are ordinary pressed buttons rather than incomplete ARIA tabs.

The desktop-first layout adapts to a single column on narrow windows. Local font packages bundle Newsreader, Geist and Geist Mono; no font requests go to a remote service. Landing-derived styling uses a faint 56px grid, white surfaces, dark text and restrained green accents, not the reference product’s branding. There are no decorative or delayed keyboard animations; reduced-motion preferences are respected.

## Verification boundary

`tests/renderer.test.ts` exercises the public renderer controller with obvious fake values and server-renders the actual React interface. Together with `tests/env-document.test.ts`, it checks ordered import rows, projection grammar/fallback, hidden-value DOM exclusion, current-draft display, Raw preservation, password validation, authoritative snapshots, exact raw documents, dirty/pending guards, native cancellation reporting, export preview/confirm/cancel, restoration, error rendering and clearing on lock. `tests/foundation.test.ts` retains bridge/security structural checks and verifies the honest browser-unavailable screen.

These tests do not prove real browser focus, keyboard behavior, native file dialogs, layout at 390px, or Electron IPC integration. Those require the parent’s browser/native integration smoke checks. The renderer expects the optional `window.vault` contract in `shared/api.ts`; no production fake bridge or demo vault is installed.
