# Security

## Reporting a vulnerability

Email security@kaperkun.de with what you found, how to reproduce it, and the
version you saw it in (the header of every page shows it). You will get an
answer within a few days. Please do not open a public issue for something
exploitable until it is fixed.

## Supported versions

Only the latest release gets fixes. Every release counts the version up, and
there are no older lines kept alive beside it, so a fix ships as a new
release: update to it (Settings → Updates says how for your install).

## What PCP protects

PCP holds credentials for other services and uses them on your behalf. The
things it defends against, and the things it does not:

**Someone with a copy of the disk or the database** sees AES-256-GCM
ciphertext and SHA-256 hashes. The vault's data key is stored only wrapped
under keys derived from your password (scrypt, 64 MiB), the recovery key, a
session cookie, an API token or what an app that signed in holds (its access
and refresh tokens) — none of which are on the disk. The browser's
sign-ins and kept results are in the vault too, encrypted the same way. See
[ARCHITECTURE.md](ARCHITECTURE.md#encryption). In the Mac app, the window's
session cookie and the Touch ID key do sit in the app's folder, but encrypted
under a key in your login keychain, which a copy of the disk does not open.

**Someone with a running server but no credential** cannot read the vault
either: the key exists in memory only for the duration of a request that
presented one. The one thing kept decrypted longer is the browser's: while
it runs (until fifteen idle minutes have passed), Chromium holds its
sign-ins in memory.

**An assistant with an API token** can call the tools of the servers that
token reaches, as far as you allowed them: tools ask you first until you
decide, and blocked tools are refused. It cannot answer a permission request
for you: you answer on PCP's own page, signed in. It can only propose a new
server, API (as OpenAPI text or a schema URL) or mail account, naming a secret
rather than seeing it; nothing is added until you agree, you are shown the
address, the tools and the secret first, and a secret PCP does not hold yet is
typed in by you on that page. It can propose levels for its own tools, but
only your save on PCP's page changes them. It never receives a stored secret,
an OAuth token, or another vault's data. Revoking the token ends its access at
once.

**An assistant with an API token and an API endpoint** can call the operations
the schema lists, with your secret (a header, or a user name and password)
or OAuth token added by PCP, and nothing else. It cannot
choose the address (PCP sends to the base URL saved on the endpoint and never
follows a redirect), cannot add a header PCP owns, cannot leave the path of
the operation, and never receives the secret: PCP removes it from the API's
answer before reading it, in case the API echoes it back. An OAuth sign-in
goes only to the addresses you saw when you saved or approved the endpoint;
a later schema that moves them is reported, never followed, and so is the
provider's own metadata when it names other addresses (PCP reads it only to
learn whether it may register itself there). Read-only keeps an
endpoint to GET operations, and a token scoped to other servers does not see
it.

**An assistant with an API token and a mail account** can do what the
account's tools do, as far as you allowed them: list and search its mail,
read emails and their attachments (a file comes back as a handle), and,
unless you made the account read-only (or, over IMAP, gave it no SMTP
server), send as you, with attachments from its own kept results, move, flag,
label and delete into the Trash, create, rename and move folders, delete an
empty one, and (JMAP) turn the automatic reply on or off. Nothing deletes mail
for good (a folder that holds mail, or the inbox, Trash and the other special
ones, is never deleted), and sending cannot be undone, so leave `send_email` on Ask you first unless you mean otherwise.
`create_draft` only writes into Drafts and sends nothing, so you can allow it
on its own and send what it wrote yourself.
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
connecting, as for an API an assistant proposes) unless you set **Private
addresses** to Allowed for that token or for all tokens, which an assistant
cannot ask for, and it never reaches PCP's own address. It cannot send one of
your secrets or any Authorization or Cookie header, and a redirect to another
site is reported to it rather than followed. The right is off unless you
tick it when you make the token or on its page.

