# Contributing

## Setup

Node 22 (`nvm use` reads `.nvmrc`) and pnpm 10.

```bash
pnpm install
pnpm db:generate
pnpm dev             # http://localhost:3000, data in ./data
```

No environment variables. The first visit sets up the owner; `./data` holds
the database and can be deleted to start over.

## Checks

```bash
pnpm lint            # ESLint
pnpm format          # Prettier, writing
pnpm format:check    # Prettier, reporting — what the hook and CI run
pnpm typecheck       # tsc --noEmit
pnpm build           # next build
pnpm test            # unit tests (vitest)
pnpm test:e2e        # Playwright against a fresh e2e database
```

Husky runs lint-staged (eslint --fix + prettier on the staged files) on every
commit, then `pnpm typecheck` and `pnpm format:check` over the whole tree.
Fix what the hook reports; `pnpm format` settles the formatting ones.

GitHub Actions runs on pull requests only (`.github/workflows/ci.yml`): lint,
format, typecheck and build in one job, unit tests in another, the Playwright
suite in a third, side by side.

## Database

- Edit `prisma/schema.prisma`, then `pnpm db:generate` and
  `pnpm db:migrate --name <what-changed>`. Commit the migration directory.
- Migrations are applied at boot by `lib/core/migrate.ts` (the production
  image has no Prisma CLI). It writes the same `_prisma_migrations` rows the
  CLI does, so both can be used on one database.
- Keep migrations additive where you can; SQLite's `ALTER TABLE` is limited
  and Prisma rewrites tables for anything else.

## Tests

Two kinds, held to different bars:

- **Unit tests** (`lib/**/*.test.ts`) for pure and near-pure code: the
  crypto, the migrator, tool search, the core against a scratch SQLite file.
  New code gets one when it has logic worth pinning down, not by default.
- **E2E tests** (`e2e/`) for the happy paths a person actually walks: setup,
  secrets, adding a server and calling it through the gateway, OAuth,
  recovery. One project per spec; `e2e/README.md` has the mechanics.

A bug that regressed gets a test that fails before the fix and passes after
(red, then green), whichever kind fits. That bar is low on purpose.

## Key files

| Path                               | Purpose                                                       |
| ---------------------------------- | ------------------------------------------------------------- |
| `lib/core/crypto.ts`               | Envelope encryption, KEK derivation, wrapping the data key    |
| `lib/core/keys.ts`                 | Key grants: password, recovery, session, API token            |
| `lib/core/vault.ts`                | Setup, sign-in, password change, recovery                     |
| `lib/core/sessions.ts`             | Browser sessions (cookie secret → grant)                      |
| `lib/core/api-tokens.ts`           | Bearer tokens for the gateway and their scope                 |
| `lib/core/secrets.ts`              | The secret store; the only place values are decrypted         |
| `lib/core/servers.ts`              | The MCP server registry and its auth configuration            |
| `lib/core/upstream.ts`             | Connecting to upstreams; the OAuth client provider            |
| `lib/core/oauth.ts`                | The authorization flow (start, callback, disconnect)          |
| `lib/core/oauth-client.ts`         | How PCP gets a client ID; redirect URI; sign-in parameters    |
| `lib/core/endpoints.ts`            | API endpoints: reading a schema, creating them, calling them  |
| `lib/core/openapi/`                | OpenAPI → tools and call plans; building and sending requests |
| `lib/core/endpoint-admin.ts`       | What an assistant may do to endpoints through the gateway     |
| `lib/core/catalogue.ts`            | Writing a server's tool list into the catalogue               |
| `lib/core/search.ts`, `gateway.ts` | Ranking tools; the MCP server the gateway serves              |
| `lib/core/tool-access.ts`          | Per-token tool levels: allowed, ask, blocked; copying them    |
| `lib/core/permissions.ts`          | Asking the owner before a call runs; running it once          |
| `lib/core/panel.ts`                | PCP's MCP Apps panel and the results it renders               |
| `lib/core/migrate.ts`              | Boot-time migrations                                          |
| `lib/server/`                      | Next-specific glue: session cookie, public URL, action state  |
| `lib/actions/`                     | Server Actions the forms call                                 |
| `app/mcp/route.ts`                 | The gateway endpoint                                          |
| `app/api/oauth/`                   | OAuth callback; PCP's client metadata document                |
| `app/api/servers/[id]/oauth/`      | OAuth start; the per-server callback older clients use        |
| `e2e/fixtures/upstream.ts`         | The fake MCP + OAuth server the e2e suite talks to            |
| `app/manifest.ts`, `public/icons/` | The manifest and icon set; `assets/icon.png` is the master    |

## Licence

MIT. By opening a pull request you agree that your contribution is licensed
the same way.
