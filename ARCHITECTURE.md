# Architecture

PCP is a Next.js application with a framework-free core. This document covers
the three things that shape it: how data is encrypted, how a request finds
the vault it works on, and what keeps the core usable under a different host
without changing the single-user product.

## Layers

```
app/                 Routes and pages (Next.js App Router)
  mcp/route.ts       The gateway endpoint
  api/oauth/…        OAuth callback and PCP's client metadata document
  api/servers/…      OAuth start (and the per-server callback older clients use)
  api/export/…       The export download (a file needs Content-Disposition)
  api/health/…       The health check; in the desktop app, the version and an install request
  api/browser/…      A browser tab's live view: its pictures out, the owner's input in
components/          React components; forms call Server Actions
lib/actions/         Server Actions: read the session, call lib/core, return a state
lib/server/          Next-specific glue: cookies, request headers, public URL
lib/core/            The domain. No Next.js, no React (ESLint enforces it)
  openapi/           OpenAPI schema → tools and call plans; building and sending the request
  mail/              Mail accounts: JMAP and IMAP/SMTP behind one set of mail tools
  fetch/             web_fetch: the request, the page, which level applies
  code/              run_code: QuickJS, the bridge to the tools, the sandbox's socket
  browser/           The headless Chromium: runtime and gate, proxy, profile, tools, install
  network/           Optional dynamic DNS and HTTPS: timers, Let's Encrypt, the edge listeners
  updates/           The daily check for a newer release, and what it found
sandbox/             run_code's sandbox container: the runner, the launcher, the pcp command
prisma/              Schema and migrations (SQLite)
e2e/                 Playwright suite, with a fake upstream MCP + OAuth server
desktop/             The Mac and Windows app: Electron around the production build, nothing of PCP in it
```

`lib/core` takes a `VaultContext` — `{ vaultId, dek }` — as an explicit
argument everywhere. It never reads a global "current user", never touches
cookies or headers, and opens its database through one module
(`lib/core/db.ts`). That is the boundary a different host would embed.

## Encryption

Every vault has a random 256-bit **data encryption key (DEK)**. Anything
sensitive is AES-256-GCM ciphertext under it, with the row's own id as
associated data (a ciphertext cannot be moved to another row):

- secret values (`secret.ciphertext`),
- OAuth token sets and the clients PCP registered (a `secret` row of kind
  `oauth`, owned by the server that uses it); an OAuth client secret the
  owner gives PCP is one of their own `text` secrets,
- the PKCE verifier of an authorization in flight (`oauth_state`),
- a memory's path and text (`memory.ciphertext`, as one JSON value),
- a tool answer or a file kept for `read_result` and handles
  (`tool_result.ciphertext`),
- what a request waiting for the owner holds: the call's arguments or the
  new server's settings, and the outcome (`permission_request`),
- the browser's sign-ins (`browser_profile`, bound to the vault's id, as
  there is one per vault).

The DEK itself is stored only **wrapped** — AES-256-GCM under a **key
encryption key (KEK)** — once per credential, in `key_grant`:

| Grant kind  | Credential                    | KEK derivation                            | Found by                  |
| ----------- | ----------------------------- | ----------------------------------------- | ------------------------- |
| `password`  | the owner's password          | scrypt (N=2^16, r=8, p=1, per-grant salt) | the vault (one per vault) |
| `recovery`  | `pcp_recovery_…`, shown once  | HKDF-SHA256 with a per-grant salt         | SHA-256 of the credential |
| `session`   | a random secret in the cookie | HKDF-SHA256                               | SHA-256 of the secret     |
| `api_token` | `pcp_…`, shown once           | HKDF-SHA256                               | SHA-256 of the token      |
| `device`    | `pcp_device_…`, the Mac app's | HKDF-SHA256                               | SHA-256 of the key        |

scrypt is slow on purpose: a copy of the database can only be attacked one
password guess at a time. The other credentials have 256 bits of entropy of
their own, so a fast KDF is enough; the SHA-256 kept for lookup is useless
for unwrapping because the KEK uses a different salt and info string.

Consequences:

- **Nothing on the server can decrypt the vault on its own.** The key
  material arrives with a request (cookie, bearer token, password) and is
  gone when it ends. `lib/core/crypto.ts` is the whole of it.
- **Changing the password** replaces the `password` grant. Every other grant
  wraps the same DEK, so sessions, API tokens and the recovery key keep
  working.
- **Revoking an API token** blanks its grant; **signing out** deletes the
  session's; **recovery** replaces the password grant, deletes every session
  grant and the Touch ID key (`device`) and, when asked, blanks every API
  token grant. **Signing out everywhere** deletes the sessions and the Touch
  ID key, and can blank the API tokens too.
- **A session cannot outlast itself.** Making an API token or a recovery key
  asks for the password again (`lib/server/password-attempts.ts`). A session
  cookie can be copied, so it may use the DEK but not mint a grant that
  survives the session. In the Mac app the Touch ID key stands in for the
  password before a new API token, an export or a restore (`confirmOwner`),
  never before a new recovery key, a new password or another Touch ID key:
  only the password and the recovery key decide who gets in. See "Touch ID
  in the Mac app".
- **Guesses are counted.** The password, the recovery key and an export
  password may be tried ten times per address (inside a session, per
  session) and sixty times for the whole instance in fifteen minutes
  (`lib/server/password-attempts.ts`). A right password gives its count
  back, so the owner signing in and confirming all day spends none of the
  tries a guesser is held to. The Touch ID key has a budget of its own,
  given back the same way: it is no password guess, and must not spend the
  owner's tries.
- **Losing every credential loses the data.** There is no back door because
  there is no key to keep one with.
- Rotating the DEK itself (re-encrypting every row) is not implemented;
  `secret.key_version` is there for when it is.

## Tenancy: one vault per user

Every table that holds a person's data has a `vault_id`, and every unique
constraint is scoped by it. The single-user product creates one vault at
setup and finds it again with "the first vault" (`ownerVault()`); that
function and the setup page are the only places that assume there is one.

A request resolves its vault in exactly one of two ways:

- **Browser:** the session cookie → `resolveSession()` → `VaultContext`
  (`lib/server/session.ts`).
- **MCP client:** the bearer token → `resolveApiToken()` → `VaultContext`
  plus the servers the token may reach (`app/mcp/route.ts`).

The gateway is stateless per request: it builds an `McpServer` for the
resolved token, serves the request and discards it. Upstream connections are
opened per call. Nothing in the endpoint knows how many vaults exist, which
is what makes it serve many of them at once.

## Running the core under another host

Nothing in the core assumes one vault, so a host that serves many people
from one endpoint could be built on it. What that would take:

1. **Embed `lib/core`.** It has no Next.js imports (ESLint rejects them), one
   database module to swap and an explicit `VaultContext`. Extracting it to a
   package is a move, not a rewrite; until then a host can vendor the
   directory.
2. **Replace vault resolution.** The host's own OAuth login yields a vault
   id; the host stores the DEK wrapped under a KEK it controls — a new grant
   kind (`external`) whose KEK comes from a KMS, or from the host's session
   store — and hands `lib/core` a `VaultContext` the same way
   `lib/server/session.ts` does. Creating a vault is `setupVault()` with the
   host's own password policy, or a variant that wraps under the host's KEK
   only.
3. **Keep the gateway.** `/mcp` already serves any vault an API token names.
   A host that wants OAuth-issued tokens instead of `pcp_…` tokens replaces
   `resolveApiToken()` with its own resolver returning the same
   `ResolvedToken` shape (vault, key, allowed servers).
4. **Move the database.** Prisma's schema is provider-neutral apart from the
   `datasource` block; a Postgres host generates its own migration history
   (`prisma migrate dev` against Postgres) and runs migrations as a deploy
   step instead of at boot (`instrumentation.ts` → `applyMigrations()` is
   for a single instance). Rate limits (`lib/core/rate-limit.ts`) are
   per-process and would move to a shared store.
5. **None of it lives in this repository.** No admin API, no "create vault"
   endpoint, no tenant switch in the UI: PCP stays single-user.

## API endpoints

An API with an OpenAPI schema is added like a server and reached the same way.
It is an `mcp_server` row with `kind = "openapi"`; its `url` is the API's base
URL, and each operation in the schema is an `mcp_tool` row. Because it is a
server row, token scoping, `search_tools`, `describe_tool`, description
overrides, the "used by" list on a secret and the request log all work on it
unchanged. Two functions in `lib/core/upstream.ts` branch on the kind:
`syncServerTools` re-reads the schema, `callServerTool` makes the request.

**Reading a schema** (`lib/core/openapi/`, no database, no secrets):

- `parse.ts` reads JSON or YAML into plain values. YAML uses the core schema
  with no custom tags and a cap on aliases, so a document cannot build
  anything but data or expand without bound.
- `refs.ts` follows only references into the same document (`#/…`). It never
  fetches a remote or relative one: that would let a schema make the server
  request any address it names. Inlining is bounded in depth and in nodes per
  operation, and a reference back into itself becomes a placeholder.
- `generate.ts` makes one tool per GET, PUT, POST, PATCH or DELETE operation,
  with a JSON Schema for its arguments and a **call plan**: the method, the
  path, which argument goes in which path, query or header parameter, and how
  the body is encoded. The plan is stored beside the tool
  (`mcp_tool.operation`) and validated when read. What PCP cannot send is
  dropped when optional and skips the operation when required, with a reason
  the owner sees (cookies, a reference into another document, a multipart
  body that names no file field). An upload is a tool too: a body of one
  binary type (a PDF, an image, `application/octet-stream`) takes one kept
  result's handle, and `multipart/form-data` takes a handle (or a list) in
  each field its schema marks `format: binary` or with a `contentMediaType`.
  `endpoints.ts` opens those files from the token's kept results before
  anything is sent, and `request.ts` sends their bytes (at most 25 MB in
  all, 20 files), never their base64.
