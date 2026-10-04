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
components/          React components; forms call Server Actions
lib/actions/         Server Actions: read the session, call lib/core, return a state
lib/server/          Next-specific glue: cookies, request headers, public URL
lib/core/            The domain. No Next.js, no React (ESLint enforces it)
  openapi/           OpenAPI schema → tools and call plans; building and sending the request
  mail/              Mail accounts: JMAP and IMAP/SMTP behind one set of mail tools
  network/           Optional dynamic DNS and HTTPS: timers, Let's Encrypt, the edge listeners
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
- the PKCE verifier of an authorization in flight (`oauth_state`).
- a memory's path and text (`memory.ciphertext`, as one JSON value).
- a tool answer kept for `read_result` (`tool_result.ciphertext`).

The DEK itself is stored only **wrapped** — AES-256-GCM under a **key
encryption key (KEK)** — once per credential, in `key_grant`:

| Grant kind  | Credential                    | KEK derivation                            | Found by                  |
| ----------- | ----------------------------- | ----------------------------------------- | ------------------------- |
| `password`  | the owner's password          | scrypt (N=2^16, r=8, p=1, per-grant salt) | the vault (one per vault) |
| `recovery`  | `pcp_recovery_…`, shown once  | HKDF-SHA256 with a per-grant salt         | SHA-256 of the credential |
| `session`   | a random secret in the cookie | HKDF-SHA256                               | SHA-256 of the secret     |
| `api_token` | `pcp_…`, shown once           | HKDF-SHA256                               | SHA-256 of the token      |

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
  grant and, when asked, blanks every API token grant. **Signing out
  everywhere** can blank them too.
- **A session cannot outlast itself.** Making an API token or a recovery key
  asks for the password again (`lib/server/password-attempts.ts`). A session
  cookie can be copied, so it may use the DEK but not mint a grant that
  survives the session.
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
  the owner sees (file uploads, cookies, a reference into another document).
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
so do Google's sign-in defaults and the renewal notice. Token requests go
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

**Registering** is `register_server`, the same tool that adds MCP servers,
with an OpenAPI document as text in `openapi_schema` or by its
address in `openapi_url` (plus `spec_patches` to edit it, `url` for the base
URL, `read_only`, and a secret named by NAME, or `auth_type` oauth for a
document that declares a sign-in, with the owner's `client_id`). It is an assistant's request,
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
null; a call is dispatched by name. Only the owner adds or changes an
account; `register_server` and the endpoint tools do not touch them.

`upstream.ts` builds the credential and hands it to `mail/accounts.ts` as a
`MailCredential`: the `Authorization` header for JMAP, the login for IMAP and
SMTP, and the values to remove from every answer. Nothing under `mail/` reads
a secret. Authentication is `basic` (a user name, in `auth_username`, and a
secret: Basic for JMAP, LOGIN for IMAP and SMTP), `header` (a bearer token,
JMAP only) or `oauth` (JMAP only).

**JMAP** (`mail/jmap.ts`): `url` is the session URL the owner typed. Reading
the account GETs it with the credential, and the API and download addresses
it names are accepted only on that URL's origin, so the credential goes
nowhere the owner did not type; they are kept (`mail_api_url`,
`mail_download_url`, `mail_account_id`, `mail_submission`) and forgotten when
the address or sign-in changes. Redirects are never followed: PCP names
where the server pointed, for the owner to enter instead. A call is one or
two POSTs of method calls. Sending creates the email in Drafts and submits
it in the same request, moving it to Sent when it went.

**IMAP** (`mail/imap.ts`, on imapflow and nodemailer): `url` is
`imaps://host:port`, or `imap://` for STARTTLS; `smtp_url` the same for
SMTP. A connection that is not encrypted after it is made is dropped, and
STARTTLS is required, never optional. Each call connects, signs in, works
and logs out. An email's id is `<uid>.<uidvalidity>.<mailbox path>`, so an id
from before a mailbox was rebuilt is refused rather than naming another
email. Sending goes over SMTP and a copy (Bcc kept) is appended to Sent.

**What an assistant gets back** is JSON PCP writes: addresses, dates, flags,
the text of a body (the HTML one made plain when there is no text one) and
the list of attachments; `get_attachment` reads text attachments and
refuses the rest without downloading them. A body or attachment longer than
20,000 characters is kept for `read_result` (below). Delete moves to the
Trash and nothing deletes for good. Failures: refused credentials mark the
account `auth_required` (with OAuth, "needs connecting"), an unreachable
server `error`; a request the server refuses (no such email or mailbox) is
an error answer and leaves the account as it is.

**OAuth** uses the same Connect flow as an MCP server (below), discovering
from the session URL. PCP makes a mail account's calls itself rather than
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

**Sending it** (`fetch/fetch.ts`). Public addresses only, always, through the
checked transport of API endpoints (`openapi/transport.ts`): the name is
resolved by PCP and every address checked as the socket connects. No secret
is read; no cookie is kept. Redirects are followed by hand, at most five and
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

The desktop app keeps its own two files beside that directory, not in it:
`desktop.json` (the port, whether other devices may connect) and the
server's stdout in the system's log folder (`~/Library/Logs/PCP` on macOS,
`logs/` under the app folder elsewhere). Everything PCP remembers is in the
database; the wrapper holds only what has to be known before the server is
up.

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
session is one browser's), nor are OAuth authorizations in flight, the
request log or the `tls/` directory.

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
host's network settings (`ddns.config`, `tls.config`, in plain text as they
are in the database) are in the file and restored only when the owner ticks
the box, with this machine's status rows dropped so nothing stale shows; a
restore that brings them has `reconcileNetwork` act on them at once, and
every restore has `rebuildOutdatedEndpoints` rebuild the tools of endpoints
a different PCP version built, as boot does. The owner's own session goes
with the vault; the action signs them in again when the password they typed
opens the restored vault (their own export), and otherwise sends them to sign
in with the exported PCP's password.

