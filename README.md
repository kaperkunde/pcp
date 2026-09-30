# PCP - Primary Control Provider

A self-hosted gateway between your AI assistant and the MCP servers you use.
PCP keeps the credentials those servers need in an encrypted store, signs in
to the ones that use OAuth, and exposes a single MCP endpoint with three tools
— `search_tools`, `describe_tool` and `call_tool` — so an assistant can reach
dozens of servers without carrying every tool definition in its context.

- **One endpoint for every server.** Add servers in the web UI; an assistant
  connects once, with an API token, and finds tools by describing what it
  needs.
- **Secrets stay on your side.** API keys and OAuth tokens are encrypted at
  rest with a key the server does not hold. They are added to upstream calls
  by PCP; the assistant never sees them.
- **Nothing to configure.** `docker compose up`, open the site, choose a
  password. No environment variables.
- **Single user, by design.** PCP is yours. The architecture keeps every row
  behind a vault id so a multi-user host can be built on it later, but the
  product exposes none of that.

## Run it

```bash
git clone https://github.com/kaperkunde/pcp.git
cd pcp
docker compose up -d
```

Open http://localhost:3000. The first visit shows the setup page: pick your
name and a password. You will be shown a **recovery key** once — store it in a
password manager. There is no password reset without it, because there is
nothing on the server that could reset it.

For anything beyond your own machine, put a TLS-terminating proxy (Caddy,
Traefik, nginx) in front of port 3000. Most OAuth servers require an `https`
redirect URL, and the session cookie is only marked `Secure` when requests
arrive over TLS (`X-Forwarded-Proto`).

The data lives in the `pcp-data` volume (`/data` in the container): the
SQLite database and the request log. Back that up; nothing else holds state.

### Without Docker

```bash
pnpm install
pnpm db:generate
pnpm build
pnpm start          # http://localhost:3000, data in ./data
```

`PCP_DATA_DIR` moves the data directory; `PORT` changes the port. Neither is
required.

## Use it

1. **Secrets.** Add the API keys and personal access tokens your servers
   need. Each is stored encrypted and can be revealed, rotated or deleted.
2. **Servers.** Add an MCP server by URL, describe what it is for in a
   sentence, and choose how PCP authenticates to it: nothing, a secret in a
   header (`Authorization: Bearer {{secret}}` by default), or OAuth. For
   OAuth, choose **Connect** on the server page: PCP discovers the
   authorization server, registers itself if it can, sends you to sign in
   and keeps the tokens as a managed secret. PCP reads each server's tool
   list; you can rewrite any tool's description so an assistant picks it
   correctly.
3. **API tokens.** Create a token per assistant or machine. A token can reach
   every server or only the ones you pick, and can expire. Revoking it
   destroys its copy of the vault key.
4. **Connect an assistant** to `https://<your-pcp>/mcp` with the token as a
   bearer token. For Claude Code:

   ```bash
   claude mcp add --transport http pcp https://<your-pcp>/mcp \
     --header "Authorization: Bearer pcp_…"
   ```

   Any client that speaks MCP over Streamable HTTP with a static bearer token
   works the same way.

The assistant then sees a short description of the servers behind the token
and three tools:

| Tool            | What it does                                                               |
| --------------- | -------------------------------------------------------------------------- |
| `search_tools`  | Finds tools across servers from a few words ("create a github issue").     |
| `describe_tool` | Returns one tool's full description and JSON Schema.                       |
| `call_tool`     | Runs it, with PCP adding the server's credentials to the upstream request. |

## How it is secured

The short version: everything sensitive is AES-256-GCM ciphertext under a
per-vault data key, and that key is stored only wrapped under keys derived
from credentials the server does not keep — your password (scrypt), a session
cookie, an API token or the recovery key (HKDF). A request that presents one
of those unwraps the key for its own duration and drops it. Someone with the
disk has ciphertext and hashes. [ARCHITECTURE.md](ARCHITECTURE.md) has the
full model; [SECURITY.md](SECURITY.md) has the threat model and how to report
a problem.

Consequences worth knowing:

- Changing the password re-wraps the key; sessions and API tokens keep
  working. Using the recovery key signs every browser out.
- Losing the password **and** the recovery key loses the data. That is the
  design, not a bug.
- The gateway never returns a secret to an assistant, only what the upstream
  server answered.

## Development

Node 22 and pnpm 10. See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow
and [CLAUDE.md](CLAUDE.md) for the conventions an agent (or a person) should
keep to.

```bash
pnpm install
pnpm db:generate
pnpm dev             # http://localhost:3000, data in ./data
pnpm test            # unit tests (vitest)
pnpm test:e2e        # Playwright, against a fresh e2e database
```

| Script             | Description                                       |
| ------------------ | ------------------------------------------------- |
| `pnpm dev`         | Dev server (Turbopack); migrations apply at boot  |
| `pnpm build`       | Production build                                  |
| `pnpm lint`        | ESLint (`pnpm lint:fix` to auto-fix)              |
| `pnpm format`      | Prettier, writing (`pnpm format:check` to verify) |
| `pnpm typecheck`   | `tsc --noEmit`                                    |
| `pnpm test`        | Unit tests                                        |
| `pnpm test:e2e`    | Reset the e2e database, run the Playwright suite  |
| `pnpm db:generate` | Generate the Prisma client                        |
| `pnpm db:migrate`  | Create a migration after changing the schema      |

## Stack

Next.js 15 (App Router, Server Actions), React 19, TypeScript, Tailwind CSS 4
with shadcn/ui primitives, Prisma 7 on SQLite (`better-sqlite3`), the
`@modelcontextprotocol` v2 SDK for both the gateway and the upstream client,
Vitest, Playwright, pnpm.

## Licence

[MIT](LICENSE).