- `patch.ts` applies an endpoint's **edits**: a JSON Patch (RFC 6902) kept
  beside the schema and applied to it every time tools are generated, before
  `generate.ts` sees it. A schema read from a URL keeps its fixes when it is
  read again, and a large one is narrowed or corrected without anyone sending
  it whole. Edits are untrusted input like the schema: keys are set as own
  properties, `__proto__` is refused, and what an edit adds counts against the
  same node limit as a parsed document. An edit that no longer applies (the
  document moved on) fails the read and leaves the tools as they were, naming
  the edit.
- The schema text is kept in `openapi_spec`, with the edits, apart from the
  server row so neither the server list nor the gateway loads it. An uploaded
  schema is regenerated from that copy when the owner changes a setting.
  `openapi_spec.built_with` records the PCP version that built the tools; a
  boot under another version rebuilds them from the stored copy
  (`endpoints.ts: rebuildOutdatedEndpoints`, in the background), so an
  endpoint gets what a newer generator makes of its schema without being
  downloaded again. One that no longer builds keeps its tools and is tried at
  the next boot.

**Making a call** (`call.ts`, `request.ts`): `buildRequest` turns the
assistant's arguments into a request following the plan. Arguments the plan
does not name are refused. Path values are percent-encoded and never `.` or
`..`. Only declared header parameters are sent, never the ones PCP owns
(Authorization, Cookie, Host, hop-by-hop headers), and a header value cannot
carry a line break. The credential is added last, so no argument can replace
it, and the finished URL must still be under the base URL. A credential can
take several headers, each with its own secret (an API that wants a key and a
secret key, as an OpenAPI security requirement naming two `apiKey` schemes
says): the first is on the server row, the rest in `server_auth_header`. None
of them is ever offered as an argument, so no part of a credential passes
through an assistant, and every secret and header value is removed from the
answer. A schema whose requirement names a key header the endpoint does not
send is reported in its status. `executeCall` sends it with a timeout and a
cap on the answer, **without following redirects** (`fetch` would repeat a
custom header such as `X-API-Key` on the next host), turns the answer into a
tool result (JSON pretty-printed and, when small, as `structuredContent`; text
as it is; other types described, not dumped; an error status as an error
result), and removes the credential from it before parsing, because an API
that echoes a key back (in an error, say) must not hand it to the assistant.

**Where requests go** is the owner's choice, made once. The base URL is the
owner's own field when filled, otherwise the schema's first server, resolved
against the address the schema was downloaded from. A refresh never changes
it; it says in the status message when the schema now names another server.
A secret only ever goes to an address the owner chose: one they typed, or one
on the origin of the schema URL they gave. A schema downloaded from one origin
that names another is refused until the owner types the address; a schema file
has no origin, so with a secret the owner always types it; and attaching a
secret later to an address that came from the schema asks for it again. An edit
with the field left empty keeps the saved address and never takes the schema's
server, so a schema cannot aim the secret somewhere the owner did not choose.

**Signing in with OAuth.** An endpoint can send the owner's OAuth token
instead of a secret, for APIs that take only that (Google's, Microsoft
Graph, Spotify). Where to sign in comes from the schema: `openapi/oauth.ts`
reads an `oauth2` security scheme's authorization code flow (the only flow
where a person signs in; implicit, password and client credentials are not
used, and OpenID Connect discovery is not read) and the scopes the offered
operations require, or every scope the flow lists when none names one. The
sign-in and token addresses are stored on the row
(`oauth_authorization_url`, `oauth_token_url`) when the owner saves or
approves the endpoint, and only then: a later schema that moves them is
reported in the status, never followed, so the client secret and the refresh
token only go where the owner was shown. Saving new ones drops the tokens.

The flow is the MCP servers' (below), with the stored addresses standing in
for discovery: `upstream.ts: endpointDiscovery` gives the SDK an
authorization server whose metadata is those two addresses, with no issuer
(a schema names addresses, not the server's identity, so the sign-in
address's origin stands in for it, and the owner's client is bound to that),
and no resource indicator (a REST API names none, and providers that do not
know RFC 8707 refuse it). The owner's client works as for an MCP server, and
so do Google's sign-in defaults and the renewal notice.

A schema cannot say whether the provider lets an app register itself, so
without a client of the owner's, `startOAuth` asks the provider
(`upstream.ts: verifiedEndpointDiscovery`): it reads the authorization
server's metadata (RFC 8414) at the sign-in address's origin, only when the
owner chooses Connect, through the endpoint's address rule. The metadata is
taken only when its sign-in and token addresses are exactly the stored ones,
and then adds what the schema could not say (the registration endpoint, the
client authentication methods, the scopes), so PCP registers itself (RFC 7591)
as it does for an MCP server. Metadata that names other addresses is not used
(the status says where it pointed), and nothing read there ever replaces the
approved addresses; renewals read it the same way and fall back to the
approved sign-in when it cannot be read. Only then is the owner asked for a
client. Token requests go
through `openapi/transport.ts` under the endpoint's address rule, like its
calls. A call carries `Authorization: Bearer <token>`; a token that has run
out is renewed first with the refresh token, and a 401 gets one renewed token
and one more try (a refused request did nothing). A renewal the provider
refuses leaves the endpoint needing connecting, which the gateway answers
with a link to connect it. The token is redacted from what the API answers, like a
secret, and the `Authorization` header is never one of an operation's
arguments.

Private addresses are allowed, as they are for MCP servers: only the owner
sets a schema URL or base URL, and a self-hosted PCP often talks to services
on its own network. A multi-tenant host must add an address policy before it
lets anyone else set one: resolve the name, refuse loopback, private,
link-local and metadata ranges, and connect to the address it checked.

## Registering and managing endpoints through the gateway

**Registering** is `register_server`, the same tool that adds MCP servers
and mail accounts, with an OpenAPI document as text in `openapi_schema` or by
its address in `openapi_url` (plus `spec_patches` to edit it, `url` for the
base URL, `read_only`, and a secret named by NAME, or `auth_type` basic with a
`username` and the password's NAME, or `auth_type` oauth for a document that
declares a sign-in, with `client_id` only for a provider that lets no app
register itself). Which of the four things a call proposes is its `kind`
(`mcp`, `api`, `jmap`, `imap`), inferred as before when it is left out, and
the rules for which arguments go with which kind are
`lib/core/register-rules.ts`: the refusals name what to pass instead, because
the assistant reads them. It is an assistant's request,
so it goes through the same owner approval as any other new server (below):
PCP reads the document when the request is made (downloading it, for a URL),
applies the edits, refuses one that cannot be used, and shows the owner the
address, where the schema came from, how many edits it has, the tool count
and operations, whether the tools can change things, and the secret that
would be sent. Nothing exists until they agree; then `executeRegister` creates the
endpoint, on, and adds it to the token's scope.

With OAuth the owner is also shown where they will sign in, where the client
secret goes and the redirect URI their client needs; the token goes to the
base URL, so that has to be named in the request, as for a secret. A
`client_id` (for an MCP server too) is the owner's client at a provider that
lets no app register itself, and its secret is a new secret the owner types
in on the approval page, which may be left empty for a client without one;
`secret` can name one they stored instead.

A secret is named, never sent. A name PCP does not hold yet (an MCP server's
or an API's) makes a request the owner agrees to on PCP's own page, like
every request, typing the value in there: it never passes through the
assistant's app. The value is saved as a new secret by the proposed name (a number is
added when that is taken by then) just before the server is made, and removed
again if making it fails; a secret of that name the owner added in the
meantime is used when they leave the field empty. The assistant is told the
name it was saved as, never the value. The owner's own forms work the same
way: the secret picker has "a new secret, entered here", saved with the
server or endpoint once everything else on the form has been checked. An assistant can write a
document from an API's documentation and register it in one call. What it
registers has `public_only` set (below) and cannot carry a secret unless the
owner approved that secret going to the address they were shown.

**Reading and changing** one afterwards is for a token the owner made with
"read and change API endpoints" (`api_token.manage_endpoints`, off for every
other token): two more gateway tools, `update_endpoint(endpoint, …)` and
`get_endpoint(endpoint, …)`. A schema is changed with edits (`addPatches`
adds to them, `patches` replaces them all) rather than by sending it again,
and read a part at a time: `get_endpoint`'s `specPointer` returns one value of
the edited document by JSON Pointer, and a value too long to include comes
back as its keys, to point further in with, so a schema of any size can be
read in steps under the answer's length limit (such a read leaves out what
the first one said). `includeProblems` lists likely mistakes in the schema
that confuse assistants, each with the edits that fix it
(`openapi/lint.ts`); `register_server` names them too. The rules are in
`lib/core/endpoint-admin.ts`, and they exist because an assistant that can
change an endpoint decides where PCP sends requests:

- **Whose endpoint it is.** An endpoint is the assistant's while it sends no
  secret or token and is still limited to public addresses. It is the owner's
  once it sends one of their secrets or OAuth tokens, or they allow private
  addresses. The assistant can
  rewrite its own. On the owner's it can read it and turn read-only on, and it
  can ask (a permission request of kind `endpoint_change`) for a new name or
  description, edits, tool descriptions, or a new read of the schema URL: the
  owner is shown every new edit and description in full and what it does to
  the tools (added, taken out, changed, and a warning when a new tool writes
  with their secret), and only that is made, to the endpoint as it was when
  they were asked (`endpoint-admin.ts: applyEndpointChange`); a re-read
  schema must still be the document they were told about. Its address and a
  whole new schema stay the owner's alone: a new address could send the key
  somewhere else, and a new document is not something a page of lines can
  show them.