**An assistant with a token that reaches the browser** (a server you add on
the Browser page, whose tools ask you first like any other's) drives a
Chromium on PCP's machine, and acts as you on every site you signed in to
there. It opens only the sites the token's web fetch lines allow (Browser
sites, for a token without web fetch), sites you allowed for that tab, and
private addresses only as for web fetch; never PCP's own site. It sees and
drives only its own tabs, the ones it opened and the ones you hand it:
another token's tabs and yours are not there for it, so it cannot read a
page another token or you opened, nor use a site you allowed for another
token's tab (a tab you hand to another token drops those), and it leaves a
page alone once its lines no longer let it open the site. A tab you hand
over goes only to a token you pick that is live and reaches the browser,
and the site it is at counts as allowed for that tab. Every connection goes
through PCP's proxy, which checks the address it dials, so a page, a
redirect or a script on it cannot reach your network either. No tool runs a
script, reads cookies or storage, or downloads a file. The sign-ins are kept
in your vault, encrypted, and shared by every token that reaches the
browser; **Forget all sites** signs it out of everything.

**Someone with your session cookie but not your password** can use PCP as you
while the session lasts (30 days from sign-in). They cannot make an API token
(nor let an app sign in, which makes one, or give an expired token a new
expiry, which brings it back), a new recovery key, a Touch ID key
or an export, because each asks for the password again, so they cannot keep a way in once the session ends. Nor can
they change PCP's public address, which decides where sign-ins, permission
links and the address you give assistants point: that asks for the password
(or Touch ID) too. **Sign out everywhere** (Settings) ends every session, turns
Touch ID off, forgets the pinned public address and can revoke every API token
with it; recovery does the same. Pin the public address again afterwards if
you had set one, and rotate any secret they could have seen.

