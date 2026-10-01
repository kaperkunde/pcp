# Architecture

PCP is a Next.js application with a framework-free core. This document covers
the three things that shape it: how data is encrypted, how a request finds
the vault it works on, and how a multi-tenant host could be built on the same
code without changing the single-user product.

## Layers

```
app/                 Routes and pages (Next.js App Router)
  mcp/route.ts       The gateway endpoint
  api/servers/…      OAuth start and callback
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
- OAuth token sets and dynamically registered client credentials (a `secret`
  row of kind `oauth`, owned by the server that uses it),
- the PKCE verifier of an authorization in flight (`oauth_state`).

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
- The schema text is kept in `openapi_spec`, apart from the server row so
  neither the server list nor the gateway loads it. An uploaded schema is
  regenerated from that copy when the owner changes a setting.

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

## Managing endpoints through the gateway

A token the owner made with "add and change API endpoints"
(`api_token.manage_endpoints`, off for every other token) gets three more
gateway tools, `register_endpoint(name, spec, baseUrl?, description?,
readOnly?)`, `update_endpoint(endpoint, …)` and `get_endpoint(endpoint,
includeSpec?)`. `spec` is OpenAPI 3 as text, so an assistant can write a
document from an API's documentation and register it in one call. The rules
are in `lib/core/endpoint-admin.ts`, and they exist because an assistant that
can register an endpoint decides where PCP sends requests:

- **Whose endpoint it is.** An endpoint is the assistant's while nothing of
  the owner's is attached (no secret) and it is still limited to public
  addresses. It becomes the owner's when they attach a secret or allow private
  addresses. The assistant can rewrite its own; on the owner's it can read and
  turn read-only on, and nothing else. A new schema could add operations the
  owner's key then performs, and a new address, name or description could send
  the key, or another assistant, somewhere else.
- **Nothing takes effect without the owner.** A registered endpoint starts
  disabled. A change to one that other assistants can see (its words, schema or
  address, or read-only turned off) disables it again until the owner enables
  it. Text an assistant writes reaches every other assistant through
  `search_tools`, the gateway's instructions and `describe_tool`, so it is the
  owner's to approve. Names cannot hold line breaks, which would otherwise
  start a line of their own in those instructions.
- **No credential, ever.** Nothing the tools accept names a secret, a header
  or a template, and `get_endpoint` shows only whether a header is sent and
  what it is called. The writer these changes go through
  (`endpoints.ts: changeEndpoint`) writes only the columns it is given and
  never the credential, the schema's source, or public-only, so an owner
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
- **Text only.** The assistant supplies the schema as text; PCP never fetches
  an address the assistant chose. An endpoint the owner reads from a URL
  keeps that URL, and its schema is the owner's to change.
- **Bounded.** Fifty endpoints per vault, 4 MB of stored tools per endpoint,
  twenty changes per token per ten minutes, no JSON-RPC batches at the
  gateway (one POST would be many calls), and the catalogue a request loads
  leaves out tool schemas, which are read when a tool is described or called.
- A token limited to some servers only sees endpoints in its scope, and what
  it registers is added to that scope.

What remains is egress: an assistant with this right can have PCP send data
it holds to any public URL, as an operation's arguments. That is why the right
is the owner's to give, per token, and why the tokens page marks it.

## Data on disk

`PCP_DATA_DIR` (default `./data`, `/data` in Docker):

- `pcp.db` — the SQLite database, in WAL mode. Migrations are applied at boot
  by `lib/core/migrate.ts`, which keeps Prisma's own `_prisma_migrations`
  bookkeeping (same table, same checksums), so a developer's
  `prisma migrate dev` and a container's boot agree on the history.
- `logs/mcp-YYYY-MM-DD.jsonl` — one line per gateway call: which token,
  which tool, which upstream, how long, whether it worked. Never arguments
  or results.

## The gateway's three tools

An MCP client that connects to `/mcp` receives an `instructions` string
listing the servers its token can reach, each with the owner's one-line
description and its tool count, and three tools (three more for a token with
the right to manage endpoints, below):

- `search_tools(query, server?, limit?)` ranks the catalogue
  (`lib/core/search.ts`: name, title, description and server words, with
  light stemming) and returns `server/tool — summary` lines.
- `describe_tool(server, tool)` returns the description (the owner's
  override when there is one) and the JSON Schema exactly as the upstream
  published it.
- `call_tool(server, tool, arguments)` opens a connection to the upstream
  with the configured credential (header secret or OAuth token, refreshed by
  the SDK when needed), calls the tool, and passes the content back.

The catalogue (`mcp_tool`) is read from each server when it is added, when
the owner refreshes it, after an OAuth connection, and lazily when the
gateway finds a server with no tools. It is a cache of the upstream's
`tools/list`; the owner's description overrides survive a refresh.