- **Nothing takes effect without the owner.** A registration waits for their
  answer. A change to an endpoint that other assistants can see (its words,
  schema or address, or read-only turned off) disables it until the owner
  enables it. Text an assistant writes reaches every other assistant through
  `search_tools`, the gateway's instructions and `describe_tool`, so it is the
  owner's to approve. Names cannot hold line breaks, which would otherwise
  start a line of their own in those instructions.
- **No credential changes, ever.** A secret only comes with a registration
  the owner approves, and then by name. `update_endpoint` accepts nothing that
  names a secret, a header or a template, and `get_endpoint` shows only
  whether headers are sent and what they are called. The writer these changes
  go through (`endpoints.ts: changeEndpoint`) writes only the columns it is
  given and never the credential, the schema's source, or public-only, so an
  owner changing those at the same moment is not overwritten and the rules
  above cannot be got around by what is passed in.
- **Public addresses only.** What an assistant registers has `public_only`
  set, and only the owner can clear it. Such an endpoint refuses loopback,
  private, link-local, carrier-grade NAT and multicast addresses, cloud
  host addresses and the IPv6 forms that wrap one (`openapi/address.ts`), for
  its calls and for any schema download. The check is made on the address the
  socket connects to (`openapi/transport.ts` resolves the name itself and
  checks every answer), so a name that resolves to a public address for a
  check and a private one for the connection cannot get through. The owner
  turns it off per endpoint, for an API on their own network. It connects
  directly, not through an outbound proxy (a proxy does its own name
  resolution, which PCP could not check): a host that must use one has to turn
  this off for those endpoints, and the proxy's own egress rules are then what
  protect it. What a name resolves to is neither looked up at registration nor
  told to the assistant, so the tools cannot be used to map the owner's DNS.
  A literal private address is noted in the request the owner reads.
- **Approved as downloaded.** A schema URL an assistant names is downloaded
  once, when it asks, from public addresses only and with no credential, and
  the copy is held (encrypted) on the request: the endpoint is made from the
  document the owner was shown, not from a second download. Afterwards
  (`mcp_server.spec_url_from_assistant`) a background re-read that finds a
  different document reports it and keeps the approved tools; the owner's
  "Re-read" takes it, and so does the assistant's `refreshSpec` while the
  endpoint is its own, which disables it until the owner enables it again.
  Whoever controls that address cannot add operations, or words every
  assistant reads, by changing the file. When a downloaded document does not
  parse, the assistant is told that much and not the parser's message, which
  quotes the text. An endpoint the owner reads from a URL they typed keeps
  following it, as before.
- **Bounded.** Fifty endpoints per vault, 5 MB of schema per registration,
  the same as an upload (it is held, encrypted, on the request until
  answered), a thousand edits and a million characters of them, 4 MB of
  stored tools per endpoint, twenty registrations and twenty changes per token
  per ten minutes, no JSON-RPC batches at the gateway (one POST would be many
  calls), and the catalogue a request loads leaves out tool schemas, which are
  read when a tool is described or called.
- A token limited to some servers only sees endpoints in its scope, and what
  it registers is added to that scope.

What remains is egress: an assistant with the right to register can have PCP
send data it holds to any public URL, as an operation's arguments, once the
owner has agreed to the endpoint and allowed the tool. Both are the owner's to
give, and tools ask first by default. And it can have PCP download a public
address it names, as a schema: what it learns back is whether that was an
OpenAPI document and, if so, what the owner would be asked, which matters
only for a service that trusts PCP's own address more than the assistant's.

## Mail accounts

A mail account is a server row of kind `jmap` or `imap` with a fixed set of
tools (`lib/core/mail/tools.ts`), the same names and answers for both, so an
assistant learns one set: `list_mailboxes`, `search_emails`, `get_email`,
`get_attachment`, `move_email`, `mark_email`, `delete_email`, `send_email`,
and on JMAP `get_thread` and `list_identities`. Which ones an account has
depends on read-only (the tools that change mail are left out, and refused if
called anyway), and on whether it can send (JMAP: the session offers
submission; IMAP: the owner gave an SMTP server). `mcp_tool.operation` is
null; a call is dispatched by name. An assistant can propose an account
through `register_server` (below); only the owner changes one, and the
endpoint tools do not touch them.

