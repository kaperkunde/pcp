# Changelog

What changed in each release of PCP, newest first. The release workflow
writes it (`.github/workflows/release.yml`, `scripts/changelog.mjs`) from
the pull requests merged since the release before: each one's "Changelog"
section, or its title. The builds of develop that led to a release are in its
section; each also has its own notes on its pre-release.

## [0.5.1](https://github.com/kaperkunde/pcp/releases/tag/v0.5.1) - 2026-11-15

- Mail accounts keep one signed-in connection per account instead of signing in on every call. Searches and moves no longer count every folder first, and a search with no filter reads only the newest page. A Gmail call that took about 80 seconds should now take a few. The server's page shows each rec… ([#144](https://github.com/kaperkunde/pcp/pull/144))
- One set of limits for every kind of server: calls at once, spacing, calls per minute, a time limit per call, and bytes per day. Each kind has its own defaults, and you change them in the new Limits section of a server's page. ([#144](https://github.com/kaperkunde/pcp/pull/144))
- When a server asks PCP to slow down, or keeps answering much slower than usual, PCP gives it a cool-down. Calls then answer at once, saying when to try again, instead of hanging. The server's page shows the cool-down with a button to end it, and counts calls, errors, slow-downs and times over the l… ([#144](https://github.com/kaperkunde/pcp/pull/144))
- Assistants can propose limits for a new server, or changes to a server's limits, with a note on why. Nothing changes until you save it on PCP's page. ([#144](https://github.com/kaperkunde/pcp/pull/144))
- API schemas are no longer capped at 5 MB. The largest size is a setting (Settings → Resources), sized to your machine by default. A big YAML schema is read off PCP's main thread, and stored schemas are compressed. GitHub's complete REST API (11 MB of YAML) now registers. ([#144](https://github.com/kaperkunde/pcp/pull/144))
- Settings → Repeated calls takes a time per tool for PCP's own tools too. ([#144](https://github.com/kaperkunde/pcp/pull/144))
- More is encrypted on disk: tool names in your levels, tiers and requests the values you type for a service header templates access waiting for a server's first read tool icons an exit's name and label a storage folder's path and login the app a token is for Old request-log files are overwritten bef… ([#144](https://github.com/kaperkunde/pcp/pull/144))
- A mail account whose server marks its answers [THROTTLED] now cools down. The server page and `check_server` say why, and calls fail at once saying when to try again, instead of each waiting out the time limit. ([#145](https://github.com/kaperkunde/pcp/pull/145))
- Search puts a tool first when you give its title word for word, even among an API's hundreds of similar tools. ([#145](https://github.com/kaperkunde/pcp/pull/145))

## [0.5.0](https://github.com/kaperkunde/pcp/releases/tag/v0.5.0) - 2026-11-15

- Resolve open issues #27, #39–#46, a follow-up to #38, and one tool interface for the MCP layer ([#49](https://github.com/kaperkunde/pcp/pull/49))
- Upgrade to Next 16.3, React 19.2 and Vitest 5, with ESLint's flat config ([#54](https://github.com/kaperkunde/pcp/pull/54))
- Resolve #48, #50, #51, #52 and #53: tool tiers, upload links, private skills, front-loaded descriptions and client profiles ([#55](https://github.com/kaperkunde/pcp/pull/55))
- Browser points, scripts and logs; sign-in hints; access with proposals; check on next message; search by task and embeddings; services through SSH, started on demand; private-address switch (#56–#64) ([#65](https://github.com/kaperkunde/pcp/pull/65))
- Resolve #38, #66, #68–#75, #77–#79 and #82–#84: storage folders, browser secrets and time limits, service updates and builds, file previews ([#85](https://github.com/kaperkunde/pcp/pull/85))
- Resolve #90, #91, #92: encrypted file storage, capability tools that suggest their plugin, files into services ([#93](https://github.com/kaperkunde/pcp/pull/93))
- Take the lint, format, type and test presets from `@kaperkunde/config` ([#67](https://github.com/kaperkunde/pcp/pull/67))
- Adopt the shared `@kaperkunde` packages: pcpgg-protocol, security, mcp, next-kit (Phase A) ([#101](https://github.com/kaperkunde/pcp/pull/101))
- Draw the owner's pages with `@kaperkunde/ui`, held to screenshots ([#103](https://github.com/kaperkunde/pcp/pull/103))
- Give Renovate its config in the repository ([#128](https://github.com/kaperkunde/pcp/pull/128))
- Assistants now see seven tools: search, and execute and run in read, write and destructive forms. PCP's own tools run through execute by name. The old tool names keep working for one release. ([#133](https://github.com/kaperkunde/pcp/pull/133))
- A Write or Destructive call repeated within a while is answered with how the first one went, not run again, unless the assistant says why it repeats it. Set the window under Settings → Repeated calls. ([#133](https://github.com/kaperkunde/pcp/pull/133))
- More of your vault is encrypted on disk: secret names and their sites, server addresses and logins, tool descriptions and schemas, short names, tool names and the request log. Deleted data is overwritten in the database file. ([#133](https://github.com/kaperkunde/pcp/pull/133))
- Linux installer: images are now signature-checked before they run. Under Podman with `PCP_AUTO_UPDATE=1`, an existing install keeps Podman's own auto-update, which checks nothing, until you run the install line again or use Install and restart. ([#133](https://github.com/kaperkunde/pcp/pull/133))
- Behind a reverse proxy, set `PCP_TRUSTED_PROXIES` to your proxy's address, or every visitor shares one rate limit; PCP warns once in its log. ([#133](https://github.com/kaperkunde/pcp/pull/133))
- Browser: faster pacing between actions, a pace an assistant can set per tab or per flow within your limits, print a page to PDF, full-page screenshots, and downloads that follow popup windows. ([#133](https://github.com/kaperkunde/pcp/pull/133))
- New `view_image` tool to look at a picture, and `convert_document` can turn a PDF page into a picture. ([#133](https://github.com/kaperkunde/pcp/pull/133))
- Browser flows type the secrets their program names once you approve the flow; the approval and the flow's page show which ones. ([#133](https://github.com/kaperkunde/pcp/pull/133))
- `check_permission` can wait on several requests at once. ([#133](https://github.com/kaperkunde/pcp/pull/133))
- The browser's live view: Take over and Hand back no longer get stuck, and the view reconnects by itself. ([#133](https://github.com/kaperkunde/pcp/pull/133))
- none ([#135](https://github.com/kaperkunde/pcp/pull/135))
- --- _Generated by [Claude Code](https://claude.ai/code/session_01J6Kwog1VyvL9RwUz97kNJS)_ ([#135](https://github.com/kaperkunde/pcp/pull/135))
- Raise the version to 0.5.0 ([#136](https://github.com/kaperkunde/pcp/pull/136))
- Update Kaperkunde shared packages ([#137](https://github.com/kaperkunde/pcp/pull/137))
- none ([#139](https://github.com/kaperkunde/pcp/pull/139))
- --- _Generated by [Claude Code](https://claude.ai/code/session_01J6Kwog1VyvL9RwUz97kNJS)_ ([#139](https://github.com/kaperkunde/pcp/pull/139))
- Tools: what the text says reaches a client that shows only structuredContent ([a169328](https://github.com/kaperkunde/pcp/commit/a169328682f08726030ec52e1dd6e3b2ce112942))
- Permissions page: an access request saved says levels and tiers, as the save did ([10c5af2](https://github.com/kaperkunde/pcp/commit/10c5af28a4b005085e1d0e5bc5165e59a6d6bc18))
- Slim README: bring #80 to develop (pitch, screenshots, detail moved to docs/), keeping develop's newer text ([3491dd1](https://github.com/kaperkunde/pcp/commit/3491dd19e314d54f85cf031357ab3ca96a1dbbcd))
