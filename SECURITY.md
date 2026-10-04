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
for you, and it can only propose a new server or API (as OpenAPI text),
naming a stored secret rather than seeing it; nothing is added until you
agree, and you are shown the address, the tools and the secret first. It never receives a stored
secret, an OAuth token, or another vault's data. Revoking the token ends its
access at once.

**An assistant with an API token and an API endpoint** can call the operations
the schema lists, with your secret in the header, and nothing else. It cannot
choose the address (PCP sends to the base URL saved on the endpoint and never
follows a redirect), cannot add a header PCP owns, cannot leave the path of
the operation, and never receives the secret: PCP removes it from the API's
answer before reading it, in case the API echoes it back. Read-only keeps an
endpoint to GET operations, and a token scoped to other servers does not see
it.

**An assistant with a token that may manage endpoints** can read an API
endpoint and rewrite one it registered, and nothing that decides where your
secrets go. A change that other assistants would see disables the endpoint
until you enable it. It cannot see, choose or change a secret. Once an
endpoint sends your secret, or you allow private addresses, the endpoint is
yours: it can read it and turn read-only on, and nothing else, so it cannot add
operations your key would then perform or move it. An API an assistant
proposes is only added when you agree, refuses private and local addresses
(checked at the moment of connecting, so a rebinding name does not get past
it) until you allow them, and sends a secret only to the address you were
shown. The right to read and change endpoints is off unless you tick it when
you make the token.

**Someone with your session cookie but not your password** can use PCP as
you while the session lasts. They cannot make an API token or a new recovery
key, because both ask for the password again, so they cannot keep a way in
once the session ends. **Sign out everywhere** (Settings) ends every session
and can revoke every API token with it; recovery can do the same. Rotate any
secret they could have seen.

**Password guessing** is rate-limited: 10 attempts per 15 minutes per address
on the sign-in page and per session inside PCP, 60 in all. scrypt makes each
guess expensive.

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
- **A schema you add is someone else's text.** PCP bounds it (size, nesting,
  aliases, no remote references), but its operation names and descriptions
  reach the assistant, and every operation it lists can be called with your
  credential, destructive ones included. Use a key with only the access the
  assistant needs, turn on Read-only, and scope the token. Read-only trusts
  the HTTP method: a GET that changes something is the API's doing.
- **Addresses on your own network.** PCP does not stop a schema URL or a base
  URL from pointing at a private address; only you can set one, and that is
  often the point. A host that lets anyone else do it needs an address
  policy first (see [ARCHITECTURE.md](ARCHITECTURE.md#api-endpoints)).
- **Egress through an API an assistant registers.** Once you agree to an API
  and allow its tools, an assistant can have PCP send data it holds to that
  public address, as the arguments of an operation. A prompt injected into the
  assistant can do the same. Read what you are asked before you agree (it
  shows the address, the operations and whether they can change things),
  turn on Read-only where it is enough, and give a token the right to change
  endpoints only if it needs it.
- **Schema text on disk.** An endpoint's OpenAPI document, and the call plans
  built from it, are stored unencrypted, like server addresses and names. A
  copy of the disk shows them. Do not put a key or a hostname you would not
  want seen into a schema you upload.
- **Endpoints behind an outbound proxy.** Public-only endpoints connect
  directly so PCP can check the address it connects to. A host that must use
  a proxy has to allow private addresses on those endpoints, which turns that
  check off; the proxy's own egress rules are what protect it then.
- **A key an API alters before echoing it.** PCP removes the secret as sent;
  an API that hashes or truncates it first is not caught.

## Operational notes

- Run behind TLS. Most OAuth servers require an `https` redirect URL, and the
  session cookie is only marked `Secure` when the request arrived over TLS.
- The desktop app listens on this computer only (`127.0.0.1`) until its owner
  turns on **Accept connections from other devices**; then it listens on every
  interface, like the Docker image, for port forwarding from a router. A tunnel
  does not need that. PCP's Settings page explains both while its address is
  one only a home network reaches.
- Back up the data volume. Losing it loses the vault.
- Keep the recovery key somewhere safe. Losing it and the password loses the
  data; that is the design.
- The request log (`logs/*.jsonl` in the data directory) records which tools
  were called, never their arguments or results.
