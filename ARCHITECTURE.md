# Architecture

PCP is a Next.js application with a framework-free core. This document covers
the three things that shape it: how data is encrypted, how a request finds
the vault it works on, and what keeps the core usable under a different host
without changing the single-user product.

## Layers

```
app/                 Routes and pages (Next.js App Router)
  mcp/route.ts       The gateway endpoint
  oauth/…            PCP's own authorization server: sign-in page, token, register, revoke
  .well-known/…      Its discovery documents (protected resource, authorization server)
  api/oauth/…        OAuth callback and PCP's client metadata document
  api/servers/…      OAuth start (and the per-server callback older clients use)
  api/export/…       The export download (a file needs Content-Disposition)
  api/files/…        File links: an assistant's own computer downloads or sends one file
  api/health/…       The health check; in the desktop app, the version and an install request
  api/browser/…      A browser tab's live view: its pictures out, the owner's input in
components/          React components; forms call Server Actions
lib/actions/         Server Actions: read the session, call lib/core, return a state
lib/server/          Next-specific glue: cookies, request headers, public URL
lib/core/            The domain. No Next.js, no React (ESLint enforces it)
  openapi/           OpenAPI schema → tools and call plans; building and sending the request
  mail/              Mail accounts: JMAP and IMAP/SMTP behind one set of mail tools
  caldav/            Calendar accounts: calendars and reminders over CalDAV
  fetch/             web_fetch: the request, the page, which level applies
  code/              run_code: QuickJS, the bridge to the tools, the sandbox's socket
  browser/           The headless Chromium: runtime and gate, proxy, profile, tools, install
  network/           Optional dynamic DNS and HTTPS: timers, Let's Encrypt, the edge listeners
  updates/           The daily check for a newer release, and what it found
  oauth-server/      PCP's own OAuth server, for assistants that sign in to /mcp
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
- the private key PCP makes for each SSH server (a `secret` row of kind
  `ssh_key`, owned by the server),
- the browser's sign-ins (`browser_profile`, bound to the vault's id, as
  there is one per vault),
- the owner's note on a server or a skill (`mcp_server.personal_note`,
  `skill.personal_note` with `skill:<id>:note`).

The DEK itself is stored only **wrapped** — AES-256-GCM under a **key
encryption key (KEK)** — once per credential, in `key_grant`:

| Grant kind  | Credential                                                  | KEK derivation                            | Found by                  |
| ----------- | ----------------------------------------------------------- | ----------------------------------------- | ------------------------- |
| `password`  | the owner's password                                        | scrypt (N=2^16, r=8, p=1, per-grant salt) | the vault (one per vault) |
| `recovery`  | `pcp_recovery_…`, shown once                                | HKDF-SHA256 with a per-grant salt         | SHA-256 of the credential |
| `session`   | a random secret in the cookie                               | HKDF-SHA256                               | SHA-256 of the secret     |
| `api_token` | `pcp_…`, shown once                                         | HKDF-SHA256                               | SHA-256 of the token      |
| `device`    | `pcp_device_…`, the Mac app's                               | HKDF-SHA256                               | SHA-256 of the key        |
| `oauth_*`   | `pcp_code_…`, `pcp_at_…`, `pcp_rt_…`: an app that signed in | HKDF-SHA256                               | SHA-256 of the value      |

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
- **Revoking an API token** blanks its grant, and deletes the grants of
  whatever an app that signed in for it holds; **signing out** deletes the
  session's; **recovery** replaces the password grant, then signs out
  everywhere. **Signing out everywhere** (`signOutEverywhere`) deletes every
  session grant and the Touch ID key (`device`), forgets the pinned public
  URL, and, when asked, blanks every API token grant. The public URL is no
  grant, but it decides where permission links and PCP's OAuth metadata
  point, so one a stolen session pinned must not outlive it; pinning or
  clearing it takes `confirmOwner` too.
- **A session cannot outlast itself.** Making an API token or a recovery key
  asks for the password again (`lib/server/password-attempts.ts`). A session
  cookie can be copied, so it may use the DEK but not mint a grant that
  survives the session. An expired token keeps its grant, so giving it a new
  expiry (or none) is the same as making one (`revivesToken`). In the Mac app
  the Touch ID key stands in for the password before a new API token (an
  app's sign-in included, or a new expiry for an expired one), a new public
  URL, an export or a restore (`confirmOwner`),
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
- **MCP client:** the bearer token → `resolveApiToken()` (an API token) or
  `resolveAccessToken()` (an app that signed in, `lib/core/oauth-server/`)
  → `VaultContext` plus the servers the token may reach (`app/mcp/route.ts`).

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
3. **Keep the gateway.** `/mcp` already serves any vault an API token, or an
   access token from PCP's own authorization server, names. A host with an
   authorization server of its own replaces `resolveAccessToken()` with its
   own resolver returning the same `ResolvedToken` shape (vault, key,
   allowed servers).
4. **Move the database.** Prisma's schema is provider-neutral apart from the
   `datasource` block; a Postgres host generates its own migration history
   (`prisma migrate dev` against Postgres) and runs migrations as a deploy
   step instead of at boot (`instrumentation.ts` → `applyMigrations()` is
   for a single instance). Rate limits (`lib/core/rate-limit.ts`) and
   pacing's state (`lib/core/pacing/pace.ts`) are per-process and would
   move to a shared store.
5. **None of it lives in this repository.** No admin API, no "create vault"
   endpoint, no tenant switch in the UI: PCP stays single-user.

## API endpoints

An API with an OpenAPI schema is added like a server and reached the same way.
It is an `mcp_server` row with `kind = "openapi"`; its `url` is the API's base
URL, and each operation in the schema is an `mcp_tool` row. Because it is a
server row, token scoping, `search`, `describe`, description
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

Private addresses are allowed, as they are for MCP servers the owner adds:
only the owner sets a schema URL or base URL, and a self-hosted PCP often
talks to services on its own network. What an assistant proposes, an
endpoint or an MCP server, is public-only (below) until the owner allows
private addresses on its page. A multi-tenant host must add an address policy
before it lets anyone else set one: resolve the name, refuse loopback,
private, link-local and metadata ranges, and connect to the address it
checked.

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
endpoint, on, and adds it to the token's scope. With `definition` it is
another server of a definition the token sees, whose schema it takes
(Definitions and instances, below); `note` proposes the owner's note on
what it adds.

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
  `search`, the gateway's instructions and `describe`, so it is the
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
- **Secret names, never values.** The same option adds `list_secrets`: the
  vault's secrets by name, with their descriptions, their kind and what uses
  each (a server through its secret, a further header, its OAuth client or
  its tokens, and a wrapper whose definition has a place for it:
  `lib/core/secret-uses.ts`), so an assistant proposing an endpoint names a
  secret the owner already has instead of inventing one they would type in
  again. It reads no ciphertext and no dates, and a query and a cap bound
  it. Only a text secret is reused by its name; the name of an OAuth sign-in
  or an SSH key in `register_server` still means a new secret. When a
  registration reuses one, the owner's page says what already uses it, and
  so does the assistant's answer for a token with this option; for any other
  token that line is the owner's alone.
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

## Definitions and instances

The same server can be in a vault more than once: one Coolify API on two
hosts, with two keys. What makes it that API is shared; where it is and how
PCP signs in there is not. So every MCP server, API endpoint and wrapper is
an **instance** of a **definition** (`server_definition`, `lib/core/
definitions.ts`), alone at first.

- **Definition:** what the server is, as it could be shared, without an
  address, a secret or anything of the owner's: its own slug and name, the
  description, an endpoint's schema, its edits and where it is read from, a
  wrapper's programs, the tools' descriptions in the owner's words, and a
  `format_version` (1 until a change to the shape is not backward
  compatible).
- **Instance:** an `mcp_server` row with `definition_id`: its name and
  short name (what assistants call it), its address, its credential and
  secrets, its levels, whether it is on, its pace, read-only and
  public-only, and the owner's note.

**Where the shared content lives.** Each instance keeps a copy of what its
definition holds, where it was before definitions existed: the description
on its row, the schema and edits in its `openapi_spec`, a wrapper's program
in its `wrapper_spec`, tool descriptions on its `mcp_tool` rows. So every
reader (the gateway, the catalogue, calls, linked repositories, the export)
reads one row as it always did, and no data moved in the migration, which
only added the table and two columns and gave every existing server a
definition of its own (with the server's id). The definition row is the
identity and the description's authority. The cost is that every writer of
shared content must reach all instances, and they all go through
`definition-rows.ts` or the code that calls it:

- `endpoints.ts applySpec` (every way an endpoint's schema or edits are
  written: the owner's form, `changeEndpoint`, a re-read, a repository's
  change) gives the other instances the schema, the edits and where they
  are read from (`shareSpec`), and each rebuilds its tools with its own
  read-only setting and credential headers (`rebuildFromCopy`); then
  `shareDescription`.
- `servers.ts updateServer`, `changeEndpoint` and `wrappers/admin.ts
writeWrapper` share the description; a wrapper's program goes to the
  others' `wrapper_spec` and their tools are rebuilt.
- `servers.ts setToolDescription` (the owner's, an assistant's approved
  change, a repository's) writes the tool's description on every instance
  that has the tool, and `catalogue.ts storeTools` starts a tool new to an
  instance with the description the others have for it.
- A server made on a definition (`createServer`, `createEndpoint` with
  `definitionId`) takes the definition's description and, for an endpoint,
  the schema, edits and schema address another instance holds, never the
  ones it was given. Any other new server gets a definition of its own
  (`ensureDefinition`), as does a row that has none (an older export's).
- Deleting the last instance deletes its definition.

Mail and calendar accounts, SSH servers and the browser have no definition:
nothing of theirs is the same thing elsewhere but their address. Skills
have one implicit instance: the skill itself, which carries the owner's
note too.

**Clone** (the owner's alone, from an item's About card) makes another
instance of an MCP server or an endpoint: it asks for the name, the address,
how it signs in there (the source's way, with a secret of its own; a secret
goes only to the address typed on that page) and the note, and copies the
source's levels, for each token and for all tokens. A token limited to some
servers reaches it only once the owner adds it, as any new server. **Detach**
gives an instance a definition of its own with what it has now; there are
no per-instance overrides of shared content, so detaching is how one
instance differs. Editing shared content of a server with siblings says
first which servers it changes ("This changes 2 servers: gaaf, plekde") and
points at Detach.

**Merging.** Endpoints added before definitions (or separately since) are
offered as one: `findIdenticalDefinitions` groups endpoint definitions whose
schema hash, edits and tool descriptions are the same (only a schema hash
seen twice is looked at closer, as the bell reads this on every page), and
the bell says "Two API endpoints have the same schema: merge them?". The
merge page shows each definition and its servers; the owner picks the one
kept and its name, and `mergeDefinitions` makes the others' servers its
instances (they take its description and schema address; addresses,
credentials, levels and notes stay) only while the group is still what the
page showed (its key). "Keep them apart" stores the group's key in a
setting and the offer goes away.

**An assistant's endpoint.** Text and edits on an endpoint reach every
assistant, so `endpoint-admin.ts` counts an endpoint as the assistant's only
while it and every other instance of its definition send no secret and are
limited to public addresses: one shared with an endpoint of the owner's is
the owner's, and a change to what they share is an `endpoint_change`
request that names every server it changes. A change to the shared content
of an assistant's own endpoints, made switched off, switches every instance
off.

**What an assistant may propose.** Merging stays the owner's alone. The rest
an assistant may ask for, each a permission request (by link, with
`check_permission`) that writes nothing until the owner agrees and then only
what they were shown:

- **Another server of a definition** (Clone): `register_server` with
  `definition` (an MCP server or an endpoint) and `create_wrapper` with
  `definition` (a wrapper), naming a server the token sees by its short name
  (or its definition's). The request brings only the instance's own part (a
  name; for a server its address, sign-in and read-only switch, under the
  usual register rules: public addresses only, a secret by name typed in by
  the owner); the description, schema, edits, a wrapper's program and the
  tool descriptions are the definition's, and the register rules refuse
  them alongside it. The owner sees which definition and its servers, the
  tools as the definition's schema makes them (a wrapper's programs in
  full) and the note. Nothing is copied onto the request but a fingerprint
  of the definition (`definitions.ts definitionBasis`: description, schema
  hash and edits, wrapper program, tool descriptions); the server is made on
  the definition (`createEndpoint`/`createServer` with `definitionId`, the
  wrapper's row pointed at it) only while that fingerprint holds. Unlike the
  owner's Clone, no levels are copied: its tools ask first, as any new
  server's.
- **Detach**: `detach: true` on `update_endpoint` (an endpoint or an MCP
  server the token sees) or `update_wrapper`, in a call of its own, as an
  `endpoint_change` or `wrapper_change` request (action `detach`) that says
  which servers it shares with and that nothing else changes; approved, it
  is `detachServer`, only while the server and its definition are as asked.
- **The owner's note**: `note` on `update_endpoint` (an endpoint or an MCP
  server; nothing else of an MCP server is an assistant's to change) or
  `update_wrapper`, in a call of its own, `note` on `register_server` and
  `create_wrapper` for a new server, and for a skill the memory tool's
  `/skills/<name>/.note` (create proposes one, delete proposes taking it
  away; no file of a skill can have that name, and it is never in SKILL.md).
  A change is a `note_change` request (`personal-notes.ts proposeNote`) that
  shows the note before and after, whole, checked as the owner's own is; it
  is written only over the note the owner had when asked.

**The owner's note** (`personal-notes.ts`) is one line of at most 300
characters, nothing in it that does not show on screen, encrypted under the
DEK with `mcp_server:<id>` (a server) or `skill:<id>:note` (a skill) as
associated data, and written only from the owner's pages or, as an
assistant proposed it, once the owner read it whole and agreed. It is never in a
repository document or anything else shared, and not part of a skill's
SKILL.md. Assistants that see the server or skill read it as the owner's
note, after the description: the instructions' server and skill lines
(`… (N tools) Owner's note: …`, cut to 120 characters), a line per server
or skill under `search` and `search_tools` results (it counts toward
finding the server, too), the head of `list_tools`, `describe`
(`ownerNote`, beside `serverName` and `serverDescription`; a skill's under
its frame) and `check_server`. The owner wrote it, so it may stand in the
instructions as the descriptions do.

**About card** (`item-about.ts`, `components/item-about.tsx`): every item's
page (a server of any kind, a skill) says its type and definition, its
source (Local, `owner/repo/path`, or "Imported from owner/repo@commit",
with View in repo), its sync (Local only, Synced, Pending review, Modified
locally, Update available or Sync error, with Sync now, Pull update,
Review, or Review and push), its sharing (Private, or Public while it is in
a repository GitHub says anyone can read) with a Share switch that opens
the push's review, its instances with Clone and Detach, and the note. A
server's link is its definition's: the link of any of its instances counts.

## Mail accounts

A mail account is a server row of kind `jmap` or `imap` with a fixed set of
tools (`lib/core/mail/tools.ts`), the same names and answers for both, so an
assistant learns one set: `list_mailboxes`, `search_emails`, `get_email`,
`get_attachment`, `move_email`, `mark_email`, `delete_email`, `send_email`,
`create_draft`, `create_mailbox`, `rename_mailbox`, `delete_mailbox`, and on
JMAP `get_thread`, `list_identities`, `get_vacation_response` and
`set_vacation_response`. It is a fixed set on purpose, not the protocol passed
through: there is no tool that takes a raw JMAP method or IMAP command, so
every change an assistant makes is one these rules were written for. Which
ones an account has depends on read-only (the tools that change mail are left
out, and refused if called anyway), on whether it can send (JMAP: the session
offers submission; IMAP: the owner gave an SMTP server; `set_vacation_response`
counts as sending, since the server sends its text to whoever writes in, and
goes with `send_email`), and for the automatic reply on whether the JMAP
session offers `vacationresponse`.

`move_email`, `mark_email` and `delete_email` take `id` or `ids` (up to
`MAX_BULK_EMAILS`): one email answers as it always has, several answer with
`done` and `failed`, and one email's refusal stops no other (JMAP: one
`Email/set`; IMAP: one UID MOVE or STORE per mailbox). `mark_email` also sets
answered and adds or removes keywords, which every summary lists and
`search_emails` filters on; the keywords the flags carry (`$seen`,
`$flagged`, `$answered`, `$draft`) are left to the flags. `search_emails` with
`allMailboxes` looks in every mailbox but Trash and Junk (JMAP:
`inMailboxOtherThan`; IMAP: All Mail alone where the server has one, else
each selectable mailbox but the Flagged and Important views in turn, at most
`MAX_SEARCH_MAILBOXES`, merged by date and paged only to
`MAX_SEARCH_ALL_WINDOW`). A JMAP mailbox's `path` is its names from the top
joined with `/`, so a folder is named by path as on IMAP.
`delete_mailbox` removes only an empty mailbox with no role and none inside
it (`checkDeletable` in `mail/mailboxes.ts`); JMAP's `Mailbox/set` destroy
goes with `onDestroyRemoveEmails: false`, so the server refuses too if mail
arrived in between, and IMAP's DELETE, which would take mail with it, is sent
only after the listing's count said empty. `rename_mailbox` renames or moves
one, never into itself or one inside it, and never the inbox; on IMAP the
emails inside get new ids, since an id carries its mailbox's path. `create_draft` is
`send_email`'s arguments and email, recipients optional, written into Drafts
(the drafts role, or a mailbox called Drafts) marked as a draft and seen, and
sent by nobody: a separate tool so the owner can allow drafting without
allowing sending. It needs no submission or SMTP server. `mcp_tool.operation`
is null; a call is dispatched by name. An assistant can propose an account
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
IMAP is not looked at (a connection without a login shows little), but the
names of its IMAP and SMTP servers are resolved (`openapi/address.ts:
privateHostsNote`) and one on a private or local address is flagged to the
owner the same way. That line is the owner's alone (`PermissionView.ownerOnly`):
the assistant's copy of the request leaves it out, so proposals cannot be used
to learn what the owner's DNS holds.

