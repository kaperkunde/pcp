# Working in this repo

Start with [CONTRIBUTING.md](CONTRIBUTING.md) for setup and the key-files
table, and [ARCHITECTURE.md](ARCHITECTURE.md) for the encryption and tenancy
model, and [DESIGN.md](DESIGN.md) for how the owner's pages look and where
things go on them. This file is the conventions that are easy to get wrong.

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

When pushing straight to `develop`, skip the Playwright run: it is slow, and
the suite runs on the pull request from `develop` to `main` anyway. Still
update the specs your change affects, and say in the commit or your summary
that e2e was not run.

## Branches and versions

Branch from `develop` and target it with pull requests; `main` only takes
merges from `develop`, and every push to it is a release (see "Branches and
releases" in CONTRIBUTING.md). A MAJOR or MINOR bump is `pnpm version:bump
minor|major` in a commit on `develop`; the patch and the `v*` tags belong to
the release workflow, never to a hand edit. Anything that states PCP's version
uses `PCP_VERSION` from `lib/core/version.ts`, not a literal.

Never change the version yourself. Build (patch) versions count up on their
own on every push to `main`, and a MINOR or MAJOR bump is made only when the
user asks for one in so many words. A change that could justify a bump is said
so in the summary; the bump itself waits for the request.

## Boundaries

- `lib/core` is framework-free. No `next/*`, no React, no `lib/actions`,
  no `lib/server` (ESLint enforces it). Everything takes a `VaultContext`
  explicitly. If a core function needs something from the request, the
  caller passes it in (the public URL is the usual one).
- Client components must not import from `lib/core` except
  `lib/core/constants.ts` and `import type`. Anything else drags Prisma into
  the browser bundle and the build fails in webpack, not in the dev server.
- Secrets are decrypted in `lib/core/secrets.ts` and used in
  `lib/core/upstream.ts` (headers, and a wrapper's bound placeholders).
  Nothing returns a secret value to an assistant;
  `revealSecret` is for the owner's own screen. An API endpoint's calls
  (`lib/core/endpoints.ts`, `lib/core/openapi/`) are handed their finished
  header by `upstream.ts` and never read a secret; `openapi/call.ts` scrubs
  the secret from what the API answers.
- What an assistant may do to an endpoint through the gateway
  (`lib/core/endpoint-admin.ts`) is narrower than what the owner may do, on
  purpose. It registers one through `register_server` with OpenAPI text or a
  schema URL (downloaded at once, public addresses only, and approved as that
  copy), which is a permission request like any new server: the owner is shown
  the address, the tools and the secret (by name, with the user name for a
  basic login), and nothing exists until they agree. A secret PCP does not
  hold yet is typed in by the owner on PCP's
  permission page, and its value never reaches the assistant. OAuth at a
  provider that lets apps register is found out by PCP when the owner
  connects (the metadata counts only when it names the approved sign-in and
  token addresses), so `client_id` is only for one that does not. It changes a schema with edits (a JSON Patch, `openapi/patch.ts`)
  rather than resending it, and a changed document at a URL it proposed is not
  taken without the owner.
  It never changes a credential and never clears `publicOnly`. On an
  endpoint that is the owner's (it sends a secret or an OAuth token, or private
  addresses are allowed) it can turn read-only on, and anything else it may change there
  (name, description, edits, tool descriptions, a re-read of the schema URL)
  is a permission request (`endpoint_change`) that shows the owner every new
  edit and description in full and what it does to the tools, and makes only
  that, to the endpoint as it was when they were asked; never the address or
  a whole new schema. On its own endpoint a change others would see disables
  it until the owner enables it. Its changes go through `changeEndpoint`,
  which writes only the columns it is given and never the credential. Keep
  all of that when adding to it, and add a test for each new field an
  assistant can set.
- Memories (`lib/core/memories.ts`): an assistant writes its own
  (`/memories/…`) without asking, but anything other assistants would read
  (`/memories/shared/…`: creating, sharing, changing, renaming, deleting) is a
  permission request that shows the owner the whole text, writes nothing
  until they answer, and writes only what they were shown. Only the owner
  marks a memory to be read in every conversation (the Memories page, or the
  toggle on a share request; an assistant's `every` only ticks it to start).
  Shared text stays
  short enough to read whole and free of characters that do not show on
  screen. The instructions name shared memories by path, and carry the text
  of the ones the owner marked to be read in every conversation (`always`):
  only the owner sets that mark, and an assistant's change to an always
  memory it keeps clears it, so every text in the instructions is one the
  owner read. Never a token's own memory the owner did not mark.
- Tool levels an assistant proposes for its token (`propose_tool_access`,
  `lib/core/access-requests.ts`) are written only by the owner's save on the
  request's page (`applyAccessRequest`), with what they chose there. No
  decision and nothing the assistant sends writes them, and blocked tools
  stay out of what it can name.
- Mail accounts (`lib/core/mail/`) never read a secret: `upstream.ts` hands
  in a `MailCredential` (the header, the login, or an OAuth bearer from
  `credential()`, renewed through `endpointToken` like an API endpoint's). Mail travels encrypted only (TLS, or STARTTLS that
  is required, never optional); a JMAP session's API, download and upload
  addresses are taken only on the session URL's origin, and redirects are not
  followed. An attachment sent is a kept result of the token's own, read
  before anything connects. Nothing deletes mail for good: delete moves to the Trash. An
  assistant adds one only through `register_server` (kind `jmap` or `imap`),
  a permission request like any new server: the owner types the password or
  token in on PCP's page or connects it, the assistant never sees a value, and
  the JMAP address is looked at with no credential, public addresses only,
  no redirect followed. Only the owner changes an account. Add a test for
  each new `register_server` argument (`lib/core/register-rules.test.ts`,
  `register-server.test.ts`). A new mail tool goes in
  `mail/tools.ts`, for both protocols where they allow, with its arguments
  checked before anything connects, and is left out of a read-only account
  and refused there if called anyway.
- SSH servers (`lib/core/ssh/`) sign in with PCP's own key, never a
  password: an Ed25519 key made in PCP per server, a managed `ssh_key` secret
  decrypted only in `upstream.ts`, which hands the ssh module an
  `SshIdentity`; the owner puts its public half in `authorized_keys`. The
  host key is pinned the first time a key exchange finishes (after `ssh2`'s
  `handshake` event, never from `hostVerifier`, which runs before the
  signature is checked) in a check the owner started (`byOwner` on
  `syncServerTools`), and any other key is refused until the owner
  forgets it; a new address forgets it too. An assistant's call or the
  gateway's re-read never pins one and never connects to a server with
  none: it answers with a link to the server's page. The protocol is `ssh2`'s, pure
  JavaScript (its native parts stay out of `allowBuilds`), narrowed to the
  algorithms in `client.ts`; no child process, no `ssh` binary. One tool,
  `run_command` (`ssh/tools.ts`), its arguments checked before anything
  connects: `exec` only, never a terminal, forwarding, an agent or a file
  transfer. Only the owner adds or changes one; `register_server` has no kind
  for it. Its limits go in `ssh/limits.ts`, and a change to how a host is
  trusted or PCP signs in gets a test against the test server
  (`ssh/client.test.ts`).
- Long tool answers and files are kept only through
  `lib/core/tool-results.ts`: text or bytes, encrypted with
  `tool_result:<id>`, readable by the token whose call produced them, gone
  after a day, never logged and never exported. A handle (`{"$result": id}`)
  in a call's arguments is replaced only in `upstream.ts`, `endpoints.ts`
  and `mail/accounts.ts` (`lib/core/result-handles.ts`), with the token's own
  results, before anything is sent; a waiting request stores the handle,
  never the content.
- The request log (`lib/core/request-log.ts`) is a token's calls by name:
  tool, server, upstream tool, time, outcome, and the permission request an
  ask made. Never arguments, results, sites or a secret; the Log page
  (`lib/core/activity.ts`) reads only the vault's own lines. A new way a call
  can ask the owner calls `noteOwnerAsked`. The cleanup
  (`lib/core/cleanup/`) deletes rows and log days by their dates, needs no
  credential and reads nothing it deletes; its schedule is refused if it
  leaves more than a day between runs. Anything new that PCP keeps only for
  a while is removed by a part there, with a test.
- `lib/core/openapi` never fetches a remote `$ref`, never follows a redirect
  on a call, and never lets an argument set a header or leave the base URL.
  A schema is untrusted input: new limits go in `openapi/limits.ts`.
- Web fetch (`lib/core/fetch/`, `lib/core/web-fetch.ts`) reaches public
  addresses, and private ones only where the owner allowed them for the
  token (a `private` line in `web_fetch_rule`, never an assistant's to set
  or ask for), never PCP's own address (`isOwnAddress`), never reads a secret, never sends a header PCP owns
  or one that carries a credential, and never follows a redirect to another
  site: that site gets its own decision. A site the token has no line for
  gets one of its own on first sight, so the owner sees every site it tried.
  Its limits go in `fetch/limits.ts`. Sites stay out of the request log.
  A site that answers `cf-mitigated: challenge` is read again through the
  vault's browser (`browser/solve.ts`): GET only, in a context of its own that
  starts from none of the vault's sign-ins and is saved nowhere, the same site
  only, the token's lines deciding as before. The sign-ins (`browser_profile`)
  are never used for a web_fetch.
- run_code (`lib/core/code/`) runs an assistant's program in QuickJS
  compiled to WebAssembly, a fresh instance per run, never in Node itself
  (not `vm`, not Node's permission model, not Pyodide in Node: none of
  those is a boundary). The program's only way out is the bridge
  (`code/run.ts`), and the bridge's only way to a tool is the gateway's
  `resolveCall` and `runCodeCall`: the token's own tools at its own levels,
  an "ask" tool stopping the run with the usual permission request, every
  call in the request log, files as handles (read as base64 only when the
  program asks). Listing (`pcp.tools`) shows what `list_tools` would. No credential, network, file
  or timer ever reaches the program, and nothing but strings crosses into
  it (a wrapper's program gets its arguments the same way, as text). Its
  memory is capped by the `WebAssembly.Memory` maximum (QuickJS's
  own limit counts nothing in these builds). The sandbox container
  (`code/sandbox.ts`, `sandbox/`, `docker-compose.sandbox.yaml`) is a second
  executor behind the same bridge: PCP only listens on its socket, and only
  when `PCP_SANDBOX_SOCKET` is set; it never touches the Docker socket. The
  container keeps no network, a read-only root and no capabilities but
  SETUID/SETGID, programs run as their own user out of reach of PCP's
  socket, and everything of theirs is killed and removed after each run
  (`scripts/sandbox.test.ts` pins the compose file). New limits go in
  `code/limits.ts`, and a new bridge operation gets a test.
- Limits on the machine's memory, processors and disk (a program's memory,
  programs at once, the largest file, kept results per token) are not
  constants: they are `resourceLimits()` (`lib/core/resources/`), picked
  from the machine unless the owner set them on Settings → Resources, and
  never past what `checkResourceConfig` lets the machine spare. A new one
  goes there, with a default from the machine and a bound. What PCP keeps
  for a while is removed by the cleanup (`lib/core/cleanup/`), which also
  gives the disk back (`cleanup/space.ts`); anything new PCP keeps on disk
  is removed there too.
- Wrappers (`lib/core/wrappers/`) are servers whose tools are programs the
  owner approved, run as run_code's are (`code/run.ts runProgram`, a fresh
  QuickJS instance, `args` handed in as text). A program calls only the
  tools its definition lists for it, never a wrapper's, at the calling
  token's own levels; a wrapper's tool comes out at the strictest of its
  own level and those of the tools it calls (`gateway-servers.ts`), and a
  call that asks runs only in a call the owner allowed (`approved`). A
  secret goes in only as `{"$secret": name}` where a binding the owner
  approved names that tool (by server id), argument and address: matched
  and written in `upstream.ts`, scrubbed from the answer, errors and status
  there, refused in an assistant's own call and never put into the browser.
  An assistant's create, change and delete are a permission request
  (`wrapper_change`) that shows every program, schema, call, replaced tool
  and secret place in full and writes only that, to the wrapper as it was
  (`basis`). Add a test for each new field an assistant can set
  (`wrappers.test.ts`).
- The browser (`lib/core/browser/`) runs Chromium for the vault and keeps
  nothing on disk: its sign-ins are the vault's `browser_profile`,
  encrypted, saved only while a request holds the key. Every connection goes
  through its proxy (`proxy.ts`), which checks the address it dials as web
  fetch does, and every page a tab's main frame opens passes the gate in
  `runtime.ts`: the driving token's web fetch site lines, a site the owner
  allowed for that tab, or the owner's own control; PCP's own site never. No
  tool runs JavaScript, reads or sets cookies or storage, or downloads. A
  refusal that names a site is a tool error, never a thrown `PcpError` (the
  request log keeps those). The owner's input enters through the DevTools
  protocol with each event's own time (`input.ts`), never as page script.
  In the container image Chromium runs with windows on a virtual display PCP
  starts itself (`display.ts`: Xvfb, its own cookie, stopped with the last
  browser); never in the desktop app, which starts no child process. A
  tool that needs the owner throws `OwnerNeeded`, which `runCall` turns into
  a permission request (`browse`, `browser_handover`); a site is asked
  about only for the address in the call's arguments, so a call the owner
  allowed opens it without a second ask. `navigate` waits for a check that
  passes on its own; one that does not is the owner's, through `hand_over`,
  and nothing asks them by itself. Pages read for web_fetch are not tabs. The
  limits go in `browser/limits.ts`; the Dockerfile's Chromium is the version
  `playwright-core` drives (`scripts/docker.test.ts`). Chromium is installed
  only by the owner's click (`browser/install.ts`), only from the addresses
  Playwright pins for that version, in PCP's process: never with a child
  process, which the desktop app's fuses forbid.
- PCP's own authorization server (`lib/core/oauth-server/`), for apps that
  sign in to `/mcp` with a URL alone (claude.ai's connectors, ChatGPT), is
  PCP's and never a relay's: whoever issues the tokens could mint one for
  itself. Every code, access token and refresh token wraps the vault key in
  a grant of its own and is stored as a hash, like an API token; the first
  is made only from the owner's session after `confirmOwner`, on PCP's page
  (`app/oauth/authorize/`), and what it makes is an API token
  (`oauth_client_id` set, empty grant), so everything keyed on tokens works
  unchanged. PKCE is S256 and required, redirect URIs match exactly, codes
  and refresh tokens work once (a second use ends the token's sign-ins), and
  nothing goes back to a client before its redirect URI checked out. A
  client's metadata document is read only for a signed-in owner, from public
  addresses, with no redirect. Anything that revokes or deletes a token ends
  its sign-ins through `endOAuthSignIns`, whose grants would otherwise
  outlive the token row. A new grant type, client kind or endpoint gets a
  test in `oauth-server.test.ts`.
- A level can be a token's own or for all tokens (tools in
  `vault_tool_access`, web fetch in `web_fetch_rule` with scope `all`), and
  the token's own always wins. An owner's answer to a request writes the
  token's own level. "Allow for" (`lib/core/allowances.ts`) is not a level:
  it is read only where the levels come out at "ask", lifts that to allowed
  until it ends, never lifts a block, and is not exported.
- Server Actions live in `lib/actions/`, read the session with
  `requireContext()`, call `lib/core`, and return an `ActionState`. Forms
  use `useActionState`. Route handlers exist only for the gateway, OAuth
  (redirects and PCP's client metadata document), PCP's own authorization
  server (`app/oauth/token`, `register`, `revoke`, and the discovery
  documents under `app/.well-known/`), the health check (which, in
  the desktop app only, also carries the version and the owner's install
  request for the wrapper to read), the export download (`app/api/export/route.ts`: a file needs
  `Content-Disposition`, which an action cannot send; it checks the request's
  origin itself, `lib/server/same-origin.ts`), and the browser's live view
  (`app/api/browser/tabs/[id]/`: a stream of a tab's pictures and the
  owner's input, which an action cannot carry; the same origin check and
  session).
- The owner is asked by link only: a result hands the assistant a link to
  PCP's page, to end its reply with (`linkLastText`: nothing after it, or
  Claude's apps fold it out of sight), and a check to call once the owner
  says they answered (`check_permission`, `check_server`,
  `lib/core/owner-wait.ts`). The header's bell lists what is waiting. No client prompts (elicitation) and no MCP Apps
  panel: Claude's apps stalled on the one and rebuilt the other stale (see
  ARCHITECTURE.md). Anything new that needs the owner works the same way.
- The single-user assumption lives in two places: `ownerVault()` and the
  setup page (its restore step included). Do not add a third.
- An export (`lib/core/backup.ts`) is the vault's rows as they are, under the
  export password: nothing is decrypted to make it, and it never carries a
  session grant or the Touch ID key. A restore replaces the vault whole, in
  one transaction, after the owner has seen what the file holds and
  confirmed it with their password (or Touch ID). It never undoes a
  revocation: into an existing vault, a token the file has live that the
  vault revoked or deleted since is written revoked with its grant blanked
  (`carriedRevocations`), and the preview marks it. A
  migration that adds a column fails `pnpm typecheck` in
  `lib/core/backup-format.ts` until the format carries it, with the column's
  default so older files still restore.
- Deleting the vault (`lib/core/vault-reset.ts`, Settings → Delete vault)
  wipes it as a restore does (`wipeVault`), with the request log, after
  `confirmOwner`, and leaves PCP not set up. The machine's settings stay. A
  new table that holds a vault's rows goes in `wipeVault`
  (`vault-reset.test.ts` counts every table).
- Host settings (`lib/core/host-settings.ts`: dynamic DNS, HTTPS, pcp.gg,
  the cleanup, resources)
  belong to the machine, are read with no credential, and are stored
  unencrypted. Never copy anything from the vault into one, and never add the
  pcp.gg key to an export (`EXPORTED_HOST_KEYS`). `lib/core/network/` starts
  nothing (timer, listener, request, connection) while all three are off.
- `lib/core/network/pcpgg/{frames,mux,control}.ts` are copies of pcp.gg's
  `tunnel/protocol/` (kaperkunde/pcp-gg) and speak its wire protocol: change
  them only together with pcp.gg, keeping `PROTOCOL_VERSION`. `test-relay/`
  is pcp.gg's relay for tests; PCP never runs it.
- The Touch ID key (`lib/core/device-keys.ts`) is a credential the Mac app
  keeps and hands to PCP's page only after Touch ID. It is made only with
  the typed password (Settings, or the box on the sign-in page), a vault has
  at most one, an export never carries it, and recovery, signing out
  everywhere and a restore remove it. It stands in for the password to
  unlock and in `confirmOwner` (a new API token or an app's sign-in, an
  export, a restore, deleting the vault, the public address, a new expiry
  for an expired API token),
  never for a new password, a new recovery key or another Touch ID key:
  only the password and the recovery key decide who gets in. A new place
  that accepts it goes through `confirmOwner`, with a test.
- The update check (`lib/core/updates/`) asks GitHub's latest-release address
  and nothing else, sends nothing but PCP's version in its user agent, reads
  the answer as untrusted input (never rendered as HTML, never a link taken
  from it), and runs no timer and no request while the owner has it off; it
  asks nothing before setup. It tells the owner how to update for the way PCP
  was installed; in a container or a checkout PCP never pulls, builds or
  restarts itself. Install and restart in the Linux installer's container is
  a file in the data folder (`updates/host-signal.ts`: an id and a time,
  nothing of the vault) that the installer's `watch` reads through `exec` and
  checks as untrusted input before it runs its own `update`; PCP never
  addresses the host.
- `desktop/` is a host for the production build, not part of the app. It
  imports nothing from `lib/`, `app/` or `components/`; the app knows it only
  as `PCP_DESKTOP=1` and `PCP_DESKTOP_UPDATER` (`lib/server/desktop.ts`), for
  copy that says how the app is reached and whether it installs an update
  itself, and never addresses it: the wrapper reads `/api/health`. PCP's
  pages reach the wrapper only through `window.pcpDesktop`
  (`desktop/preload.cjs`, read through `components/desktop-bridge.ts`),
  which answers PCP's own pages only and hands over the Touch ID key only
  after Touch ID. The fuses in `desktop/electron-builder.yml` keep other
  programs from running code as the app, and so from its keychain item:
  leave them flipped. `desktop/native/keychain` is the only native code the
  wrapper builds (Touch ID's keychain item); the keychain group goes on the
  app alone, never on `entitlementsInherit`, and only with a profile
  `desktop/scripts/keychain-profile.mjs` has checked: macOS kills a process
  whose entitlements its profile does not cover. Whether the app has the
  group is read off its own signature, never inferred from a keychain
  answer. `desktop/scripts/stage.mjs` copies what the Dockerfile
  copies: a change to one is a change to both. (Its environment is the
  wrapper's own: the HTTPS ports stay 80 and 443, which the image moves.) It is its own pnpm project
  (`desktop/pnpm-workspace.yaml`); do not add it to the root workspace, or
  every install downloads Electron.

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
check refuses to start). Read the SQL Prisma writes: its table rebuild
(`RedefineTables`) drops the table, and migrations run in a transaction with
foreign keys on, so the drop cascades to every row that points at it. Drop a
column with `ALTER TABLE … DROP COLUMN` instead.

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
OpenAPI schema is an "endpoint" ("API endpoints" in the UI); a mailbox PCP
signs in to is a "mail account"; a machine PCP runs commands on is an "SSH
server" ("SSH servers" in the UI); a server whose tools are programs over the
others is a "wrapper" ("Wrappers" in the UI); a note an
assistant keeps between conversations is a "memory", "shared" when every
assistant reads it; what web_fetch reaches is a "site" (a host), and a level
every token follows is "for all tokens" ("All tokens" in the UI); unlocking
or confirming with a fingerprint in the Mac app is "Touch ID". No operator
vocabulary in the UI: no "DEK", "grant", "KEK" outside code comments and
ARCHITECTURE.md.