**Who may.** The export asks for the owner's password again, as making a
token does: a copied session cookie may use the vault but not walk off with
it. The restore, when signed in, asks for it too, so a copied cookie cannot
replace the owner's vault with one it holds the password to; on the setup
page there is no password yet, and whoever reaches that page could set up
instead. Both are rate-limited like password attempts. The download is a
route handler (an action cannot send a file), so it checks the request's
origin itself (`lib/server/same-origin.ts`), which Server Actions get built
in.

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
restart. A failed request is retried after 1 hour, doubling to at most a day.
That keeps PCP well inside Let's Encrypt's limits on failed validations;
"Try again now" skips the wait. A DNS lookup first warns, without blocking,
when the name does not point at this network. Port 3000 keeps serving plain
HTTP for the local network. In the desktop app the two ports stay 80 and 443
(macOS and Windows let an ordinary program use them), and they listen on
every interface even while the app keeps port 3000 to this computer: a
router's forward needs exactly that.

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

Only the owner's browser registers or signs in. A tool refresh or a gateway
call on a server that is not connected stops at "needs connecting" without
contacting the registration endpoint.

## The gateway's tools

An MCP client that connects to `/mcp` receives an `instructions` string
listing the servers its token can reach, each with the owner's one-line
description and the number of tools it may see, and these tools (two more
for a token with the right to manage endpoints, `memory` for a token that
keeps memories, and `web_fetch` for a token that fetches web pages, all
above):

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
- `call_tool(server, tool, arguments, fields?, decode?)` opens a connection
  to the upstream with the configured credential (header secret or OAuth
  token, refreshed by the SDK when needed), calls the tool, and passes the
  content back shaped for the assistant (`lib/core/answers.ts`): `fields`
  keeps only the named paths of a JSON answer (lists are looked into),
  `decode` turns base64 or base64url text back into text wherever the
  answer's keys end with one of its paths (`body.data` is every part of a
  Gmail message; what is not text stays encoded), a JSON answer still too
  long becomes a preview that is valid JSON with a note on asking for less,
  and structured content that repeats the text is dropped. A call that waits
  for the owner keeps its fields and decode paths on the request
  (`permission_request.fields`, `permission_request.decode`).
- `check_permission(id)`, `check_server(server)`, `register_server(...)`
  and `propose_tool_access(changes)` belong to the permission flow below.
- `read_result(id, offset?, length?, find?)` reads a slice of an answer
  PCP shortened and kept whole (below).

The catalogue (`mcp_tool`) is read from each server when it is added, when
the owner refreshes it, after an OAuth connection, and lazily when the
gateway finds a server with no tools. It is a cache of the upstream's
`tools/list`; the owner's description overrides survive a refresh.

### Long answers

`runCall` (`lib/core/permissions.ts`) shapes an upstream's answer for the
assistant with `shapeAnswer` (above). When that left something out (a JSON
preview, a text cut at 60,000 characters), the answer shaped the same way but
not cut is handed to `lib/core/tool-results.ts`: up to 4 million characters
are kept in `tool_result`, encrypted under the vault's data key with
`tool_result:<id>` as associated data, for a day, and a notice after the
shortened answer gives the result's id and length. `read_result` decrypts it
and returns one slice, for the token whose call produced it only; another
token's, another vault's or an expired id reads as not found. A token keeps
at most 100 results and 50 million characters, its oldest going first, and
expired ones are pruned at boot. A permission request's stored outcome keeps
the notice when its text is shortened, so `check_permission` names the result
too. Mail bodies and text attachments use the same store from inside the mail
tools. Kept results are not part of an export, and nothing kept is logged.

## Tool access and the owner's permission

Every token has a level per tool (`api_token_tool_access`,
`lib/core/tool-access.ts`): **allowed**, **blocked**, or, when there is no
row, **ask**. Rows are keyed by the tool's name, so a tool that drops out of
a refresh and comes back keeps its level. Blocked tools are left out of the
instructions, `search_tools` and `describe_tool`, and `call_tool` refuses
them. The gateway loads the levels by token id.

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
Once the owner agrees, PCP adds the server, adds it to the asking token when
that token is scoped to chosen servers, and reads its tools, or hands back
the link to connect it for OAuth. With `openapi_schema` or `openapi_url` the
request is an API endpoint instead: the gateway has
`endpoint-admin.ts: prepareRegistration` read the document before asking (so the owner is only asked about something that
works, and sees its address, tool count and operations), and
`executeRegister` creates it from the same text with
`createApprovedEndpoint`: on, public addresses only. Requests are deleted at
boot a week after they expire.
