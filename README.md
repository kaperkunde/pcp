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
  <a href="docs/self-hosting.md">Self-hosting guide</a> ·
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
  with your secret or OAuth sign-in, and hands the assistant the answer.
- **Secrets stay on your side.** API keys and OAuth tokens are encrypted at
  rest with a key the server does not hold. They are added to upstream calls
  by PCP; the assistant never sees them.
- **Nothing to configure.** Open the Mac or Windows app, or
  `docker compose up` and open the site; choose a password. No environment
  variables. Dynamic DNS and HTTPS with Let's Encrypt are built in for a home
  server, and off for anyone with a proxy.
- **Single user, by design.** PCP is yours: one owner, one encrypted vault.

## Run it

### On your own computer

Download the app and open it. It runs PCP on your computer, keeps the vault in
your user folder, and opens a window on it. An assistant on the same computer
reaches it at `http://localhost:3000/mcp`.

- **Mac**:
  [Apple silicon](https://github.com/kaperkunde/pcp/releases/latest/download/PCP-mac-arm64.dmg) ·
  [Intel](https://github.com/kaperkunde/pcp/releases/latest/download/PCP-mac-x64.dmg)
- **Windows**:
  [Installer](https://github.com/kaperkunde/pcp/releases/latest/download/PCP-windows-x64.exe)

The apps are not signed with a developer certificate, so the first start
needs a nod. macOS: open it, dismiss the warning, then System Settings →
Privacy & Security → **Open Anyway**. Windows: SmartScreen → **More info** →
**Run anyway**.

The app answers this computer only until you turn on **Accept connections
from other devices** in its menu. It keeps running when you close its window
(quit from the menu, or the tray icon on Windows) and can start when you sign
in. Its data is in `~/Library/Application Support/PCP` on a Mac and
`%APPDATA%\PCP` on Windows; back that folder up like a Docker volume.

**From outside your home.** An assistant that runs elsewhere (Claude on the
web, a phone) needs an address that reaches your computer from the internet,
which a home router does not give it on its own. While PCP is at a home
address, its **Settings** page explains the two ways:

- **A tunnel** (Cloudflare Tunnel, Tailscale Funnel, ngrok) runs on your
  computer, needs no router changes, works on shared (CGNAT) connections and
  comes with `https`. The easier way.
- **PCP's own Dynamic DNS and HTTPS**, with ports 80 and 443 forwarded on your
  router to this computer, as in
  [the self-hosting guide](docs/self-hosting.md#4-reach-pcp-from-outside-your-home-optional).
  The app opens those ports itself once HTTPS is on; Windows asks to let it
  through the firewall.

### On a server, with Docker

New to self-hosting? **[The self-hosting guide](docs/self-hosting.md)** walks
through it step by step, from installing Docker to reaching PCP from your phone
over HTTPS.

```bash
git clone https://github.com/kaperkunde/pcp.git
cd pcp
docker compose up -d
```

Open http://localhost:3000. The first visit shows the setup page: pick your
name and a password. You will be shown a **recovery key** once — store it in a
password manager. There is no password reset without it, because there is
nothing on the server that could reset it.

For anything beyond your own machine, PCP needs HTTPS: most OAuth servers
require an `https` redirect URL, and the session cookie is only marked
`Secure` over TLS. Either way works:

- **PCP's own HTTPS.** In the step after setup, or later under Settings, turn
  on **Dynamic DNS** (DuckDNS, No-IP, Dynu, Cloudflare or any update URL) to
  keep a name pointed at a home connection, and **HTTPS** to get and renew a
  Let's Encrypt certificate. Start PCP with the ports it needs and forward 80
  and 443 on your router:

  ```bash
  docker compose -f docker-compose.yaml -f docker-compose.https.yaml up -d
  ```

- **Your own proxy** (Caddy, Traefik, nginx, Coolify) in front of port 3000,
  passing `X-Forwarded-Proto`. Leave both settings off; they are off until
  turned on, and nothing extra listens or runs.

The data lives in the `pcp-data` volume (`/data` in the container): the
SQLite database, the request log and, with HTTPS on, the certificate. Back
that up; nothing else holds state.

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
   header (`Authorization: Bearer {{secret}}` by default, with further
   headers when the credential has several parts), or OAuth. For
   OAuth, choose **Connect** on the server page: PCP discovers the
   authorization server, registers itself if it can, sends you to sign in
   and keeps the tokens as a managed secret. Many large providers (Google,
   Slack, GitHub and others) let no app register itself: PCP then says so,
   and you create an OAuth client in the provider's developer settings with
   the redirect URI the server form shows, and enter its client ID and
   secret. Some providers only keep you signed in when the sign-in asks for
   it: PCP adds what it knows (Google's `access_type=offline`) itself, and
   **Extra sign-in parameters** takes anything else. A server that refuses
   PCP shows why on its page. PCP reads each server's tool list; you can
   rewrite any tool's description so an assistant picks it correctly.
3. **API endpoints.** Add an API by giving PCP its OpenAPI 3 schema, as a URL
   or an uploaded JSON or YAML file. PCP turns each operation into a tool,
   with the arguments the schema describes, and tells you what it left out
   (file uploads, cookies). Choose a secret to send in a header (more than
   one, each in its own header, for an API that wants a key and a secret
   key), or, for an API whose schema declares an OAuth sign-in (Google's, Microsoft Graph),
   your own OAuth client and **Connect**. **Read-only** offers only GET
   operations. Requests go to the base URL saved on the endpoint, which PCP
   never changes on its own when the schema does. A secret is only sent to an
   address you typed, or to the origin the schema was downloaded from, so
   with an uploaded file you enter the base URL yourself. **Edits** (a JSON
   Patch) fix or narrow a schema you do not control, and are kept when it is
   read again.
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

| Tool                  | What it does                                                                                                                                                      |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search_tools`        | Finds tools across servers from a few words ("create a github issue").                                                                                            |
| `list_tools`          | Lists every tool on one server, with whether it runs at once or asks you first, a page of 200 at a time.                                                          |
| `describe_tool`       | Returns one tool's full description, JSON Schema, whether it asks you first, and for an API what it answers.                                                      |
| `call_tool`           | Runs it, with PCP adding the credentials; `fields` keeps only the parts of a long JSON answer it needs, and `decode` decodes base64 text in it (an email's body). |
| `check_permission`    | Says how a request went once you have answered it; waits a little if you are still on it.                                                                         |
| `check_server`        | Says whether a server is connected; waits a little if you are still signing in.                                                                                   |
| `register_server`     | Proposes a new MCP server, or an API from an OpenAPI 3 schema (text or a URL), with no auth, a secret named by name, or OAuth.                                    |
| `propose_tool_access` | Proposes which tools its token may run, many at once and across servers, and hears which tools would change; you review and save it in PCP.                       |

A tool you have not decided about answers "Not done yet" and asks you: the
assistant ends its reply with a link to the request in PCP. Answer there,
tell it you have, and it carries on. The bell at the top of every page in
PCP shows how many requests are waiting and lists them, so you can answer
one without the link. **Allow once** runs that one call, **Always allow** and
**Block** also decide the calls after it, and **Not now** runs nothing. A
server an assistant proposes is only added once you agree; an OAuth one is
then connected from a link to its page in PCP.

An assistant can also help with a large set of tools: `propose_tool_access`
takes levels for many tools at once, by name or by pattern (`list_*`), and
hands you a link to a page in PCP with its levels filled in and each change
marked. Nothing changes until you save there, and you can change any level
first, so an assistant can suggest but never raise its own access.

An assistant can write an OpenAPI schema from an API's documentation and hand
it to `register_server` as text, or name a schema's URL. You see what it asked
for before anything is added: the address, how many tools and which
operations, whether it can change things, and the secret it would send. A
secret PCP does not hold yet is typed in by you on that page, so its value
never passes through the assistant. An API added that way reaches public
addresses only until you allow private ones on the endpoint's page.

A token made with **Let an assistant with this token read and change API
endpoints** gets two more tools:

| Tool              | What it does                                                                                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `update_endpoint` | Changes an endpoint's name, description, edits, base URL, read-only setting or tool descriptions, or reads its schema URL again.   |
| `get_endpoint`    | Reads an endpoint's settings and tools, its edits, one part of its schema at a time, and likely mistakes in it with fixes to make. |

What an assistant can do here is narrower than what you can. It can change an
endpoint it registered only while nothing of yours is attached to it (no
secret or OAuth sign-in, public addresses only), and a change disables the endpoint until you
enable it again, because the words it writes reach every other assistant. It
can never see, choose or change a secret afterwards. Once an endpoint sends
your secret or OAuth token, or you allow private addresses, it is yours: an assistant can
read it and turn read-only on, and it can ask you to fix the schema with
edits, rename it, reword its tools or read its schema URL again. You are shown
every edit and description in full and what it does to the tools, and nothing
changes unless you agree. Its address and secret stay yours alone. Leave the
option off for a token that does not need it.

A token made with **Let an assistant with this token keep memories** gets a
`memory` tool: notes that last between conversations and stay with you rather
than with one app. It works like Claude's own memory tool (files under
`/memories`: view, create, str_replace, insert, delete, rename, plus search
and every), and PCP's instructions, modelled on the protocol Claude's own
memory tool uses, tell the assistant to look there before anything else and to
save what you would not want to say twice as it goes. Before its first reply
it calls `every`, which returns the memories you chose to have read in every
conversation and lists the rest.

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
  server answered. An API's answer is scrubbed of the secret or token first,
  in case it echoes the key back in an error.

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
