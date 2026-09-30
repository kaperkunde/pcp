# Security

## Reporting a vulnerability

Email security@kaperkun.de with what you found and how to reproduce it. You
will get an answer within a few days. Please do not open a public issue for
something exploitable until it is fixed.

## What PCP protects

PCP holds credentials for other services and uses them on your behalf. The
things it defends against, and the things it does not:

**Someone with a copy of the disk or the database** sees AES-256-GCM
ciphertext and SHA-256 hashes. The vault's data key is stored only wrapped
under keys derived from your password (scrypt, 64 MiB), the recovery key, a
session cookie or an API token — none of which are on the disk. See
[ARCHITECTURE.md](ARCHITECTURE.md#encryption).

**Someone with a running server but no credential** cannot read the vault
either: the key exists in memory only for the duration of a request that
presented one.

**An assistant with an API token** can call the tools of the servers that
token reaches, as far as you allowed them: tools ask you first until you
decide, and blocked tools are refused. It cannot answer a permission request
for you, and it can only propose a new server, naming a stored secret rather
than seeing it; nothing is added until you agree. It never receives a stored
secret, an OAuth token, or another vault's data. Revoking the token ends its
access at once.

**Password guessing** is rate-limited per address (10 attempts per 15
minutes) and made expensive by scrypt.

Not defended against:

- **A compromised server process.** Anything that runs inside PCP while a
  request is being served can read that request's key. Keep the host
  patched and the image current.
- **A compromised browser or client.** A session cookie or an API token is
  a credential; treat it like one.
- **The setup race.** Before the first setup, whoever reaches the site
  first becomes its owner. Set PCP up right after starting it, and do not
  expose an unconfigured instance to the internet.
- **Malicious upstream servers.** PCP passes what a server answers to the
  assistant. A server you add can lie in its tool descriptions or results
  (prompt injection); add servers you trust.

## Operational notes

- Run behind TLS. Most OAuth servers require an `https` redirect URL, and the
  session cookie is only marked `Secure` when the request arrived over TLS.
- Back up the data volume. Losing it loses the vault.
- Keep the recovery key somewhere safe. Losing it and the password loses the
  data; that is the design.
- The request log (`logs/*.jsonl` in the data directory) records which tools
  were called, never their arguments or results.
