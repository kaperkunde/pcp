# Architecture

PCP is a Next.js application with a framework-free core. This document covers
the three things that shape it: how data is encrypted, how a request finds
the vault it works on, and how a multi-tenant host could be built on the same
code without changing the single-user product.

## Layers

```
app/                 Routes and pages (Next.js App Router)
  mcp/route.ts       The gateway endpoint
  api/oauth/…        OAuth callback and PCP's client metadata document
  api/servers/…      OAuth start (and the per-server callback older clients use)
components/          React components; forms call Server Actions
lib/actions/         Server Actions: read the session, call lib/core, return a state
lib/server/          Next-specific glue: cookies, request headers, public URL
lib/core/            The domain. No Next.js, no React (ESLint enforces it)
  openapi/           OpenAPI schema → tools and call plans; building and sending the request
prisma/              Schema and migrations (SQLite)
e2e/                 Playwright suite, with a fake upstream MCP + OAuth server
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

## Building a multi-tenant host on it

The plan for a SaaS that serves many people from one endpoint, without
exposing any of it in this repository:

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
5. **Never expose the seams here.** No admin API, no "create vault"
   endpoint, no tenant switch in the UI: the public product stays
   single-user.

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

**Making a call** (`call.ts`, `request.ts`): `buildRequest` turns the
assistant's arguments into a request following the plan. Arguments the plan
does not name are refused. Path values are percent-encoded and never `.` or
`..`. Only declared header parameters are sent, never the ones PCP owns
(Authorization, Cookie, Host, hop-by-hop headers), and a header value cannot
carry a line break. The credential is added last, so no argument can replace
it, and the finished URL must still be under the base URL. `executeCall`
sends it with a timeout and a cap on the answer, **without following
redirects** (`fetch` would repeat a custom header such as `X-API-Key` on the
next host), turns the answer into a tool result (JSON pretty-printed and,
when small, as `structuredContent`; text as it is; other types described, not
dumped; an error status as an error result), and removes the credential from
it before parsing, because an API that echoes a key back (in an error, say)
must not hand it to the assistant.

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

Private addresses are allowed, as they are for MCP servers: only the owner
sets a schema URL or base URL, and a self-hosted PCP often talks to services
on its own network. A multi-tenant host must add an address policy before it
lets anyone else set one: resolve the name, refuse loopback, private,
link-local and metadata ranges, and connect to the address it checked.

## Registering and managing endpoints through the gateway

**Registering** is `register_server`, the tool main already had for MCP
servers, with an OpenAPI document as text in `openapi_schema` or by its
address in `openapi_url` (plus `spec_patches` to edit it, `url` for the base
URL, `read_only`, and a secret named by NAME). It is an assistant's request,
so it goes through the same owner approval as any other new server (below):
PCP reads the document when the request is made (downloading it, for a URL),
applies the edits, refuses one that cannot be used, and shows the owner the
address, where the schema came from, how many edits it has, the tool count
and operations, whether the tools can change things, and the secret that
would be sent. Nothing exists until they agree; then `executeRegister` creates the
endpoint, on, and adds it to the token's scope.

A secret is named, never sent. A name PCP does not hold yet (an MCP server's
or an API's) makes a request the owner can only agree to on PCP's own page,
where they type the value in: the panel and the client's prompt run inside
the assistant's app, so they are not offered for it (the client opens the
page, or the assistant hands over the link), and an answer from either is
refused. The value is saved as a new secret by the proposed name (a number is
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
read in steps under the answer's length limit. The rules are in
`lib/core/endpoint-admin.ts`, and they exist because an assistant that can
change an endpoint decides where PCP sends requests:

- **Whose endpoint it is.** An endpoint is the assistant's while it sends no
  secret and is still limited to public addresses. It is the owner's once it
  sends one of their secrets or they allow private addresses. The assistant can
  rewrite its own; on the owner's it can read and turn read-only on, and
  nothing else. A new schema could add operations the owner's key then
  performs, and a new address, name or description could send the key, or
  another assistant, somewhere else.
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
  whether a header is sent and what it is called. The writer these changes go
  through (`endpoints.ts: changeEndpoint`) writes only the columns it is given
  and never the credential, the schema's source, or public-only, so an owner
  changing those at the same moment is not overwritten and the rules above
  cannot be got around by what is passed in.
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

## Memories

A token made with "keep memories" (`api_token.keep_memories`, off unless the
owner turns it on) gets one more tool, `memory`, with the commands of Claude's
memory tool (view, create, str_replace, insert, delete, rename, over files
under `/memories`) plus search, and a paragraph in the instructions saying
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
  stored instructions. The ask writes nothing, so the client's retry with the
  owner's answer finds the same request. A share is answered **Share it**,
  **Keep it for this assistant only** (saved privately; also what declining
  the client's own prompt means), or **Discard it**. On a yes,
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
  Claude's own memory tool adds to the system prompt (view `/memories` before
  anything else, save as you go, assume the conversation ends at any
  moment). The owner can mark any memory to be read in every conversation
  (`memory.always`, from the Memories page only): a shared one goes into
  every keeping token's instructions, a private one into its own token's.
  Its text is at most 2,000 characters, and the instructions carry at most
  8,000 characters of them and name the rest. Every such text is one the
  owner read: an assistant's change to, or move of, an always memory it keeps
  clears the mark, a change to a shared one is a `memory_change` request
  that says it is read in every conversation, and sharing a private one
  clears it. Any other memory of a token's own is its words alone and is
  only read through the tool, which labels each memory with who wrote it and
  says that it is a note, not an instruction.
- **Bounded.** 500 memories per vault, 10,000 characters each, 60 writes and
  share requests per token per ten minutes. Path and text are encrypted
  together, so uniqueness of paths is checked in code after decrypting the
  vault's memories, as `search.ts` scores every tool. A memory outlives the
  token that wrote it (`token_id` is set to null) and is then the owner's.

## Data on disk

`PCP_DATA_DIR` (default `./data`, `/data` in Docker):

- `pcp.db` — the SQLite database, in WAL mode. Migrations are applied at boot
  by `lib/core/migrate.ts`, which keeps Prisma's own `_prisma_migrations`
  bookkeeping (same table, same checksums), so a developer's
  `prisma migrate dev` and a container's boot agree on the history.
- `logs/mcp-YYYY-MM-DD.jsonl` — one line per gateway call: which token,
  which tool, which upstream, how long, whether it worked. Never arguments
  or results.

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
for a token with the right to manage endpoints, and `memory` for a token that
keeps memories, both below):

- `search_tools(query, server?, limit?)` ranks the catalogue
  (`lib/core/search.ts`: name, title, description and server words, with
  light stemming) and returns `server/tool — summary` lines.
- `describe_tool(server, tool)` returns the description (the owner's
  override when there is one), the JSON Schema exactly as the upstream
  published it, and whether the tool runs at once or asks first.
- `call_tool(server, tool, arguments)` opens a connection to the upstream
  with the configured credential (header secret or OAuth token, refreshed by
  the SDK when needed), calls the tool, and passes the content back.
- `check_permission(id)`, `check_server(server)` and
  `register_server(...)` belong to the permission flow below;
  `answer_permission(id, decision)` is only for PCP's panel.

The catalogue (`mcp_tool`) is read from each server when it is added, when
the owner refreshes it, after an OAuth connection, and lazily when the
gateway finds a server with no tools. It is a cache of the upstream's
`tools/list`; the owner's description overrides survive a refresh.

## Tool access and the owner's permission

Every token has a level per tool (`api_token_tool_access`,
`lib/core/tool-access.ts`): **allowed**, **blocked**, or, when there is no
row, **ask**. Rows are keyed by the tool's name, so a tool that drops out of
a refresh and comes back keeps its level. Blocked tools are left out of the
instructions, `search_tools` and `describe_tool`, and `call_tool` refuses
them. The gateway loads the levels by token id; `ResolvedToken` carries the
token's ways of asking (below).

A call to an "ask" tool becomes a `permission_request` row
(`lib/core/permissions.ts`, ported from plekje's confirmation flow): the
arguments encrypted under the vault's key with the row id as associated
data, a hash of the call so the same call asked twice finds the same row,
and a day to answer. The owner is asked the first way, in this order, that
the client declares and the token allows (`choosePermissionTier`):

| Tier   | When                                            | How                                                                    |
| ------ | ----------------------------------------------- | ---------------------------------------------------------------------- |
| `app`  | The request declares the MCP Apps extension     | PCP's panel, shown by `check_permission`                               |
| `form` | It declares form elicitation                    | An `input_required` result with a one-choice form                      |
| `url`  | It declares URL elicitation (and form is off)   | An `input_required` result pointing at `/permissions/<id>`             |
| `link` | Anything else, including every 2025-era request | Text with the link to `/permissions/<id>` for the assistant to pass on |

A declaration is all the server has to go on, and some clients declare form
elicitation they never show; the call then hangs until the client's timeout
(Claude Code in remote and Cowork sessions, anthropics/claude-code#94806).
So `api_token.permission_tiers` holds the tiers a token may use, all three
by default, and the token page lets the owner turn `app`, `form` and `url`
off. The link cannot be turned off: it is what is left.

Whichever way the owner answers, `decidePermission()` claims the row
(pending to running, one winner) and runs the call once. "Always allow" and
"Block" also write the tool's level. A retry that carries `requestState` is
bound to its row by vault, token and hash, so a client cannot replay an
answer onto another call, and it never runs a call the owner already ran.
`answer_permission` refuses requests that do not declare the MCP Apps
extension, and tokens with the panel off: hosts that show panels hide it from the assistant, and on any
other client the assistant could otherwise answer for the owner.

PCP's panel (`ui://pcp/panel`, `lib/core/panel.ts`) is one self-contained
MCP App; a tool result picks its view through `structuredContent.kind`
(`permission`, `connect`, or plain text). OAuth never runs inside it: hosts
sandbox the panel and sign-in pages refuse to be framed. For a server that
needs connecting, the panel's Connect button asks the host to open
`/api/servers/<id>/oauth/start` in the owner's browser (`ui/open-link`),
where their PCP session is, and polls `check_server` until the callback has
landed. A server that needs a client from the owner first (status
`client_required`) gets the same panel, and text telling the assistant so:
the start page then lands on the server's page, which says what to create.

