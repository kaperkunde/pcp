# E2E tests

Playwright drives the real app (`pnpm dev`) against its own SQLite database
(`e2e/.state/data`, set through `PCP_DATA_DIR` in `playwright.config.ts`) and
a fake upstream MCP server that runs inside the test process
(`e2e/fixtures/upstream.ts`). Nothing leaves the machine.

## Running

```bash
pnpm test:e2e                                  # fresh database, whole suite
pnpm exec playwright test --project=gateway    # one project, no reset
pnpm exec playwright test --project=oauth --headed
```

`pnpm test:e2e` deletes `e2e/.state` and `e2e/.auth` first. A bare
`playwright test` keeps them, which is faster while iterating on one spec;
every spec tolerates a database that already has the owner and earlier
runs' servers in it (names carry a per-run suffix, `setup` signs in instead
of setting up).

Playwright starts `pnpm dev` itself unless one is already answering on
:3000. A dev server you started yourself uses `./data`, not the e2e
database, so the suite then runs against your own data — start it with
`PCP_DATA_DIR=e2e/.state/data pnpm dev` or let Playwright start one.

### Against a production build or the Docker image

Playwright reuses whatever answers on `PCP_URL` (default
`http://localhost:3000`) outside CI, so the same suite checks a container:

```bash
docker run -d --rm --network host -v pcp-e2e:/data pcp:local
pnpm test:e2e
```

This catches what the dev server cannot, such as the container binding
`0.0.0.0` (see `reconcileIssuer` in `lib/core/oauth.ts`). Use a fresh volume:
`setup` expects either no owner or the one it created.

### A Chromium of your own

Where Playwright cannot download its browser, point it at an installed one:
`PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chromium pnpm test:e2e`.

## Projects

Each spec is a project; dependents declare `dependencies: ["setup"]` and
reuse the signed-in `e2e/.auth/owner.json` it writes.

| Project        | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setup`        | First visit → setup, the recovery key (saved to `e2e/.state/setup.json`), lock, unlock.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `secrets`      | Add, reveal, duplicate name refused, rotate and rename, delete.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `gateway`      | Secret → header-authenticated server → tool list → description edit → API token (refused without the password; creating one opens its page with the token) → `/mcp`: search, describe, call; the upstream sees the secret; a tool the upstream adds later is found when an assistant asks for it and by the token page's refresh; scoped tokens; revocation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `oauth`        | An OAuth upstream: discovery, dynamic registration, the browser round trip, tokens as a managed secret, a gateway call with the OAuth token, disconnect.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `oauth-client` | An OAuth upstream that lets no app register itself: connecting says it needs a client from you and shows the redirect URI (on the add form too); the owner's client ID and pasted secret (saved as a secret of theirs) connect it; without a refresh token the page says it cannot renew; a reserved sign-in parameter is refused, `access_type=offline` gets a renewable connection; a gateway call with that token.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `permissions`  | Tools ask first: the permission link, the client's own prompt and PCP's panel (also rebuilt by the host after the owner answered and signed in); Always allow, Block, copying access to another token; servers an assistant proposes, with a stored secret or OAuth.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `endpoints`    | An API from an OpenAPI schema: added by URL with a stored secret, then by file (read-only, base URL typed in); search, describe and call through `/mcp`; the upstream sees the right method, path, query, body and secret; bad arguments and `..` never leave PCP; a schema that 404s is refused and the form keeps what was typed; a token that may manage endpoints: an assistant proposes an API as OpenAPI text through `register_server`, nothing exists until the owner agrees (the page shows the address, tools and operations), it then reaches public addresses only; a change it makes switches the endpoint off until the owner enables it again; a schema URL on a private address is refused before the owner is asked; it reads one part of the schema by JSON Pointer and narrows it with an edit (a bad edit changes nothing), and the owner sees the edit on the endpoint's page and takes it out; the owner allows private addresses and attaches a secret (typing the address to confirm it); from then on the endpoint is the owner's and the assistant can only read it and turn read-only on; removal. |
| `memories`     | A token made to keep memories gets the `memory` tool and the instructions that say when to use it (a token without it gets neither); its own notes are saved without asking and refuse hidden characters; a shared one asks the owner, nothing is shared before they answer, and the permission page shows the path, the whole text and the warning; once shared it is named in the instructions; the Memories tab shows who wrote each one, and the owner's edit and delete reach the assistant.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `recovery`     | Wrong key refused; the recovery key sets a new password, signs everyone out and revokes every API token; the original password is put back; a new recovery key takes the password; signing out everywhere revokes every API token.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

`recovery` runs last: it invalidates the shared session.

## The fake upstream

`startUpstream()` returns an HTTP server with:

- `/mcp` — an MCP server (three tools) that demands `Authorization: Bearer
<expectedToken>`. Its `echo_auth` tool returns the header it received.
- `/oauth/mcp` — the same tools behind OAuth, with metadata at
  `/.well-known/oauth-authorization-server`, dynamic registration, an
  `/authorize` that approves at once, and a `/token` endpoint that checks
  PKCE. `issuedTokens` lists what it handed out.
- `/closed/mcp` — the same tools behind an authorization server (issuer
  `${origin}/closed`) without dynamic registration. It knows one client,
  `closedClient`, whose `redirectUris` a test fills in as an owner would in a
  provider's console; it wants the client secret at `/closed/token` and
  issues a refresh token only when the sign-in carried `access_type=offline`.
  `closedSignIns` records each sign-in's query.

It records every tool call in `calls`, which is how the tests assert what
reached the upstream. A name added to `lateTools` becomes a tool on both MCP
servers from the next request on, for tests of a tool list that changes.

- `/openapi.json` and `/api/*` — a small pet store and its OpenAPI document
  (the server is `${origin}/api`; two operations are there to be left out, one
  needing a cookie and one a file upload). `/api/*` wants the same bearer
  token and records every request in `requests` (method, path, query, headers
  that matter, body). `e2e/fixtures/petstore.yaml` is the same API as a file,
  with a relative server address, for the upload path.

## Writing a new spec

Walk the flow in a real browser first (`pnpm test:e2e:codegen`), then write
assertions on roles and labels rather than generated selectors. On a
failure, `e2e/.artifacts/test-results/**/error-context.md` holds the
accessibility tree at that moment and is usually faster than re-reading the
component.
