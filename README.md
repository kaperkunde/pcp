<p align="center">
  <img src="public/icons/icon-512.png" alt="The PCP logo: a lightning-blue letter P with coloured data streams flowing into it" width="200" height="200">
</p>

<h1 align="center">PCP - Primary Control Provider</h1>

<p align="center">
  <strong>One endpoint for every MCP server you use.</strong><br>
  Self-hosted, with your secrets kept encrypted on your side.
</p>

<p align="center">
  <a href="LICENSE"><img alt="MIT licence" src="https://img.shields.io/badge/licence-MIT-5ed3c3?style=flat-square&labelColor=131720"></a>
  <img alt="Self-hosted" src="https://img.shields.io/badge/self--hosted-docker%20compose-5ed3c3?style=flat-square&labelColor=131720">
  <img alt="Single user" src="https://img.shields.io/badge/vault-single%20user-5ed3c3?style=flat-square&labelColor=131720">
</p>

<p align="center">
  <a href="#run-it">Run it</a> ·
  <a href="#use-it">Use it</a> ·
  <a href="ARCHITECTURE.md">Architecture</a> ·
  <a href="CONTRIBUTING.md">Contributing</a> ·
  <a href="SECURITY.md">Security</a>
</p>

---

A self-hosted gateway between your AI assistant and the MCP servers you use.
PCP keeps the credentials those servers need in an encrypted store, signs in
to the ones that use OAuth, and exposes a single MCP endpoint built around
three tools — `search_tools`, `describe_tool` and `call_tool` — so an
assistant can reach dozens of servers without carrying every tool definition
in its context. You decide, per token and per tool, what an assistant may run
on its own, what it has to ask you about first, and what it cannot touch.

- **One endpoint for every server.** Add servers in the web UI; an assistant
  connects once, with an API token, and finds tools by describing what it
  needs.
- **APIs without an MCP server.** Give PCP an OpenAPI schema, as a URL or a
  file, and each operation becomes a tool. PCP makes the HTTP calls itself,
  with your secret in a header, and hands the assistant the answer.
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
   and keeps the tokens as a managed secret. Many large providers (Google,
   Slack, GitHub and others) let no app register itself: PCP then says so,
   and you create an OAuth client in the provider's developer settings with
   the redirect URI the server form shows, and enter its client ID and
   secret. If the provider only keeps you signed in when asked (Google wants
   `access_type=offline`), put that in **Extra sign-in parameters**. PCP reads each server's tool
   list; you can rewrite any tool's description so an assistant picks it
   correctly.
3. **API endpoints.** Add an API by giving PCP its OpenAPI 3 schema, as a URL
   or an uploaded JSON or YAML file. PCP turns each operation into a tool,
   with the arguments the schema describes, and tells you what it left out
   (file uploads, cookies). Choose a secret to send in a header, and
   **Read-only** to offer only GET operations. Requests go to the base URL
   saved on the endpoint, which PCP never changes on its own when the schema
   does. A secret is only sent to an address you typed, or to the origin the
   schema was downloaded from, so with an uploaded file you enter the base URL
   yourself.
4. **API tokens.** Create a token per assistant or machine; PCP asks for your
   password to make one. A token can reach every server and endpoint or only
   the ones you pick, and can expire. Revoking it destroys its copy of the
   vault key. A token's page sets each tool to **Allowed**, **Ask you first**
   (the default) or **Blocked**, a whole server at once, or copies all of it
   from another token.
5. **Connect an assistant** to `https://<your-pcp>/mcp` with the token as a
   bearer token. For Claude Code:

   ```bash
   claude mcp add --transport http pcp https://<your-pcp>/mcp \
     --header "Authorization: Bearer pcp_…"
   ```

   Any client that speaks MCP over Streamable HTTP with a static bearer token
   works the same way.

The assistant then sees a short description of the servers behind the token
and these tools:

| Tool               | What it does                                                                                                     |
| ------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `search_tools`     | Finds tools across servers from a few words ("create a github issue").                                           |
| `describe_tool`    | Returns one tool's full description, JSON Schema and whether it asks you first.                                  |
| `call_tool`        | Runs it, with PCP adding the credentials to the request to the server or the API.                                |
| `check_permission` | Says whether you answered a request that was waiting for you, and how it went.                                   |
| `check_server`     | Says whether a server is connected; offers you a Connect button where it can.                                    |
| `register_server`  | Proposes a new MCP server, or an API from OpenAPI 3 text (JSON or YAML), with no auth or a secret named by name. |

A tool you have not decided about answers "Not done yet" and asks you. Where
the assistant's app can show it, the question appears in the conversation:
as PCP's panel (an MCP App) or as the app's own prompt. Otherwise the
assistant hands you a link to PCP. Each token's page says which of these PCP
may use; turn one off if an app gets stuck on it. **Allow once** runs that one call,
**Always allow** and **Block** also decide the calls after it, and **Not
now** runs nothing. A server an assistant proposes is only added once you
agree; an OAuth one is then connected from a link that opens in your browser.

An assistant can write an OpenAPI schema from an API's documentation and hand
it to `register_server` as text. You see what it asked for before anything is
added: the address, how many tools and which operations, whether it can change
things, and the secret it would send. An API added that way reaches public
addresses only until you allow private ones on the endpoint's page.

A token made with **Let an assistant with this token read and change API
endpoints** gets two more tools:

| Tool              | What it does                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------- |
| `update_endpoint` | Changes an endpoint's name, description, schema text, base URL, read-only setting or tool descriptions. |
| `get_endpoint`    | Reads an endpoint's settings and tools, and optionally its schema text, to edit and send back.          |

What an assistant can do here is narrower than what you can. It can change an
endpoint it registered only while nothing of yours is attached to it (no
secret, public addresses only), and a change disables the endpoint until you
enable it again, because the words it writes reach every other assistant. It
can never see, choose or change a secret afterwards. Once an endpoint sends
your secret, or you allow private addresses, it is yours: an assistant can
read it and turn read-only on, and nothing else. Leave the option off for a
token that does not need it.

A token made with **Let an assistant with this token keep memories** gets a
`memory` tool: notes that last between conversations and stay with you rather
than with one app. It works like Claude's own memory tool (files under
`/memories`: view, create, str_replace, insert, delete, rename, plus search),
and PCP's instructions, modelled on the protocol Claude's own memory tool
uses, tell the assistant to look there before anything else and to save what
you would not want to say twice as it goes.

- `/memories/…` is the assistant's own: only the token that wrote a memory
  reads it, and writing one needs no answer from you.
- `/memories/shared/…` is read by every assistant whose token keeps memories.
  An assistant that wants to share a memory, or change, rename or delete a
  shared one, has to ask, the same way a tool asks: you see the whole text (a
  shared memory is at most 2,000 characters) with a warning about what to look
  for, and choose **Share it**, **Keep it for this assistant only** or
  **Discard it**. Nothing is written before you answer.

Text with characters that do not show on screen is refused, so what you read
is all there is. The **Memories** tab lists every memory with the token that
wrote it; you can add shared ones yourself, and edit, move or delete any of
them. Tick **Read in every conversation** on one (up to 2,000 characters) and
its text comes with PCP's instructions, so an assistant has it before it does
anything rather than when it thinks to look; a shared one reaches every
assistant, one an assistant keeps reaches only that one. If an assistant
changes one it keeps, it is no longer read in every conversation until you
tick it again. Memories are encrypted like everything else.

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
  working. Using the recovery key signs every browser out and can revoke
  every API token.
- A stolen session cannot make an API token or a recovery key: both ask for
  the password again.
- Losing the password **and** the recovery key loses the data. That is the
  design, not a bug.
- The gateway never returns a secret to an assistant, only what the upstream
  server answered. An API's answer is scrubbed of the secret first, in case it
  echoes the key back in an error.

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
