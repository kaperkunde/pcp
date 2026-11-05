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
pull request and on a push to `develop`, and nothing runs on other pushes.

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
  `lib/core/upstream.ts` (headers, a wrapper's bound placeholders, and a
  secret the browser types). Nothing returns a secret value to an assistant;
  `revealSecret` and `revealTotpCode` are for the owner's own screen. A
  `totp` secret's seed never leaves `secrets.ts`: only the code of the
  moment is typed, and only by the browser. An API endpoint's calls
  (`lib/core/endpoints.ts`, `lib/core/openapi/`) are handed their finished
  header by `upstream.ts` and never read a secret; `openapi/call.ts` scrubs
  the secret from what the API answers, and refuses a file answer (kept as
  a result, its handle answered) whose bytes hold it.
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
  It never changes a credential and never clears `publicOnly`: only the
  owner does, with the switch on the server's page (`#public-only`), or by
  ticking "Allow private addresses" on a request for a server or endpoint
  flagged as private (`allowPrivate`, offered only then, never an
  argument). On an
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
- Definitions (`lib/core/definitions.ts`, `definition-rows.ts`): an MCP
  server, endpoint, wrapper or service is an instance of a
  `server_definition`, and what instances share (description, schema and
  edits, wrapper program, a service's definition, tool descriptions) is
  copied on each of them. Anything that writes shared content goes through
  `endpoints.ts applySpec`, `shareDescription`, `setToolDescription`,
  `writeWrapper` or `services.ts writeServiceDefinition`, so every instance gets it and
  rebuilds its tools; the owner's tool tiers are the definition's own rows
  (`tool_tier`), written only through `tool-tiers.ts setToolTier`, which
  every instance reads (a detach copies them, a merge keeps the kept
  definition's); a server made on a definition takes its content, never
  its own. An endpoint shares the owner's rules with its siblings: it is the
  assistant's only while every instance is. Merge is the owner's alone. An
  assistant only proposes the rest, each a permission request that writes
  nothing until the owner agrees: another server of a definition it sees
  (`definition` on `register_server` and `create_wrapper`: the instance's
  own part only, made on the definition while `definitionBasis` holds, no
  levels copied), detach (`detach` on `update_endpoint`/`update_wrapper`)
  and the owner's note (`personal-notes.ts`: one line, at most 300
  characters, encrypted, never in a repository document; `note` there, or
  `/skills/<name>/.note`, a `note_change` the owner reads whole, written
  only over the note they had when asked).
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
- Skills (`lib/core/skills.ts`) are procedures the owner approved, kept as
  SKILL.md (frontmatter with a `version`, other tools' keys kept as they
  are), encrypted under `skill:<id>`. An assistant reads the ones its token
  sees through `search` and `describe`, and proposes a change only through
  the `memory` tool's `/skills/…` paths: a `skill_change` request that shows
  the whole skill and its diff and writes only that, while the skill is
  still at the version the owner was shown. The exception is a token's own
  skills (`/skills/mine/<name>/`, `visibility` `private` with its
  `tokenId`), as `/memories/notes.md` is: written at once, seen only by that
  token (`skill:mine/<name>`, never framed as approved) and the owner (the
  Skills page, marked with the token), never offered to another token and
  never in a linked repository (`repos/` reads `listSharedSkills` only). One
  becomes shared only by the owner's hand (`shareSkill`) or a `skill_change`
  with `share` (renaming it out of `/skills/mine/`), written as shown. A
  deleted token's stay, the owner's alone. A change to the SKILL.md shape
  stays backward compatible.
- Every tool PCP exposes is defined through `lib/core/tools/`: PCP's own
  at `/mcp` with `defineTool`, the families behind call_tool (browser, mail,
  calendar, SSH, services, storage folders) with `defineInnerTool`
  (`tools/family.ts`); a
  strict zod input published as JSON Schema 2020-12 (objects closed, every
  property described), rules across arguments as JSON Schema under
  `allOf`, all four annotations, an `output` when every answer is one
  shape. One validator (`tools/validate.ts`) checks every call's
  arguments before anything runs, connects or asks the owner, on every
  path (`lib/core/call-arguments.ts`: call_tool_<tier>, run_code_<tier>'s
  `pcp.call`, a wrapper's or flow's calls; the family again before it runs); zod adds
  only what JSON Schema cannot say. An answer is one of the outcome kinds
  (`tools/outcome.ts`: `ok`, `toolError` with its code in
  `_meta["gg.pcp/error"]`, `needsOwner`, passed on): a family throws only
  for a failure on the way (`upstream`) or a sign-in (`unauthorized`), never
  for arguments, an unknown tool or read-only. Arguments are snake_case; a
  renamed one is an alias for one release with a note (and a wrapper's
  answer says how to change its program), then `retired`, refused with the
  name to use. Each rename goes in `docs/breaking-changes.md`.
- A PCP tool's description opens with a verb, its object and what sets it
  apart, in a search's words, within its first 25 characters: Claude's apps
  show the model little more of a deferred tool (`gateway-tools.test.ts`
  checks every one; a new tool adds its keyword there). Names and
  descriptions are the same for every client and session. What differs per
  app is in answers only, by its client profile (`lib/core/clients/`: a
  typed list with `observed` dates, detected per request from clientInfo,
  label headers, user agent and OAuth client name, the owner's choice per
  token winning): whether the instructions' key rules are repeated, once a
  session, and link style. The client last seen is `api_token.client_seen`
  (its own name, version, profile, time), never the request log.
- `call_tool_read`, `call_tool_write` and `call_tool_destructive` take only
  a `call_handle` from `describe` (`lib/core/call-handles.ts`: an HMAC under
  the vault key over the token, the tool and its schema's hash, the same for
  every tier), and check the arguments with that validator before anything
  runs or asks the owner. run_code_<tier>'s `pcp.call` keeps names.
- Tool tiers (`lib/core/tool-tiers.ts`): every tool is Read, Write or
  Destructive, and `effectiveTier` is the one truth: the owner's choice,
  else for a wrapper's tool the highest tier of its calls (an unknown call
  is Destructive; the definition's own annotations only propose), else the
  annotations as MCP reads them (no hints is Destructive). An API
  endpoint's tools state both hints (GET Read, POST/PUT/PATCH Write, DELETE
  Destructive). Everything that asks whether a tool reads or destroys asks
  there, never the raw annotations: the entry gates, `markedReadOnly`
  (pacing, a run's trace), the permission page's warning, the wrapper
  review's badges, describe, list_tools, search, pcp.tools, and what PCP's
  own tools advertise. Each `call_tool_<tier>` and `run_code_<tier>` runs
  tools at or below its tier only and refuses one above, naming the entry
  that runs it, before its arguments are checked or the owner asked (in a
  program, an error it may catch); the run's duplicate key holds the tier.
  The owner's levels apply in every tier; a tier adds no right. Derived
  tiers are worked out when asked, never stored. The owner's choices are
  `tool_tier` rows (per definition, or per server without one) and the
  vault's `toolTiers` setting for PCP's own tools; a wrapper tool's choice
  below what its calls came to since goes to the bell (`tierNotices`).
- Pacing (`lib/core/pacing/`) applies only in `upstream.ts callServerTool`
  (the browser by the tab's site, in `browser/call.ts`) and web fetch's
  request path (`fetch/fetch.ts`, `web-fetch.ts runFetch`), so every way in
  is paced: call_tool_<tier>, run_code_<tier>, wrappers and flows,
  owner-approved calls, each as a read or a change by its tier; and to
  search's embeddings requests, as a read (`paceEmbeddings`).
  New defaults and bounds go in `pacing/limits.ts`, by class of action;
  nothing names a site or vendor. The owner's overrides are the vault's
  `pacing` setting, never a host setting.
- Linked repositories (`lib/core/repos/`) share items, never secrets, and
  are never a backup. Their documents carry `pcp_format` and change only
  backward compatibly (add fields with defaults, never repurpose one).
  `github.ts` is the only client: GitHub's REST API, and github.com for the
  device flow only; no redirect, public addresses only, every answer bounded
  (`repos/limits.ts`) and read against a schema, every file checked against
  its git id. It never reads a secret: `upstream.ts githubCredential` hands
  it the header, from a text secret or PCP's own sign-in (`oauth/github`).
  A token's own skill is never an item: not listed, pushed, imported onto
  or kept out. A server's document is its definition only (`PCP_FORMAT`
  2): sync never writes an instance's own fields (name and short name, address,
  credential and secrets, read-only, public-only, enabled, pace, levels,
  note; a service's SSH server, publish address, variables' secrets and
  typed values, container, what it registered, its exit), and what a format-1 document says of its
  server only fills in a first instance. Format 3 adds `services/<name>.yaml`
  (a service's definition); every other kind is still written in the
  format that first held it (`FORMAT_OF_KIND`), so an older PCP reads them
  and leaves `services/` alone. Format 4 adds `auth` on a service's MCP
  server and a service's `files`; only a service document that has either
  is written as format 4 (`serviceFormat`), and a format-3 one naming
  either is refused. PCP's common items,
  `kaperkunde/pcp-gg-common` (`repos/common.ts`), are offered in one click,
  linked read-only and untrusted (pinned imports), read without a sign-in.
  A push is one commit per item, fast-forward only, and
  only through the push's review (`repos/share-review.ts`): every file in
  full, what stays private, and the personal-data check
  (`repos/personal-data.ts`, pure), which a public repository waits on
  until each hit is fixed or ticked; Confirm pushes exactly what was shown
  (its `basis`) or opens the review again. Never a push of several items
  at once. From a trusted read-and-write repository only a `textOnly`
  change applies by itself; an item imported from a read-only repository
  is pinned, and everything else waits on the item (`pending`, named by
  its git id) and applies only as the owner was shown it, while its
  `basis` holds. Nothing syncs without a
  request's key: `runDueSyncs` runs only through `after()` from `/mcp` and
  the owner's pages; never a timer, a webhook or a stored key. An assistant
  (manage-endpoints only) helps through `search`, `describe` and
  `/repos/<id>/` in the memory tool, as one `repo_change` request, and
  proposes one item it sees for a push through `/repos/share/…`
  (`repos/assist-share.ts`): a `repo_share` request whose only yes is
  Confirm on the push's review (`confirmProposedShare`, which is
  `confirmShare` unchanged). A new way in gets a test against
  `fake-github.ts`.