`upstream.ts` builds the credential and hands it to `mail/accounts.ts` as a
`MailCredential`: the `Authorization` header for JMAP, the login for IMAP and
SMTP, and the values to remove from every answer. Nothing under `mail/` reads
a secret. Authentication is `basic` (a user name, in `auth_username`, and a
secret: Basic for JMAP, LOGIN for IMAP and SMTP), `header` (a bearer token,
JMAP only) or `oauth` (JMAP only).

**JMAP** (`mail/jmap.ts`): `url` is the session URL the owner typed. Reading
the account GETs it with the credential, and the API, download and upload
addresses it names are accepted only on that URL's origin, so the credential
goes nowhere the owner did not type; the URL is `https://`, or `http://` only
for a private, loopback or link-local address or a name that resolves only to
those (`requireEncryptedOrPrivate` when it is saved or proposed, and every
request again, to the address the socket connects to); they are kept (`mail_api_url`,
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
after the send, and says whether it could. A draft is the same Email/set
into Drafts with no EmailSubmission after it, and marks nothing.

**IMAP** (`mail/imap.ts`, on imapflow and nodemailer): `url` is
`imaps://host:port`, or `imap://` for STARTTLS; `smtp_url` the same for
SMTP. A connection that is not encrypted after it is made is dropped, and
STARTTLS is required, never optional. Each call connects, signs in, works
and logs out. An email's id is `<uid>.<uidvalidity>.<mailbox path>`, so an id
from before a mailbox was rebuilt is refused rather than naming another
email. Sending goes over SMTP, attachments included, written by nodemailer.
The copy in Sent (Bcc kept) is the account's setting, `mailSaveSent`:
`never`, `always` (appended at once), or `auto`, the default: many SMTP
servers (Gmail's, Outlook's) file their own copy, so PCP first looks for it
among the newest 15 emails in Sent, by the Message-ID (or Outlook's
`X-Microsoft-Original-Message-ID`) in their headers rather than a SEARCH,
which lags on Gmail, at 0, 1, 2, 3, 5, 7.5 and 10 seconds, and appends only
when it is not there. What it finds is kept as `mailServerFilesSent`, which
stretches the next look to 15 seconds for a server that files its own and
shortens it to 3 for one that does not; it is forgotten when the address or
user name changes. A copy the server files after the look makes two, and
nothing deletes either. The look runs once the call has answered (`savedTo`
is `"pending"`), inside the same request: the call hands it to
`lib/core/after-answer.ts`, whose scope the gateway's route and the owner's
answer to a request open and drain through Next's `after()`, on a connection
of its own with the login the call already holds; nothing is stored or timed
past the request. Where no scope is open, the look runs in the call, for 10
seconds at most. A draft is the same message,
appended to Drafts with `\Draft` and `\Seen` and sent nowhere; its id comes
from APPENDUID, and is null without UIDPLUS.

**What an assistant gets back** is JSON PCP writes: addresses, dates, flags,
the text of a body (the HTML one made plain when there is no text one) and
the list of attachments. `get_attachment` downloads an attachment of any
kind, up to 10 MiB, and keeps it for the token as a file (below): the answer
gives its handle, and a text one's first 20,000 characters too, scrubbed of
the credential. A body longer than 20,000 characters is kept the same way.
`send_email` and `create_draft` take kept results as attachments, read before
anything connects (at most 10, 20 MB together), so an attachment read from one
account can be sent from another. Delete moves to the
Trash and nothing deletes for good. Over IMAP a move (and so a delete) is
refused on a server with neither MOVE nor UIDPLUS: imapflow would copy and
then expunge, which erases every email in the folder already marked deleted.
Failures: refused credentials mark the
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

## Calendar accounts

A calendar account is a server row of kind `caldav` with a fixed set of tools
(`lib/core/caldav/tools.ts`), shaped around what an assistant is asked to do
rather than around WebDAV: `list_calendars`, `list_events`, `get_event`,
`find_free_time`, `create_event`, `update_event`, `delete_event`,
`list_reminders`, `create_reminder`, `update_reminder`, `complete_reminder`,
`delete_reminder` and `create_calendar`. No tool takes a WebDAV method or
raw iCalendar, and none adds attendees: a server that schedules (iCloud does)
would email them invitations. Read-only leaves out the tools that change
anything, and refuses them if called anyway. `mcp_tool.operation` is null; a
call is dispatched by name. Only the owner changes an account; an assistant
can propose one through `register_server` (kind `caldav`).

**Finding the calendars** (`caldav/client.ts`): `url` is what the owner
typed, a CalDAV server (`https://caldav.icloud.com`) or a home on it. PCP
asks it for `calendar-home-set`, or for the `current-user-principal` and then
the principal's home (RFC 4791 6.2.1, RFC 5397); a server root that answers
404 or 405 is asked at `/.well-known/caldav` (RFC 6764). Redirects are
followed only there, on the same origin, at most three; any other is named
for the owner to enter instead. The home is kept (`dav_home_url`), found again
when the address or sign-in changes, and once more when it answers 404. Every
address a server names (the principal, the home, an object's href) is taken
only on the typed origin, or over `https://` on a host under the typed host's
own domain (`caldav/addresses.ts: acceptedAddress`): iCloud answers at
`caldav.icloud.com` and keeps each account's calendars on
`p<n>-caldav.icloud.com`. A typed host with no domain to share (two labels, or
right under a country's second level, as `example.co.uk`) allows its own
origin only, and a home on another host is reached on public addresses only.
`http://` is for a server on the owner's own network only, checked when the
address is saved or proposed and on every request, as a JMAP session URL is.

**Reading**: the calendars are one PROPFIND (depth 1) on the home: their
names, what each holds (`supported-calendar-component-set`: events, reminders
or both), color and order (Apple's), time zone and whether this sign-in may
write (`current-user-privilege-set`). Events between two times are a
calendar-query REPORT with a time range; reminders one for VTODO, asking the
server for the open ones (no COMPLETED) and for all of them when it does not
take that filter. Answers are capped (8 MB a REPORT, 1 MB an object) and read
as untrusted XML (`caldav/xml.ts`: fast-xml-parser, no document type,
character references decoded once, as iCloud writes `&#13;`). One calendar
that cannot be searched is listed under `skipped`; the others still answer.

**Time** (`caldav/zones.ts`, `caldav/ical.ts`): iCalendar writes most times
as a wall clock in a named zone, and a recurring event repeats in that wall
clock across summer time. ical.js parses the objects and steps through
recurrence rules in wall time; PCP turns wall times into instants itself, an
IANA TZID through Node's Intl database (also behind a prefix such as
`/mozilla.org/…/Europe/Berlin`), any other (an Exchange name) through the
VTIMEZONE the object carries, never through ical.js's global registry, so one
server's VTIMEZONE never changes how another account's times read. A floating
time or a date is read in the calendar's time zone, else the `timezone`
argument, else the machine's. A series expands with its EXDATEs taken out and
its exceptions (RECURRENCE-ID) in place of the occurrences they change, an
UNTIL in UTC bounded by its instant, at most `MAX_RECURRENCE_STEPS` steps.
Each occurrence of a series carries `occurrence`, its original start (a date,
or a UTC instant), which the tools take back to change or delete that one
alone. Answers give times in ISO 8601 with their offset, an all-day event as
dates with its last day inclusive.

**Writing** (`caldav/compose.ts`): a new event or reminder is a calendar object
of its own (`<UUID>.ics`), PUT with `If-None-Match: *`; a change reads the
object, changes it and PUTs it back with `If-Match` and the ETag read, so a
change made in between is never overwritten (412 is an error answer saying to
read it again); a delete sends the ETag too. A change is made to the object as
the server sent it, so what PCP does not know about (attendees, another app's
properties, attachments) stays. Times PCP writes are in an IANA zone with a
VTIMEZONE made from the same database (yearly rules where the zone follows
one, its changes year by year otherwise), or dates for all-day values; an
UNTIL is a UTC time for a timed series. One occurrence changed (`scope`
"this") becomes an exception; a new start for one occurrence said for the
whole series ("all") moves every occurrence by as much; `recurrence: null`
ends a series with its exceptions. Deleting one occurrence is an EXDATE.
Moving to another calendar writes the copy first and deletes the original
after, so a failure in between leaves two, never none. Completing a repeating
reminder moves its due date (and its alert) on to the next occurrence and
keeps it open, as Apple's Reminders does. `create_calendar` is MKCALENDAR in
the home with one component.

**iCloud**: an app-specific password (the Apple ID's own is refused, and the
account's status says so), `https://caldav.icloud.com` as the address. iCloud
serves over CalDAV only the reminder lists it keeps as tasks; lists upgraded
in Apple's Reminders app since iOS 13 are not there, and the tools say so when
an account has no reminder list.

`upstream.ts` builds the credential (`DavCredential`, the same shape as a
mail account's): Basic for a login, a bearer header, or an OAuth token from
`credential()`, renewed once when the server refuses it. Nothing under
`caldav/` reads a secret, and every answer is scrubbed of the credential.
Failures: refused credentials mark the account `auth_required` (with OAuth,
needs connecting), an unreachable server `error`; a request the server refuses
(no such event, a read-only calendar, a changed object) is an error answer and
leaves the account as it is.

**Proposing one** is `register_server` with kind `caldav`, a `url`
(`caldav.icloud.com` alone means `https://` and the root), `read_only` and an
`auth_type` (basic, header or oauth, never none; no header of its own). It is
a permission request like any new server: `summarizeRow` shows the owner the
address, the user name, how PCP signs in and whether it can change things; a
password PCP does not hold yet is typed in on the approval page; and
`executeRegister` creates the account with `createCalendarAccount` and finds
its calendars. Nothing connects before the owner agrees; a host on a private
or local address is flagged to the owner alone, as for IMAP.

## SSH servers

An SSH server is a server row of kind `ssh` (`url` is `ssh://host:port`,
`auth_username` the login) whose one tool, `run_command`, runs one command per
call with `exec`: no shell session kept between calls, no terminal, no
forwarding, no agent, no file transfer. Only the owner adds one, on the
Servers page; `register_server` has no kind for it, because a shell on a
machine is more than an assistant should be able to ask for in a sentence.
`run_command` asks the owner first by default like every tool, and the
permission page shows the command and its standard input in full (under Show
everything when the lines cut them short), with `stdin_base64` read as text
too when it is UTF-8; a kept result's handle is described, not shown.

The protocol is `ssh2`'s (`lib/core/ssh/client.ts`), in pure JavaScript: pnpm
does not build its optional native parts (it is not in `allowBuilds`), so the
desktop app gains no native code, and Next keeps it out of the bundle
(`serverExternalPackages`). PCP narrows it to modern algorithms (curve25519 or
ECDH and SHA-2 group exchange, Ed25519, ECDSA and RSA-SHA2 host keys,
ChaCha20-Poly1305, AES-GCM and AES-CTR with SHA-2 MACs); `ssh2` adds strict key
exchange (the Terrapin countermeasure) to any offer.

- **PCP's own key.** Adding a server makes an Ed25519 key for it
  (`ssh/keys.ts`). The private half is a managed secret of kind `ssh_key`
  (`ssh/<server id>`, in `auth_secret_id`, auth type `key`), encrypted like
  every secret and decrypted only in `upstream.ts`, for one connection; the
  public half is on the row (`ssh_public_key`) and on the server's page, for
  the owner to put in the login's `authorized_keys`. PCP signs in with that
  key alone: no password, no keyboard-interactive, no agent. The owner can
  have PCP make a new key; deleting the server deletes the key.
- **The host key**, pinned on first use, by the owner. The first connection
  the owner started (adding the server, **Check sign-in**, forgetting the
  key) that finishes a key exchange stores the key the server proved it
  holds (`ssh_host_key`), whether or not signing in then works, so it is
  usually pinned when the owner adds the server, and the page shows its
  fingerprint to compare with the server's own. A call an assistant makes,
  or the gateway reading the tools again, never pins a key and does not
  connect while there is none: whoever answered first would otherwise be
  the key every later call trusts. It answers with the server's page. `ssh2` asks `hostVerifier` before it
  checks the server's signature, so the key is kept only after the
  `handshake` event, never from inside the verifier. From then on any other
  key is refused before signing in; the owner can forget the pinned key
  after changing it on purpose, and a new address forgets it too. The pin is
  written only while the row still has none and the same address.

**A call** (`ssh/hosts.ts callSshTool`) checks its arguments before anything
connects (`ssh/tools.ts`: the command, at most 16 KB and no NUL; standard
input as text or base64, at most 1 MB, which a kept result's handle can stand
for, resolved in `upstream.ts`; a timeout of 1 to 600 seconds), connects,
signs in and runs it, and answers with the exit code (or the signal), stdout
and stderr. Output is capped at 1 MB together; past that, or past the
timeout, PCP sends the session a TERM signal (which OpenSSH honours for every
login but root), closes the connection and answers with what came so far,
saying so. A key the server turns down or a host key that is not the pinned
one is answered with the server's page in PCP, for the owner; a server that
cannot be reached is an error. Limits are in `ssh/limits.ts`. The test server
(`ssh/fake-server.ts`) is `ssh2`'s own server. The request log keeps the call
by name like any other, never the command or its output.

## Memories

A token made with "keep memories" (`api_token.keep_memories`, off unless the
owner turns it on) gets one more tool, `memory`, with the commands of Claude's
memory tool (view, create, str_replace, insert, delete, rename, over files
under `/memories`) plus search and every, a second one, `read_memory`, with
only every, view and search, and a paragraph in the instructions saying when
to use them. `read_memory` and `call_read_only_tool` (call_tool for a tool
whose stored annotations say `readOnlyHint`) are marked read-only, so a
client that holds back other tools, as Claude Code's plan mode does, lets
them through; the token's levels apply to them as to the rest. The rules are in `lib/core/memories.ts`. Like endpoint
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
  the Memories page, one at a time or picked together: `setMemoriesAccess`
  gives the picked memories to all tokens (`visibility = shared`) or to one
  token that is alive and keeps memories (`private`, `token_id` set to it), and
  `deleteMemories` deletes them. Only the audience changes, so nothing is
  re-encrypted. It is one transaction, checked first against the vault as it
  would be after the change (a path taken, a text too long to share), so it
  makes every change or none. A memory read in every conversation stops being
  when its readers change, since the owner marked it for the old ones. One an
  assistant wrote, given to a token that did not write it, becomes the owner's
  (`author`), as `token_id` then names its reader, not its writer.
- **What the owner reads is all there is.** Text or a path with characters
  that do not show on screen (controls other than tab and newline, format
  characters such as zero-width spaces, direction overrides and tag
  characters, private-use, and every Unicode Default_Ignorable code point:
  blank fillers such as the Hangul ones that count as letters, variation
  selectors that can carry bytes) is refused, and a shared memory is at most
  2,000 characters, so it can be read whole. The emoji presentation
  selectors (U+FE0E, U+FE0F) are the one exception: text loses them when it
  arrives, before the owner is asked, so what they approve is what is
  written; a request answered later is checked as stored, never changed.
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
- **Memories live in PCP, and a migration brings them in once.** The memory
  paragraph and the `memory` tool's description say the owner keeps memories
  and skills in PCP, so an assistant saves new ones there rather than in its
  client's own memory (`MEMORY_HOME`). While `api_token.memory_migration` is
  on (it defaults to on, for the tokens that existed when it came too), the
  paragraph adds fixed steps (`MEMORY_MIGRATION_STEPS`), and `every`
  returns them as well, for a client that cut the instructions short: find
  what the client keeps about the owner (never a project's files), confirm
  with the owner, move it keeping its structure (a skill through
  `/skills/…`, a `skill_change` the owner answers), read it back, confirm
  again before deleting the originals, delete them or tell the owner what
  to remove, then call `memory` with `migration_done`. That command takes no
  other argument and only turns the token's own flag off, with no request;
  nothing an assistant sends turns it on. Only the owner does, with the
  switch on the token's page, which writes the flag only when they flipped
  it there (`memoryMigrationWas`), so a page drawn before the assistant
  turned it off does not turn it back on. These steps are PCP's own text,
  the same for every token, so every text in the instructions is still one
  the owner read or PCP wrote.
- **Bounded.** 500 memories per vault, 10,000 characters each, 60 writes and
  share requests per token per ten minutes. Path and text are encrypted
  together, so uniqueness of paths is checked in code after decrypting the
  vault's memories, as `search.ts` scores every tool. A memory outlives the
  token that wrote it (`token_id` is set to null) and is then the owner's.

## Skills

A skill is a procedure the owner approved, for an assistant to follow when a
task matches (`lib/core/skills.ts`). It is modelled on Anthropic's Agent
Skills: a `SKILL.md` with YAML frontmatter (`name`, a slug; `description`,
the line an assistant picks it by; `version`; `tools`, the `server/tool`
names it uses) and Markdown steps, plus at most ten reference text files.
Nothing in a skill is ever run: a "script" among its files is text.

A memory is a note an assistant weighs, written by assistants as they go;
a skill is how the owner wants a kind of task done, so every word of one is
the owner's or one they read:

- **Stored whole, encrypted.** A `skill` row holds one ciphertext of the
  name, description, version, body, tools and files, under the vault's key
  with `skill:<id>` as associated data, and `author` (`owner`, or
  `assistant` once the owner agreed to an assistant's text). Names are
  unique per vault by checking after decrypting, as memory paths are.
  Limits are in `lib/core/constants.ts` (`MAX_SKILL_*`, `MAX_SKILLS`), and
  text with characters that do not show on screen is refused, as for a
  memory (`hiddenCharacter`). The frontmatter is read with `yaml` in its
  core schema, plain (`lib/core/strict-yaml.ts`: no anchors, aliases or
  tags of any kind). Keys other tools write (`license`, `allowed-tools`,
  `metadata`, `compatibility`, any other) are kept in the ciphertext as
  `extra` and written back out after PCP's own, so a skill imported from
  elsewhere goes back the way it came; they are checked like the rest
  (nothing hidden, plain values, within the frontmatter's size) and shown
  in the SKILL.md the owner reads. Nothing in PCP acts on them.
- **Versions.** Every change, the owner's or an approved one, is the next
  version; the SKILL.md PCP serializes carries it.
- **Which tokens see it.** `api_token.all_skills` (on by default), or the
  skills listed in `api_token_skill` (cascades from both sides), the
  servers' pattern. `liveToken` resolves it into `ResolvedToken.skillIds`
  (null: every skill), `copyTokenAccess` copies it, and the token's page
  chooses it. A skill an assistant added through a request is added to its
  token's list when the token sees only some.
- **Found and read.** The gateway's instructions frame skills apart from
  memories and name each visible one with its description while they fit in
  `SKILL_INSTRUCTIONS_CHARS`, past it by name alone, and past
  `MAX_INSTRUCTION_SKILLS` not at all ("search finds the rest"). `search`
  ranks them beside tools and memories; `describe` with `skill:<name>`
  answers with one framing line ("A procedure the owner approved: follow it
  when the task matches."), the whole SKILL.md, its files by ref
  (`skill:<name>/<file>` reads one) and, for each tool it names that the
  token can call, that tool's `call_handle`.
- **Changed only by asking.** There is no skill tool: the `memory` tool
  takes `/skills/<name>/SKILL.md` and `/skills/<name>/<file>` (view, create,
  str_replace, insert, delete, rename; `read_memory` views them too). Every
  write becomes a `skill_change` request that carries the whole skill as it
  would be and `basis`, the version it was made against; the owner's page
  shows a line diff (`lib/core/line-merge.ts diffLines`) and the whole
  SKILL.md and every file, unfolded (`components/skill-review.tsx`).
  `applySkillChange` writes exactly that, checked again and refused unless
  the check leaves it as shown, and only while the skill is still at
  `basis` ("the skill changed since the owner was asked"); a new skill only
  while its name is free. The owner edits, imports (a pasted SKILL.md) and
  deletes skills freely on the Skills page.
- **Exported** as rows (`skill`, `api_token_skill`, `all_skills`); an older
  file restores with none, every token seeing every skill. Deleting the
  vault wipes them.

## Shared items in repositories

The owner can link GitHub repositories so that what is useful and not
secret is shared between PCP instances, organizations and people, and
changed and reviewed in GitHub: skills, wrappers (browser flows among them),
API endpoints and MCP servers. A repository is never a backup and never
holds a secret or anything else of the vault's. `lib/core/repos/` is the
file format both ways and what sync needs to review a change; linking,
the GitHub client and sync itself build on it.

- **Layout** (`layout.ts`): plain folders, native formats, names a person
  reads, and no index or manifest. `skills/<name>/SKILL.md` and its
  reference files beside it (an Agent Skills repository reads as is);
  `wrappers/<name>/wrapper.yaml` with one `<tool>.js` per tool, and
  `flows/<name>/` likewise for a wrapper that drives the browser
  (`isFlow`); `endpoints/<name>/openapi.json` or `openapi.yaml` (the
  document as PCP holds it, in the format it came in) with `pcp.yaml`;
  `servers/<name>.yaml` for an MCP server. Names are slugs (a skill's name,
  a server's short name). Wrappers, flows, endpoints and servers share the
  vault's server names, so two of them by one name, or two items at one
  path, are refused. Other files (a README, CI, dotfiles) are no item's and
  are left alone.
- **Documents** (`documents.ts`): `serializeItem` writes an item as files,
  the same item always as the same text; `parseItem` and `readRepo` read
  files back into what they propose. A server's document is its
  **definition only** (see Definitions and instances): the definition's
  short name and name, the description, an endpoint's schema, edits and
  tool descriptions, a wrapper's programs, and how it signs in by kind,
  header and format (an OAuth scope). Never anything of an instance: its
  name, address, read-only and public-only switches, which secrets it
  signs in with, a basic login's user name, its OAuth client, its note,
  levels, whether it is on or its pace. The vault has one item per
  definition (`local.ts`; the instance linked to a repository, or the
  oldest, stands for it). Secrets appear by name only where a wrapper's
  program needs them (its secret places, by secret name, tool and
  argument); never a value, a token, a row id or an address PCP found
  itself (a JMAP session's, a token endpoint's). A wrapper's calls are
  `server/tool` by short name as `get_wrapper` shows them. `resolveItem`
  (`apply.ts`) says what the names are in this vault: a server or tool
  with nothing to it is a problem (never a guess), a secret the vault
  lacks is listed.
- **Untrusted input.** A repository with a path that leaves its folder,
  hides a character, or clashes with another but for case is refused
  whole, as is an item past `repos/limits.ts` (files per item, bytes per
  file and per item, path length). PCP's YAML is read plain (no anchors,
  aliases or tags), unknown keys are refused, nothing that does not show
  on screen is taken (prose loses its emoji presentation selectors first),
  and each kind's own checks run before anything is proposed: a skill's
  (`checkSkill`), a program's compile and size, a schema's generation with
  its edits (`generateEndpointTools`, `readPatches`), addresses, headers,
  logins and OAuth fields as the owner's forms check them.
- **Formats.** Every document carries `pcp_format` (a SKILL.md written
  elsewhere may leave it out, reading as 1). A parser reads every format up
  to `PCP_FORMAT` and refuses a newer one in so many words ("written by a
  newer PCP"), so an older PCP never half-reads what a newer one wrote. A
  change to a document's shape stays backward compatible: a field is added
  with a default (what a document without it always meant), never
  repurposed, and `PCP_FORMAT` goes up by one. Format 2 took the
  instance's part out of server documents: a format-2 `pcp.yaml` or
  `servers/<name>.yaml` that names a `baseUrl`, `url`, `readOnly`,
  `publicOnly`, a secret, a user name or an OAuth client is refused. A
  format-1 document still reads; what it says of its server is kept apart
  (`instance`) and only fills in the first instance when the item is added,
  never a server the vault has. An MCP server's address is its binding,
  so a format-2 server document has no address, not even a suggested one:
  adding it asks for the address, as Clone does.
- **Versions.** Each document carries `version`, a whole number: a skill's
  own version; for a server, endpoint or wrapper, `mcp_server.sync_version`
  (null reads as 1), which applying an item sets to the document's. PCP's
  own edits leave it alone; sync counts it on when it writes a changed
  document. It is a column rather than derived because nothing on those
  rows counts changes (`updated_at` moves with every status write) and a
  hash has no order. Sync itself compares hashes: `hash.ts localHash` is
  SHA-256 of the canonical JSON of the serialized files, so formatting in
  the repository never reads as a change.
- **Review** (`review.ts`): an incoming item against the vault's (or none),
  file by file (`diffLines`), with a flag for each thing that would reach
  further: a new or changed program, new calls, calls on the wrapper's
  approval instead of the token's levels, a new or changed secret place; an
  endpoint's OpenAPI document or edits; how a new endpoint or MCP server
  signs in; a skill's new tools; a character that does not show on screen
  anywhere. An instance's address, sign-in and switches never change from
  a repository, so they are never flagged on a server the vault has.
  `textOnly` is true only when an existing skill's description, steps or
  reference files change and nothing is flagged: the one change sync may
  apply by itself, from a read-and-write repository the owner trusts.
  Everything else waits for the owner.
- **Apply** (`apply.ts applyItem`) writes what the owner approved with the
  owner's own paths (`saveSkillByOwner`, `saveWrapperByOwner`,
  `changeEndpoint`, `shareDescription`, `setToolDescription`,
  `createEndpoint`, `createServer`). Onto a server the vault has it writes
  the definition and nothing else: the description, the schema and its
  edits, the tool descriptions, a wrapper's programs, the definition's name
  and short name (kept when another definition has that one), and the
  version on every instance. **Sync never writes an instance's own fields**:
  its name and short name, address, credential and secrets, read-only and
  public-only, whether it is on, its pace, levels and note. A new server or
  endpoint is the definition and its first instance, whose own part the
  owner gives on the page that adds it (`InstanceInput`, the clone form);
  a format-1 document's `instance` fills it in otherwise. An endpoint read
  from a URL keeps its address, the approved text becoming its copy. A
  secret the vault lacks is never made up: the item is saved without it (a
  wrapper without that secret's places, a first instance without that
  credential) and a note tells the owner to add it on PCP's page.
- **The push's review** (`share-review.ts`, the page
  `settings/repositories/[id]/share`) is the one way an item of the vault
  goes to a repository: an item page's Share, Add and "Diff and push" on a
  repository's page, and an assistant's proposal (below). It
  shows every file in full and, for a change, its diff against the
  repository; what stays private (each instance's name, address and sign-in
  by secret name, the note, the levels, the secrets' values); and what in
  the files looks personal (`personal-data.ts`, pure: email addresses, the
  owner's own hosts, domains and machine names, IPs, UUIDs and
  Coolify-style ids, phone numbers, paths with a user name, token-shaped
  strings, the owner's name). The owner's facts come from the vault's own
  plain columns (`vaultOwnerFacts`): PCP's public address, the email
  addresses the mail and calendar accounts sign in or send with, SSH
  servers, any domain two servers share (never a mail provider's or a
  vendor's API the owner merely uses), and the vault's name. Each hit links
  to its line, and offers the fixes that apply: edit the description, move
  its sentence to the owner's note, rename what is shared (before it is in
  a repository), or leave the address out of an endpoint's shared schema
  (its `servers` go; each instance keeps its own base URL). To a public
  repository, or one GitHub has not said is private, Confirm waits until
  every hit is fixed or ticked as fine to publish; to a private one the hits
  are advice. Confirm pushes exactly what was shown: `basis` is a hash of
  the repository, its visibility, the item's place and every file, and if
  any of it changed since the page opened nothing is pushed and the review
  opens again. One commit, then the item is linked and taken off the
  repository's excluded list.

### Linking, sync and trust

The owner links repositories on Settings › Repositories (`repos/store.ts`):
`repo` holds which one (owner, name, branch: one ciphertext under
`repo:<id>`), its trust (trusted or not), its access (read-only, or read and
write), the secret PCP signs in with, if any, and `private`, what GitHub
last said of who reads it (asked when it is linked, on every sync of it and
before every push's review; null, not asked yet, counts as public).
`repo_item` links one item of the vault (a skill, or a server row standing
for its definition: deleting it deletes the link) to its folder or file
there, with how often it syncs (off, hourly, daily, weekly), whether
two-way, and its state; where it is, the hashes sync compares, the last
commit PCP knows, a change waiting for the owner and an assistant's drafts
are one ciphertext under `repo_item:<id>`. `repo_exclusion` keeps an item
out of a repository on purpose (a skill, or a server's definition, by id
only), until the owner includes it again or pushes it. All three are in an
export and in `wipeVault`.

A repository's page (`repos/overview.ts`) is one table of every shareable
item, grouped by kind, each Pushed (in it and in step), Changed (changed
in the vault, not pushed), Not pushed, Imported (added from a read-only
repository) or Excluded, with a summary on top. "Add selected" opens the
push's review of each chosen item in turn; there is no push of several
items at once.

- **The GitHub client** (`repos/github.ts`) is fixed and built in: the REST
  API at api.github.com, and github.com only for the device flow. No
  redirect is followed (one is an error), an address must resolve to a
  public one, every answer is read up to a bound (`repos/limits.ts`) and
  against a schema, and every file is checked against the git id GitHub
  named it by. It never reads a secret: `upstream.ts githubCredential`
  decrypts the one chosen for the repository (a text secret holding a
  personal access token, or PCP's own GitHub sign-in, never another
  server's OAuth tokens) and hands it the Authorization header, which goes
  to the API only. PCP's GitHub sign-in is its own OAuth App
  (`GITHUB_OAUTH_CLIENT_ID`, public; no client secret exists) through
  GitHub's device flow (`repos/signin.ts`): the owner types a code in at
  github.com/login/device and the page, while open, asks PCP to ask GitHub;
  the device code is kept in memory only. The token is saved as a managed
  `oauth` secret, asks for `public_repo` or `repo` as the owner chose, and
  does not expire (a 401 means sign in again). A development server or a
  test points the client at a fake with `PCP_GITHUB_API_URL`; a production
  build never reads it.
- **Read and write** is checked with GitHub (the repository's
  `permissions.push` for the sign-in) when it is chosen, and refused
  without it. A push (`repos/push.ts`) is GitHub's Git Data API: a blob per
  changed file, a tree on the branch's, one commit per item naming it and
  who proposed it (the owner, or an assistant's token by name), and the
  branch moved as a fast-forward only: when it moved on in between, that is
  a conflict, never a force.
- **What a repository offers** (`repos/remote.ts`): PCP's layout, and any
  other folder with a SKILL.md as a skill (Anthropic's skill repositories:
  `<name>/SKILL.md` at the root or deeper), read from one listing of the
  branch's tree. Each item is named by the git id of its folder or file.
  Adding one shows the owner every file and flag first (`reviewItem`
  against the vault's item of that name, or none) and applies only on their
  confirm, read again at the commit they were shown and only if it hashes
  the same.
- **Sync** (`repos/sync.ts`) compares by hash: the item's git id against
  the stored `remoteSha`, `localHash` against the stored one. Only the
  repository's changed: pulled. Only the vault's, with two-way on: pushed;
  otherwise kept. Both: a conflict, nothing applied, and a notice with keep
  mine, take theirs, or let an assistant help. Neither: nothing. The latest
  change wins only when one side changed.
- **Trust on a pull.** From a trusted repository the owner pushes to (read
  and write), a change that is text only (`textOnly`) is applied at once.
  An item imported from a read-only repository is **pinned** to the commit
  the owner reviewed: a newer one is an update available, which waits,
  text only or not, trusted or not. A flag, a new item, or any change from
  an untrusted repository waits as a review: the item's `pending` names the
  change by its git id and hash, never a copy of its files, and the owner's
  page reads it again by that id, so Approve applies exactly what they were
  shown, and only while the vault's item is as it was then (`basis`). Not
  now leaves that change alone until the repository changes again. The
  bell lists each waiting review and conflict (`repos/notices.ts`, from the
  items' states). A pending change has no token behind it, and
  `permission_request.token_id` is required: making it optional would
  rebuild the table, so sync's reviews stay on the items, and only an
  assistant's proposal is a permission request.
- **No background key.** Nothing reads the vault without a credential, so
  sync never runs on its own: no timer, no webhook, no stored key. A due
  sync runs after a request that already held the vault's key was answered
  (`runDueSyncs`, scheduled with Next's `after()` from `/mcp` and the
  owner's pages), one run per vault at a time, a few items in a short
  budget, and looked for at most once a minute; what it does not reach is
  due at the next request. Sync now runs one at once.
- **Assistants helping**, only a token that may manage endpoints, through
  the tools it has: `search` lists waiting changes as kind `repo`
  (`repo:<id>`), `describe` gives both sides' files, what differs and
  PCP's flags, and the memory tool writes drafts under `/repos/<id>/`.
  Writing `/repos/<id>/REVIEW.md`, the assistant's own safety review, makes
  the merged files and the review one `repo_change` request that shows the
  owner the final files in full, against the vault's and the repository's,
  with every flag; allowing it applies those files, only if neither side
  moved since, and with two-way sync pushes them too.
- **Assistants proposing a push** (`repos/assist-share.ts`), the same
  tokens, through the memory tool under `/repos/share/`: `view` lists the
  repositories PCP pushes to, and then the items of the vault the token sees
  there (a skill it sees, a server whose definition has an instance it
  sees), each Pushed, Changed, Not pushed or Excluded; `create
/repos/share/<owner>/<name>/<item's path>`, with a line for the owner as
  `file_text`, proposes adding that one item or pushing its changes. It is
  refused before asking for a read-only repository, an item the token does
  not see, or one the repository has the same (the push's review runs once,
  read only), and is otherwise one `repo_share` request that writes and
  pushes nothing. Its only answer on the permission page is Not now; it
  links to the push's review with the request's id, and Confirm there
  (`permissions.ts confirmProposedShare`) is `confirmShare` unchanged (every
  file, the personal-data check, a public repository waiting on each hit,
  exactly what was shown) with the token as the commit's proposer; then the
  request is done and `check_permission` says what was pushed. A refused
  Confirm leaves the request open. Never more than one item per request.

## Instructions for an assistant

Every token has instructions of its own, the owner's words to that
assistant (`lib/core/instructions.ts`). They are text on the token row,
`api_token.instructions`, encrypted under the vault's key with
`api_token:<id>` as associated data, and `api_token.instructions_base`, the
version of PCP's suggested instructions they were copied or merged from.

- **A copy of a suggestion.** `lib/core/instructions-defaults.ts` lists
  PCP's suggested instructions by version, oldest first, and keeps every
  version. A new token, made on PCP's page or by an app's sign-in
  (`createApiToken`, `createOAuthApiToken`), gets a copy of the latest and
  its version. A token from before instructions has neither: its page shows
  the suggestion as not set yet, and it gets nothing until the owner saves.
  Nothing is copied into existing rows by a migration.
- **Given first.** `liveToken` decrypts them into `ResolvedToken`, and the
  gateway's instructions carry them right after the memory lead, under "The
  owner's instructions for this assistant:" (at most 4,000 characters,
  `MAX_INSTRUCTIONS_CHARS`), since clients cut instructions short. For a
  token that keeps memories, `read_memory every` opens with the same block.
  `search`'s description carries the one rule that matters most:
  describe a tool before calling it and pass its call_handle; check before
  retrying anything that may have happened.
- **The owner's to change.** The token's Advanced page has the editor and,
  folded, exactly what the token is told at the start of a conversation
  (`instructionsPreview`, the same `buildInstructions` call as `/mcp`).
  Text with characters that do not show on screen is refused, as for a
  memory, and so is text still holding a merge's conflict markers. Only the
  owner writes them; no gateway tool does, and `updateApiToken` leaves them
  alone.
- **When the suggestion changes.** A token whose base is older than the
  latest version is a notice for the owner (`lib/core/owner-notices.ts`,
  worked out when the bell is read; nothing is stored for it). The notice's
  page lists those tokens: **Keep mine** moves the base to the latest,
  **Take PCP's** replaces the text, and **Save merged** saves an editor
  that starts from a three-way line merge (`lib/core/line-merge.ts`: base
  the version the token followed, one side its text, the other the latest
  suggestion), with the places both sides changed marked for the owner to
  settle. An export carries both columns as they are; an older file
  restores them as not set yet.

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
line for the site, as a tool's answer writes the token's own level, and
**Allow this site for** an allowance for the site (below); when they allow a
request, `executeFetch` runs it only if the token still has web fetch on.

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

**A site that checks its visitors.** Cloudflare can answer with a check
instead of the page ("Just a moment…", a Turnstile), marked with the response
header `cf-mitigated: challenge` on any status, usually 403 or 503
(`fetch/challenge.ts`). A plain request whose answer carries it says so in its
text: "Cloudflare is asking this site's visitors to prove they are human
before it shows the page." For a GET, when the vault has the browser added and
enabled and Chromium is found, PCP then reads the page again through the
browser (`browser/solve.ts`). The read happens in a second browser context
of its own, beside the vault's: it starts from none of the vault's sign-ins
and is never saved, because the sign-ins are never used for a web_fetch. A
plain request keeps no cookie and reads no secret, and a page read with the
owner's sign-ins would show an assistant what only the owner can see, under
a level given for a fetch. What that context keeps (the clearance a check
leaves, and any other cookie a site sets while read) is shared by every
token's web_fetch until the browser closes: they are reads signed in to
nothing, of sites each token was allowed to fetch. The context may open that one site only; a redirect to
another site is reported as web_fetch reports one, with where it points, so
that site gets its own decision. The token's own private-address line decides
private addresses for that site, as for the plain request, and the token's
decision for the site comes first: the browser only reads again what the
token was already allowed to fetch. The read waits up to twenty seconds for a
check that passes on its own and is bounded by 45 seconds in all, with at
most two such pages per vault at once. They are not tabs: nobody lists,
watches or drives them. The answer has web_fetch's usual format, with a Type
line saying the page was read through PCP's browser, after the site's check.
A site whose check passed is read through the browser first for thirty
minutes, per vault and in memory only: what passed is a bot check, not a
sign-in, and a restart forgets it. When the check does not pass, or there is
no browser, the answer says so and adds one hint: to open the site with
`navigate` and call `hand_over` (when the token reaches the browser), that
the owner can let the token use the browser, or that the owner can add the
browser on PCP's Browser page. Nothing here asks the owner, and there is no
new kind of permission request. It needs nothing more than the browser: the
container image and the desktop app run it as they run any page, with no
second container.

**Bounded** (`fetch/limits.ts`). Thirty seconds per request with its
redirects, 2 MB of an answer read, a thousand method and site lines per
vault, and 120 requests per token per ten minutes, asked about or not. The
second read of a page behind a check has limits of its own (see Browser).

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
  (`call`, `read`, `keep`, `tools`, `step`, `image`, `video`) and `console`;
  only strings cross, both ways, so the host never holds one of the
  program's objects. Memory is a
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
  `keep`), `read` (one of the token's own kept results, as text), `keep`
  (a text kept as a result of the token's, returning its handle), `tools`
  and `media` (below). A handle
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
  call for `check_permission`, and Always allow (or Allow for, while it
  lasts) lets the next run make it.
  An allowed tool runs through `runCodeCall` (`permissions.ts`), the same
  upstream path as `runCall`, with the answer turned into a value by
  `answerValue` (`answers.ts`): the JSON whole rather than a preview, its
  longest texts kept as handles when it is over the limit, and files (base64
  that decodes to one, image, audio and file blocks) kept as handles on
  sight, so their bytes never enter the program. An OAuth server to connect
  or a browser site to allow stops the run the same way, with its link.

**Images and videos** (`code/media.ts`, the bridge's `media` operation) are
there so an assistant looks at a small picture rather than a large one.
`pcp.image.compress(handle, options)` sends the handle and the options as
JSON, never the bytes: PCP opens the token's own kept result, checks by its
first bytes that it is a PNG, JPEG, WebP or GIF of at most
`MAX_IMAGE_PIXELS` (50 million, from the header, before anything is
decoded), crops, fits, greys and encodes it as JPEG, WebP or PNG, and keeps
the result as a new result of the token's, refused when it comes out past
the largest file. The codec is sharp's WebAssembly build
(`@img/sharp-wasm32`) in PCP's process: sharp's native packages are left out
of the install (`ignoredOptionalDependencies` in `pnpm-workspace.yaml`), so
its loader takes the WebAssembly in the container, a checkout and the Mac app
alike, with no native code and nothing for `allowBuilds`; the `.wasm` it
reads by path is named in `outputFileTracingIncludes`
(`scripts/standalone.test.ts`). Images take turns, one at a time in the
process, with libvips's cache off, one thread and a 30-second timeout, and
what it writes has no metadata. `pcp.video.frames` hands the job to the
sandbox (below): the bridge runs `sandbox/pcp.py`'s `frames` there as a
Python program, with a bridge of its own that reads only that video and keeps
only JPEGs, through the run's own `read` and `keep`, so ffmpeg never runs in
PCP's process; with no runner connected it says video needs one. A program
already in the sandbox calls `pcp frames` itself (the runner, running it,
could not take another job for it). Each image and each frame counts as a
keep, with `MAX_MEDIA_PER_RUN` (20) images and videos a run; like keeps,
they are not in the request log.

**The sandbox** (`code/sandbox.ts`, `sandbox/`, `docker-compose.sandbox.yaml`)
is a second executor behind the same bridge, for installs that run PCP in
Docker or Podman: a container with bash, `jq`, ffmpeg (Debian's package, for
`pcp frames`) and Python 3 where a program in `bash` or `python` runs. It has no network (`network_mode: none`), a
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
file it owns, and every System V shared memory segment, semaphore set and
message queue and POSIX message queue it made (they outlive their processes),
so nothing of one program, which may be another token's, is
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

**Runs, and a run that outlives its call.** Claude Code gives up on a tool
call after 60 seconds, and a client's disconnect may never reach PCP (the
connection stays open until PCP answers; in stateless mode a
`notifications/cancelled` reaches a fresh server, not the one running), so
run_code cannot learn in time that nobody is waiting. It does not try to:

- Every run (run_code's, and a wrapper tool's) has an id, `run_` and random
  hex, and a trace (`code/runs.ts`) of its calls: server, tool, how it went
  (ok, error, asked the owner, refused, under way), how long it took, and
  whether its server marks it read-only (`read-only.ts markedReadOnly`, as
  `call_read_only_tool` decides). The trace never holds arguments or
  results. Every answer but a plain success says the run's id and state,
  the exit reason (uncaught error, wall-clock, CPU, call or memory limit,
  the client went away, stopped for the owner's answer, or PCP failing
  around it, whose catch in `runProgram` keeps what the program printed),
  the error and what it printed, and the calls that change things that
  completed, with a warning to check them before running it again when
  there are any. A call that changes things and failed on its way (a
  `PcpError` "upstream": not reached, timed out) is marked as one that may
  have gone through; `call_tool` says the same in one line.
- run_code answers at most `RUN_ANSWER_MS` (45 seconds) after it started.
  A program not done by then, or whose request's signal aborted, is not
  stopped: it goes on within `RUN_TIMEOUT_MS`, and the answer says it is
  still running, with its id and its calls so far. Its calls run on the
  run's own signal, which aborts when the run is over, never when the
  client leaves; the bridge hands it, with the run's id, to
  `callServerTool` (`runId`, `signal`), for the browser. When such a run
  ends, its whole outcome (the answer it would have given, and its calls)
  is kept as a result of the token's own (`tool-results.ts`: encrypted,
  gone after a day, never logged), and an in-memory map from run id to that
  result is all PCP holds of it. `check_run(id)` waits up to 45 seconds for
  a run still going and answers with its state or its kept outcome; a run
  is its token's own, so another token's id (and any id after a restart,
  which also ends an unfinished run) is unknown. While either call is held
  open and the request carried a `progressToken`, PCP sends
  `notifications/progress` every `RUN_PROGRESS_MS` (15 seconds).
- The same program (the SHA-256 of its language and text, not the text)
  from the same token while a run of it is going, or within
  `DUPLICATE_RUN_MS` (5 minutes) of its end, is answered with that run's
  id, state and calls instead of running again; `rerun: true` runs it all
  the same. A run that stopped for the owner is not held to this: its
  answer says to run it again once they have answered.

A wrapper's run reports the same way but does not outlive its call: it
stops when its request goes away, as before.

## Wrappers

A wrapper is a server of its own (`mcp_server.kind = "wrapper"`, its url the
fixed `pcp:wrapper`) whose tools are programs over the vault's other tools:
a cleaner way to use a long-winded server, written by an assistant or the
owner. A tool takes fewer arguments, fills in the rest, makes several calls
as one, cuts an answer to what matters, or puts a secret where an API wants
it in its arguments. `lib/core/wrappers/` holds it:

- **The definition** (`definition.ts`, the `wrapper_spec` row beside the
  server, like an endpoint's schema) is each tool's name, description,
  input schema, optionally an output schema, hints, program, the tools its
  program `calls`, and the ones it `replaces`; and the wrapper's secret
  bindings and `callLevels` (below). The output schema, `callLevels` "approved"
  and nothing else new are stored only when set, so a definition written
  before them reads, and hashes, as it always did. Other tools are named by
  server id, never by short name, so a server added later under the same
  short name inherits nothing. `resolveDefinition` checks a proposed one
  whole: every tool named exists (for an assistant, is one of its own it is
  not blocked from), none is a wrapper's (wrappers do not nest), every
  program compiles (QuickJS with `compileOnly`, `code/quickjs.ts
checkSyntax`), nothing has a character that does not show on screen
  (`hiddenCharacter`, as for shared memories: the name, descriptions and
  titles lose their emoji presentation selectors first; a program, a
  schema, a secret's argument pointer and template refuse them too), and
  the sizes in
  `wrappers/limits.ts` hold (a program is 20,000 characters at most, for the
  owner to read). The catalogue's rows for the wrapper's tools are built
  from it (`catalogue.ts`); the row's `operation` carries the calls and
  replaced tools, so the gateway reads levels without loading programs.
- **Running a tool** (`run.ts`) is run_code's machinery with less reach:
  `code/run.ts runProgram` runs the program in a fresh QuickJS instance,
  with the caller's arguments handed in as text and parsed inside the engine
  as `args`, and logs each of its calls under `wrapper`. Its `pcp.call`
  reaches only the tools listed in that tool's `calls`, through
  `runCodeCall` like a run_code call (at the calling token's own levels, or on
  the owner's approval: Levels, below); a call to anything else is an error
  the program sees. The arguments are checked against the tool's schema at
  the top level first. What it returns is the tool's answer (a string as it
  is, anything else as JSON), shaped by `runCall` as any tool's is. When the
  tool has an `outputSchema`, the return is checked against it first
  (`schema-check.ts`: type, enum, const, required, properties,
  additionalProperties, items, anyOf, oneOf and allOf, bounded in values and
  depth; formats and ranges are not checked, and no schema is compiled to
  code); one that does not fit is an error naming where, not passed on.
  `describe` shows the schema as an outline under `returns`
  (`openapi/outline.ts outlineSchema`), and the owner reads it in full on
  the request. A `$ref` is refused when it is saved, not followed. Gateway calls and the owner's allowed requests
  run with `withWrappers(executor)`, which sends a wrapper's tool to its
  program and every other call to the executor underneath, so a program's
  own calls can never reach a wrapper.
- **Levels.** A definition's `callLevels` says whose levels the calls inside
  its tools follow, and the owner is shown which on every request. A new
  wrapper is **"approved"** unless it asks for "token": the owner's approval
  of the wrapper is the level for the calls its tools list, so
  `loadGatewayServers` gives a tool its own level alone, and `innerCall`
  (`run.ts`) finds the target among the vault's servers rather than the
  token's, skips the token's levels for it, and refuses only a server that is
  switched off or a tool the wrapper does not list. A token needs a level for
  the wrapper's tool and nothing for the server behind it, which is how a
  wrapper replaces a server that is then hidden from search; the request
  says the wrapper lets any token with a level for its tool make those calls.
  Secrets, the request log, kept results and the token's rate limits are
  unchanged. A definition without `callLevels` is **"token"**, as every
  wrapper was before it existed, and an assistant's update keeps the mode
  unless it names one. In "token" mode a wrapper's tool never reaches what
  the token could not:
  `loadGatewayServers` (`gateway-servers.ts`) gives it the strictest of its
  own level and of every tool it calls, a tool outside the token's servers
  counting as blocked. It is blocked for a token wherever one of its calls
  is, and asks wherever one of them asks. When the owner allows such a call
  (a `call` request like any other; the page names the tools it may call),
  the program runs with `approved`, so a tool that would ask runs in that
  run as often as the program calls it, with the arguments it works out (up
  to run_code's `MAX_CALLS_PER_RUN`), and the page says so; one that is
  blocked stays refused, and nothing asks again inside it. A run that was not allowed by the owner never makes a call that asks.
  Always allow writes only the wrapper tool's own level, which the
  strictest-level rule keeps asking while a tool it calls asks.
- **Secrets** go in only as a placeholder, `{"$secret": "<name>"}`, in a
  call the program makes, and only where a binding the owner approved names
  that very place: the secret, the tool (by server id), the argument (a JSON
  Pointer), how it is written (`{{secret}}` in a template) and the server's
  address as approved. `run.ts` hands the call the tool's bindings as a
  grant; `upstream.ts callServerTool` matches every placeholder to one
  (`placeholders.ts`) before anything is read or sent, refuses any other,
  refuses a server whose address changed since, puts one into the browser
  only as `type`'s text and only through the browser's own gate (see
  Browser, Secrets in pages), reads the value (`readSecretValue`) and writes
  it in. The values
  are taken out of the answer (`scrubResult`, `openapi/redact.ts`: text,
  structured content, text resources, and an endpoint's or a mail account's
  own redaction), out of errors and out of the status the server page shows,
  before the program or the assistant sees them. A placeholder in an
  assistant's own call is refused by `resolveCall`, but as the browser's
  `type` text (Browser, Secrets in pages). Scrubbing cannot catch a
  value a tool transforms or stores and answers with later: the owner's
  review of the place a secret goes is what decides, and the page says so.
- **Replacing.** A tool listed in `replaces` (it has to be among the
  tool's `calls`) is left out of `search`, `list_tools`, `pcp.tools`
  and the instructions' counts (`listedTools`) for a token while the
  wrapper's tool is not blocked for it; it can still be called and
  described by name, and `describe` says what replaced it. The owner
  shows it again from the server's page (`showReplacedTool`, which takes it
  out of every wrapper's lists).
- **Changes** (`admin.ts`). A token made with "propose wrappers"
  (`api_token.manage_wrappers`, off unless the owner turns it on) gets
  `get_wrapper`, `create_wrapper`, `update_wrapper` and `delete_wrapper`.
  Each change is a permission request (`wrapper_change`) and nothing else:
  it is checked as if it were being made, and the owner is shown every
  tool new, changed (with the program before) or removed, every schema,
  call and replaced tool, and every place a secret would go with the
  server's address (`WrapperShown`, worked out when the request is made, as
  an endpoint change's is). A secret PCP does not hold yet is typed in on
  the page, as for `register_server`. `applyWrapperChange` writes exactly
  what was shown, and only to the wrapper as it was when the owner was
  asked (`basis`: the definition's hash, name and description), else
  nothing. The request's row names no server, so deleting the wrapper keeps
  its outcome. A binding the owner approved keeps its secret through later
  changes, even if the secret is renamed. `create_wrapper` with `definition`
  proposes another wrapper of one the token sees, and `update_wrapper`'s
  `detach` and `note` ask for a definition of its own and the owner's note
  (Definitions and instances, above). Requests are limited to 20 per
  token in ten minutes and a vault to 50 wrappers. The owner adds and edits
  wrappers directly on the Servers page (`saveWrapperByOwner`, the same
  checks, with secrets they hold).
- **Browser flows.** A site task an assistant did step by step (snapshot,
  find, click, type) becomes one parameterized call as a wrapper whose
  tools call the browser's tools: no executor, approval path or column of
  its own. A tool is a flow when its `calls` name a tool of a browser
  server, and a wrapper is one when any tool is (`definition.ts isFlowTool`,
  `isFlow`, `flowWrapperIds`): derived from the definition, never stored,
  so its hash is unchanged. A flow's tools start at "ask" for every token
  like any new tool (`DEFAULT_TOOL_ACCESS`; a read-only one follows that
  default too), and nothing about a flow lifts or writes a level: the
  owner's own and their answers decide, and the instructions tell the
  assistant to leave one that sends, buys or deletes at "ask". The browser
  still opens only the sites the calling token's lines allow, and pacing
  (`browser/call.ts`) holds its actions wherever it runs. A flow's run may
  take `FLOW_RUN_TIMEOUT_MS` (2.5 minutes, as pages and pacing waits count)
  rather than `WRAPPER_RUN_TIMEOUT_MS`, still under run_code's
  `RUN_TIMEOUT_MS`. The owner's review (`WrapperShown.flow`, each tool's
  `flow` and `sites`) marks it "Browser flow", as the Servers list and the
  wrapper's page do, and lists the sites it opens: string literals and the
  fixed start of templates in its `tabs`/`navigate` calls' `url`, and
  whether an address comes from its arguments or is worked out as it runs
  (`flow-sites.ts`, a best-effort reading of the text, which the page says).
  An assistant that reaches the browser and proposes wrappers is told how
  to write one (`FLOW_INSTRUCTIONS` in `gateway.ts`, and in brief in
  `create_wrapper`): its own tab, elements by role and name, an argument
  for every value, check first and return `{already: true}`, confirm after
  acting, `hand_over` and stop on a CAPTCHA, sign-in or surprise.
- **From run_code.** A program's `pcp.call` reaches a wrapper's tool the
  token may call as any other: `resolveCall` at the token's level for it,
  then `runCodeCall` with `withWrappers`, which runs the tool's program in a
  QuickJS instance of its own under the "wrapper" count of programs at once
  (`runProgram`'s `runningBy`), apart from run_code's, so the outer program
  never waits on a slot it holds itself; a wrapper past that count answers
  busy, an error the program sees. Its calls are paced in `callServerTool`
  and the browser's call path as everywhere. The two runs name each other:
  the inner run's id is handed back through `CallOptions.onRun` into the
  outer trace's entry for the call (`- chat/post_message (run run_…)`), and
  the inner answer's report says `called from run run_…`.
- **Steps.** `pcp.step(name, fn)` is part of the program's runtime
  (`code/quickjs.ts`'s prelude, so run_code has it too), not a bridge
  operation: it runs `fn`, sends the step's name (cut to
  `MAX_STEP_NAME_CHARS`, on one line) with each call made in it, which the
  trace shows (`- browser/click (step 'send it'): ok`), and rethrows an error
  from it as "failed at step '…': …", with `error.step` set for a program
  that catches it; an outer step passes an error an inner one named on as
  it is. Steps are meant one after another: run side by side, a call
  carries whichever began last.

## Browser

The browser is a server of kind `browser`, one per vault, added by the
owner on the Browser page (`url` is the fixed `pcp:browser`). Its tools are
a fixed catalogue (`lib/core/browser/tools.ts`) written with `storeTools`
like a mail account's, and `upstream.ts` hands its calls to
`lib/core/browser/call.ts` with the calling token. So it is found, levelled,
proposed for and called like any server, and a long snapshot is kept for
`read_result` by `runCall` like any long answer.

**What runs** (`runtime.ts`). One Chromium per vault, driven by
`patchright-core`, started on the first page opened (by an assistant or the
owner) and closed after the owner's idle minutes (Settings → Resources,
`resourceLimits().browserIdleMs`: an hour unless set, 5 minutes to 8 hours)
with no tool call, no input, nobody watching a tab (the live view's tick
counts, not only a new picture) and no hand-over waiting: a tab held for a
hand-over whose request can still be answered keeps it open
(`idle.ts`). How it runs is `launch.ts`'s: in the container image with
windows on a virtual display, in the desktop app (and on a Mac or Windows
machine) with a window of its own kept off the screen, both below, and
headless anywhere else. The registry is on `globalThis`, as the network's is,
because the gateway, the actions and the route handlers are bundled apart.
Chromium runs with one in-memory context for the vault (and one more,
made on the first page read for web_fetch, for all of those, below): no
profile is written to disk.
Its config and cache folders (`XDG_CONFIG_HOME`, `XDG_CACHE_HOME`) are a
private temporary folder of its own, removed once it has closed: its crash
reporter keeps its database there, and without a folder it can write to
(a system user with no home, as the Docker image runs as) Chromium can abort
as it starts. It starts without `--enable-automation`, with
`--disable-blink-features=AutomationControlled`, and with
`--disable-popup-blocking` and `--disable-back-forward-cache`, which
patchright-core leaves out (script-opened popups reach the gate, and a back
navigation always loads a document, so the check watch sees its response).
Its user agent is a desktop one without "Headless" when headless, and
Chromium's own, with its complete client hints, when there is a window (on
the virtual display or in the desktop app); headless, its `platformVersion`
hint stays blank. The locale and time zone are the container process's
(`LANG` and `TZ`, which the installer passes in from the host; Compose users
set them), and the viewport is 1280 by 800. Service workers are refused, not
by an option (a service worker could answer a navigation without the network,
around the gate): the gate refuses a service worker's script request itself
(one marked `Service-Worker: script`), so registration fails, and no script is
injected into the page to overwrite `navigator.serviceWorker.register` (which
a page could see is not native, and go around through the prototype).
Chromium's own sandbox is used where the machine
gives one and dropped where it cannot (root, or an unprivileged container;
the Docker image says so with `PCP_BROWSER_SANDBOX=off`). Without it a
renderer exploit runs as PCP's user with the data directory in reach, and the
automatic fallback tells no one; SECURITY.md lists that as not defended
against.

**The virtual display** (`display.ts`). In the container image
(`PCP_CONTAINER=1`), or on another Linux machine with
`PCP_BROWSER_DISPLAY=virtual`, Chromium runs as a desktop's Chrome does, with
a window around each page, on a screen PCP starts itself: one Xvfb per
process (1920 by 1080), started with the first browser and stopped when the
last one closes. A site's check then sees a browser with a window, not one
whose window is exactly the page. The display takes only clients that show
its cookie, kept in a private folder and handed to Chromium alone, so
another program on the machine cannot watch the browser or type into it.
How Chromium draws there is `rendererFor`'s choice, a pure function of
whether the container has a GPU render node (`/dev/dri/renderD*`) PCP's user
may read and write (`hasRenderNode`), which `displayRenderer` says in the log
as "GPU" or "software" and nothing of the device. With one, ANGLE runs on the machine's Vulkan driver (Mesa's radv or
anv, in the image) with Chromium's documented switches for a GPU without a
desktop session: `--use-angle=vulkan`, `--enable-features=Vulkan` and
`--disable-vulkan-surface` (a GPU's Vulkan driver presents to an X server
only through DRI3, which Xvfb lacks, so frames reach the window by a copy).
No `--ignore-gpu-blocklist`. Without one, WebGL is Chromium's software
renderer (SwiftShader), as headless uses by itself. `--enable-unsafe-swiftshader`
is there either way: it does not force software, it lets WebGL fall back to
SwiftShader when the GPU does not start (a card Mesa has no driver for,
NVIDIA's), where it would otherwise be gone. The image takes Mesa's own
software Vulkan driver (lavapipe) out of the loader's list, since Chromium
would pick it on such a card, block it as software and leave no WebGL at all.
The installer passes `/dev/dri` in, with the node's group where PCP's user
needs it (docs/self-hosting.md). Chromium's RenderDocument is off there:
with it (Chromium 153) a script that runs while a new document loads often
reads the window as 0 by 0 at 0,0 until the window's place reaches it, which
no desktop's Chrome shows. Chromium keeps only the last `--disable-features`
and `--enable-features` it is given, so PCP's lists carry the driver's own
too, and a test checks them against the patchright-core installed. An Xvfb that does not start leaves the
browser headless; `PCP_BROWSER_DISPLAY=headless` asks for that. The desktop
app never uses it: it starts no child process, and runs on a real screen.

**A window of its own** (`launch.ts`). In the desktop app (`PCP_DESKTOP=1`),
and on a Mac or Windows machine otherwise, Chromium runs with a window on the
machine's own screen, kept out of the owner's way. `--window-position` puts
every window Chromium opens by itself far to the left of every screen
(`OFF_SCREEN_WINDOW`: macOS keeps a window's top edge on a screen, not its
left one), and `keepOffScreen` moves each tab's window there as PCP takes the
page in, a popup's too (a popup first opens where its page asked, on the
screen). It is not minimized: a minimized window's page is hidden to its
scripts and stops drawing, and the live view with it. An off-screen window
only counts as covered, and patchright-core's own
`--disable-backgrounding-occluded-windows`, `--disable-renderer-backgrounding`
and `--disable-background-timer-throttling` keep its page painting and its
timers running (a test checks that patchright-core still passes them). Off
the screen, a page would read its window's place as thousands of pixels left
of the screen it is told of, so it is told a place on that screen instead
(`SHOWN_WINDOW_POSITION`), through the device-metrics emulation patchright-core
tells it the screen with, sent again with the position on the tab's own
DevTools session (input PCP sends reports a screen position from the page's
own either way). Chromium is still started by patchright-core, as a child of
PCP's process (the server's utility process in the desktop app), as it was
headless; only its switches differ. None of the virtual display's switches
are among them: a windowed Chromium on the machine's own screen draws with
its graphics card by itself. A window that does not open leaves the
browser headless, and `PCP_BROWSER_DISPLAY=headless` asks for that anywhere.
On macOS the windowed Chromium is an app of its own: it shows in the Dock
while it runs, and Chromium makes it the active app when it shows a window as
the active one, which would take the keyboard from the app the owner is
typing in and could send their keys into a page an assistant drives. So PCP
opens its own pages (tabs, a reopened tab, web_fetch's pages) in the
background (`openPage`): with `Target.createTarget` and `background`, which
shows the window inactive, and `newWindow`, since a background tab in a
window it shares would be hidden and stop drawing (Playwright's `newPage`
opened a second tab in the first one's window), at `OFF_SCREEN_WINDOW`. The
page Playwright makes of that target is picked out by its target id
(`Target.getTargetInfo` on its own session), and `keepOffScreen` follows as
for every page. Playwright does not tell a context's id in Chromium, so
`newBrowserContext` notes the one `Target.getBrowserContexts` lists once the
context is made. If any of that fails, the page opens as Playwright opens it,
said once in the log. A popup a page opens is still Chromium's own and may
take the focus; `keepOffScreen` moves it. Headless and on the virtual display
there is no focus to take, and pages open as Playwright opens them.

**Sites that check their visitors.** Every context tells pages of a 1920 by
1080 screen, since headless would otherwise make the screen the 1280 by 800
viewport itself. It is the full Chromium, headless or windowed: PCP always
passes the executable, so Playwright never picks its separate headless
shell (the Docker image does not download it). `navigate`, and an action that
can load a page (`back`, a click, typing, a key, a choice, a dialog's
answer), waits up to twenty seconds for a check that passes on its own
(Cloudflare's, marked `cf-mitigated: challenge`). One that does not stays on
the page. The answer leads with the sentence web_fetch uses for it and adds
that the check did not pass on its own in this tab and that `hand_over` is
how the owner passes it themselves; so does every later answer about the tab
(a snapshot, `read_page`, `wait_for`). The assistant decides: nothing asks the
owner automatically. A clearance cookie a passed check sets lands in the
vault's profile, as any cookie does. PCP adds no stealth scripts. It drives Chromium
with `patchright-core`, which does not turn on the DevTools `Runtime` domain in
every frame as stock Playwright does, so those page-level traces are not left
for a check in a cross-origin iframe (Cloudflare Turnstile's, for one) to find.
The image adds a desktop's fonts (DejaVu, Noto Sans and Serif, Cantarell) to
Playwright's, whose set alone no person's computer has (a check found
exactly its 36 fonts), and draws with the GPU on the virtual display when
the container has one (above). Some tells remain: WebGL is SwiftShader
(software rendering) headless, and on the virtual display without a GPU (or
with an NVIDIA one), headless the window is exactly the viewport (Playwright
sizes it so, and Chromium's `--window-size` does not change that; with a
window, on the virtual display or of its own, it is not),
`screen.availHeight` equals the screen height, and a home address that reaches
the page through a container's network may not look like a person's. A
click sent through the DevTools protocol into a cross-site frame (a
Turnstile checkbox) carried the frame's own coordinates as its screen
position up to about Chromium 141, which a check could tell from a mouse;
the Chromium that `patchright-core` drives (153) reports a mouse's. The
strictest checks may still want a person, which is what `hand_over` is for.
What a page sees is measured by hand, not in CI: `scripts/fingerprint/` has a
page that records it as JSON (`harness.html`), a script that ranks how two
browsers differ (`diff.mjs`), and the list of live checks to run again after
a Chromium or Playwright upgrade (its README).

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
Starting the browser for a page read for web_fetch loads the profile into the
vault's own context as any start does; the read happens in a context of its
own, which never touches the profile and is never saved.

**Which pages open** (the gate in `runtime.ts`). A page's main frame loads
nothing the gate has not passed: the DevTools protocol pauses each document
request (redirects included) before it is sent. It passes when the owner
drives the tab, when the owner allowed the site for this tab, or when the
web fetch lines of the token whose tab it is give GET to that site
`allowed`; never PCP's own site. Otherwise it is answered with 204, which
leaves the tab on the page it was on, and the next answer says which site
was stopped and puts it on the token's page (a line of its own on first
sight, as web fetch does). Frames inside a page and subresources are not
gated per site. `navigate` and `tabs` decide before anything opens, with
`decideSite` (web-fetch.ts): blocked is refused; ask throws `OwnerNeeded`,
which `runCall` turns into a `browse` request offering Allow once (the site
for that tab while it is open), Allow this site for (an allowance, as for
web fetch), Always allow this site and Block this site (the token's site
line, as for web fetch) and Not now. A popup becomes a tab
of the tab that opened it, which that tab's next answer names by its id. The gate is the browser's, not a tab's (`Fetch`
on the browser's own DevTools session, on before the first page exists), so
it holds a popup from its very first request, before Playwright has
reported the popup: until then the popup opens only what the tab that
opened it may open, and is closed instead of opening anything else, or when
the browser has no room for another tab. A token whose `navigate` tool is
at ask is asked once: the call's request shows the address, and when the
owner allows the call, `runCall` (told so by `executeCall`) opens the site
for that tab as Allow once would, with no `browse` request after it. Only
`navigate` and `tabs` ask about a site, and only for the address in their
arguments, so the site is always one the owner saw. A blocked site stays
blocked, and a hand-over during such a call is still asked. A page read for
web_fetch (see Web fetch) passes the gate for its one site only, the site the
token was just allowed to fetch. It is not a tab: nobody lists, watches or
drives it.

**Which addresses it reaches** (`proxy.ts`). Every connection goes through
a forward proxy on 127.0.0.1 (`--proxy-server`, with loopback not
bypassed; QUIC off and WebRTC kept to the proxy, since UDP would go around
it). PCP resolves each name, checks every address, and dials the one it
checked, for pages, redirects, scripts and images alike, as web fetch's
transport does. Public addresses pass; private ones pass while an open tab
belongs to a token whose `private` line allows them (the proxy cannot tell
which tab a connection is for, so this is per browser; tabs the owner opens
follow the line for all tokens); PCP's own address never. Refusals are
remembered for half a minute so an answer can say why a page did not open.
Hosts are never logged.

**What an assistant gets.** The tools are `tabs`, `navigate`, `back`,
`snapshot`, `read_page`, `find`, `click`, `type`, `press_key`,
`select_option`, `upload_file`, `scroll`, `wait_for`, `screenshot`,
`download`, `handle_dialog`, `hand_over` and `request_secret`. Every one but
`tabs`' open and list and `request_secret` names its tab (below). An assistant reads a snapshot (Playwright's
accessibility tree with refs), `find`'s elements of it as JSON (role, name,
ref, states, and the landmark or region each is in, which tells two lines
that read the same apart; `within` searches one element), the page as
Markdown (`read-page.ts`: `htmlToMarkdown` of the live page, or of one
element or its main part, less what its HTML hides and code blocks of JSON
data, which a site's app carries hidden; web_fetch's Markdown is
unchanged), a screenshot of the viewport or of one element, and the tab's
address, title and the link to it in PCP. It acts by ref, or by a target
(`target.ts`: a role and a name, as Playwright's `getByRole` finds them,
optionally `exact`, the `nth` of several, `within` an element), which a
program can name without a snapshot; a target that is not exactly one
element is refused with the ones it could mean. A click is scrolled into
view first (`force` skips Playwright's checks), and one that cannot happen
says why from Playwright's call log (`failures.ts`: what covers the
element, by its role and label, or that it is hidden, disabled or gone),
with a short snapshot. A screenshot steps its quality, then its size, down
until it fits what an answer passes on inline (`MAX_ANSWER_IMAGE_CHARS`,
an image's own budget, apart from the text's); one that never fits is kept
and handed back as its handle. While the page shows a dialog (an alert),
every tool that needs the page answers at once with it and how to answer
it with `handle_dialog`, rather than waiting on a page that cannot answer.
It never gets a cookie or storage and never runs JavaScript. A
refusal that names a site or an address is a tool
error, not a thrown `PcpError`, whose text the request log would keep.

**Secrets in pages** (`lib/core/browser-secrets.ts`, `call.ts`, `held.ts`).
A secret goes into a page only as `type`'s text, `{"$secret": name}`: in an
assistant's call (`resolveCall` lets it through there and nowhere else),
from run_code's `pcp.call`, or from a wrapper or flow whose binding names
`browser/type` at `/text` with no template (`definition.ts`). Any other
browser tool or argument is refused, in `resolveCall` and in `upstream.ts`.
`upstream.ts callBrowser` is the one path: it hands `callBrowserTool` a
`SecretTyper`, never a value. The browser resolves the field (ref or
target), checks it is an input or textarea, that the page is at an http(s)
origin and that the frame the field is in has that same origin (a field in a
frame from another site is refused), and only then asks the typer for the
value, with the origin as it is then. The typer is the gate
(`admitSecretUse`): the secret by name (text or TOTP only), and the token's
allowance for it at that origin (`ApiTokenSecretAllowance`: once, an hour,
or always while the origin is the secret's, `SecretBrowserOrigin`). With
none it throws `OwnerNeeded` for a `secret_use` request: the secret's name,
the origin, the page, the field and the tab live; Allow once, Allow for 1
hour and Always allow (which binds the origin) write the allowance and make
the type call again through the same path (a once allowance the call did not
use is dropped); there is no Block, and no answer changes the tool's level.
That an API endpoint sends the secret never counts. Past the gate,
`secrets.ts readTypedValue` decrypts it (a TOTP secret's code of the moment,
RFC 6238 in `totp.ts`, the seed never leaving `secrets.ts`); the browser
clears and focuses the field, checks again that the page, the frame and the
focus (in the field's frame and each frame around it) are where they were,
and types it with CDP `Input.insertText`. The page then holds it (`held.ts`:
the secret's name and an HMAC of the field's value under a key of the
process, never the value, by page, in memory): while any field of the page
has that value, every answer to the token shows it as `[secret: name]`
(the snapshot's field line, and the value wherever else it appears, a title
included), and `screenshot` is refused (a tool error). It lets go when no
field has the value any more: the field changed, or a new document does not
have it. Every password field's value reads as `[password]` in a snapshot,
typed by anyone. `upstream.ts` scrubs the value from the answer and any error
too, and the request log notes the secret's name and the origin on the
call's line (`noteSecretTyped`; a use the owner's answer made gets a line of
its own), never the value. `request_secret` (name, purpose, origins, kind
text or totp) checks its arguments and refuses a name PCP holds (no
assistant writes over a secret), then throws `OwnerNeeded` for a
`secret_request`: the owner types the value (or the seed) on PCP's page, may
change the origins, and saves it with the requesting token's allowance at
each (one use, an hour, or always); the assistant hears the name. Origins
are exported; allowances are not, are listed with End on the token's page
and on the secret's row under Secrets, and are pruned once run out.

**Turns and deadlines** (`queue.ts`). The calls on one tab run one at a
time, in its own lane, so a slow page holds up only its tab. Each has a
deadline (`TAB_DEADLINE_MS`, above a page load, a check and a snapshot;
`DOWNLOAD_DEADLINE_MS` for a download): a tab whose call passes it is taken
to have stopped responding, its page closed and opened again at its
address through the gate (`reopenTab`; its id, token and allowed sites
stay), the lane goes on, and the call is told so in those words. A page
that crashes is reopened on the tab's next call, and `tabs` with action
reset does the same on request. Every page has Playwright's timeouts by
default, and what has none (its content, its title, a key press, a
DevTools call) is bounded. Only what changes the set of tabs holds the
whole browser, and briefly (`withVault`, `BROWSER_LOCK_DEADLINE_MS`):
opening or closing a tab, taking a popup in, closing the browser. Closing
a tab does not wait behind a call that hangs on it: that call ends with
the page. `tabs` list and the owner's own input wait for nothing. A caller
that gives up (an `AbortSignal` on the call, which run_code passes) stops
waiting at once and passes its turn on; what Playwright was already doing
finishes alone. One call waits for a download at a time, whichever its
tab; another meanwhile is told to try again. Profile saves run one at a
time, and none once the browser has closed, so a call that finished past
its deadline cannot write over a restore.

**Files** (`downloads.ts`, `call.ts`). A file crosses the browser only as a
result kept for the token (see Long answers and kept results): never a path on the
machine, and its bytes never pass through the assistant. `upload_file` names
kept results by handle (`{"$result": id}`, with a name and type of its own if
it likes), reads them as bytes before the page is touched, and hands them to
the file field, or to the file chooser a button opens, as a person choosing
them would; the page sends them only as it would then. Every tab catches its
file chooser, so none ever opens a window on the machine.

Playwright makes the vault's context with downloads off, and Chromium refuses
every download but while a `download` call waits for one. The call lets the
context save downloads into a folder in the browser's scratch folder, on a
DevTools session of PCP's own (Playwright's download objects can read nothing
in a context made with downloads off), clicks the ref or opens the address,
and takes the first download its tab, a frame in it, or a popup of it starts,
from an address the tab may open (`mayOpen`; a page's own blob or data file
is the page's). Every other download is cancelled as it begins, and the one
taken is cancelled once Chromium says it is larger than PCP keeps of one file
or slower than `DOWNLOAD_TIMEOUT_MS`. Its bytes are read and the file removed
before the call answers; it is kept, encrypted, as the token's result, and
the answer is its handle, so a run_code program can pass a download, or a
mail attachment, on to `upload_file` or `send_email`, and a token that moves
files by link can fetch it to its own computer (`share_result`), or send one
from there for `upload_file` (`receive_file`; see File links). A download a page
starts while no call waits is refused by Chromium and only said in the tab's
next answer, by the name the page gave, so the assistant can take it with
`download`. An address given to `download` must be at a site the tab may
open already; `navigate` is what asks the owner.

**Whose tab** (`call.ts`). A tab belongs to the token that opened it (its
`tokenId`; a popup is its opener's) or that the owner last handed it to,
and that token alone sees and drives it: `tabs` lists only its own, and
any tool given another token's tab, or the owner's own, is answered as for
a tab that does not exist, in the same words, so its address and title
never reach it. There is no current tab: every tool but `tabs`' open and
list names one, and a call that does not is refused (a tool error, with
the token's tabs by id, title and address), since two conversations on
one token would otherwise act on each other's tab. `tabs` open answers
with the new tab's id first. `navigate` naming such a tab opens a new
one of the token's own, and a `browse` request never names another token's
tab. So a site the owner allowed once stays with the token whose tab it
is, and no token reads a page another opened under its own lines. Before a
tool reads or acts on a page, the page's site is checked against the
token's lines as they are now (`mayOpen`, as the gate does): a page at a
site it may no longer open (its line changed since, or the tab's history
went back to a page the owner opened there) is refused, though the tab can
still be sent elsewhere or closed. The tabs share one profile, so the
sign-ins are every token's; the eight tabs are shared too, and a token
told the browser is full learns only how many are its own.

**The tabs view** (`app/(dashboard)/browser/page.tsx`,
`components/browser-tabs.tsx`, `browserOverview` in `owner.ts`). The
Browser page lists every open tab, every token's and the owner's: its icon,
title and site, who opened it and whose it is (the token's name), and its
state (idle, in use while a call holds its lane, or with you). The icon is
the one Chromium fetched for the page itself, through the tab and the
proxy as every request is: the tab's DevTools session follows the main
frame's responses of type Other (`favicon.ts`, with Network buffers bounded
by `MAX_FAVICON_BYTES`), reads the body of an image one once it has
arrived, and keeps it as a data: address, dropped when the main frame loads
another document. PCP fetches nothing for it, runs nothing in the page, and
the owner's own browser asks the site for nothing; a page without one shows
its site's first letter. `/browser?tab=<id>` shows that tab live under the
list; it is where `tabLink` points, and `/browser/tabs/<id>`, the tab's page
before the view, redirects there. A hand-over still waiting
(`waitingHandovers`, from the requests noted on the tab) shows on its tab
with the assistant's message and Done and Not now, answered through
`decidePermission` and the owner's queue like any request: `queueHref`
sends a `browser_handover` to `/browser?tab=<id>` while its tab is open
(`handoverTabOf`), and to its request's page once it is gone, and that page
redirects a pending hand-over whose tab is open to the tab. Its link to the
assistant stays the request's address, so it says how it ended once
answered.

**The owner's control.** A tab is driven by its assistant or by the owner.
Take over in the tabs view makes it the owner's, and every browser tool
refuses it until Hand back. A tab the owner opens is theirs, seen by no
token, until they hand it to one. Hand back gives the tab to the token the
owner picks (`handBackTab`, `giveTab`): one of the vault's tokens that is
neither revoked nor expired and reaches the browser, checked in the core
whatever the form sent. The page offers the token whose tab it was first;
a tab no token had yet waits for a choice. The token gets the tab as its
own (its lines read again), and the site the tab is at
counts as one the owner allowed for that tab, as Allow once does; handed to
another token than before, the tab first drops the sites allowed for the
one before, which were that token's. `hand_over` makes the tab the
owner's and throws `OwnerNeeded` for a `browser_handover` request, which
the tabs view shows on the tab, with the assistant's message; Done (or Not now) gives it
back to the token that handed it over, saves the profile, and is what
`check_permission` reports. A hand-over nobody answers goes back when its
request expires, or when the assistant withdraws it. The request is noted
on its tab (`noteHandoverRequest`), and a tab that closes (the owner's
Close, an assistant's, the page's own, or the browser closing) closes the
hand-overs still waiting for it (status `closed`), so none stays in the
bell for a tab that is gone.

**The live view** (`app/api/browser/tabs/[id]/`, `screencast.ts`,
`input.ts`, `components/browser-tab-view.tsx`). The tab chosen in the tabs view draws
Chromium's screencast (a JPEG each time the page repaints, shared by
everyone watching) on a canvas, streamed as server-sent events by a route
handler. The stream sends on only when its connection has room, keeping
the newest frame and skipping the rest, and a frame is acknowledged to
Chromium (which paints the next only then) once a viewer has sent it on:
the screencast runs at the fastest viewer's pace, and a viewer on a slow
link (through pcp.gg over a home upload) falls a frame behind, never a
queue of them. While the owner has the tab, their pointer (with the samples the
browser coalesced), wheel, keys and pastes go back in batches every 40 ms
to a second route, each event with the time it happened. They are replayed
through the DevTools protocol (`Input.dispatchMouseEvent` and
`dispatchKeyEvent`, which Chromium treats as a device's input: trusted
events), each at its own time plus a delay and stamped with it, so a
CAPTCHA reading the movement sees its real cadence. Presses carry `force` 0.5
while a button is down, and so do the moves made with one down, as a real
mouse reports it (`PointerEvent.pressure`). Input that arrives late
(a slow or uneven link) moves the replay further behind, up to 400 ms, so
what follows plays at its own pace instead of in a burst, and the delay
closes up by a millisecond an event while input arrives in time; a batch
more than 600 ms late starts a new clock. Events go out in order without
waiting for Chromium to acknowledge each: it acknowledges a mouse move only
with its next frame (about 17 ms), so waiting on every one would replay at
most sixty moves a second while a mouse reports hundreds, and the replay
would fall seconds behind. Chromium folds the moves into its frames, as it
does a real mouse's; should a move still wait a second unacknowledged,
further moves are dropped until it catches up, never a click or a key. The
input route answers once a batch is queued, not once it has played, since
the page sends one batch at a time. Coordinates are mapped with the frame's own
metadata. Both routes check PCP's origin and the owner's session, as the
export download does. A WebSocket would answer a little sooner, but needs a
server of its own around Next; the input's format is the same whatever
carries it.

A canvas takes no on-screen keyboard and no long press to paste, so on a
phone (`pointer: coarse`) the view also has a **Keyboard** and a **Paste**
button. Keyboard focuses a hidden text box beside the canvas. A soft keyboard
does not press keys: it composes, corrects and deletes words in the box, so
what goes to the page is the difference between the box before and after
each edit (`lib/browser-keyboard.ts`): Backspace for each letter taken out,
then a key for one letter or a `text` event for more. Keys with a name
(Enter, arrows, Tab) and shortcuts go as the keys they are, and Backspace
with an empty box to delete from does too. Nothing new reaches the server:
it is the same input events, so the limits on a batch are the same. Paste
reads the clipboard in the browser, and sends it as a `text` event; where the
browser will not hand it over (a page that is not secure, or you said no) a
box takes the text to paste into instead. Hand back sends what is still
queued, and waits for the answer, before the tab changes hands: input the
page refuses once the tab is not the owner's would be lost, and on a slow
connection the last keys are still on their way.

**Bounded** (`browser/limits.ts`). Eight tabs per vault, every token's and
the owner's together; thirty seconds per page load and ten per action
(every page's default), two for a title; a call's turn on its tab
(`TAB_DEADLINE_MS`, `DOWNLOAD_DEADLINE_MS`) and the browser's lock
(`BROWSER_LOCK_DEADLINE_MS`); a target's role and name, and the elements a
refusal lists; the snapshot a failed click answers with; screenshot's
qualities, sizes and narrowest width; 300
tool calls per token per ten minutes; four people watching a tab; and the
owner's input in batches of at most 500 events, 300 batches per session in
ten seconds, moves dropped while Chromium is a second behind. A check that may pass on its own is waited for twenty seconds
(`CHALLENGE_WAIT_MS`). A page read for web_fetch takes 45 seconds at most
(`SOLVE_TIMEOUT_MS`), two such pages per vault at once (`MAX_SOLVES`), and a
site whose check passed is remembered for thirty minutes
(`CLEARANCE_MEMORY_MS`).

**Chromium on the machine** (`executable.ts`, `install.ts`).
`PCP_BROWSER_EXECUTABLE`, then PCP's own install, then Playwright's own
variable and install location. The Docker image installs Chromium with
`patchright-core`'s CLI, at the version `patchright-core` drives; the desktop
app stages none.
Where none is found, the Browser page's **Install Chromium** downloads the
build `patchright-core` drives from the addresses Playwright pins for it
(read from `patchright-core/lib/coreBundle`'s registry, never from a
request), unpacks it with Playwright's own unzip into
`browsers/chromium-<revision>/` under the data folder, makes it executable
and writes Playwright's `INSTALLATION_COMPLETE` marker last, under a
temporary name until it is whole. It runs in PCP's process: Playwright's
installer downloads in a child process, and the desktop app's `runAsNode`
fuse is off, so it could not start one. The download is capped in size, in
time, and in time without a byte (`limits.ts`); one install runs at a time,
and the page follows its progress. The install is looked for by the
revision `patchright-core` drives, so after an update to a newer one the
page offers to install that, which removes the older build. Nothing runs
until the owner clicks.

## Pacing

Assistants act far faster than a person, and a site that sees a quick run of
automated actions can take the owner's account for a robot and flag it; a
small server or a busy page can be overloaded by one. The rate limits
(`lib/core/rate-limit.ts`) only refuse past a count; pacing
(`lib/core/pacing/`) spaces actions out, the same way whatever made them.

**Where it applies.** At two places, which every way of calling passes:

- `callServerTool` (`upstream.ts`), for a server's tools: MCP servers, API
  endpoints, mail and calendar accounts and SSH servers, paced by the
  server. call_tool and call_read_only_tool, run_code's `pcp.call`, a
  wrapper's calls and a call the owner allowed all end there. The browser's
  actions go through it too, and are paced in `browser/call.ts` by the tab's
  site (for a navigation, the site it opens), before the call queues on its
  tab: a wait for the site holds no lane and counts toward no deadline. A
  wrapper's own tool is not paced; the calls its program makes are.
- Web fetch's request path: `fetch/fetch.ts` paces each request it sends,
  every redirect it follows on the site included, and `web-fetch.ts`
  `runFetch` the read through the browser (`browser/solve.ts`), by the
  site. The owner's answer to a `fetch` request runs `runFetch` too.

Nothing at the gateway paces on its own: a new way in that reaches a server
or a site goes through one of these, and so is paced.

**Classes and defaults** (`pacing/limits.ts`, with why each is what it is).
`browser_act` (navigate, back, click, type, press_key, select_option,
upload_file, download, handle_dialog, scroll): 1.5 seconds between actions
on a site and up to 2.5 more at random. `web_fetch`: a second and up to 0.75
more. `server_change` (a tool its server does not mark read-only,
`read-only.ts markedReadOnly`): no pause, at most 30 a minute per server.
`server_read`: at most 300 a minute. The browser's reading tools (snapshot,
find, read_page, screenshot, wait_for, tabs, hand_over) are never paced:
they send the site nothing. Nothing names a site or a vendor.

**How a call waits** (`pacing/pace.ts`). State is in memory, per vault and
destination (`server:<id>` or `site:<host>`; web fetch and the browser share
a site's), on `globalThis`. A caller is given its slot the moment it asks,
in order (the last slot, the pause, and a random extra wait; then the burst
cap), so two callers never share one, and waits for it. A wait up to 30
seconds (`PACING_MAX_WAIT_MS`) is served; past it the call is answered at
once with a tool error ("Paced: <destination> takes its next action in N s;
try again then.") and takes no slot. A caller whose signal aborts (a
run_code run that ended) stops waiting and gives its slot back when no
later caller took one.

**The owner's own pace** (`pacing/config.ts`) is the vault's setting
`pacing` (the `setting` table), not the machine's: it names the owner's
sites and servers, travels with an export and goes with a deleted vault.
It holds overrides only: per class, per server (by id, on the server's
Advanced) and per site (a host, optionally with its subdomains), each a
pace or "unpaced". A call follows the most specific: the site's, then the
server's, then the class's, then PCP's default; bounds are checked in core
(`PACING_BOUNDS`), and a stored value that does not read as one counts as
none. Settings → Upkeep → Pacing shows the classes, a reset to PCP's
defaults, and the sites, folded.

`PCP_PACING=off` turns it off for a process: the unit and end-to-end suites
set it (`vitest.config.mts`, `playwright.config.ts`), and the tests that
check pacing turn it back on with a pretend clock (`setPacingClock`).

**A tab a program has.** A call that arrives while a run_code or wrapper
run's call has the tab (`Tab.running`, set for the lane's turn), from
another run or from none, is answered with one line first: "A running
program (run <id>) is acting on this tab right now; what you see may change
under it." It still runs.

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
  which tool, which upstream, how long, whether it worked, and whether it
  stopped to ask the owner (with the permission request's id). Never
  arguments or results. The Log page reads it back; the cleanup deletes the
  days older than the owner keeps (see "Cleanup and the log").
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
new API token, an export, a restore or deleting the vault with it instead
of typing the
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
  gives PCP's own pages, and only those (plain http on 127.0.0.1),
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
OAuth authorizations in flight, the request log or the `tls/` directory. An
app that signed in to PCP is like a session: its token comes along (with
its levels and memories), its credentials do not, and after a restore it
signs in again, where the owner can give it that token back.

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
transaction first checks that there is no vault, as `setupVault` does. Into
a vault that exists, the vault's browser is closed first (`withBrowserClosed`:
a call in flight finishes, the profile is saved with the owner's key, and no
browser starts until the rows are written), since a browser left running
would save its old sign-ins over the restored profile. The
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

**A restore keeps revocations.** A file made before the owner revoked a token
holds that token live, with a working wrapped key, so writing it as it is
would bring back an assistant the owner cut off. Into a vault that exists,
when the file is an export of that same vault (the ids match: a restore keeps
the vault's id), every token the file has live that the vault being replaced
has revoked, or no longer has, is written revoked (the vault's `revoked_at`,
or now for a deleted one) with its grant blanked as revoking blanks it
(`carriedRevocations`, read inside the transaction before the wipe). The
preview lists the file's tokens by name and prefix and marks those that
come back revoked. At setup, or for another PCP's export, the vault knows
nothing of them and the file is written as it is. A newer export of a vault
restored here from an older one has tokens this vault never had; they come
back revoked too, and the owner makes them again.

**Who may.** The export asks for the owner's password again (or Touch ID in
the Mac app: `confirmOwner`), as making a token does: a copied session
cookie may use the vault but not walk off with it. The restore, when signed
in, asks for it too, so a copied cookie cannot replace the owner's vault
with one it holds the password to; on the setup page there is no password
yet, and whoever reaches that page could set up instead. Both are
rate-limited like password attempts. The download is a route handler (an
action cannot send a file), so it checks the request's origin itself
(`lib/server/same-origin.ts`), which Server Actions get built in.

## Reaching PCP: pcp.gg, dynamic DNS and HTTPS

All three are optional, off until the owner turns them on (in the step after
setup or under Settings), and meant for someone running PCP at home without a
proxy of their own. While all three are off, nothing in `lib/core/network/`
starts: no timer, no listener, no outbound request or connection.

**Host settings, not vault settings.** The configuration lives in the
`host_setting` table (`lib/core/host-settings.ts`), not in the per-vault
`setting` table. It belongs to the machine, and the work that uses it runs
from a timer with no request and no `VaultContext`. So it is **stored
unencrypted**: a dynamic DNS service's token or password, and the pcp.gg
connection key, have to be readable while nobody is signed in, and reading the vault without a credential is
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
Encrypt certificate (`PCP_ACME_DIRECTORY` overrides the directory) for a
typed name or the dynamic DNS one. The key and certificate are files under
`tls/`: a server presenting a certificate needs its key before anyone signs
in. While HTTPS is on, PCP opens two listeners of its own next to Next's:

- port 80 (`PCP_HTTP_PORT`; 8080 in the Docker image, mapped by
  `docker-compose.https.yaml`) answers `/.well-known/acme-challenge/…`. Once
  a certificate works it redirects everything else to `https://<name>`;
  before that it forwards to the app, so the site is not broken while waiting.
- port 443 (`PCP_HTTPS_PORT`, 8443 in Docker) serves the certificate, and
  opens before there is one, for the TLS-ALPN-01 challenge.

**Which challenge** (`challengeOrder` in `tls.ts`): Let's Encrypt proves the
name is PCP's either with HTTP-01 (a file on port 80) or with TLS-ALPN-01
(RFC 8737: a handshake on port 443 asking for the protocol `acme-tls/1`
alone, answered with a self-signed certificate for the name that carries the
key authorization's SHA-256 in its acmeIdentifier extension). A name of the
owner's own tries HTTP-01 first, since a router forwards port 80 as readily
as 443 and some providers block only 80; a pcp.gg name tries TLS-ALPN-01
first, because pcp.gg carries port 443 to PCP untouched, while a proxy in
front of pcp.gg can keep port 80's challenge path for itself (Coolify's
Traefik, with a Let's Encrypt resolver of its own, answers every
`/.well-known/acme-challenge/…` with 404, whatever the host). When the
first fails, the other is tried once, in a new order; when PCP never got as
far as a challenge (the directory out of reach, an order refused), nothing
is tried again. The answers wait in the runtime's `ChallengeStore` (tokens
for port 80, challenge certificates by name for 443) and are removed once
validated or refused.

Node's TLS server chooses the certificate before it says which protocols the
client offered, so port 443 reads the ClientHello itself
(`client-hello.ts`, adapted from pcp.gg's `tunnel/protocol/sni.ts`), and only
while a TLS-ALPN-01 challenge is out: a connection for that name offering
`acme-tls/1` and nothing else goes to a second TLS server that never listens
(the challenge certificate, `acme-tls/1`, closed after the handshake); every
other connection, Let's Encrypt's included at any other time, goes on to the
HTTPS server with the bytes put back and gets the normal certificate. With no
challenge out, nothing is read first.

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
inside Let's Encrypt's limits on failed validations (at most two a try, with
the second challenge); "Try again now" skips
the wait. A DNS lookup first warns, without blocking, when the name does not
point at this network. Port 3000 keeps serving plain
HTTP for the local network; in a container started with HTTPS on
(`PCP_HTTPS=1`, `docker-compose.https.yaml`) it is published on 127.0.0.1
only, since a published port skips the host's firewall. In the desktop app
the two ports stay 80 and 443
(macOS and Windows let an ordinary program use them), and they listen on
every interface even while the app keeps port 3000 to this computer: a
router's forward needs exactly that (with a pcp.gg name they listen on
127.0.0.1 only, below).

**pcp.gg** (`pcpgg.ts`, `pcpgg/`): the owner pastes a connection key from
their pcp.gg dashboard, and PCP runs pcp.gg's connector itself
(`pcpgg/connector.ts`, lifted from kaperkunde/pcp-gg's `tunnel/connector/`).
It holds one WebSocket to pcp.gg (`PCP_PCPGG_RELAY_URL` overrides the
address) and answers each connection pcp.gg passes down by dialling the
edge's own listeners on 127.0.0.1. Connections to the owner's name on port
443 arrive still encrypted and end in the edge's HTTPS listener, so pcp.gg
carries bytes it cannot read, Let's Encrypt's TLS-ALPN-01 validation among
them; on port 80 pcp.gg passes on only Let's Encrypt's HTTP-01 challenge. The wire format (`pcpgg/frames.ts`, `mux.ts`,
`control.ts`) is a copy of pcp.gg's `tunnel/protocol/`, protocol version 1;
the tests run against a copy of pcp.gg's relay (`pcpgg/test-relay/`).

`reconcileNetwork()` starts the connector while a key is saved and pcp.gg
has not refused it, and stops it otherwise. pcp.gg's `ready` message names
the hostnames; PCP keeps the first and, once online, turns HTTPS on for it
(`tls.config` with `via: "pcpgg"`), so the TLS-ALPN-01 challenge reaches
port 443 through pcp.gg on the first try (HTTP-01 through port 80 if that
fails). A pcp.gg name skips the check that the name
points at this network, and the edge listens on 127.0.0.1 only: the name
leads to pcp.gg, never to this network's own address, so nothing else needs
to reach the listeners (the desktop app's 80 and 443 included). If Let's
Encrypt refuses the first certificate for the name, HTTPS turns off as usual
and stays off across reconnects until the owner asks again. A key pcp.gg
refuses (close codes 4001, 4004) stops the connector and is not tried again,
across restarts too, until the owner saves a key. Turning pcp.gg off stops
the connector and turns HTTPS for the name off. The pcp.gg card and the
header's bell (after two minutes offline, or at once for a refused key) show
the state. The HTTPS card keeps its hands off while pcp.gg is on.

Every connection through pcp.gg reaches the edge from 127.0.0.1, so the rate
limiter sees one client address for all of them. Carrying the client's
address (in the OPEN frame, then PROXY protocol v2 to the edge) is left for
a later protocol version.

## Updates

PCP tells the owner when a newer release is out and how to update the PCP
they are looking at. It never updates itself in a container or a checkout.
The code is `lib/core/updates/`.

**What it asks, and of whom.** Once a day PCP asks GitHub for the
repository's latest release (`api.github.com/repos/kaperkunde/pcp/releases/latest`,
which leaves out drafts and pre-releases), or, on the develop channel, for
its ten newest releases (`…/releases?per_page=10`), develop's pre-releases
among them. The request carries an `accept`
header and a user agent naming PCP's version, nothing else: no credential, no
cookie, nothing of the vault. So GitHub learns this PCP's address and version.
The owner is told so where the check is turned off (Settings → Updates, and
the step after setup). The address is PCP's own, not one an assistant chose,
so it goes through plain `fetch` like dynamic DNS does (which works behind an
outbound proxy), with `redirect: "manual"`: at most two redirects, to the same
origin (a renamed repository answers with one). `PCP_RELEASES_URL` replaces
the latest-release address, for tests and mirrors; the develop channel's list
is the same address without its `/latest`.

**Channels.** Every push to `main` is a release, `vMAJOR.MINOR.PATCH`; every
push to `develop` that passes CI is a build of develop, a GitHub pre-release
`vMAJOR.MINOR.PATCH-dev.N` (`.github/workflows/develop.yml`: the release it
leads to, then the run number), with the same apps and images (the image tag
`develop` rather than `latest`). A build orders after the release before it
and before the one it leads to (`updates/semver.ts`). The owner picks a
channel under Settings → Updates (`update.config`'s `channel`; by default
the one the running PCP came from): **Stable** reads the latest release
only, and never takes a build for it; **Develop** takes the latest version
among the newest releases, a build or a release. Changing it forgets what the
last check found, between rounds, so an answer for the other channel is never
written back, and asks again at once while the check is on.

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

**The desktop app installs it itself,** when it can (a build of develop
from that build's own pre-release, whose files `releases/latest` never
points at). The page cannot reach
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

**The Linux installer also installs it when the owner asks** (on unless
`PCP_UPDATE_BUTTON=0`, and only for a channel's tag, `latest` or `develop`,
never a pinned version). It passes `PCP_HOST_UPDATER=2` into the container, so Settings shows **Install and
restart**, and sets up `pcp-update-request.timer`, which runs the copy of the
installer with `watch` every 30 seconds. The button records the request in
`update.status` as the app's does, and also writes `install-request` in the
data folder (`updates/host-signal.ts`): the request's id and when it was made,
and the channel it was asked from, one line, nothing of the vault. `watch`
reads it with `docker exec` / `podman exec` and treats it as untrusted: only
a well-formed id and time, `stable` or `develop` or nothing for the channel,
fifteen minutes old at most, one it has not answered, and no more than one
every five minutes. A channel other than the one it remembers
(`PCP_CHANNEL`, `latest` or `develop` for the image tag) moves the install to
it. An installer from before channels passes `PCP_HOST_UPDATER=1` and would
ignore a line with a channel, so PCP writes the channel only for
`PCP_HOST_UPDATER=2`, and on develop asks the owner to run the install line
with `PCP_CHANNEL=develop` instead. It notes the id before it runs `update`, so a failed
install is not retried. The new PCP clears the request and the file at boot.
The host reads the container; PCP never addresses the host and has no Docker
socket.

## Cleanup and the log

**The request log** (`lib/core/request-log.ts`) is what assistants did with
their tokens: one JSON line per gateway call, and one per call a `run_code`
program made, written after the answer and never waited for. A line names the
token by id, the tool, the server and upstream tool the arguments named (cut
to 80 characters, so a caller cannot grow the log by what it sends), how long
it took and how it ended: done, failed (with PCP's own refusal text, never an
upstream's), or asked the owner. Code under a call notes an ask in async
context (`noteOwnerAsked`, from `withPermission` and `connectResult`), so the
line is right however the result is rewritten on its way out. A write that
fails pauses the log for five minutes rather than failing the call.

The **Log page** (`/log`, `lib/core/activity.ts`) reads the vault's own lines
back, newest first, filtered by token, outcome or a tool or server name, and
fills in from the database what the log does not hold: each token's name, and
how a request a call made was answered while PCP still keeps it. Paging goes
by position (`day:line`), which holds while today's file grows; a page stops
after 50,000 lines read, matching or not, and carries on from there, so a rare
filter reads a few days at a time. The page shows what the lines hold and
nothing else: no arguments, no results, no sites.

**The cleanup** (`lib/core/cleanup/`) removes what PCP keeps only for a while:
ended sign-ins, unfinished OAuth sign-ins, apps' codes and tokens past their
expiry (with their grants) and registrations no sign-in used within a day
(PCP's authorization server), permission requests a week past
their expiry, kept results past their day, and days of the request log older
than the owner keeps (90 by default, 1 to 3,650). It runs when PCP starts and
then on a node-cron task, one per process and kept on `globalThis` like the
update timer, unref'd, with no overlap: runs from the start, the schedule and
the owner's **Clean up now** go one at a time. Each part runs on its own, so
one that fails does not stop the others, and the run's status (when, what
started it, what it removed, what failed) is a host setting the settings page
shows. The schedule is five cron fields in the machine's time zone, a preset
or the owner's own; one that would leave more than a day between two runs is
refused, because a kept result is promised gone a day after it was made. The
cleanup needs no credential: it deletes rows and files by their dates and
reads nothing it deletes. Its settings (`cleanup.config`) and status
(`cleanup.status`) are the machine's and do not travel with an export.

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

## Letting assistants sign in: PCP's authorization server

An API token suits a client that takes a header. Custom connectors in
claude.ai (web, desktop and phone) and ChatGPT's developer mode take a URL
and sign in with OAuth, nothing else, so PCP is its own OAuth 2.1
authorization server for `/mcp`, as the MCP authorization spec describes it
(`lib/core/oauth-server/`, routes in `app/oauth/` and `app/.well-known/`).
It has to be PCP's own: a relay in front of PCP (a pcp.gg name, where TLS
ends at the owner's PCP) that issued the tokens could mint one for itself,
and the relay's promise is that it cannot read the owner's data.

**Discovery.** A request to `/mcp` without a valid token gets a 401 whose
`WWW-Authenticate` names `resource_metadata` (RFC 9728) at
`/.well-known/oauth-protected-resource/mcp`. That document names the
resource, `<public URL>/mcp`, and PCP as its authorization server; PCP's
metadata (RFC 8414) is at `/.well-known/oauth-authorization-server`. The
issuer is PCP's public URL (`publicUrlWithoutSession`: the address pinned in
Settings, or where the request came in), so the same build is
`http://localhost:3000` at home and `https://alice.pcp.gg` behind the relay.
The authorization response carries `iss` (RFC 9207).

**Clients.** Two kinds, and neither gets anything before the owner approves:

- A **client ID metadata document**: the client_id is an https URL (Claude
  uses `https://claude.ai/oauth/mcp-oauth-client-metadata`). PCP reads it
  when the signed-in owner opens the sign-in page and again when they
  approve: public addresses only (the pinned transport API endpoints use),
  no redirect followed, 5 KB at most, JSON. Its `client_id` must be its own
  URL, it must list its `redirect_uris`, and it must not claim a secret or a
  key (`token_endpoint_auth_method` `none`). Nothing about it is stored; no
  one who has not signed in can make PCP fetch anything.
- **Dynamic registration** (RFC 7591) at `/oauth/register`, for the others.
  It is open, so it is rate-limited per address, registrations that no
  sign-in has used are pruned after a day and capped in number, and they
  live in `oauth_client`, which belongs to the instance, not a vault. A
  client that does not ask for `none` gets a secret, kept as its SHA-256.

Redirect URIs are https, http to this computer, or an app's private-use
scheme, and are matched exactly. Until the client and its redirect URI check
out, the page tells the owner what is wrong and sends nothing back; after
that, a bad request goes back to the client as an OAuth error. It goes back
on its own only to a client the owner let in before and that still has a
live token from it (`errorGoesBack`): anyone can register a client or
publish a document with any redirect URI, so for any other one PCP would be
an open redirector (RFC 9700 §4.11.2). The page shows that error instead,
with the app's name and host and a plain "Return to …" link to the URI with
the error, which the owner follows or not.

**The owner's page** (`/oauth/authorize`) needs the owner signed in: a
locked PCP sends them to `/login`, which goes on to the sign-in page and
nowhere else (`lib/server/return-path.ts`). It shows the name the app gives
and where it really comes from (its document's host, or "registered
itself"), where PCP sends them back to, and the choices a new API token has:
its name, its servers, and the options that add tools. Allowing it is
`confirmOwner` (password or Touch ID), as making a token is, and the request
is checked again on the server. It makes an API token with
`oauth_client_id` set and no `pcp_…` value (an empty grant, as a revoked
token has), so tool levels, permission requests, memories, web fetch sites,
kept results and the request log, which all hang off the token, work as for
any other. When this client had a live token before, the owner can give it
that one instead; its earlier sign-ins end.

**Credentials** (`oauth_credential`, `tokens.ts`). The approval wraps the
DEK, which the owner's session unwrapped, under a new authorization code: a
grant of kind `oauth_code`, like an API token's, with only the SHA-256 kept.
The code lives two minutes and is bound to the client, the redirect URI and
the PKCE challenge (S256 only, required). The token endpoint unwraps the DEK
with the code and wraps it again under an access token (`oauth_access`, an
hour) and a refresh token (`oauth_refresh`, thirty days), and spends the
code. A refresh does the same with the refresh token, which is replaced at
every use. So at every moment the DEK is wrapped only under values an
assistant holds; the database has hashes and ciphertext, and the vault is
no more readable without a credential than before.

A code or refresh token works once: a second request with it loses the race
(`claim` marks it used before anything is issued). A spent one keeps its row,
without a grant, until it would have expired, and presenting it again ends
every sign-in of its token, as OAuth 2.1 advises for a refresh token that may
have been stolen. Any mismatch at the code exchange (verifier, redirect URI,
client, expiry) spends the code too, so it gets one try.

**Revoking.** The owner's Revoke, Delete, "revoke every token" on signing
out everywhere, and recovery with revoking tokens all go through
`endOAuthSignIns`, which deletes the credentials' grants (they hang off the
grant, so deleting the token row alone would leave copies of the key). An app
can revoke itself at `/oauth/revoke` (RFC 7009): its refresh token stands for
the sign-in and revokes the token, an access token only itself. `/mcp`
checks the token on every request, so a revoked one stops at once.

## The gateway's tools

An MCP client that connects to `/mcp` receives an `instructions` string
listing the servers its token can reach, each with the owner's one-line
description and the number of tools it may see, and these tools (two more
for a token with the right to manage endpoints, `memory` for a token that
keeps memories, `web_fetch` for a token that fetches web pages, `run_code`
for a token that runs code, and four for a token that proposes wrappers, all
above). A request without a valid
token is answered 401, and a token makes at most 240 requests a minute, one
message each (`app/mcp/route.ts`). The tools:

- `search(query, server?, kind?, limit?)` ranks the catalogue, the skills
  the token sees and (for a token that keeps memories) the memories it reads
  together (`lib/core/search.ts searchEverything`: name, title, description
  and server words, with light stemming; a skill scores as a tool named
  after it, a memory as one named by its path and described by its text),
  and returns `kind ref — line` lines: `tool server/tool`, `skill
skill:<name>` with its description, `memory /memories/…` with the line
  that says most of the query. `server` keeps to one server's tools, `kind`
  to one kind.
- `list_tools(server, offset?)` names every tool the token sees on one
  server, by name, with its level (`allowed` or `ask`) and a summary,
  `LIST_PAGE_SIZE` at a time (`listTools` in `lib/core/search.ts`), so an
  access review does not depend on what a search happens to rank.
- `describe(ref)` (or `describe(server, tool)`) reads what search
  found: a skill (Skills, above), a memory as `read_memory view` gives it,
  or a tool. For a tool it returns the description (the owner's
  override when there is one), the JSON Schema exactly as the upstream
  published it, whether the tool runs at once or asks first, and for an API
  endpoint's tool, `returns`: an outline of its success answer read from the
  schema (`openapi/outline.ts`, stored as `mcp_tool.output`); text the
  schema marks base64 (`format: byte`) shows as `string (base64)`. First
  in its answer is the tool's `call_handle` (below).
- `call_tool(call_handle, arguments, fields?, decode?, keep?)` takes no
  server or tool name, only the handle `describe` gave, so a tool is
  always described before it is called. It checks the arguments against
  the tool's stored inputSchema, then opens a connection
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
  `call_read_only_tool` takes the same handle.
- `search_tools` and `describe_tool`, the old names, stay registered for
  one release and answer exactly as before (tools only; server and tool),
  under one first line naming the new tool.
- `check_permission(id?)`, `withdraw_request(id)`, `check_server(server)`,
  `register_server(...)` and `propose_tool_access(changes)` belong to the
  permission flow below.
- `check_run(id)`, beside `run_code` for a token that runs code, says how
  one of the token's runs went (Running code, above). It only reads.
- `read_result(id, offset?, length?, find?)` reads a slice of an answer
  PCP shortened and kept whole, or of a kept value; a file that is not text
  is described, not shown (below).

### Call handles

`/mcp` keeps no session, so a call handle carries what it needs
(`lib/core/call-handles.ts`): `ch_<ref>_<tag>`, where the ref is the
`mcp_tool` row's id in base32 (opaque, never a name) and the tag is an
HMAC-SHA256 under a key derived with HKDF from the vault's data key ("pcp
call handle v1"), never stored. The tag holds an identity MAC (token,
server, tool name, row id and the first bytes of the schema's hash), those
bytes, and a 128-bit call MAC over the same with the whole hash of the
tool's canonical inputSchema (`canonicalJson`). So a handle cannot be made
without the vault's key, works for its own token only, and goes stale when
the schema changes. `call_tool` resolves it against the catalogue as it is
and answers, as a tool error and with nothing run or asked:

- a genuine handle for an older schema: "The tool changed since you
  described it", with the tool described again and a fresh handle;
- a name, or anything else that is not a handle: how to get one, and when
  the text names a tool the token sees (`server/tool`, or a name only one
  server has), that tool described, so recovery takes one round trip;
- a handle changed or made up, or another token's: a refusal;
- a handle for a tool the token no longer reaches (removed, its server
  gone, off or out of the token's reach): a plain refusal; a blocked one
  says it is blocked.

Then the arguments are checked against the stored inputSchema
(`checkArguments` in `wrappers/schema-check.ts`: types, required, enum,
const, properties, additionalProperties, items and the combinators) before
`withPermission` asks or anything runs: arguments
that cannot work are answered with every problem and the schema, and leave
no permission request for the owner. The check is lenient where the schema
says more than it reads: a `$ref`, `patternProperties` or
`unevaluatedProperties` passes, OpenAPI's `nullable` is honoured, `oneOf`
counts as `anyOf`, and a kept result's handle stands for what goes there.
`run_code`'s `pcp.call` and a wrapper's calls keep naming a server and a
tool: they are the gateway's own, decided by `resolveCall` as before.

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
expired ones are removed by the cleanup (see "Cleanup and the
log"). A permission request's stored outcome keeps
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

**File links** (`lib/core/file-links.ts`, `app/api/files/[secret]/`) move a
kept file between PCP and the assistant's own computer (a sandbox or a
terminal it runs commands in), so a file's bytes never pass through the
model: handles keep them out of its answers, and a link keeps them out of
the commands it writes. Only a token the owner made with **Move files by
link** (`api_token.share_files`, off by default) gets the two tools:
`share_result` makes a download link for one of its kept results, and
`receive_file` an upload link plus the handle the file will be kept under.
The assistant runs curl with the link; nothing else signs the request.

The link's secret (256 bits, base64url) is the credential for that one file
and nothing more. `file_link` stores its SHA-256, and the file encrypted
under a key derived from the secret and the row's id (HKDF, `file_link:<id>`
as associated data), so serving a download needs no vault key and the row
alone opens nothing. An upload's key is also wrapped under the vault's data
key (`file_link_key:<id>`): the file that arrives is held under the link's
key until the token, which holds the vault's key, first uses its handle
(`openResult`, `describeResults`), and is then written to `tool_result`
under the id the handle has named from the start, in a transaction that
deletes the link. A link works for an hour (never past the result a download
serves), a download for five fetches and an upload for one file within the
largest-file limit; an upload that arrived waits a day, as a kept result
would. It works only while its token is live and still has the switch.
Each use is a request-log line (`file_link/download`, `file_link/upload`),
the route is rate-limited per address, and a download is served as an
attachment with `nosniff` and a `sandbox` CSP, so nothing in it runs under
PCP's address. Links are not exported, are wiped with the vault, go with
their token, and the cleanup removes them with the kept results.

## Tool access and the owner's permission

Every token has a level per tool (`api_token_tool_access`,
`lib/core/tool-access.ts`): **allowed**, **blocked**, or, when there is no
row, **ask**. Rows are keyed by the tool's name, so a tool that drops out of
a refresh and comes back keeps its level. Blocked tools are left out of the
instructions, `search`, `list_tools` and `describe`, and
`call_tool` and `run_code` refuse them. The gateway loads the levels by
token id. A wrapper's tool comes out at the strictest of its own level and
those of the tools it calls (Wrappers, above).

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

An assistant can take back a request of its own token's while it is still
pending and unexpired (`withdraw_request`, `withdrawPermission`): one
update from pending to `withdrawn` (`closePendingRequests` in
`permission-close.ts`), so it and an answer racing it cannot both win, and
another token's request reads as none at all. Nothing runs and nothing is
written for it; in particular a memory to share is not kept for the
assistant, as the owner's Not now would. A hand-over's tab goes back to the
browser tools (`finishHandover`). The bell drops it (it lists pending rows
only), the request's page says "Withdrawn by the assistant", and the Log
shows the call that asked as withdrawn. `check_permission` with no id lists
the token's own requests still waiting (id, kind, title, age and link),
and only reads.

What waits for the owner is one queue, oldest first
(`lib/core/owner-queue.ts`): the requests from live tokens
(`waitingRequestsWhere`, `WAITING_ORDER`, which the bell, Home and a
token's page all read) and the changes linked repositories left for
review, by when each started waiting. `queueHref` is the one place that
says where each is answered. Once the owner answers one, the answer's
action returns `nextPendingRequest` (the oldest other one, or none) and the
page (`components/answer-queue.tsx`) follows that link, carrying what came
of the answer above the next request, or says nothing else is waiting. It
only opens a page: the next request waits for its own answer. The bell's
count drops the moment the owner answers and comes back if the answer
fails; every answer revalidates the dashboard's layout, so the count PCP
reads next agrees.

The page shows a call's arguments one line each, and a long value is cut
there, saying how long it is; Show everything under the lines has each
argument whole, which is what runs when the owner allows it
(`argsInFull` in `permission-rules.ts`; web fetch's headers and body the
same way). Both write out what does not show on screen (`\u202E`), and a
line writes out a value's newlines too (`visible`), so nothing an assistant
sends can turn the text around, hide in it or pass for a line of the page's
own.

"Allow for" (15 minutes, an hour or eight hours, `ALLOW_FOR_MINUTES`) writes
no level: it leaves an allowance (`lib/core/allowances.ts`,
`api_token_tool_allowance` and `api_token_site_allowance`), the token, the
tool or site, and when it ends. It is read only where the levels come out
at "ask" (`loadGatewayServers` for tools, which `call_tool` and run_code
both go through; `resolveFetchAccess` for sites, which web fetch and the
browser's page gate both go through) and lifts that to "allowed" until it
ends. It never lifts a block, and when it ends the levels decide as they
were, so a token's own "ask" over an "allowed" for all tokens asks again.
The gateway has no sessions and nothing a client sends names a
conversation, so a time is what "for now" can mean. The token's page lists
them, and the owner can end one early; copying access removes the target's,
cleanup removes the ended ones, and an export carries none (like kept
results, they belong to the tokens a restore replaces).

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
Which app is on the other end decides whether a link may come before a
tool call, and PCP is only told when a client connects: the gateway writes
each `initialize` to the server log (`[mcp] initialize`, from
`lib/core/client-hello.ts`: the client's name, version and capabilities, the
user agent, and header names, never another header's value), not to the
request log. Claude's connectors keep calling a stateless server without a
new `initialize` (none came after PCP restarted), so the first request from
each token with a new user agent or set of header names is written too
(`[mcp] client`, with its method). Under protocol revision 2026-07-28 there
is no `initialize` at all: each request names its client, capabilities and
protocol version in its `_meta`, which that line carries, with the values of
`x-anthropic-client` and `mcp-protocol-version`.
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
`createApprovedEndpoint`: on, public addresses only. An MCP server is made
public-only too (`mcp_server.public_only`, as for an endpoint): every request
PCP makes for it, the MCP transport's and its OAuth discovery, registration
and token requests, goes through `upstream.ts: serverFetch`, which sends it
over `openapi/transport.ts` with the address checked as the socket connects,
refusing private, loopback, link-local and PCP's own addresses. It follows
redirects as fetch does (`checkedFetch`), each hop a request of its own that
is checked again, so a redirect cannot lead past the check. The owner clears
it under "Public addresses only" on the server's form, for a server on their
own network; a server the owner adds is not public-only unless they tick it.
Before the owner is asked, the server's host is resolved and a private or
local one is flagged on the approval page (an owner-only line, as for a mail
account), saying it connects only once they allow private addresses.
Requests are deleted at boot a week after they expire.
