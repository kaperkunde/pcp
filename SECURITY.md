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
[ARCHITECTURE.md](ARCHITECTURE.md#encryption). In the Mac app, the window's
session cookie and the Touch ID key do sit in the app's folder, but
encrypted under a key in your login keychain, which a copy of the disk does
not open.

**Someone with a running server but no credential** cannot read the vault
either: the key exists in memory only for the duration of a request that
presented one.

**An assistant with an API token** can call the tools of the servers that
token reaches, as far as you allowed them: tools ask you first until you
decide, and blocked tools are refused. It cannot answer a permission request
for you: you answer on PCP's own page, signed in. It can only propose a new
server or API (as OpenAPI text or a schema URL), naming a secret rather than
seeing it; nothing is added until you agree, you are shown the address, the
tools and the secret first, and a secret PCP does not hold yet is typed in by
you on that page. It can propose levels for its own tools, but only your save
on PCP's page changes them. It never receives a stored secret, an OAuth
token, or another vault's data. Revoking the token ends its access at once.

**An assistant with an API token and an API endpoint** can call the operations
the schema lists, with your secret or OAuth token in the header, and nothing
else. It cannot
choose the address (PCP sends to the base URL saved on the endpoint and never
follows a redirect), cannot add a header PCP owns, cannot leave the path of
the operation, and never receives the secret: PCP removes it from the API's
answer before reading it, in case the API echoes it back. An OAuth sign-in
goes only to the addresses you saw when you saved or approved the endpoint;
a later schema that moves them is reported, never followed. Read-only keeps an
endpoint to GET operations, and a token scoped to other servers does not see
it.

**An assistant with an API token and a mail account** can do what the
account's tools do, as far as you allowed them: list and search its mail,
read emails and text attachments, and, unless you made the account
read-only (or, over IMAP, gave it no SMTP server), send as you, move, flag
and delete into the Trash. Nothing deletes mail for good, and sending cannot
be undone, so leave `send_email` on Ask you first unless you mean otherwise.
It never receives the password or token: PCP signs in itself and removes
both from every answer. It can propose a mail account, naming its password
or token and never holding it: nothing is added until you agree on PCP's page,
where you type the value in or connect it, and a private address it proposes is
flagged there. It cannot change an account. Over JMAP,
PCP sends the credential only to the session URL's origin and never follows
a redirect; over IMAP and SMTP, only over an encrypted connection.

**An assistant with a token that may manage endpoints** can read an API
endpoint and rewrite one it registered, and nothing that decides where your
secrets go. A change that other assistants would see disables the endpoint
until you enable it. It cannot see, choose or change a secret. Once an
endpoint sends your secret or OAuth token, or you allow private addresses,
the endpoint is yours: it can read it and turn read-only on, and anything
else (a new name or description, edits, tool descriptions, reading the schema
URL again) is a request you answer, shown every new edit and description in
full and what it does to the tools. Its address and a whole new schema are
never its to change, so it cannot move your key or quietly add operations your
key would then perform. An API an assistant
proposes is only added when you agree, refuses private and local addresses
(checked at the moment of connecting, so a rebinding name does not get past
it) until you allow them, and sends a secret only to the address you were
shown. The right to read and change endpoints is off unless you tick it when
you make the token.

**An assistant with a token that keeps memories** writes its own notes
without asking, and only that token reads them. Anything every assistant
would read (a shared memory, or one read in every conversation) is yours to
agree to: you are shown the whole text, nothing is written before you answer,
and text with characters that do not show on screen is refused, so what you
read is all there is. The right to keep memories is off unless you tick it.

**An assistant with a token that may fetch web pages** can have PCP request
public addresses, as far as the token's method and site levels allow: a site
it has not reached before asks you first unless you allow that method
everywhere, and every site it tried is listed on the token's page. It cannot
reach a private, loopback or link-local address (checked at the moment of
connecting, as for an API an assistant proposes), cannot send one of your
secrets or any Authorization or Cookie header, and a redirect to another site
is reported to it rather than followed. The right is off unless you tick it
when you make the token or on its page.

**Someone with your session cookie but not your password** can use PCP as
you while the session lasts. They cannot make an API token or a new recovery
key, because both ask for the password again, so they cannot keep a way in
once the session ends. **Sign out everywhere** (Settings) ends every session
and can revoke every API token with it; recovery can do the same. Rotate any
secret they could have seen.

**Touch ID in the Mac app** unlocks PCP, and confirms a new API token, an
export or a restore, with your fingerprint. It is a key of its own that PCP
makes once you have typed your password, not your password: the app keeps it
encrypted under a key in your login keychain and hands it to PCP's page only
after Touch ID, and only to PCP's own pages. It cannot change your password,
make a recovery key or set Touch ID up again; those take the password, so
someone with your finger and not your password cannot lock you out.
Recovering with the recovery key, signing out everywhere and a restore turn
it off.

**Password guessing** is rate-limited: 10 attempts per 15 minutes per address
on the sign-in page and per session inside PCP, 60 in all. scrypt makes each
guess expensive.

Not defended against:

- **A compromised server process.** Anything that runs inside PCP while a
  request is being served can read that request's key. Keep the host
  patched and the image current.
- **A compromised browser or client.** A session cookie or an API token is
  a credential; treat it like one.
- **Software already running as you on the Mac**, against Touch ID. The
  fingerprint is the app's own check, not a keychain item macOS binds to it
  (that takes a Developer ID signature with a provisioning profile). The
  keychain gives the key's encryption key to PCP's own code and asks you
  before any other program, and PCP's build stops other programs from
  running code as it; a program that gets past that can use the key without
  your finger, as it could your signed-in session.
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
- **Egress through web fetch.** A token you let fetch web pages can send
  what it holds to any public site you allow, in the address or, with a
  method that has one, in a body; a prompt injected into the assistant can do
  the same, and what a page says reaches the assistant as the page's words.
  Allow GET only where you can, keep POST and the other methods at Ask you
  first or Blocked, and read the address and the body before you allow a
  request. PCP's own address is the one the site sees, so a site that trusts
  PCP's network more than the assistant's trusts this too.
- **Site names on disk.** The sites a token reached, with when, are stored
  unencrypted, like server addresses, so the token's page can list them. A
  copy of the disk shows them.
- **Schema text on disk.** An endpoint's OpenAPI document, and the call plans
  built from it, are stored unencrypted, like server addresses and names. A
  copy of the disk shows them. Do not put a key or a hostname you would not
  want seen into a schema you upload.
- **Endpoints behind an outbound proxy.** Public-only endpoints connect
  directly so PCP can check the address it connects to. A host that must use
  a proxy has to allow private addresses on those endpoints, which turns that
  check off; the proxy's own egress rules are what protect it then.
- **What is in your mail.** An email is someone else's text: one an
  assistant reads can carry instructions meant for it (prompt injection),
  and could ask it to send or forward mail. Keep sending on Ask you first,
  or make the account read-only, for an assistant that reads mail from
  strangers.
- **Mail servers with certificates your system does not trust.** PCP checks
  the certificate of every JMAP, IMAP and SMTP server and refuses one it
  cannot verify, a self-signed one included.
- **A key an API alters before echoing it.** PCP removes the secret as sent;
  an API that hashes or truncates it first is not caught.

## Operational notes

- Run behind TLS: your own proxy, or PCP's built-in HTTPS (Settings). Most
  OAuth servers require an `https` redirect URL, and the session cookie is
  only marked `Secure` when the request arrived over TLS. Port 3000 stays
  plain HTTP either way; do not expose it to the internet.
- With dynamic DNS on, the service's token or password is stored
  **unencrypted** in the database (the `host_setting` table), because PCP uses
  it while nobody is signed in. Someone who reads the data directory can move
  your DNS name. With HTTPS on, the certificate's private key and the ACME
  account key are files under `tls/` in the data directory (mode 0600). Treat
  backups of the data volume accordingly.
- PCP's own HTTPS listeners face the internet directly and overwrite any
  `X-Forwarded-*` header a client sends.
- The desktop app's own port (3000) answers this computer only
  (`127.0.0.1`) until its owner turns on **Accept connections from other
  devices** in the app's menu; then it listens on every interface, like the
  Docker image, for other devices on the home network. PCP's built-in HTTPS,
  once turned on under Settings, listens on ports 80 and 443 on every
  interface whatever that menu says, since a router's port forward needs
  exactly that. A tunnel needs neither.
- macOS ties the Mac app's keychain item to the exact build when the app
  has no Developer ID signature, so after an update it asks once for your
  Mac's password before PCP may use it. Choose **Always Allow**; denying it
  signs the app out and turns its Touch ID off.
- Back up the data volume, or export from Settings. Losing both loses the
  vault.
- An export file (Settings → Export) holds the vault's rows as they are: the
  ciphertext, and the data key wrapped under your password, the recovery key
  and each API token, all encrypted again under the export password you chose
  (scrypt, as for the password). Reading a secret out of it takes the export
  password and one of those credentials. With dynamic DNS on, its token or
  password is in the file in plain text, as it is in the database; the
  certificate's key is not in it.
- Keep the recovery key somewhere safe. Losing it and the password loses the
  data; that is the design.
- The request log (`logs/*.jsonl` in the data directory) records which tools
  were called, never their arguments or results.
- An answer too long to pass on in one piece (a large API response, a long
  email), and a file or value handed back as a handle (an attachment, an
  image), is kept for a day: encrypted under the vault's key, readable and
  usable only by the token that asked, and pruned at the next start after it
  expires. A handle in a later call's arguments is replaced only with that
  token's own results; the permission page shows what each handle is (name,
  type, size), never its content, and the request log records neither.
