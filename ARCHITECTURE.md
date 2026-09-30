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
  session's; **recovery** replaces the password grant and deletes every
  session grant.
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

## Data on disk

`PCP_DATA_DIR` (default `./data`, `/data` in Docker):

- `pcp.db` — the SQLite database, in WAL mode. Migrations are applied at boot
  by `lib/core/migrate.ts`, which keeps Prisma's own `_prisma_migrations`
  bookkeeping (same table, same checksums), so a developer's
  `prisma migrate dev` and a container's boot agree on the history.
- `logs/mcp-YYYY-MM-DD.jsonl` — one line per gateway call: which token,
  which tool, which upstream, how long, whether it worked. Never arguments
  or results.

## The gateway's tools

An MCP client that connects to `/mcp` receives an `instructions` string
listing the servers its token can reach, each with the owner's one-line
description and the number of tools it may see, and these tools:

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
them. `ResolvedToken` is unchanged: the gateway loads the levels by token id.

A call to an "ask" tool becomes a `permission_request` row
(`lib/core/permissions.ts`, ported from plekje's confirmation flow): the
arguments encrypted under the vault's key with the row id as associated
data, a hash of the call so the same call asked twice finds the same row,
and a day to answer. The owner is asked where the client can show it
(`choosePermissionTier`):

| Tier   | When                                            | How                                                                    |
| ------ | ----------------------------------------------- | ---------------------------------------------------------------------- |
| `app`  | The request declares the MCP Apps extension     | PCP's panel, shown by `check_permission`                               |
| `form` | It declares form elicitation                    | An `input_required` result with a one-choice form                      |
| `url`  | It declares URL elicitation only                | An `input_required` result pointing at `/permissions/<id>`             |
| `link` | Anything else, including every 2025-era request | Text with the link to `/permissions/<id>` for the assistant to pass on |

Whichever way the owner answers, `decidePermission()` claims the row
(pending to running, one winner) and runs the call once. "Always allow" and
"Block" also write the tool's level. A retry that carries `requestState` is
bound to its row by vault, token and hash, so a client cannot replay an
answer onto another call, and it never runs a call the owner already ran.
`answer_permission` refuses requests that do not declare the MCP Apps
extension: hosts that show panels hide it from the assistant, and on any
other client the assistant could otherwise answer for the owner.

PCP's panel (`ui://pcp/panel`, `lib/core/panel.ts`) is one self-contained
MCP App; a tool result picks its view through `structuredContent.kind`
(`permission`, `connect`, or plain text). OAuth never runs inside it: hosts
sandbox the panel and sign-in pages refuse to be framed. For a server that
needs connecting, the panel's Connect button asks the host to open
`/api/servers/<id>/oauth/start` in the owner's browser (`ui/open-link`),
where their PCP session is, and polls `check_server` until the callback has
landed.

`register_server` takes a secret's name, never its value, and always asks:
otherwise an assistant could point a stored secret at an address it chose.
Once the owner agrees, PCP adds the server, adds it to the asking token when
that token is scoped to chosen servers, and reads its tools, or hands back
the connect panel for OAuth. Requests are deleted at boot a week after they
expire.