- Tool levels and tiers an assistant proposes (`propose_tool_access`,
  `lib/core/access-requests.ts`: `access`, `tier` or both per change; PCP's
  own tools by tier only, on the server "pcp") are written only by the
  owner's save on the request's page (`applyAccessRequest`), with what they
  chose there: levels for its token, tiers through `setToolTier` (every
  server of the definition, which the page says) or the vault's setting.
  No decision and nothing the assistant sends writes them, and blocked
  tools stay out of what it can name. The same holds for `tool_access` on
  `register_server`, `create_wrapper` and `update_wrapper`
  (`lib/core/proposed-access.ts`): stored on the request, shown filled in
  and editable beside the approval on the same page, and written only with
  the owner's yes there (`decidePermission`'s `access`, checked by
  `checkChosenAccess`), as they left it, through the access request's own
  checks and writes. By tool where the names are known up front (a
  wrapper's tools, an endpoint's operations, a mail or calendar account's
  tools); by name pattern otherwise (an MCP server, an OAuth one, what a
  service registers), kept on the server (`pending_access`) and applied
  once to the tools its first read finds (`syncServerTools`), then
  cleared, never lifting a block set since. Add a test for each new field
  (`proposed-access.test.ts`, `register-server.test.ts`,
  `wrappers.test.ts`).
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
- Calendar accounts (`lib/core/caldav/`) never read a secret either:
  `upstream.ts` hands in a `DavCredential` (Basic, a bearer header, or an
  OAuth bearer from `credential()`). The sign-in goes only to the typed origin,
  or over `https://` to a host under the typed host's own domain
  (`acceptedAddress`, for iCloud's `p<n>-caldav.icloud.com`), public addresses
  only there; `http://` only to the owner's own network. Redirects are
  followed only while finding the home, on the same origin. A change reads the
  object and writes it back with its ETag (`If-Match`; a new one
  `If-None-Match: *`), changing only what it was asked to, so another app's
  properties stay. Times are turned into instants by PCP (`zones.ts`), never
  through ical.js's global zone registry; what PCP writes names an IANA zone
  with a VTIMEZONE. The tools (`caldav/tools.ts`) are a fixed set, their
  arguments checked before anything connects, left out of a read-only account
  and refused there if called anyway; none takes WebDAV or raw iCalendar, and
  none adds attendees (the server would invite them). An assistant adds an
  account only through `register_server` (kind `caldav`), a permission request
  like a mail account's; only the owner changes one. Add a test for each new
  tool or argument (`caldav/accounts.test.ts`, against `fake-caldav.ts`).
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
  connects: `exec` only, never a terminal, an agent or a file transfer.
  SFTP is for storage folders only (`openSftp`, below), confined to the
  folder. Forwarding is open for exits and services only (`openChannel`, below):
  outbound direct-tcpip, never remote forwarding (`tcpip-forward`),
  streamlocal, the agent or X11. Only the owner adds or changes one; `register_server` has
  no kind for it. Its limits go in `ssh/limits.ts`, and a change to how a host
  is trusted, PCP signs in or a channel opens gets a test against the test
  server (`ssh/client.test.ts`).
- Storage folders (`lib/core/storage/`, kind `storage`, a `storage_root`
  row) are folders on an SSH server PCP holds that assistants list, find,
  get, save, move and delete files in, over SFTP on the SSH server's pooled
  connection (`ssh/client.ts openSftp`): a pinned host only, opened with
  the key a request handed in (`upstream.ts storageConnect`), never in the
  background, and SFTP for nothing else. Every path is confined by
  `storage/files.ts`: `..` refused before anything connects, the folder a
  name is in resolved by its real path on the server and refused unless it
  is the root's or inside it, the name itself never followed (a link is
  followed only to read or list through, and only into the root; delete
  and move act on the link). A write goes to `<name>.<random>.pcp-part`
  with exclusive create, gets the root's umask, and is renamed into place;
  a file there is replaced only with `overwrite`. SFTP writes as the login:
  `write_as` is what the owner wants, said on the page when it differs,
  never sudo or chown. Files leave as kept results (`get_file`, bounded by
  `resourceLimits().fileBytes`) and come in as the token's own
  (`save_file`'s `file`, read before anything connects). A read-only folder
  offers and runs the reading tools only; `delete` is Destructive. Only
  the owner adds one (on the SSH server's page) or changes it;
  `register_server` has no kind for it. Its file browser
  (`/servers/<id>/files`) goes through the same confinement. Limits go in
  `storage/limits.ts`, and a new tool, argument or way a path is resolved
  gets a test against the test server's SFTP (`storage/storage.test.ts`).
- Exits (`lib/core/exits/`) let web_fetch (`exit`) and a new browser tab
  (`tabs` open with `exit`) go out from somewhere else than PCP's machine:
  an SSH server PCP holds (kind `ssh`), or a VPN container PCP started on one
  (kind `service`). An assistant names an exit, never a destination: every
  connection goes through `exits/dial.ts dial`, which looks the name up by
  DNS-over-HTTPS through the exit (`exits/doh.ts`: resolvers by IP, their
  certificates checked, answers cached per exit within bounds), checks
  every address from the exit's side (`exits/check.ts`: never its loopback,
  its own address, link-local or a cloud metadata address, whatever the
  levels; its private ranges only with the token's `private` line; never
  PCP's own) and opens a channel to the address it checked; a container's
  exit is a channel to the loopback port PCP published for it (on
  127.0.0.1 only, `parsePublish`), then CONNECT or SOCKS5
  (`exits/handshake.ts`) to that address, signed in with a random password
  PCP made for that instance (a managed `proxy_password` secret, decrypted
  only in `upstream.ts`, handed to the container over standard input). The SSH connection is pooled per server
  (`ssh/client.ts openChannel`), opened only with the key a request handed
  in (`upstream.ts openExit`, a pinned host only), idled out, and never
  reopened in the background: the browser's exit proxy dials keyless. A tab
  with an exit has its own context through its own proxy (`proxy.ts` with
  `connect`), signed in to nothing, saved nowhere, no downloads. Exits are
  vault rows (`exit`), the owner's alone to add, rename or remove (on the SSH
  server's page; a VPN exit is made by launching its service, never proposed
  by an assistant); a token's level for one is a `web_fetch_rule` of kind
  `exit` keyed by its id (own or for all tokens), blocked without one; an
  ask is an `exit_use` request showing the exit, its label and the request.
  The request log names the exit, never the site. Limits go in
  `exits/limits.ts`.
- Services (`lib/core/services/`) run with the Docker or Podman the owner
  already has on an SSH server PCP holds, through the engine's command line
  over SSH `exec` only: PCP installs no engine, never touches a socket and
  starts no child process. Every command is built from checked fields (the
  patterns in `services/definition.ts`) and quoted by `services/shell.ts`,
  the one quoting helper, then run as `sh -c '<script>'`; never a shell
  string from anyone. Variable values come from the vault, decrypted only in
  `upstream.ts` (a `ServiceEnv`, beside the `ServiceHost` that runs commands
  with PCP's key, only on a pinned host), and reach the engine over standard
  input as an env file the same command deletes, never on a command line;
  they are scrubbed from logs and errors, and `inspect` reads only state,
  image (and its id) and labels. Images are pinned by digest; volumes are named volumes,
  never a host path. The owner (never an assistant, a `register_server`
  proposal or a linked repository's document) can have one built instead
  (`build`: a public GitHub repository, a 40-hex commit, a Containerfile
  path and context matched by patterns, build arguments as checked fields):
  `engine.ts buildScript` downloads the tarball at that commit over HTTPS
  with the host's curl or wget into a `mktemp -d` folder it removes, keeps
  the Containerfile and context inside the repository, builds with the
  engine and pins the image id (`localhost/pcp-<repo>@sha256:…`), which is
  never pulled; time and sizes in `services/limits.ts`. A container gets nothing beyond the engine's default
  but an exit's, which may get NET_ADMIN and /dev/net/tun only (`cap_add`
  and `devices`, allow-lists in `definition.ts`, checked again in
  `engine.ts`); a variable marked `plain` takes a value the owner types per
  instance (`service_spec.plain_values`, no secret). A service is published
  on the SSH server's 127.0.0.1 unless the owner opts into its network on
  the launch form, and PCP reaches it, calls and health checks alike,
  through the SSH connection (`reach` "tunnel": `services.ts serviceDial`,
  a direct-tcpip channel to a port it publishes, at the address it is bound
  to there, on a pinned host with the key a request handed in, built in
  `upstream.ts serviceTunnel`); a server it registered is never reached from
  PCP's machine instead. One launched before ("direct") moves over when it
  is updated or made again. What the owner asked last is
  `service_spec.intended_state`: `stop` (theirs or an assistant's) writes
  "stopped", start, restart, launch and remake "running"; only while it is
  "running" does a call to what it serves that finds its container stopped
  start it in that request (bounded, `START_ON_DEMAND_WAIT_MS`), try once
  more and say so, and does the reconcile pass (`reconcileServices`, only
  through `after()` from `/mcp` and the owner's pages, throttled, never a
  timer or a stored key) bring it back up. Only the owner
  launches, changes, updates or removes one; an assistant gets `status`, `logs`, `start`, `stop`, `restart` at the
  owner's levels, and with a files folder in the definition (`files`: a
  volume of its own and a path in it) `put_file` and `get_file`, which copy
  a kept file in and out with the engine's own `cp` and a tar stream PCP
  builds and reads (`services/files.ts`), over standard input and output:
  no program in the container, the name confined to that folder before
  anything connects, a file replaced only with `overwrite` and a folder
  never, bounded by `resourceLimits().fileBytes`, and a file holding a
  value PCP handed the service never kept, and proposes one only through `register_server` (kind
  `service`, `services/proposals.ts`): a `service_change` request that shows
  everything it runs in full (image, ports and address, variables and their
  secrets by name, volumes, health, what it registers, the SSH server) and
  launches only that once the owner agrees; a new secret is typed in on
  PCP's page; never one that adds an exit or builds. It proposes an image
  update through the service's `update` tool (`services/updates.ts`): a
  `service_change` request showing the image it runs and the one it would
  (the newest of its source tag, or a digest it names in the same
  repository), both by digest, applied only to the definition as it was
  (`basis`); never for a built one. The owner's "Check for a newer image"
  resolves the source's digest on their click only, never polled. Status is read only inside a request (page, `check_server`, a failing call), never
  polled; a saved secret remakes the services that take it through
  `after()`. A launch that fails takes back everything it did: the
  container (also one `run` made but could not start) and only the volumes
  it made, `removeContainer` reporting what the engine would not remove, the
  container's first and last lines in the error; a secret the owner typed
  for it is kept and the error names it. A failed remake marks the service
  failed and says that Start makes it again. Limits go in
  `services/limits.ts`; a new command, tool or argument gets a test against
  the fake engine (`services/fake-docker.ts`, `services.test.ts`).
- Capabilities (`lib/core/capabilities/`): `read_image`, `edit_pdf` and
  `convert_document` are PCP's own tools for every token; the work is a
  provider's, a tool among the token's own found by words in its name,
  description or arguments (`providers.ts`, pure, never a vendor's name;
  the common item a server was launched from only ranks it), called how its
  schema says (a handle, base64, or a file step `put_file` → tool →
  `get_file`, found by its tools' shape, never their names: the service's
  own when a service with `files` registered the server, else the #92
  shape on the server itself; a service's own tools are never a provider). Every call goes through `gateway.ts forwardCall` (as
  run_code's): the token's own levels, the capability tool's own tier with
  a provider above it refused naming the entry that runs it, the one
  validator, `askCodeCall` where a level asks, paced, a request-log line
  each. With no provider the answer is `needs_owner` reason `setup`: a
  markdown link, last, to `/plugins/<capability>`, `noteOwnerAsked`, and the
  tool called again once the owner launched one; that page offers the
  capability's common items (add PCP's common items first if needed, then
  the import page at the common repository's head). A new capability is a
  row in `list.ts`, its operations in `providers.ts`, and a test against
  fake providers (`capabilities.test.ts`).
- Search (`lib/core/search.ts`, pure) finds a tool by keywords with no
  provider: stems, a short synonym table, and for PCP's own tools what
  their description's lead says they are for (task phrases there, in a
  search's words). Embeddings (`lib/core/embeddings/`) are optional and the
  owner's: a provider chosen on Settings → Search (Voyage AI, an
  OpenAI-compatible address, or one of their API endpoints such as a
  text-embeddings-inference service), kept as the vault's `embeddings`
  setting, never a host setting. Only what the owner ticked leaves PCP,
  with the query: tools' names and descriptions, skills, memories
  (`itemsToEmbed`, nothing else of the vault: no server description, note,
  argument or secret); a provider elsewhere starts at tools only
  (`defaultEmbedded`). The secret is read in `upstream.ts
embeddingProvider`, which hands `embeddings/provider.ts` the header;
  Voyage AI at public addresses only, an address the owner typed never PCP's
  own, an endpoint by its own rules. Vectors are cached encrypted
  (`embedding_vector:<id>`) under a keyed hash of the provider and the text,
  rebuilt when either changes, embedded only inside a search's request
  within `embeddings/limits.ts` (never on a timer), removed by the cleanup
  once unused, in `wipeVault`, never exported. Any provider failure or
  timeout is keyword search, quietly; a name given exactly stays first.
- Long tool answers and files are kept only through
  `lib/core/tool-results.ts`: text or bytes, encrypted with
  `tool_result:<id>`, readable by the token whose call produced them, gone
  after a day, never logged and never exported. A handle (`{"$result": id}`)
  in a call's arguments is replaced only in `upstream.ts`, `endpoints.ts`,
  `mail/accounts.ts`, `storage/roots.ts`, `services/services.ts` and
  `browser/call.ts`
  (`lib/core/result-handles.ts`), with the token's own
  results, before anything is sent; a waiting request stores the handle,
  never the content. File links (`lib/core/file-links.ts`, only for a token
  with `shareFiles`) move one kept file to or from the assistant's own
  computer: the link's secret is the credential for that file alone, stored
  only as its hash, the file encrypted under a key derived from it (an
  upload's key also wrapped under the vault's, so it becomes a kept result
  only when the token uses its handle); an hour, a few downloads or one
  upload, its token live, every use in the request log, never exported, and
  pruned by the cleanup. Upload links (`lib/core/upload-links.ts`, same
  option) are the one link for the owner: `create_upload_link` hands the
  assistant `/upload/<secret>` (a page outside the dashboard, no session,
  the link alone its credential) to give the owner as a markdown link, and
  `check_upload` waits for what arrived; it takes a few files for an hour,
  then a quarter of an hour from the first or until Done, each file a
  `file_link` slot made with it (result id and wrapped key up front), so it
  too becomes a kept result only when the token uses its handle. The one
  other way a kept result goes over HTTP is to the owner's own page, while
  a call that names it waits for them (`lib/core/permission-files.ts`,
  `permissions.ts openRequestFile`): only a result that waiting request's
  arguments name, of its own token, PDF and images as themselves when their
  bytes agree, text (HTML and SVG too) as plain text, the rest as a
  download, sandboxed and nosniff. Nothing else serves a kept result over
  HTTP.
- The request log (`lib/core/request-log.ts`) is a token's calls by name:
  tool, server, upstream tool, time, outcome, the permission request an
  ask made, and for a secret the browser typed, its name and the origin.
  Never arguments, results, other sites or a secret's value; the Log page
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
  program asks, whole or a part: `pcp.read(handle, { offset, length })`).
  Listing (`pcp.tools`) shows what `list_tools` would. No credential, network, file
  or timer ever reaches the program, and nothing but strings crosses into
  it (a wrapper's program gets its arguments the same way, as text). Waits
  (`pcp.sleep`, `pcp.withTimeout`) happen only in PCP's bridge, as timers
  of the bridge's that the program holds no handle to, capped in
  `code/limits.ts` and counted against the run's wall clock. Its
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
  own level and those of the tools it calls (`gateway-servers.ts`), and at
  the highest tier of those tools unless the owner chose one, and a
  call that asks runs only in a call the owner allowed (`approved`); that is
  `callLevels` "token". With `callLevels` "approved", the default for a new
  wrapper, the owner's approval of the wrapper is the level for the calls it
  lists (a tool has its own level only, `innerCall` takes the target from
  the vault), and every request says which calls any token can make through
  it. A tool's `outputSchema` is checked on every return by the one
  validator (no `$ref`, `wrappers/schema-check.ts` refuses one when it is
  saved) and the value answered as `structuredContent`. A
  secret goes in only as `{"$secret": name}` where a binding the owner
  approved names that tool (by server id), argument and address: matched
  and written in `upstream.ts`, scrubbed from the answer, errors and status
  there, and refused in an assistant's own call. Into the browser it goes
  only as `type`'s text (in a wrapper, a binding for `browser/type` at
  `/text`, no template), through the browser's own gate below.
  An assistant's create, change and delete are a permission request
  (`wrapper_change`) that shows every program, schema, call, replaced tool
  and secret place in full and writes only that, to the wrapper as it was
  (`basis`). Add a test for each new field an assistant can set
  (`wrappers.test.ts`).
- The browser (`lib/core/browser/`) runs Chromium for the vault and keeps
  nothing on disk: its sign-ins are the vault's `browser_profile`,
  encrypted, saved only while a request holds the key. They come from the
  browser's use or from the owner's import on the Browser page
  (`sign-in-import.ts`: storage state or a cookie export, checked as
  Chromium takes a cookie, PCP's own site left out, merged per site as
  previewed, with the browser closed); never a tool. Its languages are
  Chromium's own switches from the host's locale (`--lang`,
  `--accept-lang`), never Playwright's `locale`. Every connection goes
  through its proxy (`proxy.ts`), which checks the address it dials as web
  fetch does, and every page a tab's main frame opens passes the gate in
  `runtime.ts`: the driving token's web fetch site lines, a site the owner
  allowed for that tab, or the owner's own control; PCP's own site never. Service
  workers are refused at that gate, not by a browser option. No tool
  reads or sets cookies or storage directly. JavaScript runs only through
  `evaluate` (`browser/evaluate.ts`): Destructive, asked of the owner per
  site with the whole script shown (`script_use`, with `noteOwnerAsked`;
  Run it once, or a level for the site kept as a `web_fetch_rule` of kind
  `script`, `browser-scripts.ts`), refused while a field holds a typed
  secret, and while it runs the tab reaches its own site only (its
  DevTools session fails every request elsewhere, the gate keeps its main
  frame and popups there, and the proxies hold new connections elsewhere
  until it is done, then refuse the ones it reached for); its result is
  masked and a long one kept as a result. The logs (`console_log`,
  `network_log`, `browser/devtools.ts`) are DevTools events only, never
  page script; the page's own console calls only from the first
  `console_log` on a tab (Runtime is a domain pages can detect); headers
  that carry a credential are dropped, token-like values in addresses
  masked, and bodies kept as results only when asked for, never a request
  body from a page PCP typed a secret into. A point (`x`, `y` on `click`,
  `scroll`, `drag`) is viewport CSS pixels, sent as DevTools mouse events
  through `input.ts` as the owner's input is. Files cross only
  as the token's kept results, never a path on the machine: Chromium refuses
  every download but while `download` waits for one (`downloads.ts`, on a
  DevTools session of PCP's own), which takes the first from its tab or a
  popup of it at an address the tab may open, cancels every other and one
  past the largest file, and reads and removes the file before answering;
  `upload_file` reads kept results as bytes, and no file chooser ever opens
  a window. A
  refusal that names a site is a tool error, never a thrown `PcpError` (the
  request log keeps those). The owner's input enters through the DevTools
  protocol with each event's own time (`input.ts`), never as page script.
  In the container image Chromium runs with windows on a virtual display PCP
  starts itself (`display.ts`: Xvfb, its own cookie, stopped with the last
  browser), with the host's GPU when it has a render node PCP may use and
  in software otherwise; never in the desktop app, which starts no child
  process: there Chromium has a window of its own kept off the screen,
  its pages opened in the background (`launch.ts`). A
  tool that needs the owner throws `OwnerNeeded`, which `runCall` turns into
  a permission request (`browse`, `browser_handover`, `script_use`); a site is asked
  about only for the address in the call's arguments, so a call the owner
  allowed opens it without a second ask. `navigate` waits for a check that
  passes on its own; one that does not is the owner's, through `hand_over`,
  and nothing asks them by itself. A call waits its turn per tab and
  within its own time (`timeout_ms`, `clock.ts`): past it, a `timeout` tool
  error naming the step; a lane too full for it, `browser_busy` with
  `retryAfterMs`. Tabs that are done with (idle past a TTL, or their run
  ended) are closed by the next browser call inside its request
  (`sweep.ts`), never by a timer. What the tree cannot read (empty iframes,
  closed shadow roots, canvases, `unseen.ts`) is found through Playwright
  and DevTools in PCP's own world, never page script. Pages read for web_fetch are not tabs. The
  limits go in `browser/limits.ts`; the Dockerfile's Chromium is the version
  `patchright-core` drives (`scripts/docker.test.ts`). Chromium is installed
  only by the owner's click (`browser/install.ts`), only from the addresses
  Playwright pins for that version, in PCP's process: never with a child
  process, which the desktop app's fuses forbid.
- A secret goes into a page (`lib/core/browser-secrets.ts`) only as the
  browser's `type` text `{"$secret": name}` (from an assistant's call,
  run_code or a wrapper's binding), never in another tool or argument, and
  only through `upstream.ts callBrowser`, which hands the browser a typer,
  never a value. `"part": "username"` types the login name the owner keeps
  with it instead (`secrets.ts readTypedLogin`), through the same gate,
  refused anywhere but the browser and not held, since the assistant may
  read it; a once allowance is one sign-in, both parts in the same tab
  within `SECRET_SIGN_IN_WINDOW_MS`, never more. The browser asks for it only at the moment of typing, for
  an input or textarea whose frame is the page's own origin; the typer lets
  it through only where the token has an allowance for that secret at that
  origin (once, an hour, or always while the origin is one of the secret's
  `SecretBrowserOrigin` sites), or else asks the owner (`secret_use`, with
  `noteOwnerAsked`), whose answer never changes a tool's level; an API
  endpoint's use of the secret never counts. A site may stand for its
  subdomains (`include_subdomains`): only within its own registrable
  domain by the public suffix list (`tldts`, `siteCovers`), never for an IP
  address, localhost or a public suffix, never across domains. It is typed
  with CDP `Input.insertText` once the field has the focus (in its frame,
  each frame around it and each shadow root around it). While a field holds
  it, as typed or as the page reformatted it (`browser/held.ts`, keyed
  hashes of the value and of its normalised form, white space and
  separators out and upper case, never the value), every answer shows it as
  `[secret: name]` and `screenshot` is refused; a password field's value
  never shows, its snapshot `- text:` child included. For the life of the
  tab, every answer to the token masks each secret typed into any of its
  tabs wherever the text has it once normalised (`maskTyped`: a keyed
  rolling fingerprint, then an HMAC), whatever document the tab shows now.
  The value is scrubbed from answers and errors, and the request log has
  the secret's name and origin, never the value.
  `request_secret` asks the owner to type a new one on PCP's page (with its
  login name, `username`), or to have PCP make a password there
  (`generate`: `generate-password.ts`, a CSPRNG, in `decidePermission`,
  stored at once and never handed back; the owner reveals it under
  Secrets), and never writes over a name PCP holds. Its page keeps the
  sites out of a password manager's reach (boxes outside the login form,
  `data-1p-ignore`). An assistant changes a secret's sites only by
  proposing it (`update_secret_sites`, a `secret_sites_change` request that
  always asks, whatever the levels): the page shows the sites now, each
  change and lookalikes flagged unticked (`lookalike-sites.ts`), and makes
  only what the owner ticked, to the sites as shown (`sitesBasis`).
  Allowances are not exported; origins are, with their flag.
  `navigate`, `snapshot` and `tabs` open name the owner's secrets bound to
  the page's origin (`browser/sign-in-hint.ts`, louder at a password
  field) with the login name, note and TOTP companion the owner gave each
  (`secret.login_name` and `note`, encrypted under `secret:<id>:login` and
  `:note`, opened only in `secrets.ts`); never a value, and naming one
  grants nothing: typing it is still the gate above. Add a test for each
  new way in.
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
  origin itself, `lib/server/same-origin.ts`), file links
  (`app/api/files/[secret]/`: curl from an assistant's own computer, and
  the upload page's PUTs and Done, the link's secret its only credential),
  the browser's live view
  (`app/api/browser/tabs/[id]/`: a stream of a tab's pictures and the
  owner's input, which an action cannot carry; the same origin check and
  session), a storage folder's download
  (`app/api/storage/[id]/download/`: a file needs `Content-Disposition` and
  can be larger than an action's answer; streamed from the SSH server, kept
  nowhere; the same origin check and session), and the files a waiting call
  carries (`app/api/permissions/[id]/files/[result]/`: a preview or download
  needs Content-Type and Content-Disposition; the same origin check and
  session).