**Touch ID in the Mac app** unlocks PCP, and confirms a new API token (an
app's sign-in included, or a new expiry for an expired one), a new public
address, an export, a restore or
deleting the vault, with your fingerprint. It is a key of its own that PCP
makes once you have typed your password, not your password. A release built
with PCP's provisioning profile keeps it in a keychain item that macOS itself
opens only for your fingerprint, on this Mac only; otherwise the app keeps it
encrypted under a key in your login keychain and checks the fingerprint
itself. Either way it reaches PCP's own pages only, and only after Touch
ID. In the keychain item, adding or removing a fingerprint turns it off
until you set it up again. It cannot change your password,
make a recovery key or set Touch ID up again; those take the password, so
someone with your finger and not your password cannot lock you out.
Recovering with the recovery key, signing out everywhere, a restore and
deleting the vault turn it off.

**An app that signs in with OAuth** (a claude.ai connector, ChatGPT) gets an
API token like any other, and only after you approve it on PCP's own page
with your password or Touch ID; PCP is its own authorization server, so no
relay in front of it can issue one. The page shows where the app really
comes from and where PCP sends you back to; anyone can register an app and
call it "Claude", so allow a sign-in only when you just started one. A
stolen access token works for at most an hour. A refresh token works once;
if a copy is used after the app has used it, PCP ends that app's sign-ins.
Revoking the token under API tokens signs the app out.

**Password guessing** is rate-limited: 10 wrong passwords per 15 minutes per
address on the sign-in page and per session inside PCP, 60 in all. A right
password gives its try back, since it is no guess and only someone who knows
it can type it, so you never lock yourself out by signing in. Recovery keys
and export passwords are counted the same way, each on its own, and Touch ID
has a budget of its own rather than spending the password's. scrypt makes
each guess expensive. The address is the one the proxy in front of PCP
reports (`X-Forwarded-For`), which a client reaching port 3000 directly can
set to anything; the 60 for the whole instance holds either way. The counts
are kept in memory, so a restart starts them again.

Not defended against:

- **A compromised server process.** Anything that runs inside PCP while a
  request is being served can read that request's key. Keep the host
  patched and the image current.
- **A compromised browser or client.** A session cookie or an API token is
  a credential; treat it like one.
- **Software already running as you on the Mac**, against your signed-in
  session, and against Touch ID in a build without PCP's provisioning
  profile. There the fingerprint is the app's own check: the keychain gives
  the key's encryption key to PCP's own code and asks you before any other
  program, and PCP's build stops other programs from running code as it,
  but a program that gets past that can use the key without your finger, as
  it could your session. With the profile, macOS asks for the finger itself
  and the key is no use without it, but your signed-in session is as
  exposed as before.
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
  PCP's network more than the assistant's trusts this too, and where you
  allowed private addresses, the devices on your network are in reach.
- **Pages the browser opens.** A page is someone else's text, and an
  assistant reading it can be steered by it, while it acts as you where the
  browser is signed in. Keep its tools at Ask you first where a click could
  cost something. In the Docker image Chromium runs without its own sandbox
  (an unprivileged container gives it none to use), so a flaw in Chromium
  that a page exploits runs as PCP's user in the container, with PCP's data
  directory and a network without PCP's proxy in reach; keep the image
  current. Chromium installed from the Browser page (the desktop app, a
  checkout) comes from the addresses Playwright pins for it, over HTTPS,
  with no checksum of PCP's own.
- **Programs an assistant runs.** A token you let run code can call every
  tool it may call, many times over, from one program, and a prompt
  injected into the assistant can write that program. Each call still
  follows the token's levels (a tool that asks you stops the program), so
  keep tools that send, delete or pay at Ask you first. The program runs in
  QuickJS compiled to WebAssembly, with no network, files or secrets, a
  memory the WebAssembly engine caps, and limits on time and calls; a flaw
  in QuickJS or in the WebAssembly engine of Node would be what let it out,
  so keep PCP updated. A shell or Python program, where you added the
  sandbox container, runs in a container with no network, a read-only file
  system and no capabilities but changing user, as a user that cannot reach
  PCP's socket; a flaw in the kernel or the container runtime would be what
  let it out, so keep the host updated too.
- **Site names on disk.** The sites a token reached, with when, are stored
  unencrypted, like server addresses, so the token's page can list them. A
  copy of the disk shows them.
- **Schema text on disk.** An endpoint's OpenAPI document, and the call plans
  built from it, are stored unencrypted, like server addresses, names and the
  user name of a login. A copy of the disk shows them. Do not put a key or a
  hostname you would not want seen into a schema you upload.
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
- **Being locked out by someone else's guesses.** Anyone who reaches the
  sign-in page can spend the instance's 60 password tries and keep you from
  signing in, or confirming with your password, until the 15 minutes are
  up. A session you already have keeps working.

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
- Mac app releases carry PCP's Developer ID signature, so an update keeps
  its keychain item. A Mac app you build yourself without the certificate is
  signed ad hoc and tied to the exact build: after a rebuild macOS asks once
  for your Mac's password before PCP may use it. Choose **Always Allow**;
  denying it signs the app out and turns its Touch ID off.
- The update check asks GitHub for PCP's latest release once a day, once you
  have set PCP up and until you turn it off (Settings → Updates); GitHub sees
  your address and PCP's version, which is all it sends. The answer is read as
  untrusted text: the version, date, notes and file names, never a link. In a
  container or a checkout PCP never updates itself. The Linux installer's
  daily update (`PCP_AUTO_UPDATE=1`, by its own timer or Podman's) starts PCP
  again from whatever image is published as `ghcr.io/kaperkunde/pcp:latest`,
  with no step for you to look first.
- The desktop app installs an update only when you choose **Install and
  restart**, downloading it from PCP's GitHub releases over HTTPS. On a Mac,
  the updater takes only an app signed with the same Developer ID; the
  Windows app is not signed yet, so there the download is checked against
  the checksum published beside it, and no more.
- Back up the data volume, or export from Settings. Losing both loses the
  vault.
- An export file (Settings → Export) holds the vault's rows as they are: the
  ciphertext, and the data key wrapped under your password, the recovery key
  and each API token, all encrypted again under the export password you chose
  (scrypt, as for the password). Reading a secret out of it takes the export
  password and one of those credentials. With dynamic DNS on, its token or
  password is in the file unencrypted under the vault's key, as it is in the
  database, so the export password alone opens it; the certificate's key is
  not in it, and neither are sessions or the Touch ID key.
- Keep the recovery key somewhere safe. Losing it and the password loses the
  data; that is the design.
- The request log (`logs/*.jsonl` in the data directory) records which tools
  were called, by which token, and whether they worked, never their
  arguments or results. The Log page shows it to the signed-in owner, and the
  cleanup deletes the days older than the owner keeps (Settings → Cleanup, 90
  by default).
- An answer too long to pass on in one piece (a large API response, a long
  email), and a file or value handed back as a handle (an attachment, an
  image), is kept for a day: encrypted under the vault's key, readable and
  usable only by the token that asked, and deleted once it has expired (by the
  cleanup, which runs at least once a day, or when that token keeps another). A handle in a later call's
  arguments is replaced only with that token's own results; the permission
  page shows what each handle is (name, type, size), never its content, and
  the request log records neither.