**Proposing one** is `register_server` with kind `jmap` or `imap`, a `url` (a
JMAP server's origin or session URL, or an IMAP host), `smtp_url` and
`mail_from` for IMAP sending, `read_only`, and an `auth_type`: `basic` (a
`username` and the NAME of a secret holding the password), `header` (a bearer
token's secret) or `oauth`. It is a permission request like any new server:
`summarizeRow` shows the owner the protocol, the addresses, the user name, how
PCP signs in and whether it can change mail, a password or token PCP does not
hold yet is typed in on the approval page (labelled with the user name, saved
under the proposed name, never in the conversation), and `executeRegister`
creates the account with `createMailAccount` and reads its tools, or answers
an OAuth account with the link to connect it. A JMAP address is completed (a
server's origin gets `/.well-known/jmap`) and looked at before the owner is
asked (`mail/probe.ts`): a GET with no credential, public addresses only and
no redirect followed. A wrong address is refused at once, with where a
redirect pointed; a private or local address is not looked at, and the owner
is told so, because only they should send credentials into their own network.
IMAP is not looked at (a connection without a login shows little).

`upstream.ts` builds the credential and hands it to `mail/accounts.ts` as a
`MailCredential`: the `Authorization` header for JMAP, the login for IMAP and
SMTP, and the values to remove from every answer. Nothing under `mail/` reads
a secret. Authentication is `basic` (a user name, in `auth_username`, and a
secret: Basic for JMAP, LOGIN for IMAP and SMTP), `header` (a bearer token,
JMAP only) or `oauth` (JMAP only).

**JMAP** (`mail/jmap.ts`): `url` is the session URL the owner typed. Reading
the account GETs it with the credential, and the API, download and upload
addresses it names are accepted only on that URL's origin, so the credential
goes nowhere the owner did not type; they are kept (`mail_api_url`,
`mail_download_url`, `mail_upload_url`, `mail_account_id`,
`mail_submission`) and forgotten when
the address or sign-in changes. Redirects are never followed: PCP names
where the server pointed, for the owner to enter instead. A call is one or
two POSTs of method calls. Sending uploads each attachment to the upload
address first, then creates the email in Drafts with the blobs attached and
submits it in the same request, moving it to Sent when it went. That move is
the server's own Email/set (`onSuccessUpdateEmail`, RFC 8621 7.5), answered
under the submission's call id after the submission's answer: `jmapRequest`
takes a call's answer as the first under its id named after its method, and
keeps any other apart (`implicitKey`), so the move's answer never reads as
the submission's and a failed move only means the copy stayed in Drafts. A
reply then marks the email it answers (`$answered`, `\Answered` over IMAP),
after the send, and says whether it could.

**IMAP** (`mail/imap.ts`, on imapflow and nodemailer): `url` is
`imaps://host:port`, or `imap://` for STARTTLS; `smtp_url` the same for
SMTP. A connection that is not encrypted after it is made is dropped, and
STARTTLS is required, never optional. Each call connects, signs in, works
and logs out. An email's id is `<uid>.<uidvalidity>.<mailbox path>`, so an id
from before a mailbox was rebuilt is refused rather than naming another
email. Sending goes over SMTP and a copy (Bcc kept) is appended to Sent,
attachments in both, written by nodemailer.

**What an assistant gets back** is JSON PCP writes: addresses, dates, flags,
the text of a body (the HTML one made plain when there is no text one) and
the list of attachments. `get_attachment` downloads an attachment of any
kind, up to 10 MiB, and keeps it for the token as a file (below): the answer
gives its handle, and a text one's first 20,000 characters too, scrubbed of
the credential. A body longer than 20,000 characters is kept the same way.
`send_email` takes kept results as attachments, read before anything
connects (at most 10, 20 MB together), so an attachment read from one
account can be sent from another. Delete moves to the
Trash and nothing deletes for good. Failures: refused credentials mark the
account `auth_required` (with OAuth, "needs connecting"), an unreachable
server `error`; a request the server refuses (no such email or mailbox) is
an error answer and leaves the account as it is.

**OAuth** uses the same Connect flow as an MCP server (below), discovering
from the session URL, registering PCP when the server lets apps and asking
for `offline_access` (the SDK adds it when the server lists it) so the
connection can be renewed. PCP makes a mail account's calls itself rather than
through the MCP SDK's transport, so its bearer token comes from `credential()`
in `upstream.ts`, as an OAuth API endpoint's does (`endpointToken`): renewed a
minute before it runs out, and once more when the server refuses it. When that
fails the account needs connecting, and the gateway answers with the link to
connect it.

## Memories

A token made with "keep memories" (`api_token.keep_memories`, off unless the
owner turns it on) gets one more tool, `memory`, with the commands of Claude's
memory tool (view, create, str_replace, insert, delete, rename, over files
under `/memories`) plus search and every, and a paragraph in the instructions saying
when to use it. The rules are in `lib/core/memories.ts`. Like endpoint
management, they are drawn around the fact that what one assistant writes
another one reads:

- **Private memories** (`/memories/…`) belong to the token that wrote them
  and are read by it alone. Writing one needs nobody's say: it is that
  assistant's own notebook, no more trusted than the client's built-in
  memory.
- **Shared memories** (`/memories/shared/…`) are read by every token that
  keeps memories. An assistant can only ask: creating one, sharing one of its
  own, and changing, renaming or deleting a shared one are permission
  requests (`memory_share`, `memory_change`) through the same flow as a tool
  call, showing the owner the path and the whole text with a warning about
  stored instructions. The ask writes nothing, and asking again finds the
  same request. A share is answered **Share it**, **Keep it for this
  assistant only** (saved privately), or **Discard it**. On a yes,
  `decideMemoryAsk` re-reads the memory and writes only if it is still what
  the owner was shown. The owner writes, moves and deletes memories freely on
  the Memories page.
- **What the owner reads is all there is.** Text with characters that do not
  show on screen (controls other than tab and newline, format characters such
  as zero-width spaces, direction overrides and tag characters, private-use,
  blank fillers, variation selectors that can carry bytes) is refused, and a
  shared memory is at most 2,000 characters, so it can be read whole.
- **The instructions name shared memories by path, and carry the ones read
  in every conversation whole.** The memory paragraph follows the protocol
  Claude's own memory tool adds to the system prompt (look at `/memories`
  before anything else, save as you go, assume the conversation ends at any
  moment). The owner can mark any memory to be read in every conversation
  (`memory.always`): on the Memories page, or with the toggle on a
  `memory_share` request, where it holds whether they share the memory or
  keep it for the assistant that asked. An assistant can only ask for it
  (`create` under `/memories/shared/` with `every: true` starts the toggle
  ticked); the mark is the owner's answer, never the assistant's ask. A
  shared one goes into every keeping token's instructions, a private one
  into its own token's.
  Its text is at most 2,000 characters, and the instructions carry at most
  8,000 characters of them and name the rest. Clients do not always pass
  the instructions on whole (Claude Code cuts them short; claude.ai showed
  none of them with PCP's tools deferred), so the instructions open with a
  line naming these memories, and the memory tool's `every` command returns
  their text with the listing. The tool's description opens with "call
  every before your first reply" whether or not there are any: a client that
  defers tools shows only that first sentence, and keeps a tool list long
  after the memories change. Every such text is one the
  owner read: an assistant's change to, or move of, an always memory it keeps
  clears the mark, a change to a shared one is a `memory_change` request
  that says it is read in every conversation, and sharing a private one
  sets it to what the owner chose on that request. Any other memory of a token's own is its words alone and is
  only read through the tool, which labels each memory with who wrote it and
  says that it is a note, not an instruction.
- **Bounded.** 500 memories per vault, 10,000 characters each, 60 writes and
  share requests per token per ten minutes. Path and text are encrypted
  together, so uniqueness of paths is checked in code after decrypting the
  vault's memories, as `search.ts` scores every tool. A memory outlives the
  token that wrote it (`token_id` is set to null) and is then the owner's.

## Web fetch

A token made with "fetch web pages" (`api_token.web_fetch`, off unless the
owner turns it on) gets one more tool, `web_fetch(url, method?, headers?,
body?, raw?, max_length?, start_index?)`, and a paragraph in the
instructions. It is the reference fetch server's interface with a method,
headers and a body added. The code is in `lib/core/fetch/` (the request, the
page, and which level applies; no database) and `lib/core/web-fetch.ts` (the
levels as stored, and what the owner does with them).

**Which level applies.** Every request is one method to one site, a site
being the URL's host (with the port when it is not the scheme's own). The
levels are rows in `web_fetch_rule`, a method's or a site's, each for one
token or for all of them (`scope` is the token's id or `all`):

1. the token's own line for the site; set to "Use the method settings"
   (`access` null), it goes straight to step 3, past all tokens' line;
2. all tokens' line for the site, the same way;
3. the token's own level for the method's group (GET, POST, PUT, PATCH,
   DELETE, OTHER);
4. all tokens' level for it;
5. ask.

A site the token has no line for, its own or all tokens', gets one of its
own the first time an assistant reaches for it, at the method settings and
marked as the assistant's: that is how every site an assistant tried shows
on the token's page. Ask goes through `permission_request` like a tool call
(kind `fetch`, the checked request as its encrypted arguments). The owner's
**Always allow this site** and **Block this site** write the token's own
line for the site, as a tool's answer writes the token's own level; when
they allow a request, `executeFetch` runs it only if the token still has web
fetch on.

**What a request may be** (`fetch/request.ts`). http and https, no user name
or password in the address, no CONNECT or TRACE, at most twenty headers, and
none that PCP owns or that carry a credential (`openapi/headers.ts`, apart
from Accept and Content-Type, which are the assistant's own here). A body
only on methods that have one, up to 1 MB. It is checked before the owner is
asked, so what they allow is what runs.

**Private addresses.** One more line per scope, kind `private` (key
`private`, `allowed` or `blocked`), says whether requests may reach
loopback, private and link-local addresses: the owner's own network.
Without a line they are blocked; the token's own line beats all tokens',
as for sites. Only the owner sets it, on the token's page, and an
assistant cannot ask for it: the address is known only once PCP looks the
name up, after the owner would have been asked about the site. The browser
follows the same line (see Browser). PCP's own address is refused whatever
the line says: its public URL's site before the owner is asked, and any of
PCP's ports (`PORT`, `PCP_HTTP_PORT`, `PCP_HTTPS_PORT`) on a loopback,
unspecified or interface address as the socket connects
(`openapi/address.ts` `isOwnAddress`). A request there would hand an
assistant PCP's own pages.

**Sending it** (`fetch/fetch.ts`). Public addresses only unless the
token's private line allows more, through the checked transport of API
endpoints (`openapi/transport.ts`): the name is resolved by PCP and every
address checked as the socket connects, so a name that answers with a
public address to a check and a private one to the connection gets
nowhere. Whether private addresses are allowed is read when the request
runs, so a request the owner allows later follows the line as it is then.
No secret is read; no cookie is kept. Redirects are followed by hand, at most five and
only within the site: one to another site ends the call with where it
points, so that site gets its own decision when the assistant fetches it. A
303 (and a 301 or 302 after a POST) becomes a GET without the body, as in a
browser.

**What comes back** (`fetch/html.ts`). The bytes are decoded with the
charset the answer declares (a byte order mark, the content type, a
`<meta charset>`, then UTF-8). HTML is parsed into a document that is never
rendered (domino), stripped of scripts, styles, frames and embedded objects,
its links and images made absolute, and converted to Markdown (turndown);
`raw` skips that. JSON is pretty-printed, other text passed on as it is, and
anything else described rather than dumped. The text is handed back a part
at a time (20,000 characters by default, 50,000 at most) after a few lines
saying the final address, the status, the type, the title and where the
next part starts. An error status is an error result with the page in it.

**Bounded** (`fetch/limits.ts`). Thirty seconds per request with its
redirects, 2 MB of an answer read, a thousand method and site lines per
vault, and 120 requests per token per ten minutes, asked about or not.

The sites a token reached are on its page and in `web_fetch_rule`, in the
clear like server addresses, and never in the request log: the gateway logs
that `web_fetch` was called and not where to.

## Running code

A token made with "run code" (`api_token.run_code`, off unless the owner
turns it on) gets `run_code(code)`: a JavaScript program, the body of an
async function, that calls the token's tools and works on their answers, so
a large answer is filtered or moved without passing through the assistant.
It is the pattern of Anthropic's programmatic tool calling, which does not
reach tools behind an MCP connector, hosted by PCP. `lib/core/code/` has
three parts:

- **The executor** (`quickjs.ts`) runs the program in QuickJS compiled to
  WebAssembly (`quickjs-emscripten`), one fresh instance per run. The
  engine has the language and nothing of Node's: no `require`, `process`,
  `fetch`, timers or file system. Two host functions are put on its global
  object, and a prelude takes them off at once and wraps them as `pcp`
  (`call`, `read`, `keep`) and `console`; only strings cross, both ways, so
  the host never holds one of the program's objects. Memory is a
  `WebAssembly.Memory` made with a maximum (128 MB), which the WebAssembly
  engine enforces; QuickJS's own memory limit counts nothing in these
  builds, which lack `malloc_usable_size`, so it is not used. An interrupt
  handler stops the program past 15 seconds of its own computing (time
  spent waiting on a call does not count), when the run is aborted, and when
  the bridge says stop; none of these can be caught by the program, and
  after a stop nothing of it runs again. A reply too large for the memory
  left is an error the program sees; an allocation that fails anyway traps
  the instance, which is then dropped untouched.
- **The bridge** (`run.ts`) is everything the program can ask for, as an
  operation name and a JSON payload it checks as untrusted: `call` (a
  server, a tool, its arguments, and call_tool's `fields`, `decode` and
  `keep`), `read` (one of the token's own kept results, as text) and `keep`
  (a text kept as a result of the token's, returning its handle). A handle
  PCP wrote into an answer is made bare (`{"$result"}`) before a call, so a
  program passes on what it was handed as it is. Limits are in
  `code/limits.ts`: 3 minutes in all, 100 calls with 5 under way at once,
  50 reads and 50 keeps, 4 million characters of JSON per answer, and 4
  runs at once per process; the gateway allows a token 60 runs in ten
  minutes.
- **The caller** is the gateway's: `resolveCall` looks the tool up among
  the token's own and refuses a blocked one or a handle the token has no
  result for, as for `call_tool`. An "ask" tool leaves the same permission
  request a `call_tool` would and stops the run, which answers with what ran
  before it and the owner's link last; the owner's Allow once runs that one
  call for `check_permission`, and Always allow lets the next run make it.
  An allowed tool runs through `runCodeCall` (`permissions.ts`), the same
  upstream path as `runCall`, with the answer turned into a value by
  `answerValue` (`answers.ts`): the JSON whole rather than a preview, its
  longest texts kept as handles when it is over the limit, and files (base64
  that decodes to one, image, audio and file blocks) kept as handles on
  sight, so their bytes never enter the program. An OAuth server to connect
  or a browser site to allow stops the run the same way, with its link.

**The sandbox** (`code/sandbox.ts`, `sandbox/`, `docker-compose.sandbox.yaml`)
is a second executor behind the same bridge, for installs that run PCP in
Docker or Podman: a container with bash, `jq` and Python 3 where a program in
`bash` or `python` runs. It has no network (`network_mode: none`), a
read-only root, every capability dropped but SETUID and SETGID, an init that
reaps, and memory, CPU and process limits. PCP starts nothing and never
touches the Docker socket: when `PCP_SANDBOX_SOCKET` is set (only the compose
file sets it), it listens on a Unix socket in the `pcp-sandbox` volume, in a
directory only PCP's group (1001) reaches, and the runner in the container
(root with that group, `sandbox/runner.py`) connects, says which languages it
has, and runs one program at a time as PCP asks. The program runs as its own
user (2000, `sandbox/launcher.py`), which cannot reach PCP's socket, in a
directory of its own on a tmpfs, with rlimits; its only way to PCP is a
socket the runner makes for that program alone, where the `pcp` command and
module (`sandbox/pcp.py`) send each request, and the runner passes it to PCP
under the program's job. PCP hands it to the bridge as it would QuickJS's,
so a shell program has exactly a JavaScript program's rights; a request for
any other job is ignored. A stop from the bridge, an abort or the time limit
makes the runner kill every process of the program's user and remove every
file it owns, so nothing of one program, which may be another token's, is
left for the next. What the program prints, stdout and stderr together,
comes back with its exit status. `run_code` offers a `language` argument only
while a runner is connected, so a token on an install without the sandbox
never sees one. Its state is kept on `globalThis`, like the browser's,
because the boot code that listens and the gateway are bundled apart.

Each call is in the request log under `run_code`, by server and tool; the
program, what it printed and its errors are not logged or kept. What it
printed (up to a million characters) and what it returned come back in the
answer, and a long part is kept as a result of the token's (the returned
value as JSON, shown by its handle) rather than cut.

## Browser

The browser is a server of kind `browser`, one per vault, added by the
owner on the Browser page (`url` is the fixed `pcp:browser`). Its tools are
a fixed catalogue (`lib/core/browser/tools.ts`) written with `storeTools`
like a mail account's, and `upstream.ts` hands its calls to
`lib/core/browser/call.ts` with the calling token. So it is found, levelled,
proposed for and called like any server, and a long snapshot is kept for
`read_result` by `runCall` like any long answer.

**What runs** (`runtime.ts`). One headless Chromium per vault, driven by
`playwright-core`, started on the first page opened (by an assistant or the
owner) and closed after fifteen minutes with no tool call, no input and
nobody watching. The registry is on `globalThis`, as the network's is,
because the gateway, the actions and the route handlers are bundled apart.
Chromium runs with one in-memory context: no profile is written to disk.
Its config and cache folders (`XDG_CONFIG_HOME`, `XDG_CACHE_HOME`) are a
private temporary folder of its own, removed once it has closed: its crash
reporter keeps its database there, and without a folder it can write to
(a system user with no home, as the Docker image runs as) Chromium can abort
as it starts. It starts without `--enable-automation`, with
`--disable-blink-features=AutomationControlled`, a desktop user agent without
"Headless", the host's locale and time zone and a 1280 by 800 viewport, and
with service workers blocked (one could answer a navigation without the
network, around the gate). Chromium's own sandbox is used where the machine
gives one and dropped where it cannot (root, or an unprivileged container;
the Docker image says so with `PCP_BROWSER_SANDBOX=off`). PCP adds no
stealth beyond that: the strictest sites may still refuse a headless
Chromium.

**The sign-ins** (`profile.ts`). The context starts from the vault's
`browser_profile`: Playwright's storage state (cookies, local storage,
IndexedDB) as JSON, AES-256-GCM under the data key with
`browser_profile:<vaultId>`, at most 8 MB (past that IndexedDB is left out,
then local storage, and the page says so). It is saved while a request
holds the key: after every tool call that can change a site, after the
owner's input (every two seconds at most), when the owner hands a tab back
or answers a hand-over, when they stop watching a tab, and when they close
the browser. The idle close has no key and saves nothing, so what a page
changed on its own since the last save is lost. Counts (sites, cookies,
size) are kept in the clear for the page. An export carries the row as
ciphertext; Forget all sites closes the browser unsaved and deletes it.

**Which pages open** (the gate in `runtime.ts`). A tab's main frame loads
nothing the gate has not passed: the DevTools protocol pauses each document
request (redirects included) before it is sent. It passes when the owner
drives the tab, when the owner allowed the site for this tab, or when the
web fetch lines of the token that drives the tab give GET to that site
`allowed`; never PCP's own site. Otherwise it is answered with 204, which
leaves the tab on the page it was on, and the next answer says which site
was stopped and puts it on the token's page (a line of its own on first
sight, as web fetch does). Frames inside a page and subresources are not
gated per site. `navigate` and `tabs` decide before anything opens, with
`decideSite` (web-fetch.ts): blocked is refused; ask throws `OwnerNeeded`,
which `runCall` turns into a `browse` request offering Allow once (the site
for that tab while it is open), Always allow this site and Block this site
(the token's site line, as for web fetch) and Not now. A popup becomes a tab
of the tab that opened it. A token whose `navigate` tool is at ask is asked
once: the call's request shows the address, and when the owner allows the
call, `runCall` (told so by `executeCall`) opens the site for that tab as
Allow once would, with no `browse` request after it. Only `navigate` and
`tabs` ask about a site, and only for the address in their arguments, so
the site is always one the owner saw. A blocked site stays blocked, and a
hand-over during such a call is still asked.

**Which addresses it reaches** (`proxy.ts`). Every connection goes through
a forward proxy on 127.0.0.1 (`--proxy-server`, with loopback not
bypassed; QUIC off and WebRTC kept to the proxy, since UDP would go around
it). PCP resolves each name, checks every address, and dials the one it
checked, for pages, redirects, scripts and images alike, as web fetch's
transport does. Public addresses pass; private ones pass while an open tab
is driven by a token whose `private` line allows them (the proxy cannot tell
which tab a connection is for, so this is per browser; tabs the owner opens
follow the line for all tokens); PCP's own address never. Refusals are
remembered for half a minute so an answer can say why a page did not open.
Hosts are never logged.

**What an assistant gets.** The tools are `tabs`, `navigate`, `back`,
`snapshot`, `read_page`, `find`, `click`, `type`, `press_key`,
`select_option`, `scroll`, `wait_for`, `screenshot`, `handle_dialog` and
`hand_over`. An assistant reads a snapshot (Playwright's accessibility tree
with refs), the page as Markdown (`htmlToMarkdown`, read from the live
page), a screenshot of the viewport, and the tab's address, title and the
link to it in PCP. It acts by ref (click, type, select), by key or by
scroll. It never gets a cookie or storage, never runs JavaScript, never
downloads a file. A refusal that names a site or an address is a tool
error, not a thrown `PcpError`, whose text the request log would keep.

**The owner's control.** A tab is driven by the assistants or by the owner.
Take over on the tab's page makes it the owner's, and every browser tool
refuses it until Hand back; a tab the owner opens starts as theirs.
`hand_over` makes the tab the owner's and throws `OwnerNeeded` for a
`browser_handover` request, which shows the assistant's message and the tab
live; Done (or Not now) gives it back, saves the profile, and is what
`check_permission` reports. A hand-over nobody answers goes back when its
request expires.

**The live view** (`app/api/browser/tabs/[id]/`, `screencast.ts`,
`input.ts`, `components/browser-tab-view.tsx`). The tab's page draws
Chromium's screencast (a JPEG each time the page repaints, shared by
everyone watching) on a canvas, streamed as server-sent events by a route
handler. While the owner has the tab, their pointer (with the samples the
browser coalesced), wheel, keys and pastes go back in batches every 40 ms
to a second route, each event with the time it happened. They are replayed
through the DevTools protocol (`Input.dispatchMouseEvent` and
`dispatchKeyEvent`, which Chromium treats as a device's input: trusted
events), each at its own time plus a fixed delay and stamped with it, so a
CAPTCHA reading the movement sees its real cadence; a batch that arrives
late starts a new clock. Coordinates are mapped with the frame's own
metadata. Both routes check PCP's origin and the owner's session, as the
export download does. A WebSocket would answer a little sooner, but needs a
server of its own around Next; the input's format is the same whatever
carries it.

**Bounded** (`browser/limits.ts`). Eight tabs per vault, the owner's
included; thirty seconds per page load and ten per action; 300 tool calls
per token per ten minutes; four people watching a tab; and the owner's
input in batches of at most 500 events, 200 batches per session in ten
seconds.

**Chromium on the machine** (`executable.ts`, `install.ts`).
`PCP_BROWSER_EXECUTABLE`, then PCP's own install, then Playwright's own
variable and install location. The Docker image installs Playwright's
Chromium, the version `playwright-core` drives; the desktop app stages none.
Where none is found, the Browser page's **Install Chromium** downloads the
build `playwright-core` drives from the addresses Playwright pins for it
(read from `playwright-core/lib/coreBundle`'s registry, never from a
request), unpacks it with Playwright's own unzip into
`browsers/chromium-<revision>/` under the data folder, makes it executable
and writes Playwright's `INSTALLATION_COMPLETE` marker last, under a
temporary name until it is whole. It runs in PCP's process: Playwright's
installer downloads in a child process, and the desktop app's `runAsNode`
fuse is off, so it could not start one. The download is capped in size, in
time, and in time without a byte (`limits.ts`); one install runs at a time,
and the page follows its progress. The install is looked for by the
revision `playwright-core` drives, so after an update to a newer one the
page offers to install that, which removes the older build. Nothing runs
until the owner clicks.

## Data on disk

`PCP_DATA_DIR` (default `./data`; `/data` in Docker; in the desktop app
`data/` under the system's folder for the app: `~/Library/Application
Support/PCP` on macOS, `%APPDATA%\PCP` on Windows, `~/.config/PCP` on
Linux):

- `pcp.db` — the SQLite database, in WAL mode. Migrations are applied at boot
  by `lib/core/migrate.ts`, which keeps Prisma's own `_prisma_migrations`
  bookkeeping (same table, same checksums), so a developer's
  `prisma migrate dev` and a container's boot agree on the history.
- `logs/mcp-YYYY-MM-DD.jsonl` — one line per gateway call: which token,
  which tool, which upstream, how long, whether it worked. Never arguments
  or results.
- `tls/` — only once HTTPS is turned on: the ACME account key and, per name,
  `key.pem` and `cert.pem`. Directory mode 0700, files 0600 (see "Reaching
  PCP").
- `browsers/chromium-<revision>/` — only once the owner installs Chromium
  from the Browser page: Playwright's build of it, as Playwright lays it out
  (see "Browser"). Machine data, not the vault's: it holds nothing of the
  owner's, and an export does not carry it.

The desktop app keeps its own files beside that directory, not in it:
`desktop.json` (the port, whether other devices may connect), on a Mac with
Touch ID on and no keychain item for it `touch-id.bin` (the Touch ID key,
encrypted; see below), and the
server's stdout in the system's log folder (`~/Library/Logs/PCP` on macOS,
`logs/` under the app folder elsewhere). Everything PCP remembers is in the
database; the wrapper holds only what has to be known before the server is
up, and the key it hands PCP's page after Touch ID.

## Touch ID in the Mac app

The owner can unlock with their fingerprint in the Mac app, and confirm a
new API token, an export or a restore with it instead of typing the
password. It is a credential of its own, not a stored password: a
`device` grant (`lib/core/device-keys.ts`) whose key, `pcp_device_…`, the
app keeps and hands over only after Touch ID.

- **Turning it on takes the password**: in Settings, or with the box under
  the password on the sign-in page. PCP makes the key, the page hands it to
  the app, and the app keeps it only once Touch ID has said yes. A vault has
  at most one; a new one replaces it. If the app does not keep it, the page
  turns Touch ID off again, so no key is left that nobody holds.
- **Where the key lives**, one of two ways (`desktop/touch-id-store.mjs`
  decides; the server never reads either, and an export never carries the
  grant, `backup-format.ts` refuses one):
  - **A keychain item macOS opens only for a fingerprint**, when the app is
    signed with its keychain group. The item is in the data-protection
    keychain (`desktop/native/keychain`, a small Node-API module), made with
    `kSecAccessControlBiometryCurrentSet` and `…WhenPasscodeSetThisDeviceOnly`:
    reading it is the Touch ID check, done by macOS, so no process reads the
    key without a finger, PCP's own included. It never leaves this Mac (no
    iCloud, no backup), and adding or removing a fingerprint voids it: the
    item records the set it was made under, and the app drops it once the
    set has changed, so the page offers the password and Settings offers
    to set Touch ID up again. Saving reads the item back with the owner's
    finger before it counts.
  - **Otherwise a file**, `touch-id.bin` in the app's folder, encrypted with
    Electron's `safeStorage` (whose own key macOS keeps in the login
    keychain for this app's code) and handed over after the app's own Touch
    ID prompt (`systemPreferences.promptTouchID`). A checkout, a fork, or a
    release built without the profile works this way.
- **How a page reaches it.** The window's preload (`desktop/preload.cjs`)
  gives PCP's own pages, and only those (plain http on localhost),
  `window.pcpDesktop.touchId`: `status`, `unlock`, `save`, `forget`. The
  main process (`desktop/touch-id.mjs`) checks again that the call comes
  from the window's main frame at the app's own address and port, shows the
  system prompt with a reason of its own (never text from the page), and
  returns the key only after Touch ID. The page sends it in a form field
  (`deviceKey`) to `touchIdLoginAction` or `confirmOwner`, rate-limited like
  the password but on a budget of its own (a random key is no password
  guess, and must not spend the owner's tries), and keeps it nowhere. An OAuth provider's page in the same
  window gets no bridge.
- **What turns it off**: the Settings card, recovering with the recovery
  key, signing out everywhere, and a restore (the vault is replaced, and the
  file holds no `device` grant). A key PCP refuses is forgotten by the app
  (`TOUCH_ID_REJECTED`), and the page falls back to the password.
- **What it protects against.** Someone at the owner's unlocked Mac without
  their finger, and a copy of the app's folder (a backup): the window's
  session cookie is encrypted under the app's keychain key (the
  `enableCookieEncryption` fuse), and so is the file when the key is kept
  there. With the keychain item, also another program running as the owner:
  macOS hands the key to nobody without a fingerprint. With the file, the
  fingerprint is the app's own check, and what stops another program from
  simply asking the keychain as PCP are the fuses
  (`desktop/electron-builder.yml`): no running the app as plain Node, no
  `NODE_OPTIONS`, no inspector. The session cookie relies on those fuses
  either way.
- **Signing.** Releases carry PCP's Developer ID signature and are
  notarized, so macOS recognises each update as the same app and its
  keychain items stay readable. The keychain group takes more: a Developer
  ID provisioning profile, the `MAC_PROVISIONING_PROFILE` secret.
  `desktop/scripts/dist.mjs` checks it (`keychain-profile.mjs`: Developer
  ID, this app, its team, the keychain group, a year or more left), embeds
  it, and signs the app itself with `com.apple.application-identifier`,
  the team and `keychain-access-groups`; the helpers keep
  `entitlements.mac.plist`, since a process signed with an entitlement its
  profile does not cover is killed at launch. The app finds out which it is
  from its own signature (`SecTaskCopyValueForEntitlement`), not from the
  keychain, which answers a process without the group "not found". A build
  without the certificate (a fork, or `pnpm dist` in a checkout) is signed
  ad hoc and tied to the exact build: after a rebuild macOS asks once for
  the Mac's password before PCP may use its keychain key ("Always
  Allow").

## Export and restore

Settings offers an export of everything PCP holds, as one file, and a restore
from such a file in place of everything here; a PCP not set up yet offers the
restore on its setup page. The code is `lib/core/backup.ts` (making, opening
and writing a file) and `lib/core/backup-format.ts` (what is in one).

**The file never holds a plaintext secret.** It is the vault's rows as they
are in the database: `secret.ciphertext` stays ciphertext under the DEK, bound
to its row id, and the DEK itself travels only wrapped, in the `key_grant`
rows of kind `password`, `recovery` and `api_token`. So the password, the
recovery key and every API token work wherever the file is restored, which is
what lets a PCP move to another machine without every assistant being set up
again, and reading a secret out of the file takes what reading it off the
disk takes: one of those credentials. Session grants are not in it (a
session is one browser's), nor is the Touch ID key (one app's), nor are
OAuth authorizations in flight, the request log or the `tls/` directory.

Around the rows: gzip, then AES-256-GCM under a key derived from an **export
password** the owner chooses, with scrypt at the parameters of the password
grant. The envelope is JSON — the format's name and version, the scrypt
parameters, the ciphertext as base64 — with the format name and version as
associated data, so a relabelled envelope does not decrypt. The parameters a
file asks for are bounded before the key is derived: a file is untrusted
input, and scrypt's memory comes from them.

**What is checked before anything is written.** The envelope's version
(a newer format is refused with "update PCP"), the password (a wrong one and
a damaged file look alike to GCM, and are reported as one), the unpacked size
(a cap, against a file that unpacks to more than it should), then every row
against a strict schema naming every column of its table — a column this PCP
does not know means a newer PCP wrote the file — and the name of the last
migration applied where it was written, which this PCP must have. Then the
rows must hold together: one vault, a password grant, every foreign key
pointing at a row in the file, every row the vault's own. `backup-format.ts`
ends with a compile-time guard that fails `pnpm typecheck` when a migration
adds a column the format does not carry yet.

**A restore replaces.** One transaction wipes the vault it is aimed at, table
by table (not trusting cascades alone), and writes the file's rows in its
place, parents before children, in chunks that keep under SQLite's variable
limit; row ids and timestamps are the file's. On a PCP not set up yet the
transaction first checks that there is no vault, as `setupVault` does. The
host's settings (`ddns.config`, `tls.config` and `update.config`, in plain
text as they are in the database) are in the file and restored only when the
owner ticks the box, with this machine's network status rows dropped so
nothing stale shows (the update status stays: what GitHub said holds here
too); a restore that brings them has `reconcileNetwork` and
`reconcileUpdates` act on them at once, and
every restore has `rebuildOutdatedEndpoints` rebuild the tools of endpoints
a different PCP version built, as boot does. The owner's own session goes
with the vault; the action signs them in again when the password they typed
opens the restored vault (their own export), and otherwise sends them to sign
in with the exported PCP's password.

**Who may.** The export asks for the owner's password again (or Touch ID in
the Mac app: `confirmOwner`), as making a token does: a copied session
cookie may use the vault but not walk off with it. The restore, when signed
in, asks for it too, so a copied cookie cannot replace the owner's vault
with one it holds the password to; on the setup page there is no password
yet, and whoever reaches that page could set up instead. Both are
rate-limited like password attempts. The download is a route handler (an
action cannot send a file), so it checks the request's origin itself
(`lib/server/same-origin.ts`), which Server Actions get built in.

## Reaching PCP: dynamic DNS and HTTPS

Both are optional, off until the owner turns them on (in the step after setup
or under Settings), and meant for someone running PCP at home without a proxy
of their own. While both are off, nothing in `lib/core/network/` starts:
no timer, no listener, no outbound request.

**Host settings, not vault settings.** The configuration lives in the
`host_setting` table (`lib/core/host-settings.ts`), not in the per-vault
`setting` table. It belongs to the machine, and the work that uses it runs
from a timer with no request and no `VaultContext`. So it is **stored
unencrypted**: a dynamic DNS service's token or password has to be readable
while nobody is signed in, and reading the vault without a credential is
exactly what PCP refuses to allow. The owner is told so where they type it.
Such a credential can only move a DNS name. Nothing from the vault (a secret,
a token) is ever copied into a host setting, and the page never sends a saved
credential back to the browser. Only a signed-in owner's Server Action
(`lib/actions/network.ts`) changes them.

**One runtime per process.** `lib/core/network/runtime.ts` keeps the timers,
the listeners and the answers to Let's Encrypt's challenges on `globalThis`,
because `instrumentation.ts` (which calls `startNetwork()` at boot) and the
Server Actions (which call `reconcileNetwork()` after a save) are bundled
apart. Each reconcile reads the host settings and makes the process match.

**Dynamic DNS** (`ddns.ts`): DuckDNS, dyndns2 (No-IP, Dynu, any server),
Cloudflare (finds the zone and A record, creates the record if needed) or a
custom URL template (`{ip}`, `{hostname}`, a login in the URL is sent as Basic
auth). The public IPv4 address is looked up every five minutes from plain-text
services (`PCP_PUBLIC_IP_URL` overrides them). An update is sent when it
changed, once a day regardless, and right after a save. Failures back off
from 5 to 60 minutes. A refused login (`badauth`, `KO`, 401/403) stops
updates until the owner saves again, as dyndns2 services require. If the
lookup fails, services that see the caller's address themselves still get an
update, at most hourly.

**HTTPS** (`tls.ts`, `edge.ts`, `proxy.ts`): `acme-client` gets a Let's
Encrypt certificate (`PCP_ACME_DIRECTORY` overrides the directory) with the
HTTP-01 challenge, for a typed name or the dynamic DNS one. The key and
certificate are files under `tls/`: a server presenting a certificate needs
its key before anyone signs in. While HTTPS is on, PCP opens two listeners of
its own next to Next's:

- port 80 (`PCP_HTTP_PORT`; 8080 in the Docker image, mapped by
  `docker-compose.https.yaml`) answers `/.well-known/acme-challenge/…`. Once
  a certificate works it redirects everything else to `https://<name>`;
  before that it forwards to the app, so the site is not broken while waiting.
- port 443 (`PCP_HTTPS_PORT`, 8443 in Docker) serves the certificate.

Both forward to the app on `127.0.0.1:$PORT`, streaming (MCP's server-sent
events stay open) and passing upgrades through. They are the edge, so they
**replace** any `X-Forwarded-*` a client sent rather than trusting it.
`originFromHeaders`, the `Secure` cookie and the rate limiter's client address
then work unchanged.

A certificate is renewed once less than a third of its life is left, which
keeps working as Let's Encrypt shortens lifetimes. The check runs every 30
minutes, and the new one is swapped in with `setSecureContext`, without a
restart. When the first certificate for a name fails, PCP turns HTTPS off
again and the card says why: what went wrong is usually the router or the
name, which no retry fixes. Once a name has had a certificate, a failed
renewal is retried after 1 hour, doubling to at most a day, and the
header's bell says so on every page until it works. That keeps PCP well
inside Let's Encrypt's limits on failed validations; "Try again now" skips
the wait. A DNS lookup first warns, without blocking, when the name does not
point at this network. Port 3000 keeps serving plain
HTTP for the local network. In the desktop app the two ports stay 80 and 443
(macOS and Windows let an ordinary program use them), and they listen on
every interface even while the app keeps port 3000 to this computer: a
router's forward needs exactly that.

## Updates

PCP tells the owner when a newer release is out and how to update the PCP
they are looking at. It never updates itself in a container or a checkout.
The code is `lib/core/updates/`.

**What it asks, and of whom.** Once a day PCP asks GitHub for the
repository's latest release (`api.github.com/repos/kaperkunde/pcp/releases/latest`,
which leaves out drafts and pre-releases). The request carries an `accept`
header and a user agent naming PCP's version, nothing else: no credential, no
cookie, nothing of the vault. So GitHub learns this PCP's address and version.
The owner is told so where the check is turned off (Settings → Updates, and
the step after setup). The address is PCP's own, not one an assistant chose,
so it goes through plain `fetch` like dynamic DNS does (which works behind an
outbound proxy), with `redirect: "manual"`: at most two redirects, to the same
origin (a renamed repository answers with one). `PCP_RELEASES_URL` replaces
the address, for tests and mirrors.

**The answer is untrusted input.** It is read within limits
(`updates/limits.ts`: ten seconds, 256 KB) through a schema that keeps the tag,
the date, the notes and the names of the attached files. The tag must be
`vMAJOR.MINOR.PATCH`. The notes are cut to 4,000 characters, stripped of
characters that do not show, and shown as text, never as HTML or Markdown.
The release page the owner is sent to is built from PCP's repository address
and the version; the answer's own links are never used.

**When.** The check is on unless the owner turns it off (`update.config`, a
host setting, stored like the network ones and carried by an export). While
it is on, one timer per process (`updates/runtime.ts`, on `globalThis` as the
network runtime is) wakes every hour; a round runs only when PCP is set up
and a day has passed since the last good check, so a restart asks nothing
again, and nothing is asked before an owner exists to have been told. A
failure backs off an hour, four hours, then a day. With the check off there
is no timer and no request; **Check now** still asks, because the owner
pressed it (at most five times a minute). What a round finds is
`update.status`, a host setting that never leaves the machine. It is not in
the request log.

**What the owner sees.** Every page's header has a "v… available" link next to
the version while the last check found a later release; the layout reads it
from `update.status` on each page and nothing polls. Settings → Updates says
which version runs, what the last check found, with the release notes, and
how to update this PCP for the way it was installed
(`lib/server/install-kind.ts`): the container image sets `PCP_CONTAINER`
(run the install line again, pull with compose, or redeploy from the tool that
runs it), the desktop app sets `PCP_DESKTOP` (below), and
anything else is a checkout (`git pull` and a build). A develop build ahead
of the last release counts as up to date.

**The desktop app installs it itself,** when it can. The page cannot reach
the wrapper (no IPC), so **Install and restart** records the owner's request
in `update.status`, and `/api/health` repeats it, in the app only and for
fifteen minutes. The wrapper reads that every fifteen seconds and has
electron-updater download the release from GitHub, check it against the
update file's hashes, and restart into it; a request from before the app
started is never acted on, so a failed install cannot loop. macOS lets an
update replace only an app with the same real signature, so an ad-hoc signed
build tells the server (`PCP_DESKTOP_UPDATER=manual`) and the page links to
the download instead. `desktop/README.md` has the details.

**The Linux installer can update it once a day** (`PCP_AUTO_UPDATE=1`,
remembered like its other settings). Under Podman with Quadlet that is
Podman's own `podman-auto-update.timer`, which follows the unit's autoupdate
label; otherwise a systemd timer runs a copy of the installer with `update`,
which pulls the image and starts PCP again only when the image changed. The
installer passes `PCP_AUTO_UPDATE=1` into the container, so Settings says
there is nothing to do. PCP itself still pulls and restarts nothing.

## Connecting OAuth servers

An OAuth server needs a client ID for PCP before anyone can sign in, and
servers differ in how they hand one out. `startOAuth` (`lib/core/oauth.ts`)
discovers the authorization server and `chooseRegistration`
(`lib/core/oauth-client.ts`) picks, without knowing any provider by name:

1. **The owner's client**, when the server's settings have a client ID (and,
   optionally, a secret: one of the owner's own secrets, which the form can
   create from a pasted value). Always first.
2. **A client PCP registered earlier**, kept in the server's managed secret.
3. **Dynamic registration** (RFC 7591), when the server has a registration
   endpoint, or publishes no metadata at all.
4. **PCP's client metadata document**, when the server supports those and
   PCP's public URL is https: the client ID is
   `<public URL>/api/oauth/client-metadata`, which the authorization server
   fetches. The MCP spec ranks this above registration; PCP does not,
   because a PCP reachable only on a private network registers fine but
   cannot be fetched.
5. **Otherwise the owner is asked**: the server's status becomes
   `client_required`, and its page says to create a client with the
   provider using PCP's redirect URI and asks for its ID and secret right
   there, in the status card. A registration endpoint that refuses PCP ends
   the same way. The gateway's connect result says so too.

Every flow returns to one address, `/api/oauth/callback`; the state
parameter names the flow, and the flow the server. The owner registers that
address once per provider, before the server exists in PCP, and one client
can serve several servers. Clients PCP registered when the address was
per-server (`/api/servers/<id>/oauth/callback`) keep using it.

The owner's client is bound to the authorization server it is first used
with (the SDK's SEP-2352 check, stamped in the managed secret), so a server
that later names another authorization server never gets its secret.

Some providers only issue a refresh token when the sign-in asks for it. The
server's **extra sign-in parameters** (`oauth_authorize_params`) are added
to the sign-in address; the names the flow sets itself (client, redirect,
state, PKCE, scope, resource) are refused when saved and skipped when used.
For providers whose needs PCP knows (`SIGN_IN_DEFAULTS` in
`oauth-client.ts`: Google's `access_type=offline&prompt=consent`), it adds
them itself after the owner's, so the owner's value for a name wins. When a
connection came without a refresh token, the server's page says until when
it lasts and offers the fix: Reconnect when PCP would now ask for renewable
access, otherwise the parameters field and Save and reconnect.

A server that answers a signed-in request with 401 or 403 gets the status
`refused` ("Access refused"), with the HTTP status and the reason from its
`WWW-Authenticate` challenge or error object, never its body: Google sends
the whole answer with its refusals.

An API endpoint takes the same steps with its sign-in fixed to the addresses
the owner approved: the authorization server's metadata is read for what the
schema cannot say, and used only when it names those addresses (see Signing
in with OAuth under API endpoints).

Only the owner's browser registers or signs in. A tool refresh or a gateway
call on a server that is not connected stops at "needs connecting" without
contacting the registration endpoint, and a proposal from an assistant
contacts nothing at that address but the JMAP look above.

## The gateway's tools

An MCP client that connects to `/mcp` receives an `instructions` string
listing the servers its token can reach, each with the owner's one-line
description and the number of tools it may see, and these tools (two more
for a token with the right to manage endpoints, `memory` for a token that
keeps memories, `web_fetch` for a token that fetches web pages, and
`run_code` for a token that runs code, all above). A request without a valid
token is answered 401, and a token makes at most 240 requests a minute, one
message each (`app/mcp/route.ts`). The tools:

- `search_tools(query, server?, limit?)` ranks the catalogue
  (`lib/core/search.ts`: name, title, description and server words, with
  light stemming) and returns `server/tool — summary` lines.
- `list_tools(server, offset?)` names every tool the token sees on one
  server, by name, with its level (`allowed` or `ask`) and a summary,
  `LIST_PAGE_SIZE` at a time (`listTools` in `lib/core/search.ts`), so an
  access review does not depend on what a search happens to rank.
- `describe_tool(server, tool)` returns the description (the owner's
  override when there is one), the JSON Schema exactly as the upstream
  published it, whether the tool runs at once or asks first, and for an API
  endpoint's tool, `returns`: an outline of its success answer read from the
  schema (`openapi/outline.ts`, stored as `mcp_tool.output`); text the
  schema marks base64 (`format: byte`) shows as `string (base64)`.
- `call_tool(server, tool, arguments, fields?, decode?, keep?)` opens a connection
  to the upstream with the configured credential (header secret or OAuth
  token, refreshed by the SDK when needed), calls the tool, and passes the
  content back shaped for the assistant (`lib/core/answers.ts`): `fields`
  keeps only the named paths of a JSON answer (lists are looked into),
  `decode` turns base64 or base64url text back into text wherever the
  answer's keys end with one of its paths (`body.data` is every part of a
  Gmail message; what is not text stays encoded), a JSON answer still too
  long becomes a preview that is valid JSON with a note on asking for less,
  and structured content that repeats the text is dropped. Large values
  become handles (below). A call that waits for the owner keeps its fields,
  decode and keep paths on the request (`permission_request.fields`,
  `permission_request.decode`, `permission_request.keep`).
- `check_permission(id)`, `check_server(server)`, `register_server(...)`
  and `propose_tool_access(changes)` belong to the permission flow below.
- `read_result(id, offset?, length?, find?)` reads a slice of an answer
  PCP shortened and kept whole, or of a kept value; a file that is not text
  is described, not shown (below).

The catalogue (`mcp_tool`) is read from each server when it is added, when
the owner refreshes it, after an OAuth connection, and lazily when the
gateway finds a server with no tools. It is a cache of the upstream's
`tools/list`; the owner's description overrides survive a refresh.

### Long answers and kept results

`runCall` (`lib/core/permissions.ts`) shapes an upstream's answer for the
assistant with `shapeAnswerKeeping` (the shaping above, and the handles
below). When that left something out (a JSON preview, a text cut at 60,000
characters), the answer shaped the same way but not cut is handed to
`lib/core/tool-results.ts`: up to 4 million characters are kept in
`tool_result`, encrypted under the vault's data key with `tool_result:<id>`
as associated data, for a day, and a notice after the shortened answer gives
the result's id and length. `read_result` decrypts it and returns one slice,
for the token whose call produced it only; another token's, another vault's
or an expired id reads as not found. A token keeps at most 300 results and
50 million characters and bytes together, its oldest going first, and
expired ones are pruned at boot. A permission request's stored outcome keeps
the notice when its text is shortened, so `check_permission` names the
result too. Mail bodies and attachments use the same store from inside the
mail tools. Kept results are not part of an export, and nothing kept is
logged.

A kept result is a text or a file's bytes (`tool_result.kind`, with `name`
and any media type), encrypted the same way. A file over 10 MiB is refused
rather than cut.

**Handles** move a kept value between tools without the assistant reading it.
`shapeAnswerKeeping` (`lib/core/answers.ts`) makes them while it shapes an
answer, once, so the shown answer and the whole kept one carry the same ids:
the parts `keep` names; base64 that decodes to a file, recognised by its
first bytes or by looking like standard base64; and, when the answer is
still too long, its longest texts, longest first, up to 20. Image, audio and
embedded file blocks are kept too, and one too large to pass on is replaced
by its handle. At most 50 per answer; a note at the top names each. A handle
is `{"$result": id, type, size or length, name?, preview?, readableUntil}`.
Each answer also carries a `resource_link` per handle (`pcp://results/<id>`),
the mail tools' own included; the gateway's resource template of that name
gives the text or the file's bytes to the token that kept it, and lists
none.

In arguments, an object of only `$result` (and `as`) is replaced before the
call is sent (`lib/core/result-handles.ts`, called from `upstream.ts` for MCP
servers and the browser, from `endpoints.ts` for API endpoints, whose upload
fields take a file's bytes instead, and from `mail/accounts.ts`, whose
attachments do too): a text as its text, a file as base64, or the other way
with `as`. Only the token's own results resolve; an unknown or expired id is
refused by name before anything is sent, and the gateway checks the ids
before it asks the owner. A request
waiting for the owner stores the handle, never the content, and its page
shows each one's name, type, size and the tool that kept it.

## Tool access and the owner's permission

Every token has a level per tool (`api_token_tool_access`,
`lib/core/tool-access.ts`): **allowed**, **blocked**, or, when there is no
row, **ask**. Rows are keyed by the tool's name, so a tool that drops out of
a refresh and comes back keeps its level. Blocked tools are left out of the
instructions, `search_tools`, `list_tools` and `describe_tool`, and
`call_tool` and `run_code` refuse them. The gateway loads the levels by
token id.

A tool can also have a level for **all tokens** (`vault_tool_access`, the
"All tokens" box on a token's page), and a token's own level wins over it:
the specific line beats the general one. So a token's own `ask` is stored
while there is a level for all tokens for it to override, and is the absence
of a row otherwise. Ticking the box makes the level that applies to that
token now the one for all tokens and removes the token's own; unticking
removes the one for all tokens and leaves the token its level as its own, so
nothing changes for it. The owner's answers to a request ("Always allow",
"Block") write the asking token's own level, as before. The web fetch levels
(above) work the same way.

A call to an "ask" tool becomes a `permission_request` row
(`lib/core/permissions.ts`): the
arguments encrypted under the vault's key with the row id as associated
data, a hash of the call so the same call asked twice finds the same row,
and a day to answer. The result is text for the assistant: what was asked,
the link to `/permissions/<id>` to end its reply with, and to call
`check_permission` once the owner says they have answered. The signed-in
owner answers on that page, and only there (the header's bell lists every
request still waiting, `listPendingRequests`, and links to each); `decidePermission()` claims the row (pending to running, one winner)
and runs the call once. "Always allow" and "Block" also write the tool's
level.

Nothing can wake an assistant from outside its conversation: an MCP server
cannot start a turn, and an answer on PCP's page reaches no app. The link
has to be the last thing in the assistant's reply, with no tool call after
it: Claude's apps fold the text an assistant writes before a tool call into
that call's row and show a summary of their own, so a link followed by
`check_permission` in the same reply was often never seen. So the result
says to end the reply with the link (`connect.ts: linkLastText`, the link on
its own last line) and to call `check_permission` once the owner says they
have answered. In case they are still on it, the check holds the call while
the request is open (`lib/core/owner-wait.ts`: up to 45 seconds, under the
minute at which clients and proxies give up, checking every second, and
dropping out when the client goes away) and answers as soon as they have.
An OAuth server that needs signing in (a call to it, or one the owner just
agreed to add) answers with a link to its page in PCP, handed over the same
way, where Connect starts the sign-in; `check_server` then says whether it
is connected, waiting the same way, and its tools are read. A server that needs a client from the owner first (status
`client_required`) gets the same link; its page says what to create.

The client's own prompts (form and URL elicitation, with `input_required`
rounds) and an MCP Apps panel in the conversation were tried and dropped.
Claude's apps declared both kinds of prompt and left them on "Loading…"
until the call timed out
([anthropics/claude-ai-mcp#1085](https://github.com/anthropics/claude-ai-mcp/issues/1085)).
They mounted a declared panel for every result of a tool, rebuilt it from
the original result whenever the conversation was shown again (the first
question again, after it was answered), did not let a rebuilt panel reach
PCP, and did not act on `ui/message` or `request-teardown`. A link at the
end of a reply works in every client.

`propose_tool_access` lets an assistant suggest levels for its own token,
many at once (`lib/core/access-requests.ts`): each change names a server,
tool names or `*` patterns (none for the whole server) and a level, later
changes winning, so a catalogue of hundreds of tools can be set in a call.
Blocked tools stay hidden: no name or pattern reaches them. The proposal is
a request of kind `access` holding one level per tool that would change;
the assistant is told those tools by name, by server and level
(`listAccessLevels`, up to `MAX_LISTED_TOOLS`), to check its patterns. Its
page fills the levels in over the token's current ones and marks each
change; the owner can change any of them, and only their save there writes
anything (`applyAccessRequest`, once). The kind's only decision is "Not
now", and `decidePermission` refuses any other, so an assistant cannot raise
its own access. `check_permission` waits for the save as for any answer and
says what was saved, and how it differs from what was proposed.

`register_server` takes a secret's name, never its value, and always asks:
otherwise an assistant could point a stored secret at an address it chose.
Once the owner agrees, PCP adds the server (or the mail account: `executeRegister`
has a branch for each of the three kinds), adds it to the asking token when
that token is scoped to chosen servers, and reads its tools, or hands back
the link to connect it for OAuth. With `openapi_schema` or `openapi_url` the
request is an API endpoint instead: the gateway has
`endpoint-admin.ts: prepareRegistration` read the document before asking (so the owner is only asked about something that
works, and sees its address, tool count and operations), and
`executeRegister` creates it from the same text with
`createApprovedEndpoint`: on, public addresses only. Requests are deleted at
boot a week after they expire.