- The owner is asked by link only: a result hands the assistant a link to
  PCP's page, to end its reply with (`linkLastText`: nothing after it, or
  Claude's apps fold it out of sight; several links in one reply all go at
  its end, each on its own line; a markdown link with a short label
  naming the action, never the bare address, so voice mode reads the label;
  `owner-link.ts` holds the label rules and the wording instructions and
  descriptions use), and a check to call on the owner's next message,
  whatever it says, before the link is sent again (`nextMessageCheck`;
  `check_permission`, `check_server`, `check_upload`,
  `lib/core/owner-wait.ts`). In a session, the next answer of any of PCP's
  own tools names the token's requests answered since, once each, and
  `check_permission` with no id lists the last hour's. The header's bell lists what is waiting. No client prompts (elicitation) and no MCP Apps
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
  (on the develop channel, its list of the newest releases, of which the
  latest version counts) and nothing else, sends nothing but PCP's version in
  its user agent, reads
  the answer as untrusted input (never rendered as HTML, never a link taken
  from it), and runs no timer and no request while the owner has it off; it
  asks nothing before setup. It tells the owner how to update for the way PCP
  was installed; in a container or a checkout PCP never pulls, builds or
  restarts itself. Install and restart in the Linux installer's container is
  a file in the data folder (`updates/host-signal.ts`: an id and a time,
  nothing of the vault) that the installer's `watch` reads through `exec` and
  checks as untrusted input before it runs its own `update`, which runs the
  installer read out of the image it pulled (`/app/install.sh`), never out
  of the running container; PCP never addresses the host. A build of develop (`X.Y.Z-dev.N`, a pre-release that
  `.github/workflows/develop.yml` makes on every push to develop) is never
  offered on the stable channel.
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
server" ("SSH servers" in the UI); a folder on one that assistants keep
files in is a "storage folder" ("Storage folders" in the UI; a storage root
in code); a container PCP runs on one is a
"service" ("Services" in the UI); calendars and reminders PCP reaches over
CalDAV are a "calendar account" ("Calendar accounts" in the UI); a server
whose tools are programs over the
others is a "wrapper" ("Wrappers" in the UI); a note an
assistant keeps between conversations is a "memory", "shared" when every
assistant reads it; a procedure the owner approved for assistants to follow
is a "skill" ("Skills" in the UI); a wrapper whose tools drive the browser
is a "browser flow"; a GitHub repository PCP shares items with is a "linked
repository"; what web_fetch reaches is a "site" (a host), and a level
every token follows is "for all tokens" ("All tokens" in the UI); unlocking
or confirming with a fingerprint in the Mac app is "Touch ID". No operator
vocabulary in the UI: no "DEK", "grant", "KEK" outside code comments and
ARCHITECTURE.md.
