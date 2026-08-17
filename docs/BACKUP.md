# Encrypted key backup / restore

`rgoe backup` and `rgoe restore` encrypt and recover the secret key material an operator cannot
afford to lose. This replaces the manual `tar | gpg` recipe in [OPERATOR.md](./OPERATOR.md#backup):
it uses only Node's built-in crypto (`node:crypto`), so it works with no `gpg` installed.

## What it backs up

It walks a source directory and collects, **by filename**, the three secrets:

| file | what it is |
|---|---|
| `identity.local.json` | the 32-byte onion seed (announce-signing). Losing it loses the onion address. |
| `hs_ed25519_secret_key` | Tor's expanded hidden-service secret key. |
| `bootnode-signer.key` | the `{pub,priv}` that signs the directory (`pub` is what clients pin as `--dir-signer`). |

Everything else in the tree (e.g. `hostname`, `hs_ed25519_public_key`) is ignored.

## Usage

The passphrase is passed **only** via the `RGOE_BACKUP_PASSPHRASE` environment variable — never on
the command line (so it never lands in your shell history or the process list) and never logged.

```bash
# Back up: encrypt every secret under deploy-state/ into one file.
export RGOE_BACKUP_PASSPHRASE='…a long, unique passphrase…'
rgoe backup deploy-state rgoe-keys-$(date +%F).rgoebak
# then move the .rgoebak file to an off-box, encrypted-at-rest location.

# Restore: decrypt back into a directory (refuses to clobber existing files).
export RGOE_BACKUP_PASSPHRASE='…the same passphrase…'
rgoe restore rgoe-keys-2026-08-13.rgoebak deploy-state          # add --force to overwrite
```

Restored files are written with restrictive perms (secrets `0600`, directories `0700`), so the
onion address and pinned signer survive a rebuild and clients keep working. Restore refuses to
overwrite existing files unless you pass `--force`.

Paths may also be supplied via env (`RGOE_BACKUP_SRC` / `RGOE_BACKUP_OUT` for backup,
`RGOE_BACKUP_IN` / `RGOE_BACKUP_DEST` for restore) for non-interactive/automated runs.

## Crypto

- **Key derivation:** `scrypt` with a fresh random 16-byte salt per backup (N=2¹⁵, r=8, p=1 → a
  32-byte key). The salt is stored in the backup file; the passphrase never is.
- **Encryption:** AES-256-GCM with a random 12-byte IV. The 16-byte GCM auth tag makes the backup
  **tamper-evident**: a wrong passphrase or any modified byte fails authentication on restore, which
  aborts loudly and writes nothing.
- **The plaintext bundle never touches disk.** Secrets are collected into memory, encrypted, and
  only the ciphertext envelope (`{version, cipher, kdf, kdfParams, salt, iv, authTag, ciphertext}`,
  all base64) is written out.

## The passphrase is your responsibility

There is **no recovery path** for a lost passphrase — that is the point. A wrong or forgotten
passphrase means the backup is unrecoverable, by design. Store the passphrase separately from the
backup file (a password manager or your normal secrets vault), and treat it with the same care as
the keys themselves.

The operator EOA key (`RGOE_GW_OPERATOR_KEY` / `RGOE_REGISTER_KEY` / `RGOE_SLASH_KEY`) is **not**
covered here — back it up with your normal wallet backups.
