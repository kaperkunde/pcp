# Working in this repo

Start with [CONTRIBUTING.md](CONTRIBUTING.md) for setup and the key-files
table, and [ARCHITECTURE.md](ARCHITECTURE.md) for the encryption and tenancy
model. This file is the conventions that are easy to get wrong.

## Before pushing

```bash
pnpm lint
pnpm typecheck
pnpm format:check
pnpm test
pnpm build
```

The pre-commit hook runs the first three; a red hook is fixed, not skipped
(`pnpm format` settles formatting; `--no-verify` is not an answer). Run the
Playwright projects your change touches (`pnpm exec playwright test
--project=<name>`; dependencies run first) — CI runs the whole suite on the
pull request, and nothing runs on a push.

## Boundaries

- `lib/core` is framework-free. No `next/*`, no React, no `lib/actions`,
  no `lib/server` (ESLint enforces it). Everything takes a `VaultContext`
  explicitly. If a core function needs something from the request, the
  caller passes it in (the public URL is the usual one).
- Client components must not import from `lib/core` except
  `lib/core/constants.ts` and `import type`. Anything else drags Prisma into
  the browser bundle and the build fails in webpack, not in the dev server.
- Secrets are decrypted in `lib/core/secrets.ts` and used in
  `lib/core/upstream.ts`. Nothing returns a secret value to an assistant;
  `revealSecret` is for the owner's own screen. An API endpoint's calls
  (`lib/core/endpoints.ts`, `lib/core/openapi/`) are handed their finished
  header by `upstream.ts` and never read a secret; `openapi/call.ts` scrubs
  the secret from what the API answers.
- What an assistant may do to an endpoint through the gateway
  (`lib/core/endpoint-admin.ts`) is narrower than what the owner may do, on
  purpose. It registers one through `register_server` with OpenAPI text, which
  is a permission request like any new server: the owner is shown the address,
  the tools and the secret (by name), and nothing exists until they agree.
  It never changes a credential, never clears `publicOnly`, can only read and
  turn read-only on for an endpoint that is the owner's (it sends a secret, or
  private addresses are allowed), and a change others would see disables the
  endpoint until the owner enables it. Its changes go through
  `changeEndpoint`, which writes only the columns it is given and never the
  credential. Keep all of that when adding to it, and add a test for each new
  field an assistant can set.
- Memories (`lib/core/memories.ts`): an assistant writes its own
  (`/memories/…`) without asking, but anything other assistants would read
  (`/memories/shared/…`: creating, sharing, changing, renaming, deleting) is a
  permission request that shows the owner the whole text, writes nothing
  until they answer, and writes only what they were shown. Shared text stays
  short enough to read whole and free of characters that do not show on
  screen, and only shared memories' paths go into the instructions, never a
  token's own memory.
- `lib/core/openapi` never fetches a remote `$ref`, never follows a redirect
  on a call, and never lets an argument set a header or leave the base URL.
  A schema is untrusted input: new limits go in `openapi/limits.ts`.
- Server Actions live in `lib/actions/`, read the session with
  `requireContext()`, call `lib/core`, and return an `ActionState`. Forms
  use `useActionState`. Route handlers exist only for the gateway, OAuth
  (redirects and PCP's client metadata document) and the health check.
- The single-user assumption lives in two places: `ownerVault()` and the
  setup page. Do not add a third.

## Cryptography

Do not add a way to read the vault without a credential — no admin key, no
environment-variable master key, no "forgot password" that does not use the
recovery key. If a feature seems to need one, it needs a different design.
New encrypted fields use `encryptString(ctx.dek, value, "<table>:<id>")` with
the row id as associated data, same as the existing ones.

## Database

Schema changes: edit `prisma/schema.prisma`, `pnpm db:generate`, `pnpm
db:migrate --name <change>`, commit the migration. Migrations apply at boot
through `lib/core/migrate.ts`; never edit an applied migration (the checksum
check refuses to start).

## Tests

- Unit tests sit next to the code (`*.test.ts`) and run with `pnpm test`.
  The core is tested against a scratch database (`lib/core/test-db.ts`).
- E2E specs are Playwright projects; a new spec gets a project in
  `playwright.config.ts` and a line in `e2e/README.md`. The fake upstream in
  `e2e/fixtures/upstream.ts` is the MCP server the suite talks to, and the
  pet store (a REST API with its OpenAPI schema) for API endpoints; extend it
  rather than reaching for a real service.
- Bar for new tests: high for new code (one when there is logic to pin
  down), low for regressions (red, then green, always).

## Copy

The owner is "you"; the assistant is "an assistant"; the thing PCP holds is
a "secret", the server it talks to is a "server", and an API added from an
OpenAPI schema is an "endpoint" ("API endpoints" in the UI); a note an
assistant keeps between conversations is a "memory", "shared" when every
assistant reads it. No operator
vocabulary in the UI: no "DEK", "grant", "KEK" outside code comments and
ARCHITECTURE.md.
