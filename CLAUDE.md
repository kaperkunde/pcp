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
  `lib/core/upstream.ts`. Nothing returns a secret value to an assistant;
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
- Long tool answers and files are kept only through
  `lib/core/tool-results.ts`: text or bytes, encrypted with
  `tool_result:<id>`, readable by the token whose call produced them, gone
  after a day, never logged and never exported. A handle (`{"$result": id}`)
  in a call's arguments is replaced only in `upstream.ts` and
  `mail/accounts.ts` (`lib/core/result-handles.ts`), with the token's own
  results, before anything is sent; a waiting request stores the handle,
  never the content.
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
  protocol with each event's own time (`input.ts`), never as page script. A
  tool that needs the owner throws `OwnerNeeded`, which `runCall` turns into
  a permission request (`browse`, `browser_handover`); a site is asked
  about only for the address in the call's arguments, so a call the owner
  allowed opens it without a second ask. Its limits go in
  `browser/limits.ts`; the Dockerfile's Chromium is the version
  `playwright-core` drives (`scripts/docker.test.ts`). Chromium is installed
  only by the owner's click (`browser/install.ts`), only from the addresses
  Playwright pins for that version, in PCP's process: never with a child
  process, which the desktop app's fuses forbid.
- A level can be a token's own or for all tokens (tools in
  `vault_tool_access`, web fetch in `web_fetch_rule` with scope `all`), and
  the token's own always wins. An owner's answer to a request writes the
  token's own level.
- Server Actions live in `lib/actions/`, read the session with
  `requireContext()`, call `lib/core`, and return an `ActionState`. Forms
  use `useActionState`. Route handlers exist only for the gateway, OAuth
  (redirects and PCP's client metadata document), the health check (which, in
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
  confirmed it with their password (or Touch ID). A
  migration that adds a column fails `pnpm typecheck` in
  `lib/core/backup-format.ts` until the format carries it, with the column's
  default so older files still restore.
- Host settings (`lib/core/host-settings.ts`: dynamic DNS, HTTPS) belong to
  the machine, are read with no credential, and are stored unencrypted. Never
  copy anything from the vault into one. `lib/core/network/` starts nothing
  (timer, listener, request) while both features are off.
- The Touch ID key (`lib/core/device-keys.ts`) is a credential the Mac app
  keeps and hands to PCP's page only after Touch ID. It is made only with
  the typed password (Settings, or the box on the sign-in page), a vault has
  at most one, an export never carries it, and recovery, signing out
  everywhere and a restore remove it. It stands in for the password to
  unlock and in `confirmOwner` (a new API token, an export, a restore),
  never for a new password, a new recovery key or another Touch ID key:
  only the password and the recovery key decide who gets in. A new place
  that accepts it goes through `confirmOwner`, with a test.
- The update check (`lib/core/updates/`) asks GitHub's latest-release address
  and nothing else, sends nothing but PCP's version in its user agent, reads
  the answer as untrusted input (never rendered as HTML, never a link taken
  from it), and runs no timer and no request while the owner has it off; it
  asks nothing before setup. It tells the owner how to update for the way PCP
  was installed; in a container or a checkout PCP never pulls, builds or
  restarts itself.
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
signs in to is a "mail account"; a note an
assistant keeps between conversations is a "memory", "shared" when every
assistant reads it; what web_fetch reaches is a "site" (a host), and a level
every token follows is "for all tokens" ("All tokens" in the UI); unlocking
or confirming with a fingerprint in the Mac app is "Touch ID". No operator
vocabulary in the UI: no "DEK", "grant", "KEK" outside code comments and
ARCHITECTURE.md.