Hosts hand the panel the tool result it was made for, and hand the same one
again whenever they rebuild it (scrolling back, the app returning from the
browser), so a result is a snapshot: the panel asks `check_permission` or
`check_server` where things are now, and shows a question's buttons only
once PCP says it is still open (if PCP does not answer, the question as given;
answering a settled one is refused). `check_permission` answers an allowed
request whose OAuth server still needs signing in to with the connect view,
and once it is connected with the server's state. MCP Apps keep no state for
a panel across rebuilds, so PCP's request is the record. Model context
(`ui/update-model-context`) is only read on the owner's next message, so
what the owner just did in the panel (an answer, a sign-in it saw land) goes
to the assistant as a message in the owner's words (`ui/message`) at once;
a change a rebuilt panel finds is offered as "Tell the assistant" instead,
so reloading never posts. When nothing is left to do (the message went, or
the request is more than a day old), the panel asks the host to close it
(`ui/notifications/request-teardown`); the host decides. PCP itself cannot
wake the assistant: nothing in MCP lets a server start a turn.

`register_server` takes a secret's name, never its value, and always asks:
otherwise an assistant could point a stored secret at an address it chose.
Once the owner agrees, PCP adds the server, adds it to the asking token when
that token is scoped to chosen servers, and reads its tools, or hands back
the connect panel for OAuth. With `openapi_schema` the request is an API
endpoint instead: the gateway has `endpoint-admin.ts: prepareRegistration`
read the text before asking (so the owner is only asked about something that
works, and sees its address, tool count and operations), and
`executeRegister` creates it from the same text with
`createApprovedEndpoint`: on, public addresses only. Requests are deleted at
boot a week after they expire.
